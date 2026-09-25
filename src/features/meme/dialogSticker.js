const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const {
  splitTextEmoji,
  preloadEmojisInText,
  emojiImageCache,
  emojiToCodepoints,
} = require("./emoji");

// =====================================================
// Fitur: "!schat Nama|Pesan|badge" -- stiker "dialog chat" ala screenshot
// WhatsApp (avatar bulat + nama pengirim + bubble pesan).
//
// Layout & rumus render DIPORT LANGSUNG dari prototype
// "dialog-sticker-generator.html" yang dikirim user (renderDialogSticker,
// wrapLines, drawAvatar, roundRectPath, dst) -- cuma dipindah dari Canvas
// browser ke @napi-rs/canvas (Node), dan render teks-nya dibikin sadar
// EMOJI (dipakai bareng emoji.js, sama seperti bratSticker.js) karena
// font sistem (DejaVu Sans) gak punya glyph emoji berwarna.
//
// Avatar itu OPSIONAL: kalau user reply/kirim gambar bareng "!schat",
// gambar itu dipakai (di-crop bulat). Kalau enggak ada, fallback ke
// lingkaran warna solid (dari nama, deterministik) + huruf awal nama --
// sama seperti fallbackPalette() di HTML generator-nya.
// =====================================================

// Font sistem yang sudah pasti ada di server (dipakai fitur lain juga --
// lihat emoji.js untuk MEME_FONT_PATH & bratSticker.js untuk fallback-nya).
// Bisa dioverride lewat env kalau lokasinya beda.
const NAME_FONT_PATH =
  process.env.DIALOG_NAME_FONT_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const MSG_FONT_PATH =
  process.env.DIALOG_MSG_FONT_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const NAME_FONT_FAMILY = "DialogNameFont";
const MSG_FONT_FAMILY = "DialogMsgFont";

let fontsRegistered = false;
function ensureDialogFontsRegistered() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (fs.existsSync(NAME_FONT_PATH)) {
    GlobalFonts.registerFromPath(NAME_FONT_PATH, NAME_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font nama dialog tidak ditemukan di ${NAME_FONT_PATH} (set env DIALOG_NAME_FONT_PATH).`,
    );
  }
  if (fs.existsSync(MSG_FONT_PATH)) {
    GlobalFonts.registerFromPath(MSG_FONT_PATH, MSG_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font pesan dialog tidak ditemukan di ${MSG_FONT_PATH} (set env DIALOG_MSG_FONT_PATH).`,
    );
  }
}

// --- Parameter layout (nilai sama persis dengan CONFIG di
// dialog-sticker-generator.html) -----------------------------------------
const CONFIG = {
  avatarSize: 68,
  bubbleRadius: 18,
  bubbleRadiusTL: 8,
  bubblePaddingX: 22,
  bubblePaddingY: 18,
  nameFontSize: 30,
  messageFontSize: 22,
  maxBubbleWidth: 440,
  minBubbleWidth: 240,
  canvasPadding: 18,
  lineHeightMul: 1.32,
  bubbleFill: "#f7f5f2",
  bubbleShadow: "rgba(0,0,0,0.14)",
  nameColor: "#f58a25",
  messageColor: "#1d1d1d",
  renderScale: 3, // supersample lebih tinggi dari versi web (2x) karena hasil akhir di-downscale ke kanvas stiker
  nameColorPalette: [
    "#e17055", "#d35400", "#e67e22", "#c0392b", "#d63031",
    "#e84393", "#a55eea", "#8e44ad", "#6c5ce7", "#0984e3",
    "#0fb9b1", "#00b894", "#20bf6b", "#2e86de", "#eb3b5a",
  ],
};

// Batas biar rendernya cepat & stikernya gak jadi raksasa gak jelas.
const MAX_NAME_CHARS = 40;
const MAX_MESSAGE_CHARS = 500;

