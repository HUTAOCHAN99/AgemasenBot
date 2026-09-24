const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

// =====================================================
// Fitur: "!sbrat <teks>" (alias ".sbrat") -- stiker gaya BRAT.
//
// Metode render-nya DIPORT dari project "brat-generator" (App.js ->
// createCanvasWithBackground / calculateOptimalFontSize / wrapText /
// drawJustifiedLine), supaya hasil di bot sama dengan hasil Download di
// web generator-nya:
//
//   1. Teks selalu di-lowercase.
//   2. Font: Archivo Narrow (regular), letter-spacing -0.05em.
//   3. Kanvas putih, margin 32/600 (~5.3%) di semua sisi, teks menempel
//      di KIRI-ATAS (bukan ditengahkan).
//   4. Ukuran font dicari otomatis: mulai dari 1/3 lebar kanvas, turun
//      sampai hasil word-wrap muat di area teks. Line-height 0.9.
//   5. Setiap baris KECUALI baris terakhir di-JUSTIFY (sisa lebar dibagi
//      rata ke celah antarkata). Baris terakhir tetap rata kiri.
//   6. Efek "fried": blur (fried/100 * 3px pada kanvas 600px) lalu
//      kompresi JPEG berkualitas rendah (quality = 1 - fried/100).
//      Default fried = 80, sama seperti slider di web generator.
//
// !sbrat murni dari TEKS -- gak butuh media apa pun, makanya dipisah dari
// stickerBuilder.js/textRender.js yang khusus nge-overlay teks di media.
// =====================================================

// Font default ikut di repo (assets/fonts, lisensi OFL -- lihat
// ArchivoNarrow-OFL.txt), jadi gak bergantung font sistem server. Bisa
// dioverride lewat env BRAT_FONT_PATH.
const BRAT_FONT_PATH =
  process.env.BRAT_FONT_PATH ||
  path.join(__dirname, "../../../assets/fonts/ArchivoNarrow-Variable.ttf");
const BRAT_FONT_FAMILY = "BratFont";

// Font cadangan buat karakter yang gak ada di Archivo Narrow (mis.
// simbol tertentu). Kalau file-nya gak ada di server, dilewati saja.
const BRAT_FALLBACK_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const BRAT_FALLBACK_FAMILY = "BratFallback";

