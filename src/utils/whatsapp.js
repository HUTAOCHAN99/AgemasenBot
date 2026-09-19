const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const { OWNER_JID } = require("../config/env");

// Ambil jid pengirim ASLI (bukan jid chat) -- di grup itu participant,
// di chat pribadi ya remoteJid itu sendiri.
//
// PENTING soal @lid: WhatsApp sekarang bisa ngirim jid pengirim dalam
// bentuk "xxxxx@lid" (Linked ID / identitas tersembunyi) bukan
// "nomor@s.whatsapp.net", tergantung setting privasi pengirimnya --
// walaupun itu beneran nomor yang sama. Baileys nyediain field
// participantPn (di grup) / senderPn (di chat pribadi) yang isinya
// SELALU jid berbasis nomor telepon asli, jadi itu yang diprioritaskan
// biar perbandingan ke OWNER_JID gak meleset gara-gara @lid.
function getSenderJid(msg) {
  const raw =
    msg.key.participantPn ||
    msg.key.participant ||
    msg.key.senderPn ||
    msg.key.remoteJid;
  if (!raw) return null;
  try {
    return jidNormalizedUser(raw);
  } catch {
    return raw.split(":")[0];
  }
}

function isOwnerMsg(msg) {
  if (!OWNER_JID) return false;
  const sender = getSenderJid(msg);
  return sender === OWNER_JID;
}

// Kunci session unik per pengirim asli.
// Di chat pribadi: remoteJid sudah unik per orang.
// Di grup: remoteJid sama untuk semua anggota, jadi wajib digabung
// dengan participant supaya 2 orang di grup yang sama tidak bentrok.
//
// Dipakai buat fitur-fitur yang memang harus PRIVAT per orang (mis. sesi
// pencarian gambar !img / !pin -- kalau 2 orang di grup yang sama lagi
// nyari kata kunci beda-beda barengan, jangan sampai nyampur).
function getSessionKey(msg) {
  const jid = msg.key.remoteJid;
  const participant = msg.key.participant;
  return participant ? `${jid}::${participant}` : jid;
}

// Kunci session buat obrolan AI tsundere (chatSession.js / agemasenTsundere.js)
// -- SENGAJA beda dari getSessionKey biasa di atas.
//
// Dulu obrolan tsundere pakai getSessionKey (per jid::participant), jadi tiap
// orang di grup punya riwayat & "reply-thread" sendiri-sendiri ke bot --
// akibatnya cuma orang yang ASLI nge-tag bot yang bisa lanjut ngobrol lewat
// reply; orang lain di grup yang ikut reply ke pesan bot yang sama gak
// nyambung ke obrolan itu (dianggap sesi baru/kosong).
//
// Sekarang: di GRUP, kunci sesinya cukup remoteJid (jadi SATU obrolan
// bersama buat seluruh grup) -- supaya siapa pun anggota grup bisa reply ke
// balasan bot manapun (punya orang lain sekalipun) dan tetap nyambung ke
// riwayat yang sama, ngobrol bareng-bareng kayak grup chat beneran. Di chat
// pribadi tetap sama seperti biasa (remoteJid = lawan bicara itu sendiri).
function getTsundereSessionKey(msg) {
  return msg.key.remoteJid;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getSenderJid,
  isOwnerMsg,
  getSessionKey,
  getTsundereSessionKey,
  sleep,
};
