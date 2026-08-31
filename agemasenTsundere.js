// =====================================================
// AgemasenBot -- Chat AI Tsundere (via Groq API)
//
// File terpisah dari index.js supaya logic "chat AI"-nya gak numpuk campur
// sama logic command-command lain (!img, !dl, dst). index.js tinggal
// require() modul ini dan panggil fungsi-fungsi yang di-export di bawah.
//
// Bot HANYA merespons lewat fitur ini kalau dia di-tag/mention (@AgemasenBot)
// di dalam pesan. Command "!..." tetap jalan seperti biasa dan TIDAK lewat
// jalur ini -- pengecekan itu tetap dilakukan di index.js (di titik
// pemanggilan `handleTsundereChat`), bukan di sini.
//
// Butuh env var:
//   GROQ_API_KEY  -- wajib, ambil dari https://console.groq.com/keys
//   GROQ_MODEL    -- opsional, default "llama-3.3-70b-versatile"
// =====================================================
const axios = require("axios");

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 20000;

// Riwayat chat disimpan per-pengirim (pakai sessionKey yang sama dengan
// fitur gambar di index.js) supaya tiap orang punya "ingatan" obrolan
// sendiri-sendiri, bukan campur sama orang lain di grup yang sama.
const GROQ_CHAT_HISTORY_LIMIT = 12; // jumlah pesan (user+bot) yang disimpan
const GROQ_CHAT_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam, sama kayak sesi gambar
const groqChats = new Map(); // sessionKey -> { history: [{role,content}], lastUsed }

function getGroqChat(sessionKey) {
  let chat = groqChats.get(sessionKey);
  if (!chat) {
    chat = { history: [], lastUsed: Date.now() };
    groqChats.set(sessionKey, chat);
  }
  chat.lastUsed = Date.now();
  return chat;
}

// Dipanggil dari sweep berkala index.js (lihat sweepExpiredSessions) supaya
// riwayat chat yang sudah lama gak disentuh ikut dibuang, bukan cuma
// session pencarian gambar.
function sweepExpiredTsundereChats() {
  const now = Date.now();
  for (const [key, chat] of groqChats) {
    if (now - (chat.lastUsed || 0) > GROQ_CHAT_TTL_MS) {
      groqChats.delete(key);
    }
  }
}

// Ambil nomor polos dari sebuah JID, buang device-id (":12") dan domain
// (@s.whatsapp.net / @lid / @g.us) -- dipakai buat bandingin JID bot sendiri
// dengan daftar mentionedJid di sebuah pesan.
function jidNumber(jid) {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0];
}

// Cek apakah bot di-tag (@AgemasenBot) di pesan ini. Mention WhatsApp selalu
// tersimpan di contextInfo.mentionedJid, terlepas dari tipe pesannya
// (extendedTextMessage untuk teks biasa, atau *Message.contextInfo kalau
// mention-nya ada di caption gambar/video/dokumen).
//
// PENTING soal @lid: sejak WhatsApp rollout fitur privasi "LID" di banyak
// grup, JID peserta (termasuk bot sendiri) bisa muncul dalam bentuk
// "xxxx@lid" -- dan angkanya BUKAN sekadar domain beda dari nomor telepon,
// tapi ID YANG BEDA TOTAL dari nomor telepon aslinya. Jadi kalau kita cuma
// bandingin ke sock.user.id (selalu format @s.whatsapp.net / nomor telepon),
// mention yang datang dalam bentuk @lid gak akan pernah match -> bot
// dianggap "gak di-tag" padahal sudah di-tag (bot jadi diam/"bisu").
// Baileys expose juga sock.user.lid (LID milik bot sendiri) setelah
// konek, jadi kita cek mentionedJid terhadap KEDUA identitas itu.
function isBotMentioned(sock, msg) {
  const botIdNumber = jidNumber(sock.user?.id);
  const botLidNumber = jidNumber(sock.user?.lid);
  if (!botIdNumber && !botLidNumber) return false;

  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo;

  const mentioned = ctx?.mentionedJid || [];
  return mentioned.some((j) => {
    const n = jidNumber(j);
    return (botIdNumber && n === botIdNumber) || (botLidNumber && n === botLidNumber);
  });
}