// --- Teks + emoji: ukur & gambar ----------------------------------------
// Emoji digambar sebagai gambar persegi (Twemoji, lewat emoji.js) karena
// font DejaVu Sans gak punya glyph emoji berwarna. Ukuran relatif ke
// font size teks di sekitarnya.
const EMOJI_SIZE_EM = 0.92;
const EMOJI_TOP_EM = 0.02;

function getEmojiImg(emoji) {
  return emojiImageCache.get(emojiToCodepoints(emoji)) || null;
}

function stripUnavailableEmoji(text) {
  return splitTextEmoji(text)
    .filter((seg) => seg.type !== "emoji" || getEmojiImg(seg.value))
    .map((seg) => seg.value)
    .join("");
}

function emojiBox(size) {
  return size * EMOJI_SIZE_EM;
}

// Lebar 1 "kata" (campuran teks + emoji) dengan konteks font yang sedang
// aktif di ctx (nameFont/messageFont beda ukuran, jadi ctx harus sudah
// di-set font-nya SEBELUM manggil ini).
function measureWordEmoji(ctx, word, size) {
  let width = 0;
  for (const seg of splitTextEmoji(word)) {
    width += seg.type === "emoji" ? emojiBox(size) : ctx.measureText(seg.value).width;
  }
  return width;
}

// Pecah 1 kata jadi unit-unit sekecil mungkin buat forced-break (1 huruf
// teks, atau 1 emoji utuh -- emoji gabungan gak boleh kepotong tengah).
function splitUnitsEmoji(word) {
  return splitTextEmoji(word).flatMap((seg) =>
    seg.type === "emoji" ? [seg.value] : Array.from(seg.value),
  );
}

