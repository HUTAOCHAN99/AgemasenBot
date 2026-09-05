const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { normalizeFfmpegInputBuffer } = require("../media/detect");
const {
  probeVideoDimensions,
  computeSafeMargins,
  runFfmpegUnderSizeLimit,
} = require("../media/ffmpeg");
const { renderMemeOverlayPng } = require("./textRender");

function parseMemeText(raw) {
  const parts = raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return { top: parts[0], bottom: parts[1] };
  }

  return { top: null, bottom: parts[0] || raw.trim() };
}

// Proses inti: buffer GIF/video/foto/stiker input -> buffer stiker WebP
// bertext. `isStill` = true kalau sumbernya cuma 1 frame (foto/stiker
// statis) -> filter "fps=12" di-skip karena butuh minimal 2 frame buat
// jalan, kalau tetap dipaksa malah bikin output kosong (lihat isStillMedia).
async function gifToTextSticker(inputBuffer, memeText, isStill = false) {
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(tmpDir, `meme-in-${uid}`);
  const overlayPath = path.join(tmpDir, `meme-${uid}.png`);
  const outputPath = path.join(tmpDir, `meme-out-${uid}.webp`);

  inputBuffer = await normalizeFfmpegInputBuffer(inputBuffer);
  fs.writeFileSync(inputPath, inputBuffer);

  try {
    const parsed = parseMemeText(memeText);
    const srcDims = await probeVideoDimensions(inputPath);
    const margins = computeSafeMargins(srcDims);

    // Render teks (+ emoji WA kalau ada) ke PNG transparan 512x512 sekali
    // di awal, lalu PNG ini di-overlay ke SETIAP frame lewat ffmpeg.
    // Karena tekstnya statis (tidak animasi), 1 gambar overlay saja cukup.
    const overlayBuffer = await renderMemeOverlayPng({
      ...parsed,
      marginTop: margins.top,
      marginBottom: margins.bottom,
    });
    fs.writeFileSync(overlayPath, overlayBuffer);

    // Background (video/gif sumber) diskalakan & di-pad transparan ke
    // 512x512 seperti sebelumnya, lalu overlay teks/emoji ditumpuk di
    // atasnya. "format=rgba" WAJIB: GIF sumber biasanya tidak punya
    // channel alpha, jadi kalau langsung di-pad warna "transparan" itu
    // malah dianggap hitam solid oleh encoder.
    const buildArgs = (step) => {
      const size = step.size || 512;
      const bgFilters = [
        "format=rgba",
        // `size` biasanya 512 (konten pas kanvas penuh). Di tangga darurat
        // (lihat ANIMATED_QUALITY_LADDER), size diperkecil (mis. 400/320)
        // supaya konten discale ke kotak lebih kecil DULU sebelum di-pad --
        // kanvas akhirnya tetap wajib 512x512, tapi piksel yang perlu
        // di-encode tiap frame jauh lebih sedikit -> ukuran file lebih kecil.
        `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        ...(isStill || !step.fps ? [] : [`fps=${step.fps}`]),
      ];

      const filterComplex =
        `[0:v]${bgFilters.join(",")}[bg];` +
        `[bg][1:v]overlay=0:0:format=auto[vout]`;

      const args = [
        "-y",
        "-i",
        inputPath,
        "-i",
        overlayPath,
        "-filter_complex",
        filterComplex,
        "-map",
        "[vout]",
        "-vcodec",
        "libwebp",
        "-pix_fmt",
        "yuva420p", // paksa encoder ikut simpan channel alpha
        "-loop",
        "0",
        "-preset",
        "default",
        "-quality",
        String(step.quality),
        "-compression_level",
        "6", // paling pelan tapi paling kecil hasilnya -- worth it, bot yang nunggu bukan user
        "-an",
        "-fps_mode",
        "cfr",
      ];

      if (!isStill && step.duration) args.push("-t", String(step.duration)); // batas durasi stiker WA

      args.push(outputPath);
      return args;
    };

    return await runFfmpegUnderSizeLimit(buildArgs, outputPath, isStill);
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(overlayPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

// Proses inti buat "!s": buffer GIF/video/stiker/foto -> buffer stiker WebP
// polos, TANPA teks (tidak lewat tahap subtitle/.ass sama sekali). Filter
// scale+pad+fps-nya sama persis dengan gifToTextSticker supaya hasil
// crop/rasio-nya konsisten antara "!s" dan "!meme"/"!smeme". `isStill` sama
// perannya kayak di gifToTextSticker: skip "fps=12" buat gambar diam (lihat
// isStillMedia untuk alasannya).
async function mediaToSticker(inputBuffer, isStill = false) {
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(tmpDir, `s-in-${uid}`);
  const outputPath = path.join(tmpDir, `s-out-${uid}.webp`);

  inputBuffer = await normalizeFfmpegInputBuffer(inputBuffer);
  fs.writeFileSync(inputPath, inputBuffer);

  try {
    const buildArgs = (step) => {
      const size = step.size || 512;
      const filters = [
        "format=rgba",
        `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        ...(isStill || !step.fps ? [] : [`fps=${step.fps}`]),
      ];

      const args = [
        "-y",
        "-i",
        inputPath,
        "-vf",
        filters.join(","),
        "-vcodec",
        "libwebp",
        "-pix_fmt",
        "yuva420p",
        "-loop",
        "0",
        "-preset",
        "default",
        "-quality",
        String(step.quality),
        "-compression_level",
        "6",
        "-an",
        "-fps_mode",
        "cfr",
      ];

      if (!isStill && step.duration) args.push("-t", String(step.duration));

      args.push(outputPath);
      return args;
    };

    return await runFfmpegUnderSizeLimit(buildArgs, outputPath, isStill);
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

module.exports = {
  parseMemeText,
  gifToTextSticker,
  mediaToSticker,
};
