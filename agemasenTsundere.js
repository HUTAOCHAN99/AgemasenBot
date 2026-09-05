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
} = require("./src/tsundere/chatSession");
const { findImageForVision, downloadImageAsDataUri } = require("./src/tsundere/vision");
const { saveDocumentContext, DOC_CONTEXT_TTL_MS } = require("./src/tsundere/documentContext");
const { askGroqTsundere } = require("./src/tsundere/chatReply");
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
  const senderName = msg.pushName || "";
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
    const { chunks } = await askGroqTsundere(chat, cleanText, senderName, imageDataUri);

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
