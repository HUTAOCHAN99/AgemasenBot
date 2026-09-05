const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { findMediaSource } = require("../media/detect");
const { ROOT_DIR } = require("../../config/env");

// =====================================================
// Fitur: AI Image Upscaler ("!hd") -- Real-ESRGAN LOKAL (ncnn-vulkan CLI),
// BUKAN API berbayar. Bisa dipakai lewat 3 cara: reply foto + "!hd",
// caption langsung "!hd" di fotonya, atau "!hd 2x" / "!hd 4x" buat pilih
// scale (default 2x kalau gak dikasih argumen).
//
// Alur: WhatsApp -> Baileys -> download media (downloadGifBuffer, dipakai
// bareng !meme/!smeme/!s karena memang generik) -> validasi & re-encode
// PNG lewat sharp -> tulis ke tmp/hd_<uid>_input.png -> spawn (BUKAN
// exec()! args selalu berupa array, jadi aman dari command injection
// walau isinya path/nama file yang "dikontrol" user secara tidak
// langsung) -> tmp/hd_<uid>_output.png -> baca balik -> sendMessage image
// -> semua file tmp dihapus di blok finally, termasuk kalau prosesnya
// gagal di tengah jalan.
//
// Concurrency dibatasi (default 1 proses barengan, lihat
// HD_QUEUE_CONCURRENCY) pola queue-nya sama persis kayak dlQueue punya
// "!dl" di atas -- biar CPU/RAM gak langsung penuh kalau banyak user
// pakai "!hd" bersamaan.
// =====================================================
const REALESRGAN_PATH =
  process.env.REALESRGAN_PATH || "./realesrgan/realesrgan-ncnn-vulkan";
const REALESRGAN_MODEL_DIR = process.env.REALESRGAN_MODEL_DIR || "./models";
// Model default buat foto/gambar umum. JANGAN auto-ganti ke model anime
// (RealESRGAN_x4plus_anime_6B) tanpa alasan -- kalau mau, ganti lewat env
// var ini secara manual/sengaja, biar gak ada kejutan hasil upscale yang
// beda dari ekspektasi user.
const REALESRGAN_MODEL_NAME =
  process.env.REALESRGAN_MODEL_NAME || "realesrgan-x4plus";
const REALESRGAN_DEFAULT_SCALE =
  Number(process.env.REALESRGAN_DEFAULT_SCALE) || 2;
const REALESRGAN_MAX_INPUT_MB = Number(process.env.REALESRGAN_MAX_INPUT_MB) || 10;
const REALESRGAN_MAX_OUTPUT_MB =
  Number(process.env.REALESRGAN_MAX_OUTPUT_MB) || 30;
// Batas sisi terpanjang HASIL upscale (bukan gambar aslinya) -- mis. foto
// 1500x1000 di-"!hd 4x" bakal jadi 6000x4000, kalau itu melebihi batas
// ini, ditolak DULU sebelum buang-buang CPU/RAM buat proses yang hasilnya
// bakal ditolak juga pas mau dikirim.
const REALESRGAN_MAX_OUTPUT_DIMENSION =
  Number(process.env.REALESRGAN_MAX_OUTPUT_DIMENSION) || 4000;
const REALESRGAN_TIMEOUT_MS =
  Number(process.env.REALESRGAN_TIMEOUT_MS) || 120000; // 2 menit
const HD_QUEUE_CONCURRENCY = Number(process.env.HD_QUEUE_CONCURRENCY) || 1;
const HD_TMP_DIR = process.env.HD_TMP_DIR || path.join(ROOT_DIR, "tmp");
// Mesin yang dipakai "!hd" -- default "sharp" (CATATAN Agustus 2026: binary
// Real-ESRGAN TIDAK ter-install di server ini -- nixpacks.toml cuma nyiapin
// yt-dlp, gak ada langkah download Real-ESRGAN -- jadi "!hd" pasti gagal
// "executable tidak ditemukan" kalau tetap dipaksa pakai realesrgan). Ganti
// ke "realesrgan" via env var HD_ENGINE cuma kalau binary + model-nya sudah
// beneran di-install manual di server.
const HD_ENGINE = (process.env.HD_ENGINE || "sharp").toLowerCase();

let hdActiveWorkers = 0;
const hdQueue = [];

function processHdQueue() {
  while (hdActiveWorkers < HD_QUEUE_CONCURRENCY && hdQueue.length > 0) {
    const job = hdQueue.shift();
    hdActiveWorkers++;
    job
      .jobFn()
      .then(job.resolve, job.reject)
      .finally(() => {
        hdActiveWorkers--;
        processHdQueue();
      });
  }
}

function enqueueHdJob(jobFn) {
  return new Promise((resolve, reject) => {
    hdQueue.push({ jobFn, resolve, reject });
    processHdQueue();
  });
}

function ensureHdTmpDir() {
  fs.mkdirSync(HD_TMP_DIR, { recursive: true });
}

// Cuma FOTO biasa (imageMessage, atau documentMessage bermime image/*
// selain gif) yang dianggap valid buat "!hd" -- BEDA dari isStaticSource
// (dipakai !smeme) yang juga nerima stiker WA. Stiker sengaja tidak
// didukung di sini karena ukurannya sudah kecil (512x512 WebP) dan hasil
// upscale-nya biasanya kurang berguna/rawan artefak dibanding foto biasa.
function isImageOnlySource(content) {
  if (!content) return false;
  if (content.imageMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("image/") && mime !== "image/gif";
  }

  return false;
}

