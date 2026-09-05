const sharp = require("sharp");
const {
  REALESRGAN_MAX_INPUT_MB,
  REALESRGAN_MAX_OUTPUT_MB,
  REALESRGAN_MAX_OUTPUT_DIMENSION,
} = require("./realesrgan");

// =====================================================
// Mesin "sharp" -- fallback tanpa Real-ESRGAN (ditambahkan Agustus 2026)
// -----------------------------------------------------
// Real-ESRGAN (ncnn-vulkan) butuh binary + file model terpisah yang berat
// buat di-setup di Railway (apalagi tanpa GPU/Vulkan) -- makanya "!hd"
// selalu gagal "executable tidak ditemukan". Jalur ini pakai "sharp" yang
// SUDAH jadi dependency project ini, TANPA proses/binary eksternal apa pun:
// lebar & tinggi gambar dikali scale yang PERSIS SAMA (jadi rasio/bentuk
// gambar aslinya tetap terjaga, gak ada distorsi), lalu ditajamkan pakai
// filter sharpen biar hasilnya gak blur.
//
// Ini BUKAN AI super resolution beneran (gak "mengarang" detail baru kayak
// Real-ESRGAN) -- cuma resize berkualitas tinggi + penajaman biasa. Tapi
// itu sudah cukup buat kebutuhan "yang penting gak blur" tanpa install
// apa pun tambahan. Validasi ukuran file & batas dimensi hasil TETAP sama
// persis kayak jalur Real-ESRGAN, biar konsisten.
// =====================================================
async function upscaleImageWithSharp(inputBuffer, scale) {
  if (inputBuffer.length > REALESRGAN_MAX_INPUT_MB * 1024 * 1024) {
    throw new Error(
      `Ukuran gambar melebihi batas ${REALESRGAN_MAX_INPUT_MB}MB.`,
    );
  }

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

  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);

  if (
    targetWidth > REALESRGAN_MAX_OUTPUT_DIMENSION ||
    targetHeight > REALESRGAN_MAX_OUTPUT_DIMENSION
  ) {
    throw new Error(
      `Resolusi hasil upscale (${targetWidth}x${targetHeight}) melebihi ` +
        `batas ${REALESRGAN_MAX_OUTPUT_DIMENSION}px. Coba gambar yang lebih ` +
        `kecil atau scale yang lebih rendah.`,
    );
  }

  const outputBuffer = await sharp(inputBuffer)
    .resize(targetWidth, targetHeight, {
      fit: "fill", // target sudah proporsional (dikali scale yang sama), jadi aman
      kernel: sharp.kernel.lanczos3, // kernel resize paling tajam yang didukung sharp
    })
    .sharpen({ sigma: 1.2 }) // penajaman tambahan biar hasil upscale gak keliatan blur
    .png()
    .toBuffer();

  if (outputBuffer.length > REALESRGAN_MAX_OUTPUT_MB * 1024 * 1024) {
    throw new Error(
      `Hasil upscale melebihi batas ukuran ${REALESRGAN_MAX_OUTPUT_MB}MB.`,
    );
  }

  return outputBuffer;
}

// teks bisa "atas|bawah" (dua baris) atau cuma "teks" (satu baris di bawah)

module.exports = {
  upscaleImageWithSharp,
};
