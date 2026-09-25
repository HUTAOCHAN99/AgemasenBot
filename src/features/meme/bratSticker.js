const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const {
  splitTextEmoji,
  preloadEmojisInText,
  emojiImageCache,
  emojiToCodepoints,
} = require("./emoji");

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
//   5. Setiap baris di-JUSTIFY (sisa lebar dibagi rata ke celah antarkata).
//      Baris terakhir ikut di-justify HANYA kalau isinya lebih dari 2 kata
//      (LAST_LINE_JUSTIFY_MIN_WORDS); kalau 1-2 kata tetap rata kiri.
//      Baris 1 kata tetap rata kiri (gak ada celah untuk dibagi).
//   5b. Margin kiri & kanan diukur dari TINTA huruf yang sebenarnya (bukan
//      dari lebar advance font), jadi jarak tepi kiri teks ke kanvas sama
//      dengan jarak tepi kanan teks ke kanvas.
//   5c. EMOJI didukung: font brat gak punya glyph emoji, jadi tiap emoji
//      digambar sebagai gambar Twemoji (fetch + cache lewat emoji.js, sama
//      seperti fitur meme) dan diperlakukan sebagai bagian dari kata --
//      ikut word-wrap, ikut justify, ikut kena efek fried. Emoji yang
//      gambarnya gagal diambil dibuang dari teks (bukan jadi kotak kosong).
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
// Baris terakhir baru di-justify kalau jumlah katanya LEBIH dari 2
// (artinya minimal 3). Ubah angka ini kalau mau ambang lain.
const LAST_LINE_JUSTIFY_MIN_WORDS = 3;

// Emoji digambar sebagai gambar persegi. Angka relatif terhadap ukuran font
// (tinggi huruf brat: puncak ascender ~0.16, baseline ~0.885).
const EMOJI_SIZE_EM = 0.8; // sisi gambar emoji
const EMOJI_TOP_EM = 0.12; // jarak gambar dari atas kotak teks
const EMOJI_GAP_EM = 0.05; // celah kecil setelah tiap emoji

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

// --- Helper emoji ------------------------------------------------------
function emojiBox(size) {
  return size * EMOJI_SIZE_EM;
}

function emojiAdvance(size) {
  return emojiBox(size) + size * EMOJI_GAP_EM;
}

function getEmojiImg(emoji) {
  return emojiImageCache.get(emojiToCodepoints(emoji)) || null;
}

// Buang emoji yang gambarnya gak tersedia (gagal fetch / gak ada di Twemoji)
// supaya gak muncul sebagai ruang kosong di stiker.
function stripUnavailableEmoji(text) {
  return splitTextEmoji(text)
    .filter((seg) => seg.type !== "emoji" || getEmojiImg(seg.value))
    .map((seg) => seg.value)
    .join("");
}

// Lebar 1 kata (campuran teks + emoji). Emoji dihitung selebar emojiAdvance.
function measureWord(ctx, word, size) {
  let width = 0;
  for (const seg of splitTextEmoji(word)) {
    width +=
      seg.type === "emoji"
        ? emojiAdvance(size)
        : ctx.measureText(seg.value).width;
  }
  return width;
}

// Pecah kata jadi "unit": 1 karakter teks, atau 1 emoji utuh (emoji gabungan
// gak boleh kepotong di tengah).
function splitUnits(word) {
  return splitTextEmoji(word).flatMap((seg) =>
    seg.type === "emoji" ? [seg.value] : Array.from(seg.value),
  );
}

