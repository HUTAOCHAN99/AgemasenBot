const sharp = require("sharp");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");


// Ambil buffer media dari sebuah "message content" (msg.message ATAU
// contextInfo.quotedMessage). Dipecah jadi dua kategori karena sekarang
// !meme (GIF/video) dan !smeme (stiker/foto) sengaja dipisah sumbernya:
//
// - "animated": GIF/video (videoMessage, documentMessage bertipe video/*
//   atau image/gif) -> dipakai !meme.
// - "static": stiker WA / "emote" (stickerMessage, statis maupun animasi)
//   dan foto biasa (imageMessage, documentMessage bertipe image/* selain
//   gif) -> dipakai !smeme.
//
// ffmpeg otomatis bisa nangani baik input berupa gambar diam (hasilnya 1
// frame) maupun animasi (banyak frame) lewat filter yang sama, jadi tidak
// perlu penanganan khusus di ffmpeg-nya sendiri, cuma di deteksi sumbernya.
// Baileys' downloadMediaMessage butuh objek berbentuk { key, message }.
function isAnimatedSource(content) {
  if (!content) return false;

  if (content.videoMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("video/") || mime === "image/gif";
  }

  return false;
}

function isStaticSource(content) {
  if (!content) return false;

  if (content.stickerMessage) return true;
  if (content.imageMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("image/") && mime !== "image/gif";
  }

  return false;
}

function isAnyMediaSource(content) {
  return isAnimatedSource(content) || isStaticSource(content);
}

// Dokumen PDF (dipakai !ringkas) -- HANYA documentMessage bermime
// application/pdf. Beda jalur dari isStaticSource/isAnimatedSource di
// atas (yang khusus stiker/meme), karena PDF bukan media visual.
function isPdfSource(content) {
  if (!content) return false;
  if (!content.documentMessage) return false;
  const mime = content.documentMessage.mimetype || "";
  return mime === "application/pdf";
}

// PENTING: apakah medianya cuma 1 frame (gambar diam)?
// Filter ffmpeg "fps=12" (dipakai bareng "-fps_mode cfr") butuh minimal 2
// frame buat bisa nentuin durasi/timing antar-frame. Kalau sumbernya cuma
// SATU frame (foto biasa, atau stiker WA yang statis/bukan animasi), filter
// "fps=12" itu malah gagal ngeluarin frame sama sekali -> file output jadi
// kosong (0 byte) dan dikirim sebagai stiker rusak ("Sticker with no
// label" di WhatsApp). Makanya sebelum bikin stiker, kita cek dulu: kalau
// medianya "still" (gambar diam), filter "fps=12" di-skip total di
// gifToTextSticker/mediaToSticker.
function isStillMedia(content) {
  if (!content) return false;

  if (content.stickerMessage) return !content.stickerMessage.isAnimated;
  if (content.imageMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("image/") && mime !== "image/gif";
  }

  return false; // videoMessage, dokumen video/gif -> selalu dianggap stream, bukan still
}

async function downloadGifBuffer(content, refKey) {
  const fakeMsg = {
    key: refKey,
    message: content,
  };

  return downloadMediaMessage(fakeMsg, "buffer", {});
}

// Cari konten media dari pesan masuk: bisa dari pesan itu sendiri
// (caption langsung di medianya), atau dari pesan yang di-reply (quoted).
// `matcher` menentukan jenis media apa yang dianggap valid buat command
// yang lagi diproses (lihat isAnimatedSource / isStaticSource / isAnyMediaSource).
function findMediaSource(msg, matcher) {
  const jid = msg.key.remoteJid;

  if (matcher(msg.message)) {
    return { content: msg.message, refKey: msg.key };
  }

  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;

  if (quoted && matcher(quoted)) {
    return {
      content: quoted,
      refKey: {
        remoteJid: jid,
        id: ctx.stanzaId,
        participant: ctx.participant,
      },
    };
  }

  return null;
}

// Alias biar kode lama yang manggil findGifSource tetap jalan -> khusus
// GIF/video (dipakai !meme).
function findGifSource(msg) {
  return findMediaSource(msg, isAnimatedSource);
}

// Khusus stiker/foto (dipakai !smeme).
function findStickerSource(msg) {
  return findMediaSource(msg, isStaticSource);
}

// Semua jenis media (dipakai !s, karena !s memang generik).
function findAnySource(msg) {
  return findMediaSource(msg, isAnyMediaSource);
}

// Dokumen PDF (dipakai !ringkas).
function findPdfSource(msg) {
  return findMediaSource(msg, isPdfSource);
}

