const fs = require("fs");
const sharp = require("sharp");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { MEME_FONT_PATH } = require("./emoji");

// =====================================================
// Fitur: "!sbrat <teks>" (alias ".sbrat") -- generate stiker gaya BRAT
// (khas cover album "brat" Charli XCX): kanvas putih/nyaris putih, teks
// hitam dengan font normal (bukan bold), ukuran relatif kecil (banyak
// white space), rata kiri, blur ringan, antarbaris rapat. Layout kata
// mengalir kiri->kanan berbasis LEBAR TEKS SEBENARNYA (bukan hitungan
// karakter), lalu turun baris kalau ruang horizontal habis.
//
// BEDA dari !meme/!smeme/!s: fitur-fitur itu semua butuh SUMBER MEDIA
// (GIF/video/stiker/foto) yang di-reply/caption. !sbrat murni generate
// dari TEKS SAJA, gak butuh media apa pun -- makanya dipisah jadi modul
// sendiri, bukan nebeng ke stickerBuilder.js/textRender.js yang memang
// didesain buat nge-overlay teks DI ATAS media.
//
// Font: DEFAULT-nya SENGAJA BEDA dari !meme/!smeme (lihat
// BRAT_FONT_REGULAR_FALLBACK di bawah) karena MEME_FONT_PATH default-nya
// adalah varian BOLD, sementara brat-style aslinya pakai sans-serif
// normal/ringan. Tetap bisa dioverride independen lewat env var
// BRAT_FONT_PATH tanpa mengubah font meme.
// =====================================================

// Font BRAT: default-nya SENGAJA dipisah dari MEME_FONT_PATH (yang
// defaultnya DejaVuSans-Bold -- itu penyebab utama teks !sbrat sebelumnya
// selalu keliatan bold berat). Brat-style asli pakai sans-serif ringan/
// normal (Helvetica Neue-ish), jadi default-nya diarahkan ke DejaVu Sans
// varian REGULAR/"Book" (bukan Bold) yang lazim tersedia satu paket sama
// DejaVuSans-Bold di server Linux. Tetap bisa dioverride lewat env var
// BRAT_FONT_PATH kalau mau pakai font lain yang lebih mendekati referensi.
const BRAT_FONT_REGULAR_FALLBACK =
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const BRAT_FONT_PATH =
  process.env.BRAT_FONT_PATH ||
  (fs.existsSync(BRAT_FONT_REGULAR_FALLBACK)
    ? BRAT_FONT_REGULAR_FALLBACK
    : MEME_FONT_PATH); // fallback terakhir kalau regular gak ketemu sama sekali
const BRAT_FONT_FAMILY = "BratFont";

