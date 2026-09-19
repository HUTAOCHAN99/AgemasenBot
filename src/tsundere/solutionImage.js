// =====================================================
// solutionImage.js -- render jawaban yang mengandung rumus ($$..$$ / $..$)
// dan/atau tabel markdown (| a | b |) jadi SATU gambar rapi ("foto
// pengerjaan"), daripada dikirim sebagai teks mentah yang berantakan di
// WhatsApp (WA gak render LaTeX & rapihnya tabel markdown sama sekali).
//
// Strategi:
//   1. Parse balasan jadi segmen berurutan: text biasa, blok rumus, blok
//      tabel -- urutannya dipertahankan supaya alur penjelasan gak acak.
//   2. Tiap blok rumus dirender jadi PNG lewat CodeCogs (butuh internet di
//      server produksi, TIDAK dipakai/dites di sandbox ini). Kalau gagal
//      (mis. domain diblokir/API down), fallback: tulis apa adanya sebagai
//      teks (mending kelihatan agak mentah daripada jawaban ilang).
//   3. Tiap blok tabel digambar manual pakai @napi-rs/canvas (grid rapi,
//      header dikasih warna) -- gak butuh internet sama sekali.
//   4. Semua segmen ditumpuk jadi 1 kanvas panjang bergaya "kertas
//      catatan", lalu diexport sebagai PNG buffer siap dikirim lewat
//      sock.sendMessage(jid, { image: buffer, caption: ... }).
// =====================================================
const fs = require("fs");
const axios = require("axios");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");

const FONT_REGULAR_PATH =
  process.env.SOLUTION_FONT_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const FONT_BOLD_PATH =
  process.env.SOLUTION_FONT_BOLD_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_ITALIC_PATH =
  process.env.SOLUTION_FONT_ITALIC_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf";
const FONT_FAMILY = "SolutionFont";

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  fontsReady = true;
  for (const [path, variant] of [
    [FONT_REGULAR_PATH, FONT_FAMILY],
    [FONT_BOLD_PATH, `${FONT_FAMILY}-Bold`],
    [FONT_ITALIC_PATH, `${FONT_FAMILY}-Italic`],
  ]) {
    if (fs.existsSync(path)) {
      GlobalFonts.registerFromPath(path, variant);
    } else {
      console.log(`⚠️ [solutionImage] font tidak ditemukan: ${path}`);
    }
  }
}

// =====================================================
// 1. PARSING -- pecah teks jadi segmen { type: "text"|"math"|"table" }
// =====================================================

// Deteksi cepat: worth-it dirender jadi gambar kalau ada blok $$..$$,
// $..$ (yang beneran matematika, bukan cuma tanda dolar biasa/harga), atau
// tabel markdown (>=2 baris berturut yang mengandung "|").
function hasRenderableContent(text) {
  if (!text) return false;
  if (/\$\$[\s\S]+?\$\$/.test(text)) return true;
  if (/(?<!\d)\$[^\s$][^$]{0,200}?\$(?!\d)/.test(text)) return true;
  if (/(^|\n)\s*\|.+\|\s*\n\s*\|[\s:|-]+\|\s*\n(\s*\|.*\|\s*\n?)+/.test(text)) {
    return true;
  }
  return false;
}

