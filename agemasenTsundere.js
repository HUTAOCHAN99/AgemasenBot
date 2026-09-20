// =====================================================
// AgemasenBot -- Chat AI Tsundere (via Groq API)
//
// Entry point tipis: semua logic-nya sudah dipecah ke src/tsundere/*
// (lihat file masing-masing untuk detail):
//
//   src/tsundere/groqClient.js      -> rotasi API key + panggilan HTTP ke Groq
//   src/tsundere/chatSession.js     -> riwayat obrolan per sesi + persistensi disk
//   src/tsundere/vision.js          -> deteksi & download gambar buat dianalisis Groq
//   src/tsundere/documentContext.js -> "ingatan" dokumen PDF dari !ringkas
//   src/tsundere/persona.js         -> system prompt (kepribadian Special Week)
//   src/tsundere/replyFormat.js     -> pemecah jawaban jadi beberapa bubble pesan
//   src/tsundere/chatReply.js       -> askGroqTsundere (obrolan biasa)
//   src/tsundere/summarizer.js      -> summarizeDocumentText (!ringkas)
//
// File ini sendiri cuma berisi handleTsundereChat (dipanggil dari
// src/bot/router.js) yang mengurus orkestrasi: cek mention/reply, bangun
// konteks, panggil Groq, kirim balasan -- serta re-export semua fungsi
// yang masih dipakai langsung dari luar (router.js, dst).
// =====================================================

const { sleep } = require("./src/tsundere/groqClient");
const {
  groqChats,
  getGroqChat,
  forgetGroqChat,
  sweepExpiredTsundereChats,
  isBotMentioned,
  isReplyToBotMessage,
  rememberSentMsgId,
  scheduleSaveHistory,
  jidNumber,
} = require("./src/tsundere/chatSession");
const { getSenderJid } = require("./src/utils/whatsapp");
const { findImageForVision, downloadImageAsDataUri } = require("./src/tsundere/vision");
const { saveDocumentContext, DOC_CONTEXT_TTL_MS } = require("./src/tsundere/documentContext");
const { askGroqTsundere } = require("./src/tsundere/chatReply");
const { splitReplyIntoChunks } = require("./src/tsundere/replyFormat");
const { hasRenderableContent, parseSegments, buildSegmentImage } = require("./src/tsundere/solutionImage");
const {
  summarizeDocumentText,
  DOC_HARD_MAX_CHARS,
  SUMMARY_SINGLE_PASS_MAX_CHARS,
  SUMMARY_CHUNK_CHARS,
} = require("./src/tsundere/summarizer");

// =====================================================
// Fungsi utama yang dipanggil dari index.js di dalam handler
// messages.upsert. Mengurus semuanya: cek mention, bangun riwayat, panggil
// Groq, kirim balasan (atau pesan error tsundere kalau gagal) -- index.js
// cukup panggil 1 fungsi ini.
//
// Return true kalau pesan ini DITANGANI oleh fitur tsundere (supaya
// index.js tahu harus `return` dan gak lanjut ke pengecekan lain), false
// kalau tidak relevan (bot tidak di-tag & bukan reply ke bot, atau teksnya
// command "!...").
//
// Trigger-nya SEKARANG ada 2 cara (boleh salah satu):
//   1. Nge-tag bot (@AgemasenBot) -- seperti sebelumnya.
//   2. REPLY ke pesan balasan tsundere sebelumnya dari bot -- supaya
//      obrolan bisa dilanjut natural kayak chat WhatsApp beneran, tanpa
//      harus nge-tag ulang tiap kali mau lanjut.
// =====================================================
// Kirim balasan yang mengandung tabel/rumus sebagai CAMPURAN pesan
// berurutan, MEMPERTAHANKAN urutan asli jawabannya (misal: teks
// pembuka -> gambar tabel -> teks penutup):
//   - Segmen teks -> dipecah per-bubble (splitReplyIntoChunks, SAMA
//     kayak jalur teks biasa) dan dikirim sebagai pesan teks WA normal.
//   - Segmen tabel/rumus -> dirender jadi gambar KECIL per-segmen
//     (buildSegmentImage), TANPA teks lain nempel di situ. Kalau
//     render-nya gagal (mis. API LaTeX down), fallback kirim mentah
//     sebagai teks (tabel jadi baris " | " dipisah newline, rumus jadi
//     "$..$"/"$$..$$" apa adanya) daripada segmen itu ilang total.
//
// quoted+reply-tracking cuma ditempel di pesan yang PALING PERTAMA
// kekirim (apa pun tipenya -- teks atau gambar), sisanya nyusul biasa.
// =====================================================
async function sendSegmentedReply({ sock, jid, msg, chat, fullReply }) {
  const segments = parseSegments(fullReply);
  let sentAny = false;

  async function sendOne(content) {
    const opts = sentAny ? {} : { quoted: msg };
    const sentMsg = await sock.sendMessage(jid, content, opts);
    sentAny = true;
    rememberSentMsgId(chat, sentMsg?.key?.id);
  }

  async function typingPause(approxLen) {
    if (!sentAny) return; // jangan ada delay sebelum bubble PERTAMA
    await sock.sendPresenceUpdate("composing", jid);
    await sleep(Math.min(2500, 400 + approxLen * 8));
  }

  for (const seg of segments) {
    if (seg.type === "text") {
      const textChunks = splitReplyIntoChunks(seg.value);
      for (const chunk of textChunks) {
        await typingPause(chunk.length);
        await sendOne({ text: chunk });
      }
    } else {
      // seg.type === "table" atau "math"
      await typingPause(80);
      try {
        const imgBuffer = await buildSegmentImage(seg);
        await sendOne({ image: imgBuffer });
      } catch (err) {
        console.log(
          "[groq tsundere] gagal render segmen gambar, fallback teks mentah:",
          err.message || err,
        );
        const raw =
          seg.type === "table"
            ? [seg.header.join(" | "), ...seg.rows.map((r) => r.join(" | "))].join("\n")
            : seg.display
              ? `$$${seg.latex}$$`
              : `$${seg.latex}$`;
        await sendOne({ text: raw });
      }
    }
  }
}