let bratFontRegistered = false;
function ensureBratFontRegistered() {
  if (bratFontRegistered) return;
  bratFontRegistered = true;

  if (fs.existsSync(BRAT_FONT_PATH)) {
    GlobalFonts.registerFromPath(BRAT_FONT_PATH, BRAT_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font BRAT tidak ditemukan di ${BRAT_FONT_PATH} (set env BRAT_FONT_PATH).`,
    );
  }
}

const CANVAS_SIZE = 1024;
const BG_COLOR = "#FFFFFF"; // putih bersih, sesuai referensi (dulu abu-abu #E6E6E6)
const TEXT_COLOR = "#151515"; // hitam pekat (bukan pure #000 biar gak terlalu keras)
const MARGIN_RATIO = 0.09; // margin lebih longgar (~9%) supaya white space kerasa
const LINE_HEIGHT_RATIO = 1.2; // rapat tapi tetap ada nafas antar baris
// Font size DIBATASI cukup rendah dengan sengaja -- brief minta teks
// "relatif kecil terhadap canvas", BUKAN memenuhi kanvas kayak poster.
// Nilai ini dikalibrasi supaya paragraf ~6 baris kira-kira mengisi
// separuh tinggi kanvas (mirip referensi), bukan 80-90% seperti versi lama.
const MIN_FONT_SIZE = 28;
const MAX_FONT_SIZE = 100;
const MAX_LINES = 8; // batas aman (MAX_CHARS=80 bikin ini jarang kepakai)
const BLUR_SIGMA = 3; // gaussian blur ringan (brief minta 2-4px)
const MAX_CHARS = 80; // batas panjang teks biar layout tetap rapi
// Teks pendek (<= sekian kata) TIDAK dipaksa muat 1 baris -- dipecah jadi
// beberapa baris pendek dengan sedikit variasi horizontal ("loose flow"),
// sesuai bagian "TEKS PENDEK" di brief.
const SHORT_TEXT_WORD_THRESHOLD = 6;

function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------
// Word-wrap "asli": mengalir dari kiri ke kanan berbasis LEBAR TEKS YANG
// SEBENARNYA (ctx.measureText), bukan jumlah karakter/DP balance seperti
// versi lama. Aturan intinya persis seperti brief:
//   currentLineWidth + wordWidth + spacing <= availableWidth
// kalau gak muat -> baris baru. Ini yang bikin hasil wrap mengikuti
// bentuk visual kata (kata lebar kayak "diberi-tahu" diperlakukan beda
// dari kata pendek "ya"), bukan cuma hitungan huruf.
function greedyWrapWords(ctx, words, maxWidth) {
  const spaceWidth = ctx.measureText(" ").width || 10;
  const lines = [];
  let current = [];
  let currentWidth = 0;

  for (const word of words) {
    const wordWidth = ctx.measureText(word).width;
    const extra = current.length === 0 ? 0 : spaceWidth;

    if (current.length > 0 && currentWidth + extra + wordWidth > maxWidth) {
      lines.push(current);
      current = [word];
      currentWidth = wordWidth;
    } else {
      current.push(word);
      currentWidth += extra + wordWidth;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// Cari ukuran font TERBESAR (dalam batas MIN/MAX_FONT_SIZE, yang sudah
// sengaja dibikin moderat) yang membuat hasil greedy-wrap tetap muat
// dalam maxHeight. MAX_FONT_SIZE yang rendah + logic ini artinya: makin
// panjang teksnya, makin banyak baris yang kebentuk secara alami dari
// greedy-wrap, dan kalau itu bikin blok teks kepanjangan vertikal, baru
// font-size diturunkan bertahap sampai muat -- BUKAN font dimaksimalkan
// dulu baru dipaksa entah berapa baris seperti algoritma lama.
function fitGreedyLayout(ctx, words, maxWidth, maxHeight) {
  for (let size = MAX_FONT_SIZE; size >= MIN_FONT_SIZE; size -= 2) {
    ctx.font = `${size}px "${BRAT_FONT_FAMILY}"`;
    const lines = greedyWrapWords(ctx, words, maxWidth);
    const totalHeight = size * LINE_HEIGHT_RATIO * lines.length;

    if (totalHeight <= maxHeight && lines.length <= MAX_LINES) {
      return { lines, size, mode: "flow" };
    }
  }
  // Fallback: teks kepanjangan banget -- pakai font minimum apa adanya
  // (MAX_CHARS=80 bikin kasus ini jarang tersentuh sama sekali).
  ctx.font = `${MIN_FONT_SIZE}px "${BRAT_FONT_FAMILY}"`;
  return {
    lines: greedyWrapWords(ctx, words, maxWidth),
    size: MIN_FONT_SIZE,
    mode: "flow",
  };
}

// ---------------------------------------------------------------------
// Mode "loose flow" khusus TEKS PENDEK (brief bagian "TEKS PENDEK"):
// jangan paksa semua kata jadi satu baris rapat. Sebagai gantinya, kata
// dikelompokkan 1-2 per baris (deterministik dari isi kata, bukan random
// bebas), lalu tiap baris diberi offset horizontal terkontrol -- baris
// pertama tetap condong ke kiri, baris berikutnya boleh sedikit ke
// tengah/kanan. Offset SELALU dihitung dari sisa ruang (maxWidth -
// lineWidth), jadi mustahil keluar kanvas atau overlap antar baris
// (baris tetap ditumpuk vertikal seperti mode biasa).
function buildLooseGroups(words) {
  const groups = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const next = words[i + 1];
    const combine =
      next !== undefined &&
      w.length + next.length <= 9 && // cuma gabung kalau dua-duanya pendek
      seededJitter(`${w}${next}${i}-combine`, 1) > 0; // ~50% deterministik
    if (combine) {
      groups.push([w, next]);
      i += 2;
    } else {
      groups.push([w]);
      i += 1;
    }
  }
  return groups;
}

function fitLooseLayout(ctx, words, maxWidth, maxHeight) {
  const groups = buildLooseGroups(words);
  for (let size = MAX_FONT_SIZE; size >= MIN_FONT_SIZE; size -= 2) {
    ctx.font = `${size}px "${BRAT_FONT_FAMILY}"`;
    const widest = Math.max(
      ...groups.map((g) => ctx.measureText(g.join(" ")).width),
    );
    const totalHeight = size * LINE_HEIGHT_RATIO * groups.length;

    if (widest <= maxWidth && totalHeight <= maxHeight) {
      return { lines: groups, size, mode: "loose" };
    }
  }
  ctx.font = `${MIN_FONT_SIZE}px "${BRAT_FONT_FAMILY}"`;
  return { lines: groups, size: MIN_FONT_SIZE, mode: "loose" };
}

// Router kecil: teks pendek -> loose flow, selain itu -> greedy flow
// biasa. Keduanya sama-sama "satu sistem" (word-flow kiri->kanan,
// turun baris kalau gak muat) -- bedanya cuma seberapa banyak kata
// digabung per baris, sesuai instruksi brief supaya panjang/pendek
// teks berbagi prinsip layout yang sama.
function pickBestLayout(ctx, words, maxWidth, maxHeight) {
  if (words.length <= SHORT_TEXT_WORD_THRESHOLD) {
    return fitLooseLayout(ctx, words, maxWidth, maxHeight);
  }
  return fitGreedyLayout(ctx, words, maxWidth, maxHeight);
}

// Random kecil TAPI deterministik (seed dari isi baris itu sendiri) --
// dipakai buat jitter posisi/rotasi tiap baris (efek "sengaja sedikit
// berantakan" di brief). Deterministik dipilih supaya teks yang sama
// selalu hasilnya konsisten, bukan berubah-ubah acak tiap kali dipanggil.
function seededJitter(seedText, max) {
  let hash = 0;
  for (let i = 0; i < seedText.length; i++) {
    hash = (hash * 31 + seedText.charCodeAt(i)) | 0;
  }
  const unit = ((hash % 1000) + 1000) % 1000 / 1000; // 0..1
  return (unit - 0.5) * 2 * max; // -max..+max
}

// Render 1 lembar PNG 1024x1024 gaya BRAT dari teks mentah.
function renderBratPng(text) {
  ensureBratFontRegistered();

  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const margin = Math.round(CANVAS_SIZE * MARGIN_RATIO);
  const maxWidth = CANVAS_SIZE - margin * 2;
  const maxHeight = CANVAS_SIZE - margin * 2;

  const words = splitWords(text);
  const { lines, size, mode } = pickBestLayout(ctx, words, maxWidth, maxHeight);

  ctx.font = `${size}px "${BRAT_FONT_FAMILY}"`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = TEXT_COLOR;

  const spaceWidth = ctx.measureText(" ").width || size * 0.28;
  const lineGap = size * LINE_HEIGHT_RATIO;
  const totalHeight = lineGap * lines.length;
  // Blok teks ditengahkan vertikal dalam area yang tersedia (bukan nempel
  // ke atas/bawah), tapi tiap baris tetap mulai rata kiri dari margin kiri
  // (sesuai default alignment LEFT di brief).
  let y = margin + (maxHeight - totalHeight) / 2 + size * 0.78;

  lines.forEach((lineWords, lineIndex) => {
    const lineText = lineWords.join(" ");
    const lineWidth = ctx.measureText(lineText).width;

    // Offset horizontal awal baris:
    // - mode "flow" (teks panjang/normal): tiap baris rata kiri (cuma
    //   jitter beberapa px) -- ini yang menghasilkan paragraf alami
    //   seperti referensi.
    // - mode "loose" (teks pendek): baris PERTAMA tetap dipaksa dekat
    //   kiri, baris berikutnya boleh bergeser ke arah tengah/kanan
    //   secara terkontrol (bergantung sisa ruang horizontal), sesuai
    //   brief bagian "TEKS PENDEK". Offset ini dihitung dari sisa
    //   ruang (maxWidth - lineWidth) jadi TIDAK PERNAH keluar kanvas.
    let startXOffset = 0;
    if (mode === "loose" && lineIndex > 0) {
      const room = Math.max(0, maxWidth - lineWidth);
      // Faktor 0..0.55 -- condong kiri secara umum, tapi sebagian baris
      // bisa jatuh di area tengah/kanan seperti pada referensi ASCII.
      const factor = (seededJitter(lineText + lineIndex + "shift", 1) + 1) / 2 * 0.55;
      startXOffset = room * factor;
    }

    // Jitter halus per baris (beberapa px + rotasi <2 derajat) -- "sedikit
    // berantakan tapi tetap mudah dibaca" sesuai brief, bukan diacak liar.
    const dx = seededJitter(lineText + lineIndex + "x", 6);
    const dy = seededJitter(lineText + lineIndex + "y", 2);
    const angle = seededJitter(lineText + lineIndex + "r", 1.2) * (Math.PI / 180);

    ctx.save();
    ctx.translate(margin + startXOffset + dx, y + dy);
    ctx.rotate(angle);

    // Render kata per kata (bukan satu fillText string gabungan) supaya
    // jarak antarkata bisa dikasih variasi kecil ("natural", bukan
    // seragam sempurna) -- variasinya dibatasi ±25% dari lebar spasi
    // normal, cukup kecil untuk tetap aman terhadap batas wrap.
    let cursorX = 0;
    lineWords.forEach((word, wordIndex) => {
      ctx.fillText(word, cursorX, 0);
      const wordWidth = ctx.measureText(word).width;
      const gapJitter = seededJitter(word + wordIndex + lineIndex + "gap", spaceWidth * 0.25);
      cursorX += wordWidth + spaceWidth + gapJitter;
    });

    ctx.restore();

    y += lineGap;
  });

  return canvas.toBuffer("image/png");
}

// PNG -> WEBP + gaussian blur ringan (2-4px, di sini pakai sigma=3) dalam
// satu langkah lewat sharp. Blur di-apply ke SELURUH kanvas (bukan cuma
// teksnya), tapi karena background-nya warna solid rata, blur situ gak
// kelihatan efeknya -- jadi hasil visualnya sama seperti blur khusus di
// teks saja, tanpa perlu proses layer terpisah.
async function pngToBratWebp(pngBuffer) {
  return sharp(pngBuffer).blur(BLUR_SIGMA).webp({ quality: 92 }).toBuffer();
}

// Proses inti dipanggil dari router: teks -> buffer stiker WebP siap
// dikirim sebagai `sticker` di Baileys. Semua tahap (render PNG, konversi
// WEBP) dilakukan di MEMORY lewat Buffer -- sengaja TIDAK menulis file
// sementara ke disk sama sekali, jadi tidak ada file temp yang perlu
// dihapus/dijaga-jaga (lebih aman drpd nulis-lalu-hapus manual).
async function textToBratSticker(text) {
  const pngBuffer = renderBratPng(text);
  return pngToBratWebp(pngBuffer);
}

module.exports = {
  MAX_CHARS,
  splitWords,
  greedyWrapWords,
  fitGreedyLayout,
  buildLooseGroups,
  fitLooseLayout,
  pickBestLayout,
  renderBratPng,
  pngToBratWebp,
  textToBratSticker,
};
