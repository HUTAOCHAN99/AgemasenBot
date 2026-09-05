const { createCanvas } = require("@napi-rs/canvas");
const { splitTextEmoji, getEmojiImage, ensureFontsRegistered, MEME_FONT_FAMILY, preloadEmojisInText } = require("./emoji");

// Ukur lebar total 1 baris (campuran teks+emoji), emoji dihitung selebar
// fontSize (persegi).
function measureSegments(ctx, segments, fontSize) {
  let width = 0;
  for (const seg of segments) {
    width += seg.type === "emoji" ? fontSize : ctx.measureText(seg.value).width;
  }
  return width;
}

// Pecah teks (boleh mengandung emoji) jadi baris-baris yang muat dalam
// maxWidth. Wrapping dilakukan per KATA (dipisah spasi), tapi emoji di
// dalam kata tetap dihitung sebagai unit lebar sendiri lewat measureSegments.
function wrapMixedText(ctx, text, fontSize, maxWidth) {
  ctx.font = `bold ${fontSize}px "${MEME_FONT_FAMILY}"`;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let current = [];

  for (const word of words) {
    // untuk kata kedua dst, gabungkan spasi ke potongan pertama word itu
    const candidateSegments = current.length
      ? [...current, ...prependSpace(splitTextEmoji(word))]
      : splitTextEmoji(word);

    if (
      current.length &&
      measureSegments(ctx, candidateSegments, fontSize) > maxWidth
    ) {
      lines.push(current);
      current = splitTextEmoji(word);
    } else {
      current = candidateSegments;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

function prependSpace(segments) {
  if (segments.length === 0) return segments;
  const [first, ...rest] = segments;
  if (first.type === "text") {
    return [{ type: "text", value: " " + first.value }, ...rest];
  }
  return [{ type: "text", value: " " }, first, ...rest];
}

// Cari ukuran font terbesar (mulai dari startSize, turun bertahap) yang
// bikin teks tetap muat dalam maxWidth x maxLines baris.
function fitMixedTextLines(
  ctx,
  text,
  { startSize, maxWidth, maxLines, minSize = 20 },
) {
  for (let size = startSize; size >= minSize; size -= 2) {
    const lines = wrapMixedText(ctx, text, size, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
  }
  return { size: minSize, lines: wrapMixedText(ctx, text, minSize, maxWidth) };
}

// Gambar 1 baris (segmen teks+emoji campuran) terpusat secara horizontal
// di y tertentu. Teks pakai stroke hitam + fill putih (gaya meme klasik);
// emoji ditempel apa adanya (drawImage) sejajar tengah baris itu.
function drawMixedLine(ctx, segments, centerX, y, fontSize) {
  ctx.font = `bold ${fontSize}px "${MEME_FONT_FAMILY}"`;
  const totalWidth = measureSegments(ctx, segments, fontSize);
  let x = centerX - totalWidth / 2;

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(4, Math.round(fontSize / 9));

  for (const seg of segments) {
    if (seg.type === "emoji") {
      const img = emojiImageCache.get(emojiToCodepoints(seg.value));
      if (img) {
        ctx.drawImage(img, x, y - fontSize / 2, fontSize, fontSize);
      }
      x += fontSize;
    } else {
      ctx.strokeStyle = "black";
      ctx.fillStyle = "white";
      ctx.strokeText(seg.value, x, y);
      ctx.fillText(seg.value, x, y);
      x += ctx.measureText(seg.value).width;
    }
  }
}

// Render teks atas/bawah (bisa berisi emoji WA) jadi 1 lembar PNG 512x512
// transparan, siap di-overlay ke frame video/gif. `marginTop`/`marginBottom`
// = jarak aman dari tepi (dihitung computeSafeMargins berdasar rasio asli
// video sumber).
async function renderMemeOverlayPng({ top, bottom, marginTop, marginBottom }) {
  ensureFontsRegistered();
  await Promise.all([preloadEmojisInText(top), preloadEmojisInText(bottom)]);

  const CANVAS_SIZE = 512;
  const MAX_WIDTH = 470;
  const START_SIZE = 46;
  const MAX_LINES = 3;
  const LINE_HEIGHT = 1.15;

  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d");

  if (top) {
    const { size, lines } = fitMixedTextLines(ctx, top, {
      startSize: START_SIZE,
      maxWidth: MAX_WIDTH,
      maxLines: MAX_LINES,
    });
    const lineGap = size * LINE_HEIGHT;
    let y = marginTop + size / 2;
    for (const line of lines) {
      drawMixedLine(ctx, line, CANVAS_SIZE / 2, y, size);
      y += lineGap;
    }
  }

  if (bottom) {
    const { size, lines } = fitMixedTextLines(ctx, bottom, {
      startSize: START_SIZE,
      maxWidth: MAX_WIDTH,
      maxLines: MAX_LINES,
    });
    const lineGap = size * LINE_HEIGHT;
    const totalHeight = lineGap * (lines.length - 1);
    let y = CANVAS_SIZE - marginBottom - size / 2 - totalHeight;
    for (const line of lines) {
      drawMixedLine(ctx, line, CANVAS_SIZE / 2, y, size);
      y += lineGap;
    }
  }

  return canvas.toBuffer("image/png");
}

module.exports = {
  measureSegments,
  wrapMixedText,
  prependSpace,
  fitMixedTextLines,
  drawMixedLine,
  renderMemeOverlayPng,
};
