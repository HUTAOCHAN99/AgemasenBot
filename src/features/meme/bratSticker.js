const fs = require("fs");
const sharp = require("sharp");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { MEME_FONT_PATH } = require("./emoji");

// =====================================================
// Fitur: "!sbrat <teks>" (alias ".sbrat") -- generate stiker gaya BRAT
// (khas cover album "brat" Charli XCX): kanvas abu-abu muda, teks hitam
// pekat berukuran raksasa, rata kiri, blur ringan, antarbaris rapat.
//
// BEDA dari !meme/!smeme/!s: fitur-fitur itu semua butuh SUMBER MEDIA
// (GIF/video/stiker/foto) yang di-reply/caption. !sbrat murni generate
// dari TEKS SAJA, gak butuh media apa pun -- makanya dipisah jadi modul
// sendiri, bukan nebeng ke stickerBuilder.js/textRender.js yang memang
// didesain buat nge-overlay teks DI ATAS media.
//
// Font pakai infrastruktur yang SAMA seperti !meme/!smeme (lihat
// emoji.js) secara default -- gak perlu font baru diinstall di server.
// Bisa dioverride independen lewat env var BRAT_FONT_PATH kalau suatu
// saat mau pakai font lain khusus buat !sbrat tanpa mengubah font meme.
// =====================================================

const BRAT_FONT_PATH = process.env.BRAT_FONT_PATH || MEME_FONT_PATH;
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
const BG_COLOR = "#E6E6E6";
const TEXT_COLOR = "#111111";
const MARGIN_RATIO = 0.065; // margin kecil (~6.5%), sesuai brief 5-8%
const LINE_HEIGHT_RATIO = 1.15; // rapat, tapi cukup buat hindari ascender/descender numpuk
const MIN_LINES = 1;
const MAX_LINES = 4;
const MIN_FONT_SIZE = 26;
const MAX_FONT_SIZE = 820;
const BLUR_SIGMA = 3; // gaussian blur ringan (brief minta 2-4px)
const MAX_CHARS = 80; // batas panjang teks biar layout tetap rapi

function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

// Bagi array kata jadi PERSIS `numLines` baris (urutan kata tetap
// dipertahankan -- ini bukan penyusunan ulang, cuma nyari titik potong
// terbaik), dengan meminimalkan variansi PANJANG KARAKTER antar baris.
// Ini "algoritma sederhana" yang bikin hasil potongan barisnya keliatan
// SEIMBANG secara visual, dipakai buat kasus semacam:
//   "ayo ayo ganyang fufufafa" (3 baris) -> "ayo ayo" / "ganyang" / "fufufafa"
// (7 / 7 / 8 karakter -- jauh lebih seimbang dibanding potongan lain)
// dibanding word-wrap biasa yang cuma "makan kata sampai mentok lebar".
//
// Pakai DP klasik "pembagian array jadi k bagian, minimalkan jumlah
// kuadrat panjang tiap bagian" -- karena total panjang teks FIXED,
// meminimalkan jumlah kuadrat = memaksa semua bagian sedekat mungkin ke
// panjang rata-rata (itulah definisi "seimbang" di sini).
function balancedPartition(words, numLines) {
  const n = words.length;
  if (numLines <= 1 || n <= 1) return [words];
  if (numLines >= n) return words.map((w) => [w]); // 1 kata per baris

  const lineLen = (j, i) => {
    let len = 0;
    for (let k = j; k < i; k++) len += words[k].length;
    return len + (i - j - 1); // + spasi antar kata dalam baris itu
  };

  const INF = Infinity;
  const dp = Array.from({ length: numLines + 1 }, () =>
    new Array(n + 1).fill(INF),
  );
  const choice = Array.from({ length: numLines + 1 }, () =>
    new Array(n + 1).fill(-1),
  );
  dp[0][0] = 0;

  for (let k = 1; k <= numLines; k++) {
    for (let i = k; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        if (dp[k - 1][j] === INF) continue;
        const len = lineLen(j, i);
        const cost = dp[k - 1][j] + len * len;
        if (cost < dp[k][i]) {
          dp[k][i] = cost;
          choice[k][i] = j;
        }
      }
    }
  }

  const lines = [];
  let i = n;
  for (let k = numLines; k >= 1; k--) {
    const j = choice[k][i];
    lines.unshift(words.slice(j, i));
    i = j;
  }
  return lines;
}

