const sharp = require("sharp");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");

// =====================================================
// Vision (deteksi & download gambar buat dianalisis Groq)
//
// Gambar bisa datang dari 2 sumber:
//  1. Foto dikirim LANGSUNG dengan caption yang nge-tag bot
//     (msg.message.imageMessage, caption-nya juga sumber teks `text` yang
//     sudah diambil index.js).
//  2. User REPLY ke sebuah foto (punya bot, punya orang lain, hasil !img,
//     dll) sambil nulis pertanyaan yang nge-tag bot -- foto aslinya ada di
//     extendedTextMessage.contextInfo.quotedMessage.imageMessage.
// Pola ini sama seperti findMediaSource() di index.js (dipakai !smeme dkk),
// sengaja diduplikasi di sini (bukan di-import dari index.js) supaya file
// ini tetap berdiri sendiri tanpa circular require ke index.js.
function findImageForVision(msg) {
  if (msg.message?.imageMessage) {
    return { content: msg.message, refKey: msg.key };
  }

  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (quoted?.imageMessage) {
    return {
      content: quoted,
      refKey: {
        remoteJid: msg.key.remoteJid,
        id: ctx.stanzaId,
        participant: ctx.participant,
      },
    };
  }

  return null;
}

// Download gambar (lewat Baileys) lalu encode jadi data URI base64 --
// format persis yang diminta Groq buat image_url lokal
// (`data:<mimetype>;base64,<data>`, lihat console.groq.com/docs/vision).
//
// Sebelum di-base64, gambar di-resize/kompres dulu pakai sharp. Ini
// PENTING karena foto WhatsApp (apalagi kalau dikirim kualitas HD, atau
// hasil forward berkali-kali) bisa berukuran beberapa MB -- giliran
// dijadikan base64 ukurannya membengkak ~33% lagi, gampang nabrak batas
// ukuran request Groq (400/413) atau bikin request jadi lambat & gampang
// timeout. Resize ke maksimal 1568px di sisi terpanjang (cukup buat
// vision model "melihat" detail gambar dengan baik, sesuai rekomendasi
// umum vision API) + encode ulang ke JPEG kualitas 80 biasanya sudah
// cukup mengecilkan ukuran file drastis tanpa bikin gambar jadi jelek.
async function downloadImageAsDataUri({ content, refKey }) {
  const fakeMsg = { key: refKey, message: content };
  const rawBuffer = await downloadMediaMessage(fakeMsg, "buffer", {});

  try {
    const compressed = await sharp(rawBuffer)
      .rotate() // ikutin orientasi EXIF sebelum resize, biar gak kebalik
      .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${compressed.toString("base64")}`;
  } catch (err) {
    // Kalau gagal dikompres (format aneh, dsb), tetap coba kirim buffer
    // aslinya apa adanya daripada gagal total.
    console.log("[groq tsundere] gagal kompres gambar, pakai buffer asli:", err.message || err);
    const mimetype = content.imageMessage?.mimetype || "image/jpeg";
    return `data:${mimetype};base64,${rawBuffer.toString("base64")}`;
  }
}


module.exports = {
  findImageForVision,
  downloadImageAsDataUri,
};