function findImageSource(msg) {
  return findMediaSource(msg, isImageOnlySource);
}

// Parse argumen setelah "!hd": "" (default), "2x", atau "4x". Selain itu
// (termasuk mis. "8x") dianggap tidak valid.
function parseHdScaleArg(raw) {
  const arg = raw.trim().toLowerCase();

  if (arg === "") return { ok: true, scale: REALESRGAN_DEFAULT_SCALE };
  if (arg === "2x") return { ok: true, scale: 2 };
  if (arg === "4x") return { ok: true, scale: 4 };

  return { ok: false };
}

// Jalanin realesrgan-ncnn-vulkan sebagai child process TERPISAH lewat
// spawn() dengan args berbentuk ARRAY (bukan exec() dengan string yang
// digabung manual) -- ini yang bikin aman dari command injection, karena
// tiap elemen args diteruskan apa adanya ke OS, tidak pernah diinterpretasi
// ulang oleh shell.
function runRealEsrgan(args) {
  return new Promise((resolve, reject) => {
    let proc;

    try {
      proc = spawn(REALESRGAN_PATH, args);
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, REALESRGAN_TIMEOUT_MS);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `Real-ESRGAN executable tidak ditemukan di "${REALESRGAN_PATH}". ` +
              `Set env var REALESRGAN_PATH ke lokasi binary yang benar, atau ` +
              `install dulu (lihat dokumentasi "!hd").`,
          ),
        );
        return;
      }
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(`Real-ESRGAN timeout setelah ${REALESRGAN_TIMEOUT_MS}ms.`),
        );
        return;
      }

      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Real-ESRGAN keluar dengan kode ${code}\n${stderr.slice(-800)}`,
          ),
        );
      }
    });
  });
}

// Proses inti "!hd": buffer gambar input -> buffer gambar hasil upscale
// AI. Semua validasi (ukuran file, format/corrupt, dimensi hasil) DAN
// cleanup file tmp (finally, termasuk kalau gagal di tengah jalan)
// ditangani di sini, jadi handler command di messages.upsert cukup
// tangkap satu try/catch besar tanpa perlu tau detail internalnya.
async function upscaleImageWithRealEsrgan(inputBuffer, scale) {
  if (inputBuffer.length > REALESRGAN_MAX_INPUT_MB * 1024 * 1024) {
    throw new Error(
      `Ukuran gambar melebihi batas ${REALESRGAN_MAX_INPUT_MB}MB.`,
    );
  }

  // sharp otomatis melempar error kalau buffer-nya corrupt/bukan gambar
  // yang valid -- ini jadi validasi "gambar corrupt" sekaligus.
  let metadata;
  try {
    metadata = await sharp(inputBuffer).metadata();
  } catch {
    throw new Error("Gambar tidak valid atau corrupt.");
  }

  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error("Gagal membaca dimensi gambar.");
  }

  if (
    width * scale > REALESRGAN_MAX_OUTPUT_DIMENSION ||
    height * scale > REALESRGAN_MAX_OUTPUT_DIMENSION
  ) {
    throw new Error(
      `Resolusi hasil upscale (${width * scale}x${height * scale}) melebihi ` +
        `batas ${REALESRGAN_MAX_OUTPUT_DIMENSION}px. Coba gambar yang lebih ` +
        `kecil atau scale yang lebih rendah.`,
    );
  }

  // Selalu re-encode ke PNG lewat sharp dulu -- selain jadi format yang
  // pasti didukung realesrgan-ncnn-vulkan apa pun format aslinya (jpeg,
  // webp, dst), proses re-encode ini juga "membersihkan" struktur file
  // dari keanehan metadata sumber aslinya.
  const pngBuffer = await sharp(inputBuffer).png().toBuffer();

  ensureHdTmpDir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(HD_TMP_DIR, `hd_${uid}_input.png`);
  const outputPath = path.join(HD_TMP_DIR, `hd_${uid}_output.png`);

  fs.writeFileSync(inputPath, pngBuffer);

  try {
    const args = [
      "-i",
      inputPath,
      "-o",
      outputPath,
      "-s",
      String(scale),
      "-n",
      REALESRGAN_MODEL_NAME,
      "-m",
      REALESRGAN_MODEL_DIR,
    ];

    await runRealEsrgan(args);

    if (!fs.existsSync(outputPath)) {
      throw new Error(
        "File hasil upscale tidak ditemukan setelah proses selesai.",
      );
    }

    const outputBuffer = fs.readFileSync(outputPath);

    if (outputBuffer.length > REALESRGAN_MAX_OUTPUT_MB * 1024 * 1024) {
      throw new Error(
        `Hasil upscale melebihi batas ukuran ${REALESRGAN_MAX_OUTPUT_MB}MB.`,
      );
    }

    return outputBuffer;
  } finally {
    // Selalu bersihin, baik proses berhasil MAUPUN gagal.
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

function getHdActiveWorkers() {
  return hdActiveWorkers;
}

module.exports = {
  getHdActiveWorkers,
  REALESRGAN_MAX_INPUT_MB,
  REALESRGAN_MAX_OUTPUT_MB,
  REALESRGAN_MAX_OUTPUT_DIMENSION,
  HD_ENGINE,
  isImageOnlySource,
  findImageSource,
  parseHdScaleArg,
  runRealEsrgan,
  upscaleImageWithRealEsrgan,
  processHdQueue,
  enqueueHdJob,
  HD_QUEUE_CONCURRENCY,
};