async function handleTsundereChat(sock, msg, { jid, text, sessionKey }) {
  if (text.startsWith("!")) return false;

  // Ambil chat yang SUDAH ADA (kalau ada) tanpa bikin entry baru dulu --
  // dipakai buat cek "reply ke bot". Kalau langsung pakai getGroqChat() di
  // sini, tiap pesan biasa (yang bukan buat bot) bakal bikin entry kosong
  // numpuk sia-sia di memory & di file.
  const existingChat = groqChats.get(sessionKey);

  const mentioned = isBotMentioned(sock, msg);
  const repliedToBot = isReplyToBotMessage(existingChat, msg);
  if (!mentioned && !repliedToBot) return false;

  const cleanText = text.replace(/@\d+/g, "").trim();

  // Label pengirim buat dikasih tau ke LLM (dipakai chatReply.js sebagai
  // "[dari <label>]" di history) -- SENGAJA nggak cuma pakai pushName
  // mentah (msg.pushName), karena pushName itu NAMA TAMPILAN yang bisa
  // diganti pengirimnya kapan aja lewat setting WA-nya sendiri. Kalau
  // cuma modal nama, begitu orang ganti nick di tengah obrolan, di mata
  // bot dia jadi "kelihatan seperti orang baru" -- riwayat lama jadi
  // kayak punya orang lain. Sama juga kalau kebetulan ada 2 orang di
  // grup yang pushName-nya sama persis, bot bisa ketuker.
  //
  // Solusinya: tempelkan suffix STABIL yang diturunkan dari NOMOR WA asli
  // (getSenderJid -> jidNumber, 4 digit terakhir) -- ini nggak berubah
  // walau nick-nya ganti-ganti, jadi biar nick berapa kali pun diganti,
  // suffix ini tetap sama dan LLM tetap bisa "mengenali" ini orang yang
  // sama dari histori sebelumnya.
  const senderJid = getSenderJid(msg);
  const senderNumberSuffix = senderJid ? jidNumber(senderJid).slice(-4) : "";
  const rawSenderName = msg.pushName || "";
  const senderName = senderNumberSuffix
    ? `${rawSenderName || "seseorang"} (...${senderNumberSuffix})`
    : rawSenderName;

  const chat = getGroqChat(sessionKey);

  // Cek apakah ada gambar yang perlu dianalisis (dikirim langsung dengan
  // caption nge-tag bot, atau reply ke sebuah foto sambil nge-tag bot).
  // Gagal download BUKAN error fatal -- kalau gagal, tetap lanjut sebagai
  // chat teks biasa (bot cuma jawab pertanyaannya tanpa lihat gambarnya).
  const imageSource = findImageForVision(msg);
  let imageDataUri = null;
  if (imageSource) {
    try {
      imageDataUri = await downloadImageAsDataUri(imageSource);
    } catch (err) {
      console.log("[groq tsundere] gagal download gambar buat vision:", err.message || err);
    }
  }

  try {
    await sock.sendPresenceUpdate("composing", jid);
    const { text: fullReply, chunks } = await askGroqTsundere(chat, cleanText, senderName, imageDataUri);

    // Kalau jawabannya mengandung rumus ($$..$$ / $..$) atau tabel
    // markdown (| a | b |), pecah jawabannya per-segmen (lihat
    // parseSegments di src/tsundere/solutionImage.js) dan kirim CAMPURAN:
    //   - segmen teks biasa -> dikirim sebagai bubble chat WA NORMAL
    //     (bisa di-reply/di-copy, format *bold*/_italic_ WA-nya tetap
    //     kepakai) -- SAMA seperti kalau jawabannya nggak ada tabel sama
    //     sekali.
    //   - segmen tabel/rumus -> BARU ini yang dirender jadi gambar kecil
    //     terpisah (lihat buildSegmentImage), karena WA emang gak bisa
    //     nampilin tabel markdown / LaTeX dengan rapi kalau dikirim
    //     mentah sebagai teks.
    //
    // Dulu SEMUANYA (termasuk basa-basi tsundere-nya) digambar jadi SATU
    // gambar besar (buildSolutionImage) -- akibatnya teksnya "kebawa"
    // masuk ke gambar dan gak bisa di-reply/di-copy kayak chat biasa.
    if (hasRenderableContent(fullReply)) {
      try {
        await sendSegmentedReply({ sock, jid, msg, chat, fullReply });
        scheduleSaveHistory();
        return true;
      } catch (err) {
        // Gagal total di tengah proses kirim campuran (jarang -- biasanya
        // cuma 1 segmen gambar yang gagal, dan itu SUDAH ditangani sendiri
        // di dalam sendSegmentedReply dengan fallback teks per-segmen).
        // Kalau sampai ke sini, fallback ke chunk teks polos seperti
        // sebelumnya (dari askGroqTsundere), daripada user gak dapet
        // jawaban sama sekali.
        console.log(
          "[groq tsundere] gagal kirim balasan campuran teks+gambar, fallback teks:",
          err.message || err,
        );
      }
    }

    // Kirim tiap chunk (paragraf/bagian jawaban) sebagai pesan terpisah
    // berurutan, bukan sekaligus jadi 1 dinding teks -- biar kerasa kayak
    // orang ngetik nyicil per-bubble. Delay singkat + "composing" lagi di
    // antara chunk biar animasi "typing..." muncul wajar (bukan spam
    // kilat), skala dikit sesuai panjang teksnya.
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await sock.sendPresenceUpdate("composing", jid);
        const typingDelay = Math.min(2500, 400 + chunks[i].length * 8);
        await sleep(typingDelay);
      }
      const sentMsg = await sock.sendMessage(
        jid,
        { text: chunks[i] },
        i === 0 ? { quoted: msg } : {},
      );
      // Ingat ID tiap bubble supaya kalau user reply ke salah satu (bukan
      // cuma yang terakhir), bot tetap tau harus lanjut obrolan (lihat
      // isReplyToBotMessage di atas).
      rememberSentMsgId(chat, sentMsg?.key?.id);
    }
    scheduleSaveHistory();
  } catch (err) {
    // Log detail lengkap (bukan cuma err.message) -- error dari axios ke
    // Groq seringkali cuma nyimpen "Request failed with status code 400"
    // di message, sedangkan alasan sebenarnya (mis. gambar kegedean,
    // format model salah, dll) ada di err.response.data. Tanpa ini,
    // sebelumnya kita gak bisa tau kenapa persisnya chat gambar gagal.
    console.log(
      "[groq tsundere] gagal:",
      err.code === "ECONNABORTED" ? "timeout" : err.message || err,
      err.response?.status ? `status=${err.response.status}` : "",
      err.response?.data ? JSON.stringify(err.response.data) : "",
    );
    const isConfigError = /GROQ_API_KEY/.test(err.message || "");
    await sock.sendMessage(
      jid,
      {
        text: isConfigError
          ? "Hmph, aku belum dikasih GROQ_API_KEY sama pemilikku. Bukan salahku ya! 😤"
          : "H-hmph! Otakku lagi ngambek gara-gara lagi malas mikir. Coba tag aku lagi nanti. 💢",
      },
      { quoted: msg },
    );
  }

  return true;
}


module.exports = {
  handleTsundereChat,
  sweepExpiredTsundereChats,
  forgetGroqChat,
  summarizeDocumentText,
  saveDocumentContext,
  DOC_HARD_MAX_CHARS,
  SUMMARY_SINGLE_PASS_MAX_CHARS,
  SUMMARY_CHUNK_CHARS,
  DOC_CONTEXT_TTL_MS,
  // Di-export juga kalau-kalau index.js atau test butuh akses langsung.
  isBotMentioned,
  isReplyToBotMessage,
  askGroqTsundere,
  getGroqChat,
};
