const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { runFfmpeg } = require("../features/media/ffmpeg");

// =====================================================
// Vision (deteksi & download gambar buat dianalisis Groq)
//
// Gambar/media visual bisa datang dari 4 sumber:
//  1. Foto dikirim LANGSUNG dengan caption yang nge-tag bot
//     (msg.message.imageMessage, caption-nya juga sumber teks `text` yang
//     sudah diambil index.js).
//  2. User REPLY ke sebuah foto (punya bot, punya orang lain, hasil !img,
//     dll) sambil nulis pertanyaan yang nge-tag bot -- foto aslinya ada di
//     extendedTextMessage.contextInfo.quotedMessage.imageMessage.
//  3. User REPLY ke sebuah STIKER (stickerMessage -- statis maupun
//     animasi) sambil nulis pertanyaan yang nge-tag bot, mis. "@bot ini
//     apaan". Stiker WA gak bisa dikirim sekaligus sama caption teks
//     (makanya gak ada kasus "stiker dikirim langsung + tag" kayak
//     imageMessage di poin 1), jadi jalur yang relevan cuma quoted-nya.
//     Format aslinya WebP -- ditangani belakangan pas download (sharp bisa
//     decode WebP langsung, termasuk ambil frame pertama kalau animasi).
//  4. "GIF" WhatsApp -- WA TIDAK PERNAH kirim file .gif asli, "GIF" yang
//     dikirim/diteruskan lewat WA itu SELALU video mp4 biasa dengan flag
//     `gifPlayback` (lihat juga catatan di sticker.js), jadi masuknya
//     sebagai videoMessage -- baik dikirim langsung dengan caption tag bot
//     maupun di-reply. Groq vision cuma nerima GAMBAR DIAM (bukan video),
//     jadi videoMessage ditangani beda: bukan didownload+kompres langsung
//     kayak foto/stiker, tapi diambil SATU frame representatifnya dulu
//     lewat ffmpeg (lihat extractVideoFrameAsDataUri) baru itu yang
//     dikirim ke Groq -- bot "lihat" 1 momen dari GIF/video-nya, bukan
//     seluruh gerakannya.
// Pola ini sama seperti findMediaSource() di index.js (dipakai !smeme dkk),
// sengaja diduplikasi di sini (bukan di-import dari index.js) supaya file
// ini tetap berdiri sendiri tanpa circular require ke index.js.
function findImageForVision(msg) {
  if (msg.message?.imageMessage) {
    return { content: msg.message, refKey: msg.key };
  }

  // Stiker dikirim langsung TANPA tag (WA gak izinin caption di stiker),
  // jadi ini praktiknya gak akan pernah lolos cek mention -- tetap
  // ditangani di sini biar konsisten sama imageMessage & buat jaga-jaga
  // kalau suatu saat ada jalur mention lain (mis. forward).
  if (msg.message?.stickerMessage) {
    return { content: msg.message, refKey: msg.key };
  }

  // GIF/video dikirim langsung dengan caption tag bot.
  if (msg.message?.videoMessage) {
    return { content: msg.message, refKey: msg.key };
  }

  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (quoted?.imageMessage || quoted?.stickerMessage || quoted?.videoMessage) {
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

// Download video/GIF (lewat Baileys), ambil SATU frame representatif
// pakai ffmpeg (filter "thumbnail" -- otomatis milih frame yang paling
// "mewakili" dari beberapa kandidat, bukan asal frame pertama yang kadang
// masih hitam/transisi), lalu encode ke JPEG. File sementara ditulis ke
// tmpdir lalu dihapus lagi di finally, sama persis polanya kayak
// animatedStickerToGifVideo di features/media/sticker.js.
async function extractVideoFrameAsDataUri({ content, refKey }) {
  const fakeMsg = { key: refKey, message: content };
  const rawBuffer = await downloadMediaMessage(fakeMsg, "buffer", {});

  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(tmpDir, `vision-in-${uid}.mp4`);
  const outputPath = path.join(tmpDir, `vision-out-${uid}.jpg`);
  fs.writeFileSync(inputPath, rawBuffer);

  try {
    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      "thumbnail,scale=1568:1568:force_original_aspect_ratio=decrease",
      "-frames:v",
      "1",
      "-update",
      "1",
      outputPath,
    ]);
    const frameBuffer = fs.readFileSync(outputPath);
    return `data:image/jpeg;base64,${frameBuffer.toString("base64")}`;
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
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
//
// Stiker WA formatnya WebP (statis maupun animasi) -- sharp/libvips bisa
// decode WebP langsung tanpa opsi tambahan, dan SENGAJA TIDAK dipanggil
// dengan `{ animated: true }` di sini: tanpa opsi itu, sharp otomatis cuma
// ambil frame PERTAMA dari WebP animasi, yang pas buat kebutuhan vision
// (cukup 1 snapshot gambar diam, bukan seluruh animasinya).
async function downloadImageAsDataUri({ content, refKey }) {
  // Video/"GIF" -> jalur beda total (ffmpeg ambil 1 frame dulu), lihat
  // catatan panjang di extractVideoFrameAsDataUri soal kenapa.
  if (content.videoMessage) {
    return extractVideoFrameAsDataUri({ content, refKey });
  }

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
    const mimetype =
      content.imageMessage?.mimetype || content.stickerMessage?.mimetype || "image/jpeg";
    return `data:${mimetype};base64,${rawBuffer.toString("base64")}`;
  }
}


module.exports = {
  findImageForVision,
  downloadImageAsDataUri,
};