function breakLongWordEmoji(ctx, word, maxWidth, size) {
  if (measureWordEmoji(ctx, word, size) <= maxWidth) return [word];

  const chunks = [];
  let current = "";
  for (const unit of splitUnitsEmoji(word)) {
    const test = current + unit;
    if (current && measureWordEmoji(ctx, test, size) > maxWidth) {
      chunks.push(current);
      current = unit;
    } else {
      current = test;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Word-wrap per paragraf (baris baru manual dari "\n" tetap dihormati),
// sadar emoji & kata kepanjangan (dipenggal paksa) -- port dari
// wrapLines() di dialog-sticker-generator.html, ditambah dukungan emoji.
function wrapLinesEmoji(ctx, text, maxWidth, size) {
  const paragraphs = String(text).split("\n");
  const lines = [];

  for (const para of paragraphs) {
    if (para === "") {
      lines.push("");
      continue;
    }

    const words = para
      .split(" ")
      .flatMap((w) => breakLongWordEmoji(ctx, w, maxWidth, size));

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current === "" || measureWordEmoji(ctx, candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines;
}

// Gambar 1 baris teks (bisa campur teks+emoji) di (x, y) -- textBaseline
// HARUS "alphabetic" & textAlign "left" sebelum manggil ini. `y` dianggap
// baseline teks; emoji digambar sedikit di atas baseline supaya optically
// center dengan huruf teks di sekitarnya.
function drawTextEmojiRun(ctx, text, x, y, size) {
  let cursor = x;
  for (const seg of splitTextEmoji(text)) {
    if (seg.type === "emoji") {
      const img = getEmojiImg(seg.value);
      if (img) {
        const box = emojiBox(size);
        ctx.drawImage(img, cursor, y - size * (0.78 - EMOJI_TOP_EM), box, box);
      }
      cursor += emojiBox(size);
    } else {
      ctx.fillText(seg.value, cursor, y);
      cursor += ctx.measureText(seg.value).width;
    }
  }
}

// --- Avatar --------------------------------------------------------------
function fallbackPalette(seed) {
  const palettes = ["#2f6f5a", "#7a4fb5", "#c1573a", "#2b6ea8", "#9b8b2c", "#b2497e"];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palettes[h % palettes.length];
}

function drawAvatar(ctx, img, cx, cy, size, senderName) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (img) {
    const s = Math.max(size / img.width, size / img.height);
    const w = img.width * s;
    const h = img.height * s;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = fallbackPalette(senderName || "A");
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `700 ${Math.round(size * 0.42)}px "${NAME_FONT_FAMILY}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((senderName || "A").trim().charAt(0).toUpperCase(), cx, cy + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
}

// --- Bubble ----------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r, cornerTL) {
  const rTL = cornerTL === undefined ? r : cornerTL;
  ctx.beginPath();
  ctx.moveTo(x + rTL, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, rTL);
  ctx.closePath();
}

// Render "kartu" dialog (avatar + nama + bubble) -> canvas @napi-rs/canvas
// berukuran pas konten (BUKAN kanvas stiker 512x512 -- itu dipadding di
// textToDialogSticker). Port dari renderDialogSticker() di
// dialog-sticker-generator.html.
function renderDialogCanvasSync({ avatarImg, senderName, badge, message, nameColor }) {
  ensureDialogFontsRegistered();
  const cfg = CONFIG;
  const scale = cfg.renderScale;

  const measureCanvas = createCanvas(10, 10);
  const mctx = measureCanvas.getContext("2d");

  const avatarSize = cfg.avatarSize;
  const avatarCx = cfg.canvasPadding + avatarSize / 2 + 8;
  const avatarCy = cfg.canvasPadding + avatarSize / 2;
  const nameX = avatarCx + avatarSize / 2 + 12;
  const nameBaseline = avatarCy + 10;

  const contentMaxWidth = cfg.maxBubbleWidth - cfg.bubblePaddingX * 2;

  mctx.font = `bold ${cfg.nameFontSize}px "${NAME_FONT_FAMILY}"`;
  const nameWidth = measureWordEmoji(mctx, senderName, cfg.nameFontSize);
  const badgeSize = cfg.nameFontSize - 2;
  const badgeWidth = badge ? measureWordEmoji(mctx, badge, badgeSize) : 0;

  mctx.font = `${cfg.messageFontSize}px "${MSG_FONT_FAMILY}"`;
  const msgLines = wrapLinesEmoji(mctx, message, contentMaxWidth, cfg.messageFontSize);
  let msgMaxLine = 0;
  for (const l of msgLines) {
    msgMaxLine = Math.max(msgMaxLine, measureWordEmoji(mctx, l, cfg.messageFontSize));
  }

  const bubbleWidth = Math.min(
    Math.max(msgMaxLine + cfg.bubblePaddingX * 2, cfg.minBubbleWidth),
    cfg.maxBubbleWidth,
  );
  const lineHeight = cfg.messageFontSize * cfg.lineHeightMul;
  const bubbleHeight = cfg.bubblePaddingY * 2 + msgLines.length * lineHeight;

  const bubbleX = Math.max(cfg.canvasPadding + 10, nameX - 18);
  const bubbleY = avatarCy + 34;

  const totalW = Math.max(
    bubbleX + bubbleWidth + cfg.canvasPadding,
    avatarCx + avatarSize + cfg.canvasPadding,
    nameX + nameWidth + (badge ? 8 + badgeWidth : 0) + cfg.canvasPadding,
  );
  const totalH = bubbleY + bubbleHeight + cfg.canvasPadding + 8;

  const canvas = createCanvas(Math.ceil(totalW * scale), Math.ceil(totalH * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, totalW, totalH);

  drawAvatar(ctx, avatarImg, avatarCx, avatarCy, avatarSize, senderName);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${cfg.nameFontSize}px "${NAME_FONT_FAMILY}"`;
  ctx.fillStyle = nameColor;
  drawTextEmojiRun(ctx, senderName, nameX, nameBaseline, cfg.nameFontSize);

  if (badge) {
    ctx.font = `${badgeSize}px "${MSG_FONT_FAMILY}"`;
    drawTextEmojiRun(ctx, badge, nameX + nameWidth + 8, nameBaseline, badgeSize);
  }

  ctx.save();
  ctx.shadowColor = cfg.bubbleShadow;
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  roundRectPath(ctx, bubbleX, bubbleY, bubbleWidth, bubbleHeight, cfg.bubbleRadius, cfg.bubbleRadiusTL);
  ctx.fillStyle = cfg.bubbleFill;
  ctx.fill();
  ctx.restore();

  // "Ekor" kecil bubble, nunjuk ke arah avatar (sama seperti HTML asli).
  ctx.beginPath();
  ctx.moveTo(bubbleX - 18, bubbleY + 18);
  ctx.lineTo(bubbleX + 10, bubbleY + 30);
  ctx.lineTo(bubbleX - 2, bubbleY + 52);
  ctx.closePath();
  ctx.fillStyle = cfg.bubbleFill;
  ctx.fill();

  ctx.font = `${cfg.messageFontSize}px "${MSG_FONT_FAMILY}"`;
  ctx.fillStyle = cfg.messageColor;
  let ly = bubbleY + cfg.bubblePaddingY + cfg.messageFontSize * 0.86;
  for (const line of msgLines) {
    drawTextEmojiRun(ctx, line, bubbleX + cfg.bubblePaddingX, ly, cfg.messageFontSize);
    ly += lineHeight;
  }

  return canvas;
}

function pickRandomNameColor() {
  const palette = CONFIG.nameColorPalette;
  return palette[Math.floor(Math.random() * palette.length)];
}

// Dipanggil dari router: { avatarBuffer?, senderName, badge?, message,
// randomNameColor? } -> Buffer WebP siap kirim sbg stiker WA (statis,
// dipadding transparan ke kanvas 512x512 seperti !s/!meme/!sbrat).
async function textToDialogSticker({
  avatarBuffer,
  senderName,
  badge = "",
  message,
  randomNameColor = false,
}) {
  ensureDialogFontsRegistered();

  const cleanName = String(senderName || "Sender").replace(/\s+/g, " ").trim() || "Sender";
  const cleanBadge = String(badge || "").trim();
  const cleanMessage = String(message || " ");

  // Emoji yang gagal di-fetch dibuang dulu (bukan jadi kotak kosong).
  await preloadEmojisInText(`${cleanName} ${cleanBadge} ${cleanMessage}`);
  const finalName = stripUnavailableEmoji(cleanName) || "Sender";
  const finalBadge = stripUnavailableEmoji(cleanBadge);
  const finalMessage = stripUnavailableEmoji(cleanMessage) || " ";

  let avatarImg = null;
  if (avatarBuffer) {
    try {
      avatarImg = await loadImage(avatarBuffer);
    } catch (err) {
      console.log("⚠️ Gagal load avatar buat !schat, lanjut tanpa avatar:", err.message);
      avatarImg = null;
    }
  }

  const nameColor = randomNameColor ? pickRandomNameColor() : CONFIG.nameColor;

  const canvas = renderDialogCanvasSync({
    avatarImg,
    senderName: finalName,
    badge: finalBadge,
    message: finalMessage,
    nameColor,
  });

  const contentPng = canvas.toBuffer("image/png");

  // Padding transparan ke kanvas stiker WA 512x512 (konten diperkecil kalau
  // perlu, TIDAK di-crop) -- konvensi yang sama dengan !s/!meme/!smeme.
  const STICKER_SIZE = 512;
  const resized = await sharp(contentPng)
    .resize(STICKER_SIZE, STICKER_SIZE, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .toBuffer();
  const meta = await sharp(resized).metadata();

  const padded = await sharp({
    create: {
      width: STICKER_SIZE,
      height: STICKER_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: resized,
        left: Math.max(0, Math.round((STICKER_SIZE - meta.width) / 2)),
        top: Math.max(0, Math.round((STICKER_SIZE - meta.height) / 2)),
      },
    ])
    .png()
    .toBuffer();

  return sharp(padded).webp({ quality: 92 }).toBuffer();
}

module.exports = {
  MAX_NAME_CHARS,
  MAX_MESSAGE_CHARS,
  CONFIG,
  wrapLinesEmoji,
  renderDialogCanvasSync,
  textToDialogSticker,
};
