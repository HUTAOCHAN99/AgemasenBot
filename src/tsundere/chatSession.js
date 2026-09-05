const fs = require("fs");
const path = require("path");
const { ROOT_DIR } = require("../config/env");

const GROQ_CHAT_HISTORY_LIMIT = Number(process.env.GROQ_MAX_HISTORY_MESSAGES) || 12;
const GROQ_CHAT_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam, sama kayak sesi gambar

const groqChats = new Map(); // sessionKey -> { history, lastUsed, sentMsgIds }

// Berapa banyak ID pesan balasan bot yang diingat per sesi -- dipakai buat
// deteksi "user reply ke pesan bot" (lihat isReplyToBotMessage). Gak perlu
// banyak-banyak, cukup nampung beberapa balasan terakhir.
const SENT_MSG_ID_LIMIT = 20;

const DATA_DIR = path.join(ROOT_DIR, "data");
const HISTORY_FILE =
  process.env.GROQ_HISTORY_FILE || path.join(DATA_DIR, "tsundere_history.json");
const SAVE_DEBOUNCE_MS = 3000;
let saveTimer = null;

function loadHistoryFromDisk() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    for (const [key, chat] of Object.entries(parsed)) {
      groqChats.set(key, {
        history: Array.isArray(chat.history) ? chat.history : [],
        lastUsed: chat.lastUsed || Date.now(),
        sentMsgIds: Array.isArray(chat.sentMsgIds) ? chat.sentMsgIds : [],
        // Konteks dokumen PDF (dari !ringkas) -- ikut dipulihkan dari disk
        // supaya "ingatan" dokumennya gak hilang kalau bot restart di
        // tengah window DOC_CONTEXT_TTL_MS. Divalidasi bentuknya dulu biar
        // gak crash kalau file lama (sebelum fitur ini ada) gak punya field
        // ini sama sekali.
        documentContext:
          chat.documentContext && typeof chat.documentContext.text === "string"
            ? chat.documentContext
            : null,
      });
    }
    console.log(
      `[groq tsundere] riwayat chat dimuat dari disk (${groqChats.size} sesi).`,
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log("[groq tsundere] gagal load riwayat dari disk:", err.message);
    }
    // File belum ada (ENOENT) itu normal buat first run -- gak perlu log error.
  }
}

function writeHistoryToDiskNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const plain = Object.fromEntries(groqChats);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(plain), "utf8");
  } catch (err) {
    console.log("[groq tsundere] gagal simpan riwayat ke disk:", err.message);
  }
}

// Debounce: kalau ada banyak pesan numpuk dalam waktu dekat, gak perlu
// nulis file tiap kali -- cukup tulis sekali beberapa detik setelah
// perubahan TERAKHIR berhenti.
function scheduleSaveHistory() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeHistoryToDiskNow, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

// Pastikan riwayat sempat ke-flush ke disk kalau proses dimatikan (mis.
// Railway restart/redeploy yang ngirim SIGTERM), bukan cuma pas debounce
// timer kebetulan sempat jalan.
function flushHistoryOnExit() {
  if (saveTimer) clearTimeout(saveTimer);
  writeHistoryToDiskNow();
}
process.on("SIGTERM", flushHistoryOnExit);
process.on("SIGINT", flushHistoryOnExit);

loadHistoryFromDisk();

function getGroqChat(sessionKey) {
  let chat = groqChats.get(sessionKey);
  if (!chat) {
    chat = { history: [], lastUsed: Date.now(), sentMsgIds: [], documentContext: null };
    groqChats.set(sessionKey, chat);
  }
  chat.lastUsed = Date.now();
  return chat;
}

// Buang riwayat obrolan 1 sesi (dipanggil dari command "!lupain" di
// index.js). Return true kalau memang ada yang dibuang, false kalau sesi
// itu memang belum punya riwayat sama sekali.
function forgetGroqChat(sessionKey) {
  const had = groqChats.delete(sessionKey);
  if (had) scheduleSaveHistory();
  return had;
}

// Dipanggil dari sweep berkala index.js (lihat sweepExpiredSessions) supaya
// riwayat chat yang sudah lama gak disentuh ikut dibuang, bukan cuma
// session pencarian gambar.
function sweepExpiredTsundereChats() {
  const now = Date.now();
  let changed = false;
  for (const [key, chat] of groqChats) {
    if (now - (chat.lastUsed || 0) > GROQ_CHAT_TTL_MS) {
      groqChats.delete(key);
      changed = true;
    }
  }
  if (changed) scheduleSaveHistory();
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

// Cek apakah pesan ini adalah REPLY ke salah satu balasan tsundere
// SEBELUMNYA dari bot di sesi (sessionKey) yang sama. Ini yang bikin
// obrolan bisa "dilanjut" cuma dengan reply -- gak wajib nge-tag bot lagi
// tiap kali mau lanjut ngobrol, selama masih reply ke pesan bot.
//
// Dicek lewat ctx.stanzaId (ID pesan yang di-reply) dibandingkan sama
// daftar ID pesan yang PERNAH dikirim bot buat sesi ini (chat.sentMsgIds,
// lihat rememberSentMsgId). Pola ini sama seperti yang dipakai buat
// "kode sesi" (!next / promptMsgId) di index.js.
function isReplyToBotMessage(chat, msg) {
  if (!chat || !chat.sentMsgIds?.length) return false;

  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo;

  const stanzaId = ctx?.stanzaId;
  if (!stanzaId) return false;

  return chat.sentMsgIds.includes(stanzaId);
}

// Simpan ID pesan balasan tsundere yang baru dikirim, biar bisa dideteksi
// nanti kalau user reply ke pesan itu (lihat isReplyToBotMessage). Cuma
// nyimpen beberapa ID terakhir (SENT_MSG_ID_LIMIT) supaya gak numpuk terus.
function rememberSentMsgId(chat, msgId) {
  if (!msgId) return;
  chat.sentMsgIds = chat.sentMsgIds || [];
  chat.sentMsgIds.push(msgId);
  if (chat.sentMsgIds.length > SENT_MSG_ID_LIMIT) {
    chat.sentMsgIds.splice(0, chat.sentMsgIds.length - SENT_MSG_ID_LIMIT);
  }
}

module.exports = {
  GROQ_CHAT_HISTORY_LIMIT,
  GROQ_CHAT_TTL_MS,
  groqChats,
  getGroqChat,
  forgetGroqChat,
  sweepExpiredTsundereChats,
  jidNumber,
  isBotMentioned,
  isReplyToBotMessage,
  rememberSentMsgId,
  scheduleSaveHistory,
};