let fontsRegistered = false;
function ensureBratFontRegistered() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (fs.existsSync(BRAT_FONT_PATH)) {
    GlobalFonts.registerFromPath(BRAT_FONT_PATH, BRAT_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font BRAT tidak ditemukan di ${BRAT_FONT_PATH} (set env BRAT_FONT_PATH).`,
    );
  }
  if (fs.existsSync(BRAT_FALLBACK_FONT_PATH)) {
    GlobalFonts.registerFromPath(BRAT_FALLBACK_FONT_PATH, BRAT_FALLBACK_FAMILY);
  }
}

// --- Parameter layout (semua angka acuan dari kanvas 600px di generator,
// lalu di-scale ke ukuran kanvas bot) -----------------------------------
const CANVAS_SIZE = 1024;
const SCALE = CANVAS_SIZE / 600;
const MARGIN = 32 * SCALE;
const BG_COLOR = "#FFFFFF";
const TEXT_COLOR = "#000000";
const LINE_HEIGHT_RATIO = 0.9;
const LETTER_SPACING_EM = -0.05;
const BASE_FONT_SIZE = CANVAS_SIZE / 3; // = min(200, size/3) di generator
const MIN_FONT_SIZE = 20 * SCALE;
const FONT_STEP = 2; // generator pakai 5; lebih halus = font lebih pas ke ruang
const MAX_CHARS = 80;

// Fried level 1..99 (default 80 seperti slider di generator).
const FRIED_LEVEL = Math.min(
  99,
  Math.max(1, parseInt(process.env.BRAT_FRIED_LEVEL, 10) || 80),
);

function fontString(size) {
  return `${size}px "${BRAT_FONT_FAMILY}", "${BRAT_FALLBACK_FAMILY}", sans-serif`;
}

function applyFont(ctx, size) {
  ctx.font = fontString(size);
  ctx.letterSpacing = `${(LETTER_SPACING_EM * size).toFixed(2)}px`;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function splitWords(text) {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ") : [];
}

// Kata yang lebih lebar dari area teks dipecah per karakter (di generator
// cuma berlaku kalau inputnya 1 kata; di sini berlaku untuk semua kata
// supaya kata panjang di tengah kalimat gak keluar kanvas).
function breakLongWord(ctx, word, maxWidth) {
  if (ctx.measureText(word).width <= maxWidth) return [word];

  const chunks = [];
  let current = "";
  for (const char of Array.from(word)) {
    const test = current + char;
    if (current && ctx.measureText(test).width > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current = test;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Word-wrap greedy berbasis lebar teks sebenarnya (measureText), sama
// seperti wrapText() di generator. Mengembalikan array string (1 per baris).
function wrapText(ctx, words, maxWidth) {
  const tokens = words.flatMap((w) => breakLongWord(ctx, w, maxWidth));
  const lines = [];
  let current = tokens[0] || "";

  for (let i = 1; i < tokens.length; i++) {
    const test = `${current} ${tokens[i]}`;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      lines.push(current);
      current = tokens[i];
    }
  }
  lines.push(current);
  return lines;
}

// Cari font TERBESAR (mulai 1/3 kanvas, turun bertahap) yang membuat
// hasil wrap muat di tinggi area teks -- setara calculateOptimalFontSize().
// Beda kecil dari generator: kalau sampai ukuran minimum pun gak muat,
// yang dipakai ukuran minimum + baris hasil ukuran itu (di generator
// ukuran dan baris bisa gak sinkron pada kasus ini).
function calculateOptimalFontSize(ctx, words, maxWidth, maxHeight) {
  let size = BASE_FONT_SIZE;
  for (; size >= MIN_FONT_SIZE; size -= FONT_STEP) {
    applyFont(ctx, size);
    const lines = wrapText(ctx, words, maxWidth);
    if (lines.length * size * LINE_HEIGHT_RATIO <= maxHeight) {
      return { size, lines };
    }
  }
  applyFont(ctx, MIN_FONT_SIZE);
  return { size: MIN_FONT_SIZE, lines: wrapText(ctx, words, maxWidth) };
}

// Justify: sisa lebar dibagi rata ke celah antarkata (drawJustifiedLine).
function drawJustifiedLine(ctx, line, x, y, maxWidth) {
  const words = line.split(" ");
  if (words.length <= 1) {
    ctx.fillText(line, x, y);
    return;
  }

  const widths = words.map((w) => ctx.measureText(w).width);
  const totalWords = widths.reduce((sum, w) => sum + w, 0);
  const gap = Math.max(maxWidth - totalWords, 0) / (words.length - 1);

  let cursorX = x;
  words.forEach((word, i) => {
    ctx.fillText(word, cursorX, y);
    cursorX += widths[i] + gap;
  });
}

// Render kanvas putih + teks brat -> buffer PNG (belum di-blur/fried).
function renderBratPng(text) {
  ensureBratFontRegistered();

  const words = splitWords(text);
  if (words.length === 0) words.push("brat"); // sama seperti generator

  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const maxWidth = CANVAS_SIZE - MARGIN * 2;
  const maxHeight = CANVAS_SIZE - MARGIN * 2;

  const { size, lines } = calculateOptimalFontSize(
    ctx,
    words,
    maxWidth,
    maxHeight,
  );

  applyFont(ctx, size);
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  // Bayangan tipis yang sama dengan generator (rgba(0,0,0,.3), blur 2, offset 1).
  ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
  ctx.shadowBlur = 2 * SCALE;
  ctx.shadowOffsetX = 1 * SCALE;
  ctx.shadowOffsetY = 1 * SCALE;

  const lineGap = size * LINE_HEIGHT_RATIO;
  let y = MARGIN;
  lines.forEach((line, index) => {
    if (index < lines.length - 1) {
      drawJustifiedLine(ctx, line, MARGIN, y, maxWidth);
    } else {
      ctx.fillText(line, MARGIN, y); // baris terakhir rata kiri
    }
    y += lineGap;
  });

  return canvas.toBuffer("image/png");
}

// Efek "fried" ala generator, lalu jadi WebP untuk stiker:
//   blur   = fried/100 * 3px (di kanvas 600px -> di-scale ke 1024px)
//   JPEG q = 1 - fried/100   (bikin artefak kompresi khas "deep fried")
// Blur diterapkan ke seluruh kanvas; karena background-nya putih rata,
// hasilnya sama dengan blur khusus teks.
async function pngToBratWebp(pngBuffer, friedLevel = FRIED_LEVEL) {
  const sigma = Math.max(0.3, (friedLevel / 100) * 3 * SCALE);
  const jpegQuality = Math.max(1, Math.round((1 - friedLevel / 100) * 100));

  const friedJpeg = await sharp(pngBuffer)
    .blur(sigma)
    .jpeg({ quality: jpegQuality })
    .toBuffer();

  return sharp(friedJpeg).webp({ quality: 90 }).toBuffer();
}

// Dipanggil dari router: teks -> buffer stiker WebP siap kirim.
// Semua proses di memory (tanpa file temp).
async function textToBratSticker(text) {
  const pngBuffer = renderBratPng(text);
  return pngToBratWebp(pngBuffer);
}

module.exports = {
  MAX_CHARS,
  splitWords,
  wrapText,
  calculateOptimalFontSize,
  renderBratPng,
  pngToBratWebp,
  textToBratSticker,
};