// Cari ukuran font TERBESAR (dalam batas MIN/MAX_FONT_SIZE) yang bikin
// SEMUA baris muat dalam maxWidth, dan total tinggi bloknya muat dalam
// maxHeight.
function fitFontSizeForLines(ctx, lines, maxWidth, maxHeight) {
  for (let size = MAX_FONT_SIZE; size >= MIN_FONT_SIZE; size -= 2) {
    ctx.font = `${size}px "${BRAT_FONT_FAMILY}"`;
    const widest = Math.max(
      ...lines.map((line) => ctx.measureText(line.join(" ")).width),
    );
    const totalHeight = size * LINE_HEIGHT_RATIO * lines.length;

    if (widest <= maxWidth && totalHeight <= maxHeight) return size;
  }
  return MIN_FONT_SIZE;
}

// Inti algoritma line-break: coba semua opsi jumlah baris (1..4, dibatasi
// jumlah kata yang ada), balance-partition tiap opsi lewat balancedPartition,
// lalu hitung font terbesar yang muat buat tiap opsi. Opsi dengan font
// PALING BESAR yang menang -- karena target brief adalah teks memenuhi
// ~80-90% kanvas, jadi "line-break paling estetis" didefinisikan sebagai
// "line-break yang bikin teksnya bisa dirender paling besar". Kalau ada
// beberapa opsi dengan font size yang SAMA persis, menangkan yang barisnya
// LEBIH SEDIKIT -- gak ada gunanya mecah baris lebih banyak kalau toh
// ukuran fontnya gak nambah gede, itu cuma bikin makin ramai tanpa manfaat
// visual (mis. "ayo ayo / ganyang / fufufafa" [3 baris] menang atas
// "ayo / ayo / ganyang / fufufafa" [4 baris] kalau font size-nya sama).
function pickBestLayout(ctx, words, maxWidth, maxHeight) {
  const maxPossibleLines = Math.max(
    MIN_LINES,
    Math.min(MAX_LINES, words.length),
  );

  let best = null;
  for (let numLines = MIN_LINES; numLines <= maxPossibleLines; numLines++) {
    const lines = balancedPartition(words, numLines);
    const size = fitFontSizeForLines(ctx, lines, maxWidth, maxHeight);

    if (!best || size > best.size) {
      best = { lines, size };
    }
    // size === best.size -> best sudah dari numLines lebih kecil (loop naik),
    // jadi TIDAK diganti -- ini yang mewujudkan tie-break "lebih sedikit baris".
  }
  return best;
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
  const { lines, size } = pickBestLayout(ctx, words, maxWidth, maxHeight);

  ctx.font = `${size}px "${BRAT_FONT_FAMILY}"`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = TEXT_COLOR;

  const lineGap = size * LINE_HEIGHT_RATIO;
  const totalHeight = lineGap * lines.length;
  // Blok teks ditengahkan vertikal dalam area yang tersedia (bukan nempel
  // ke atas/bawah), tapi tiap baris tetap RATA KIRI dari margin kiri.
  let y = margin + (maxHeight - totalHeight) / 2 + size * 0.78;

  for (const lineWords of lines) {
    const lineText = lineWords.join(" ");
    // Jitter halus (beberapa px + rotasi <2 derajat) -- "sedikit
    // berantakan tapi tetap mudah dibaca" sesuai brief, bukan diacak liar.
    const dx = seededJitter(lineText + "x", 6);
    const dy = seededJitter(lineText + "y", 2);
    const angle = seededJitter(lineText + "r", 1.2) * (Math.PI / 180);

    ctx.save();
    ctx.translate(margin + dx, y + dy);
    ctx.rotate(angle);
    ctx.fillText(lineText, 0, 0);
    ctx.restore();

    y += lineGap;
  }

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
  balancedPartition,
  fitFontSizeForLines,
  pickBestLayout,
  renderBratPng,
  pngToBratWebp,
  textToBratSticker,
};