function parseSegments(text) {
  const segments = [];
  let rest = text;

  // Regex gabungan: cocokkan salah satu dari (a) tabel markdown blok,
  // (b) $$..$$, (c) $..$ -- dicek berurutan dari index paling depan yang
  // ketemu duluan.
  const tableRe = /(^|\n)([ \t]*\|.+\|[ \t]*\n[ \t]*\|[\s:|-]+\|[ \t]*\n(?:[ \t]*\|.*\|[ \t]*\n?)+)/;
  const blockMathRe = /\$\$([\s\S]+?)\$\$/;
  const inlineMathRe = /(?<!\d)\$([^\s$][^$]{0,300}?)\$(?!\d)/;

  while (rest.length > 0) {
    const tableMatch = rest.match(tableRe);
    const blockMatch = rest.match(blockMathRe);
    const inlineMatch = rest.match(inlineMathRe);

    const candidates = [
      tableMatch && { type: "table", match: tableMatch, index: tableMatch.index + tableMatch[1].length },
      blockMatch && { type: "math", display: true, match: blockMatch, index: blockMatch.index },
      inlineMatch && { type: "math", display: false, match: inlineMatch, index: inlineMatch.index },
    ].filter(Boolean);

    if (candidates.length === 0) {
      pushText(segments, rest);
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const winner = candidates[0];

    pushText(segments, rest.slice(0, winner.index));

    if (winner.type === "table") {
      const rows = parseMarkdownTable(winner.match[2]);
      if (rows) segments.push({ type: "table", ...rows });
      rest = rest.slice(winner.index + winner.match[2].length);
    } else {
      const latex = winner.match[1].trim();
      if (latex) segments.push({ type: "math", latex, display: winner.display });
      rest = rest.slice(winner.index + winner.match[0].length);
    }
  }

  return segments;
}

function pushText(segments, chunk) {
  const cleaned = chunk.replace(/\n{3,}/g, "\n\n");
  if (cleaned.trim()) segments.push({ type: "text", value: cleaned.trim() });
}

function parseMarkdownTable(block) {
  const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const splitRow = (line) =>
    line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return { header, rows };
}

// =====================================================
// 2. RENDER RUMUS -- lewat CodeCogs (butuh internet, di-skip kalau gagal)
// =====================================================
async function renderLatexPng(latex, display) {
  const dpi = display ? 180 : 150;
  const url = `https://latex.codecogs.com/png.image?\\dpi{${dpi}}\\color{Black}${encodeURIComponent(
    display ? `\\displaystyle ${latex}` : latex,
  )}`;
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 10000 });
  return await loadImage(Buffer.from(res.data));
}

// =====================================================
// 3. RENDER TABEL -- manual pakai canvas, gak butuh internet
// =====================================================
function renderTableCanvas(header, rows) {
  ensureFonts();
  const PAD = 14;
  const FONT_SIZE = 22;
  const font = `${FONT_SIZE}px "${FONT_FAMILY}"`;
  const fontBold = `bold ${FONT_SIZE}px "${FONT_FAMILY}-Bold"`;

  const measureCtx = createCanvas(10, 10).getContext("2d");
  const allRows = [header, ...rows];
  const colCount = header.length;
  const colWidths = new Array(colCount).fill(0);

  allRows.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      if (ci >= colCount) return;
      measureCtx.font = ri === 0 ? fontBold : font;
      const w = measureCtx.measureText(cell || "").width;
      colWidths[ci] = Math.max(colWidths[ci], w + PAD * 2, 60);
    });
  });

  const rowHeight = FONT_SIZE + PAD * 1.4;
  const tableWidth = colWidths.reduce((a, b) => a + b, 0) + 1;
  const tableHeight = rowHeight * allRows.length + 1;

  const canvas = createCanvas(Math.ceil(tableWidth), Math.ceil(tableHeight));
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  allRows.forEach((row, ri) => {
    let x = 0;
    const y = ri * rowHeight;
    ctx.fillStyle = ri === 0 ? "#7a3b6d" : ri % 2 === 0 ? "#faf5f8" : "#ffffff";
    ctx.fillRect(0, y, tableWidth, rowHeight);

    row.forEach((cell, ci) => {
      if (ci >= colCount) return;
      ctx.strokeStyle = "#d8c3d3";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, colWidths[ci], rowHeight);

      ctx.font = ri === 0 ? fontBold : font;
      ctx.fillStyle = ri === 0 ? "#ffffff" : "#332633";
      ctx.textBaseline = "middle";
      ctx.fillText(cell || "", x + PAD, y + rowHeight / 2 + 1);
      x += colWidths[ci];
    });
  });

  return canvas;
}

// =====================================================
// 4. WRAP TEKS BIASA
// =====================================================
function wrapPlainText(ctx, text, font, maxWidth) {
  ctx.font = font;
  const paragraphs = text.split("\n");
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    lines.push(current);
  }
  return lines;
}