// Kata yang lebih lebar dari area teks dipecah per karakter (di generator
// cuma berlaku kalau inputnya 1 kata; di sini berlaku untuk semua kata
// supaya kata panjang di tengah kalimat gak keluar kanvas).
function breakLongWord(ctx, word, maxWidth, size) {
  if (measureWord(ctx, word, size) <= maxWidth) return [word];

  const chunks = [];
  let current = "";
  for (const unit of splitUnits(word)) {
    const test = current + unit;
    if (current && measureWord(ctx, test, size) > maxWidth) {
      chunks.push(current);
      current = unit;
    } else {
      current = test;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Word-wrap greedy berbasis lebar sebenarnya (measureText; emoji dihitung
// lewat measureWord), sama seperti wrapText() di generator. Mengembalikan
// array string (1 per baris). `size` = ukuran font saat ini (untuk emoji).
// Dipakai sebagai FALLBACK TERAKHIR di calculateOptimalFontSize (lihat di
// bawah) -- yaitu kalau bahkan di MIN_FONT_SIZE ada kata yang masih lebih
// lebar dari area teks, baru kata itu dipenggal paksa.
function wrapText(ctx, words, maxWidth, size) {
  const tokens = words.flatMap((w) => breakLongWord(ctx, w, maxWidth, size));
  return wrapTokensNoBreak(ctx, tokens, maxWidth, size);
}

// Word-wrap greedy TANPA memenggal kata: kalau 1 kata sendirian sudah lebih
// lebar dari maxWidth, kata itu tetap ditaruh sendirian di baris itu (lebar
// baris boleh melebihi maxWidth sementara -- ini dipakai calculateOptimalFontSize
// buat mendeteksi "kata ini masih kepanjangan, font-nya harus lebih kecil lagi"
// SEBELUM nyerah dan memenggal kata).
function wrapTokensNoBreak(ctx, tokens, maxWidth, size) {
  if (tokens.length === 0) return [];
  const spaceWidth = ctx.measureText(" ").width;
  const lines = [];
  let current = tokens[0];
  let currentWidth = measureWord(ctx, current, size);

  for (let i = 1; i < tokens.length; i++) {
    const tokenWidth = measureWord(ctx, tokens[i], size);
    if (currentWidth + spaceWidth + tokenWidth <= maxWidth) {
      current = `${current} ${tokens[i]}`;
      currentWidth += spaceWidth + tokenWidth;
    } else {
      lines.push(current);
      current = tokens[i];
      currentWidth = tokenWidth;
    }
  }
  lines.push(current);
  return lines;
}

// Baris "overflow" = baris yang lebih lebar dari maxWidth (cuma bisa terjadi
// kalau baris itu berisi 1 kata yang sendirian sudah kepanjangan).
function hasOverflowingLine(ctx, lines, maxWidth, size) {
  return lines.some((line) => measureWord(ctx, line, size) > maxWidth);
}

// Cari font TERBESAR (mulai 1/3 kanvas, turun bertahap) yang membuat SEMUA
// kata muat utuh (gak dipenggal) dalam maxWidth x maxHeight -- setara
// calculateOptimalFontSize() di generator, ditambah pengaman supaya kata
// gak dipenggal selama masih ada ukuran font lebih kecil yang muat.
//
// Kalau langsung pakai wrapText (yang boleh memenggal kata) di sini, loop
// bisa berhenti di font BESAR gara-gara pemenggalan bikin baris "muat"
// tingginya -- padahal turun sedikit lagi kata itu muat utuh 1 baris tanpa
// dipenggal sama sekali. Makanya di loop ini dipakai wrapTokensNoBreak, dan
// breakLongWord baru dipakai kalau MIN_FONT_SIZE pun kata itu masih kepanjangan.
function calculateOptimalFontSize(ctx, words, maxWidth, maxHeight) {
  let size = BASE_FONT_SIZE;
  for (; size >= MIN_FONT_SIZE; size -= FONT_STEP) {
    applyFont(ctx, size);
    const lines = wrapTokensNoBreak(ctx, words, maxWidth, size);
    const fitsHeight = lines.length * size * LINE_HEIGHT_RATIO <= maxHeight;
    const fitsWidth = !hasOverflowingLine(ctx, lines, maxWidth, size);
    if (fitsHeight && fitsWidth) {
      return { size, lines };
    }
  }
  // Sampai MIN_FONT_SIZE pun masih ada kata yang kepanjangan atau baris
  // kebanyakan -- baru di sini kata dipenggal paksa (breakLongWord).
  applyFont(ctx, MIN_FONT_SIZE);
  return {
    size: MIN_FONT_SIZE,
    lines: wrapText(ctx, words, maxWidth, MIN_FONT_SIZE),
  };
}

// Ukur TEPI TINTA sebenarnya dari sebuah teks (bukan lebar advance):
// gambar di kanvas kecil, lalu pindai piksel dari kiri dan dari kanan.
// Hasilnya jarak dari titik origin x ke piksel tinta pertama (left) dan
// terakhir (right). Ini yang bikin margin kiri/kanan benar-benar simetris,
// karena letter-spacing negatif dan side-bearing huruf membuat tinta
// bergeser dari posisi advance-nya.
let inkCtx = null;
const inkCache = new Map();
function measureTextInk(text, size) {
  const key = `${size}|${text}`;
  const cached = inkCache.get(key);
  if (cached) return cached;

  const pad = Math.ceil(size);
  const width = Math.ceil(inkCtxMeasure(text, size)) + pad * 2;
  const height = Math.ceil(size * 1.6);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  applyFont(ctx, size);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, pad, Math.ceil(size * 1.2));

  const { data } = ctx.getImageData(0, 0, width, height);
  const THRESHOLD = 64; // alpha; cukup untuk lewati anti-alias tipis
  const columnHasInk = (x) => {
    for (let y = 0; y < height; y++) {
      if (data[(y * width + x) * 4 + 3] > THRESHOLD) return true;
    }
    return false;
  };

  let first = 0;
  while (first < width && !columnHasInk(first)) first++;
  let last = width - 1;
  while (last > first && !columnHasInk(last)) last--;

  // Kolom piksel x menutupi [x, x+1), jadi tepi kanan = last + 1.
  const result = { left: first - pad, right: last + 1 - pad };
  inkCache.set(key, result);
  return result;
}

// Lebar advance untuk ukuran kanvas kecil di atas (dipisah supaya
// measureInk tetap ringkas).
function inkCtxMeasure(text, size) {
  if (!inkCtx) inkCtx = createCanvas(1, 1).getContext("2d");
  applyFont(inkCtx, size);
  return inkCtx.measureText(text).width;
}

// Tepi tinta sebuah KATA (bisa campuran teks + emoji): jarak dari origin
// kata ke tinta paling kiri (left) dan paling kanan (right). Segmen teks
// diukur lewat piksel, gambar emoji dianggap penuh selebar emojiBox.
function measureInk(word, size) {
  const segs = splitTextEmoji(word);
  if (segs.length === 0) return { left: 0, right: 0 };

  const first = segs[0];
  const last = segs[segs.length - 1];
  const left = first.type === "emoji" ? 0 : measureTextInk(first.value, size).left;

  let prefix = 0;
  for (let i = 0; i < segs.length - 1; i++) {
    prefix +=
      segs[i].type === "emoji"
        ? emojiAdvance(size)
        : inkCtxMeasure(segs[i].value, size);
  }
  const right =
    prefix +
    (last.type === "emoji"
      ? emojiBox(size)
      : measureTextInk(last.value, size).right);

  return { left, right };
}

// Gambar 1 kata di (x, y): segmen teks pakai fillText, emoji pakai drawImage.
function drawWord(ctx, word, x, y, size) {
  let cursor = x;
  for (const seg of splitTextEmoji(word)) {
    if (seg.type === "emoji") {
      const img = getEmojiImg(seg.value);
      if (img) {
        ctx.drawImage(
          img,
          cursor,
          y + size * EMOJI_TOP_EM,
          emojiBox(size),
          emojiBox(size),
        );
      }
      cursor += emojiAdvance(size);
    } else {
      ctx.fillText(seg.value, cursor, y);
      cursor += ctx.measureText(seg.value).width;
    }
  }
}

// Gambar satu baris. Tepi TINTA kata pertama dipasang tepat di margin kiri;
// kalau di-justify, tepi TINTA kata terakhir dipasang tepat di margin kanan
// dan sisa lebar dibagi rata ke celah antarkata (drawJustifiedLine).
function drawLine(ctx, line, y, size, justify) {
  const words = line.split(" ");
  const x0 = MARGIN - measureInk(words[0], size).left;
  const widths = words.map((w) => measureWord(ctx, w, size));

  let gap = ctx.measureText(" ").width; // rata kiri: celah normal
  if (justify && words.length > 1) {
    const rightInk = measureInk(words[words.length - 1], size).right;
    const xLast = CANVAS_SIZE - MARGIN - rightInk; // origin kata terakhir
    const widthsExceptLast = widths
      .slice(0, -1)
      .reduce((sum, w) => sum + w, 0);
    gap = Math.max(xLast - x0 - widthsExceptLast, 0) / (words.length - 1);
  }

  let cursorX = x0;
  words.forEach((word, i) => {
    drawWord(ctx, word, cursorX, y, size);
    cursorX += widths[i] + gap;
  });
}

// Render kanvas putih + teks brat -> buffer PNG (belum di-blur/fried).
function renderBratPngSync(text) {
  ensureBratFontRegistered();

  // Emoji yang gambarnya gak berhasil di-preload dibuang dulu.
  const words = splitWords(stripUnavailableEmoji(normalizeText(text)));
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
    const isLast = index === lines.length - 1;
    // Baris biasa selalu di-justify; baris terakhir hanya kalau > 2 kata.
    const justify =
      !isLast || line.split(" ").length >= LAST_LINE_JUSTIFY_MIN_WORDS;
    drawLine(ctx, line, y, size, justify);
    y += lineGap;
  });

  return canvas.toBuffer("image/png");
}

// Versi async: pra-load gambar emoji dulu (fetch + cache), baru render.
async function renderBratPng(text) {
  await preloadEmojisInText(normalizeText(text));
  return renderBratPngSync(text);
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
  const pngBuffer = await renderBratPng(text);
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