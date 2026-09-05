const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

function probeVideoDimensions(inputPath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-i", inputPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      // Contoh baris yang mau ditangkap:
      // "Stream #0:0: Video: gif, bgra, 480x270, ..."
      const match = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!match) return resolve(null);
      resolve({
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10),
      });
    });
  });
}

// Hitung MarginV (jarak dari tepi atas/bawah kanvas 512x512) yang aman
// dipakai, berdasarkan ukuran asli video/GIF. Selalu memberi margin minimum
// (MIN_MARGIN) walau videonya kebetulan pas 1:1 (tidak ada bar transparan),
// dan menambah margin ekstra sebesar bar transparan + jarak aman kalau video
// landscape/portrait menyebabkan letterboxing vertikal.
function computeSafeMargins(srcDims) {
  const CANVAS = 512;
  const MIN_MARGIN = 20; // margin dasar biar teks tetap enak dilihat, tidak nempel tepi
  const SAFE_GAP_TOP = 20; // jarak ekstra dari batas area transparan buat teks atas
  const SAFE_GAP_BOTTOM = 25; // jarak ekstra dari batas area transparan buat teks bawah

  if (!srcDims || !srcDims.width || !srcDims.height) {
    // Gagal deteksi ukuran -> fallback ke margin aman generik.
    return {
      top: MIN_MARGIN + SAFE_GAP_TOP,
      bottom: MIN_MARGIN + SAFE_GAP_BOTTOM,
    };
  }

  const scale = Math.min(CANVAS / srcDims.width, CANVAS / srcDims.height);
  const scaledHeight = srcDims.height * scale;
  // Setengah dari total bar transparan atas+bawah (pad simetris di tengah).
  const verticalPad = Math.max(0, Math.round((CANVAS - scaledHeight) / 2));

  return {
    top: Math.max(MIN_MARGIN, verticalPad + SAFE_GAP_TOP),
    bottom: Math.max(MIN_MARGIN, verticalPad + SAFE_GAP_BOTTOM),
  };
}

// Jalankan ffmpeg dan tunggu sampai selesai.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg keluar dengan kode ${code}\n${stderr.slice(-800)}`),
        );
    });
  });
}

// WhatsApp punya batas ukuran ketat buat stiker WEBP -- animasi maksimal
// sekitar 500KB. Lewat dari situ, WA nolak KIRIM ULANG/forward stiker itu
// dengan pesan "can't send this sticker because it's too large", dan bahkan
// SEBELUM ditolak pun animasinya sering cuma tampil diam (frame pertama
// doang) pas pertama kali diterima -- persis gejala yang kelihatan dari
// bot ini. ffmpeg dengan "-preset default" tanpa "-quality" di-set (default
// 75) dan tanpa batas ukuran sama sekali gampang ngasilin file di atas itu
// buat GIF sumber yang lumayan panjang/detail.
const STICKER_MAX_BYTES = 500 * 1024;