// ffmpeg (termasuk build "ffmpeg-static" yang dipakai bot ini) BISA encode
// WebP animasi (dipakai buat OUTPUT stiker), tapi decoder bawaannya TIDAK
// bisa baca WebP animasi sebagai INPUT (cuma baca frame pertama atau
// langsung gagal total dengan "Invalid data found when processing input").
// Stiker WA (baik yang dikirim user maupun quoted/reply) formatnya WebP,
// dan yang animasi otomatis bikin ffmpeg gagal proses -> "Gagal membuat
// stiker" walau teksnya sudah benar. Makanya sebelum masuk ffmpeg, WebP
// animasi dideteksi & dikonversi dulu ke GIF pakai sharp/libvips (yang
// decode WebP animasinya beres). Stiker statis & GIF/video biasa tidak
// kena ini sama sekali, langsung lewat jalur lama seperti biasa.
function isAnimatedWebpBuffer(buffer) {
  if (!buffer || buffer.length < 16) return false;

  const isRiffWebp =
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP";

  if (!isRiffWebp) return false;

  // WebP animasi selalu punya chunk "ANIM" (beda dari WebP statis biasa).
  return buffer.includes(Buffer.from("ANIM"));
}

// Konversi buffer WebP animasi -> buffer GIF animasi (frame & timing tetap
// terjaga), supaya bisa dipakai sebagai input ffmpeg seperti GIF biasa.
async function normalizeFfmpegInputBuffer(buffer) {
  if (!isAnimatedWebpBuffer(buffer)) return buffer;

  try {
    return await sharp(buffer, { animated: true }).gif().toBuffer();
  } catch (err) {
    console.log(
      "⚠️ Gagal convert stiker WebP animasi ke GIF, coba pakai buffer asli:",
      err.message,
    );
    return buffer;
  }
}

// Khusus stiker WA (BEDA dari findStickerSource yang generik, nerima
// stiker ATAUPUN foto -- dipakai !smeme). !togif dan !toimg maunya emang
// spesifik dari stiker, jadi foto/GIF/video yang di-reply sengaja tidak
// dianggap valid di sini.
function isStickerOnlySource(content) {
  return !!(content && content.stickerMessage);
}

function findStickerOnlySource(msg) {
  return findMediaSource(msg, isStickerOnlySource);
}

// Stiker yang aslinya bukan rasio 1:1 (mis. dibikin lewat !s/!meme/!smeme
// dari foto/video non-persegi) disimpan dengan border TRANSPARAN biar pas
// jadi kanvas 512x512 (syarat stiker WA). Masalahnya: MP4 (dipakai buat
// "GIF" WhatsApp lewat gifPlayback) TIDAK support transparansi -- begitu
// di-flatten, border transparan itu otomatis diisi warna solid (biasanya
// PUTIH) oleh ffmpeg, jadi hasilnya kelihatan ada "ruang putih" gak sesuai
// ukuran konten aslinya. Fungsi ini deteksi bounding-box area yang BENERAN
// kelihatan (alpha > threshold) dari 1 frame representatif, supaya nanti
// bisa di-crop dulu sebelum alpha-nya dibuang -- hasilnya pas ukuran
// konten aslinya, gak ada sisa border putih.
async function detectContentBoundingBox(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const ALPHA_THRESHOLD = 10; // toleransi noise kompresi di pinggir gambar

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + (channels - 1)];
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null; // semua transparan, aneh -> skip

  // Konten sudah memenuhi seluruh kanvas (gak ada border) -> gak perlu crop.
  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) {
    return null;
  }

  let cropW = maxX - minX + 1;
  let cropH = maxY - minY + 1;

  // Lebar/tinggi wajib genap buat yuv420p.
  if (cropW % 2 !== 0) cropW = Math.min(width - minX, cropW + 1);
  if (cropH % 2 !== 0) cropH = Math.min(height - minY, cropH + 1);

  return { x: minX, y: minY, width: cropW, height: cropH };
}

module.exports = {
  isAnimatedSource,
  isStaticSource,
  isAnyMediaSource,
  isPdfSource,
  isStillMedia,
  downloadGifBuffer,
  findMediaSource,
  findGifSource,
  findStickerSource,
  findAnySource,
  findPdfSource,
  isAnimatedWebpBuffer,
  normalizeFfmpegInputBuffer,
  isStickerOnlySource,
  findStickerOnlySource,
  detectContentBoundingBox,
};