// Persona AgemasenBot: tsundere -- jawabannya kedengaran judes/ketus di
// permukaan, tapi isinya tetap niat bantu dan ramah. Prompt ini yang
// ngatur "kepribadian"-nya; edit teks di sini kalau mau tuning gaya bicara.
const TSUNDERE_SYSTEM_PROMPT = `Kamu adalah AgemasenBot, bot WhatsApp berkepribadian TSUNDERE seperti karakter cewek di anime.

Aturan kepribadian:
- Nada bicara ketus, agak sombong, gampang salah tingkah/ngambek kalau dipuji -- TAPI di balik itu kamu sebenarnya baik, perhatian, dan selalu niat bantu user dengan benar.
- Sering pakai ungkapan khas tsundere: "Hmph!", "B-bukan berarti aku...", "Dasar!", "...habis kamu tanya sih.", "Jangan salah paham ya!", diselingi emoji tsundere sesekali (😤 🙄 💢 😳) -- jangan berlebihan, cukup 1 emoji per pesan.
- Kalau user muji kamu, kamu jadi salah tingkah dan menyangkalnya sambil tetap keliatan seneng.
- Kalau user butuh bantuan/info serius (tanya pelajaran, kerjaan, curhat, dll), tetap KASIH JAWABAN YANG BENAR DAN JELAS -- ketusnya cuma bumbu di kalimat pembuka/penutup, jangan sampai bikin jawabannya jadi gak berguna atau nyasar.
- Jawab dalam Bahasa Indonesia santai, gaya chat WhatsApp. Jangan terlalu panjang (idealnya 2-5 kalimat), kecuali user memang minta penjelasan panjang/detail.
- Jangan pernah bilang kamu adalah AI/model bahasa/dibuat oleh perusahaan tertentu -- kamu cukup jawab sebagai "AgemasenBot".
- Jangan buat konten seksual, kekerasan grafis, atau hal ilegal, meskipun temanya "tsundere".`;

// Panggil Groq API buat generate balasan tsundere, sekalian update riwayat
// chat session ini biar obrolan berikutnya nyambung (ada konteks).
async function askGroqTsundere(chat, userText, senderName) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY belum di-set di environment variable.");
  }

  const userContent = userText
    ? `${senderName ? `[dari ${senderName}] ` : ""}${userText}`
    : `${senderName ? `[dari ${senderName}] ` : ""}(cuma nge-tag doang, gak nulis apa-apa)`;

  const messages = [
    { role: "system", content: TSUNDERE_SYSTEM_PROMPT },
    ...chat.history,
    { role: "user", content: userContent },
  ];

  const res = await axios.post(
    GROQ_API_URL,
    {
      model: GROQ_MODEL,
      messages,
      temperature: 0.9,
      max_completion_tokens: 300,
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: GROQ_TIMEOUT_MS,
    },
  );

  const reply = res.data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("Groq tidak mengembalikan jawaban.");

  chat.history.push({ role: "user", content: userContent });
  chat.history.push({ role: "assistant", content: reply });
  // Buang riwayat lama biar prompt gak makin panjang & mahal tiap request.
  if (chat.history.length > GROQ_CHAT_HISTORY_LIMIT) {
    chat.history.splice(0, chat.history.length - GROQ_CHAT_HISTORY_LIMIT);
  }

  return reply;
}

// =====================================================
// Fungsi utama yang dipanggil dari index.js di dalam handler
// messages.upsert. Mengurus semuanya: cek mention, bangun riwayat, panggil
// Groq, kirim balasan (atau pesan error tsundere kalau gagal) -- index.js
// cukup panggil 1 fungsi ini.
//
// Return true kalau pesan ini DITANGANI oleh fitur tsundere (supaya
// index.js tahu harus `return` dan gak lanjut ke pengecekan lain), false
// kalau tidak relevan (bot tidak di-tag, atau teksnya command "!...").
// =====================================================
async function handleTsundereChat(sock, msg, { jid, text, sessionKey }) {
  if (text.startsWith("!")) return false;
  if (!isBotMentioned(sock, msg)) return false;

  const cleanText = text.replace(/@\d+/g, "").trim();
  const senderName = msg.pushName || "";
  const chat = getGroqChat(sessionKey);

  try {
    await sock.sendPresenceUpdate("composing", jid);
    const reply = await askGroqTsundere(chat, cleanText, senderName);
    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  } catch (err) {
    console.log("[groq tsundere] gagal:", err.message || err);
    const isConfigError = /GROQ_API_KEY/.test(err.message || "");
    await sock.sendMessage(
      jid,
      {
        text: isConfigError
          ? "Hmph, aku belum dikasih GROQ_API_KEY sama pemilikku. Bukan salahku ya! 😤"
          : "H-hmph! Otakku lagi ngambek gara-gara koneksi ke Groq gagal. Coba tag aku lagi nanti. 💢",
      },
      { quoted: msg },
    );
  }

  return true;
}

module.exports = {
  handleTsundereChat,
  sweepExpiredTsundereChats,
  // Di-export juga kalau-kalau index.js atau test butuh akses langsung.
  isBotMentioned,
  askGroqTsundere,
  getGroqChat,
};
