const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { runFfmpeg } = require("./ffmpeg");
const { normalizeFfmpegInputBuffer, detectContentBoundingBox } = require("./detect");

// !togif: stiker ANIMASI -> video mp4 yang dikirim dengan flag
// `gifPlayback`, supaya WhatsApp nampilin & muter-loop-in kayak GIF asli
// (WhatsApp gak pernah kirim file .gif mentah, selalu mp4 + flag ini).
async function animatedStickerToGifVideo(buffer) {
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(tmpDir, `togif-in-${uid}`);
  const outputPath = path.join(tmpDir, `togif-out-${uid}.mp4`);

  // Deteksi border transparan dari frame ASLI (sebelum lewat konversi apa
  // pun) -- asumsinya border ini statis/sama persis di semua frame, karena
  // memang begitu cara kerja letterbox/pad (bordernya gak ikut geser-geser
  // pas animasi jalan).
  const bbox = await detectContentBoundingBox(buffer).catch((err) => {
    console.log("⚠️ Gagal deteksi bounding-box, lanjut tanpa crop:", err.message);
    return null;
  });

  // Stiker WA animasi selalu WebP, dan ffmpeg gak bisa decode WebP animasi
  // langsung (lihat catatan panjang di normalizeFfmpegInputBuffer), jadi
  // dikonversi dulu ke GIF pakai sharp sebelum masuk ffmpeg.
  const normalized = await normalizeFfmpegInputBuffer(buffer);
  fs.writeFileSync(inputPath, normalized);

  try {
    const filters = [];

    if (bbox) {
      filters.push(`crop=${bbox.width}:${bbox.height}:${bbox.x}:${bbox.y}`);
    }

    // Lebar/tinggi WAJIB genap buat yuv420p, makanya dibulatkan ke bawah
    // ke kelipatan 2 terdekat (biasanya sudah genap habis crop, ini cuma
    // jaga-jaga).
    filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");

    const args = [
      "-y",
      "-i",
      inputPath,
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      filters.join(","),
      "-an",
      outputPath,
    ];

    await runFfmpeg(args);

    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

// !toimg: stiker (statis, atau animasi -- kalau animasi cuma diambil
// frame pertamanya) -> buffer gambar PNG biasa. Sharp otomatis kasih
// frame pertama aja buat WebP animasi kalau {animated:true} gak di-set,
// jadi tidak perlu penanganan animasi/statis secara terpisah di sini.
// Border transparan (padding biar pas kanvas persegi stiker WA) juga
// di-crop dulu, supaya ukuran gambar yang keluar itu sesuai konten
// aslinya, bukan ukuran kanvas stiker yang dipaksa persegi.
async function stickerToImageBuffer(buffer) {
  const image = sharp(buffer).png();
  const bbox = await detectContentBoundingBox(buffer).catch(() => null);

  if (bbox) {
    image.extract({
      left: bbox.x,
      top: bbox.y,
      width: bbox.width,
      height: bbox.height,
    });
  }

  return image.toBuffer();
}

module.exports = {
  animatedStickerToGifVideo,
  stickerToImageBuffer,
};