// Tangga kualitas buat stiker ANIMASI: dicoba dari kualitas terbaik dulu,
// makin turun (quality, fps, dan durasi maksimal dipangkas bareng) sampai
// hasilnya muat di bawah STICKER_MAX_BYTES. Stiker STATIS (isStill) jarang
// sekali kebesaran (cuma 1 frame), jadi cukup 1 percobaan kualitas tinggi.
//
// PENTING soal `size`: sebelum ini, tangga cuma pernah menurunkan
// quality/fps/duration -- resolusi kontennya SELALU dipatok 512 (baru
// di-pad transparan ke kanvas 512x512, itu wajib format WA). Masalahnya,
// itu bukan jaminan hasil akhirnya <= STICKER_MAX_BYTES: kalau GIF sumber
// sudah "pas-pasan" (baru muat di tangga PALING BAWAH), nambahin overlay
// teks lewat !meme/!smeme bisa nambah ~40-50% ukuran (teks = informasi
// visual baru yang beneran makan bit), dan waktu itu terjadi TIDAK ADA
// tangga lagi buat diturunin -> hasil akhirnya nyeberang batas WA, animasi
// gagal/keliatan cuma diam pas pertama diterima ("meledak"). Makanya 2
// tangga darurat terakhir sengaja nambah `size` (konten diskalakan ke
// kotak lebih kecil SEBELUM di-pad ke kanvas 512x512 yang tetap wajib) --
// ini lever terakhir yang belum kepake, dan paling ampuh nurunin ukuran
// karena langsung motong jumlah piksel yang perlu di-encode tiap frame.
const ANIMATED_QUALITY_LADDER = [
  { quality: 75, fps: 12, duration: 10, size: 512 },
  { quality: 60, fps: 10, duration: 8, size: 512 },
  { quality: 45, fps: 10, duration: 6, size: 512 },
  { quality: 35, fps: 8, duration: 5, size: 512 },
  { quality: 25, fps: 8, duration: 4, size: 512 },
  { quality: 25, fps: 8, duration: 4, size: 400 }, // darurat: konten diperkecil
  { quality: 20, fps: 6, duration: 3, size: 320 }, // darurat terakhir
];
// Tangga kualitas buat stiker STATIS (isStill). Beda dari animasi: nomor 1
// (quality 90, size 512) cukup buat 99% kasus karena cuma 1 frame. TAPI ada
// jaring pengaman 2 tangga tambahan di bawahnya (size diperkecil) buat
// jaga-jaga kalau kontennya salah kedeteksi "still" padahal sebenarnya
// ANIMASI (mis. gara-gara flag isAnimated gak keisi -- lihat komentar di
// pemanggil sock.sendMessage({sticker,...}) soal ini). Kalau itu terjadi,
// TANPA jaring pengaman ini hasilnya bisa jauh di atas limit WA karena
// filter fps/durasi juga di-skip total buat jalur "still" (lihat
// buildArgs di gifToTextSticker/mediaToSticker).
const STILL_QUALITY_LADDER = [
  { quality: 90, fps: null, duration: null, size: 512 },
  { quality: 75, fps: null, duration: null, size: 400 },
  { quality: 60, fps: null, duration: null, size: 320 },
];

// `buildArgs(step)` harus mengembalikan array argumen ffmpeg lengkap untuk
// satu percobaan encode, memakai `step.quality` / `step.fps` /
// `step.duration`. Dipanggil berulang dengan step yang makin "murah" dari
// tangga kualitas sampai file outputnya <= STICKER_MAX_BYTES, atau sampai
// tangganya habis (dalam hal itu, hasil terkecil yang didapat tetap
// dikembalikan -- mendingan dikirim & mungkin gagal daripada bot diam).
async function runFfmpegUnderSizeLimit(buildArgs, outputPath, isStill) {
  const ladder = isStill ? STILL_QUALITY_LADDER : ANIMATED_QUALITY_LADDER;
  let buffer = null;

  for (let i = 0; i < ladder.length; i++) {
    const step = ladder[i];
    await runFfmpeg(buildArgs(step));
    buffer = fs.readFileSync(outputPath);

    if (buffer.length <= STICKER_MAX_BYTES) return buffer;

    const isLastStep = i === ladder.length - 1;
    console.log(
      `⚠️ [tangga ${i + 1}/${ladder.length}: q=${step.quality} fps=${step.fps ?? "-"} dur=${step.duration ?? "-"}s size=${step.size || 512}] ` +
        `Stiker ${Math.round(buffer.length / 1024)}KB > batas WA (~${STICKER_MAX_BYTES / 1024}KB)` +
        (isLastStep
          ? ", sudah di kualitas paling rendah, tetap dikirim apa adanya."
          : ", coba render ulang dengan kualitas lebih rendah..."),
    );
  }

  return buffer;
}

module.exports = {
  probeVideoDimensions,
  computeSafeMargins,
  runFfmpeg,
  runFfmpegUnderSizeLimit,
  STICKER_MAX_BYTES,
  ANIMATED_QUALITY_LADDER,
  STILL_QUALITY_LADDER,
};