// Hilangkan tanda *italic gesture* / **bold** markdown yang gak perlu di
// dalam gambar (biar gak ada tanda bintang nyasar di teks hasil render).
function stripMarkup(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1");
}

// =====================================================
// 5. COMPOSE -- gabung semua segmen jadi 1 gambar "lembar jawaban"
// =====================================================
async function buildSolutionImage(fullText, { title } = {}) {
  ensureFonts();

  const CANVAS_WIDTH = 900;
  const MARGIN = 36;
  const CONTENT_WIDTH = CANVAS_WIDTH - MARGIN * 2;
  const LINE_HEIGHT = 30;
  const BODY_FONT = `20px "${FONT_FAMILY}"`;
  const TITLE_FONT = `bold 26px "${FONT_FAMILY}-Bold"`;

  const segments = parseSegments(fullText);

  // Render dulu tiap blok jadi gambar/lines terpisah (pass 1), sekalian
  // hitung total tinggi kanvas final (pass ini juga yang nentuin urutan
  // gambar ditumpuk).
  const rendered = [];
  let totalHeight = MARGIN * 2 + (title ? 44 : 0);

  const measureCtx = createCanvas(10, 10).getContext("2d");

  for (const seg of segments) {
    if (seg.type === "text") {
      const lines = wrapPlainText(measureCtx, stripMarkup(seg.value), BODY_FONT, CONTENT_WIDTH);
      rendered.push({ type: "text", lines });
      totalHeight += lines.length * LINE_HEIGHT + 10;
    } else if (seg.type === "math") {
      try {
        const img = await renderLatexPng(seg.latex, seg.display);
        const scale = Math.min(1, CONTENT_WIDTH / img.width);
        const w = img.width * scale;
        const h = img.height * scale;
        rendered.push({ type: "math-img", img, w, h });
        totalHeight += h + 20;
      } catch (err) {
        console.log("[solutionImage] gagal render LaTeX, fallback teks:", err.message || err);
        const raw = seg.display ? `$$${seg.latex}$$` : `$${seg.latex}$`;
        const lines = wrapPlainText(measureCtx, raw, BODY_FONT, CONTENT_WIDTH);
        rendered.push({ type: "text", lines, mono: true });
        totalHeight += lines.length * LINE_HEIGHT + 10;
      }
    } else if (seg.type === "table") {
      const tableCanvas = renderTableCanvas(seg.header, seg.rows);
      const scale = Math.min(1, CONTENT_WIDTH / tableCanvas.width);
      const w = tableCanvas.width * scale;
      const h = tableCanvas.height * scale;
      rendered.push({ type: "table-img", canvas: tableCanvas, w, h });
      totalHeight += h + 20;
    }
  }

  totalHeight += MARGIN;

  const canvas = createCanvas(CANVAS_WIDTH, Math.ceil(totalHeight));
  const ctx = canvas.getContext("2d");

  // Background "kertas catatan"
  ctx.fillStyle = "#fffaf5";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#f0c9dd";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);

  let y = MARGIN;

  if (title) {
    ctx.font = TITLE_FONT;
    ctx.fillStyle = "#7a3b6d";
    ctx.textBaseline = "top";
    ctx.fillText(title, MARGIN, y);
    y += 44;
  }

  for (const item of rendered) {
    if (item.type === "text") {
      ctx.font = item.mono ? `18px "${FONT_FAMILY}"` : BODY_FONT;
      ctx.fillStyle = "#2b2230";
      ctx.textBaseline = "top";
      for (const line of item.lines) {
        ctx.fillText(line, MARGIN, y);
        y += LINE_HEIGHT;
      }
      y += 10;
    } else if (item.type === "math-img") {
      ctx.drawImage(item.img, MARGIN, y, item.w, item.h);
      y += item.h + 20;
    } else if (item.type === "table-img") {
      ctx.drawImage(item.canvas, MARGIN, y, item.w, item.h);
      y += item.h + 20;
    }
  }

  return canvas.toBuffer("image/png");
}

module.exports = {
  hasRenderableContent,
  buildSolutionImage,
};
