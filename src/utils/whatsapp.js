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
function getSessionKey(msg) {
  const jid = msg.key.remoteJid;
  const participant = msg.key.participant;
  return participant ? `${jid}::${participant}` : jid;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getSenderJid,
  isOwnerMsg,
  getSessionKey,
  sleep,
};
