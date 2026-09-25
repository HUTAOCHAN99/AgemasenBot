const fs = require("fs");
const axios = require("axios");

const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");

// Path font teks (bukan emoji). Bisa dioverride lewat env var kalau lokasinya
// beda di server.
const MEME_FONT_PATH =
  process.env.MEME_FONT_PATH ||
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const MEME_FONT_FAMILY = "MemeFont";

// Sumber gambar emoji (Twemoji), bisa dioverride lewat env var kalau CDN ini
// diblokir di server. {code} diganti dengan codepoint hex (mis. "1f602").
const EMOJI_IMAGE_BASE_URL =
  process.env.EMOJI_IMAGE_BASE_URL ||
  "https://raw.githubusercontent.com/jdecked/twemoji/main/assets/72x72";

let fontsRegistered = false;

function ensureFontsRegistered() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (fs.existsSync(MEME_FONT_PATH)) {
    GlobalFonts.registerFromPath(MEME_FONT_PATH, MEME_FONT_FAMILY);
  } else {
    console.log(
      `⚠️ Font meme tidak ditemukan di ${MEME_FONT_PATH} (set env MEME_FONT_PATH).`,
    );
  }
}

// Regex Unicode buat nangkep 1 "cluster" emoji utuh supaya tidak kepotong
// jadi beberapa gambar terpisah. Mendukung:
//   - bendera (2 regional indicator, mis. 🇮🇩)
//   - emoji + variation selector (❤️) dan skin tone (👍🏽)
//   - emoji gabungan pakai ZWJ (👨‍👩‍👧, ❤️‍🔥, 🧑🏽‍💻)
const EMOJI_MODIFIER = "[\\u{1F3FB}-\\u{1F3FF}]";
const EMOJI_UNIT = `\\p{Extended_Pictographic}\\uFE0F?${EMOJI_MODIFIER}?`;
const EMOJI_REGEX = new RegExp(
  `\\p{Regional_Indicator}{2}|${EMOJI_UNIT}(?:\\u200D${EMOJI_UNIT})*`,
  "gu",
);

// "😂" -> "1f602" (dipakai buat nama file Twemoji). Aturan Twemoji:
// variation selector (U+FE0F) dibuang, KECUALI untuk emoji gabungan pakai
// ZWJ (U+200D) -- di situ FE0F harus tetap ada (mis. 2764-fe0f-200d-1f525).
function emojiToCodepoints(emoji) {
  const hasZwj = emoji.includes("\u200D");
  return Array.from(emoji)
    .map((ch) => ch.codePointAt(0))
    .filter((cp) => hasZwj || cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join("-");
}

// Pecah teks jadi array segmen { type: "text" | "emoji", value }.
function splitTextEmoji(text) {
  const segments = [];
  let lastIndex = 0;

  for (const match of text.matchAll(EMOJI_REGEX)) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        value: text.slice(lastIndex, match.index),
      });
    }
    segments.push({ type: "emoji", value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments;
}

// Cache in-memory: codepoint -> Image (atau null kalau gagal/tidak ada,
// supaya tidak coba fetch berulang-ulang untuk emoji yang sama yang gagal).
const emojiImageCache = new Map();

async function getEmojiImage(emoji) {
  const code = emojiToCodepoints(emoji);
  if (emojiImageCache.has(code)) return emojiImageCache.get(code);

  try {
    const res = await axios.get(`${EMOJI_IMAGE_BASE_URL}/${code}.png`, {
      responseType: "arraybuffer",
      timeout: 8000,
    });
    const img = await loadImage(Buffer.from(res.data));
    emojiImageCache.set(code, img);
    return img;
  } catch (err) {
    console.log(
      `⚠️ Gagal ambil gambar emoji "${emoji}" (${code}):`,
      err.message,
    );
    // Cache "tidak ada" HANYA kalau memang 404 (emoji tidak ada di Twemoji).
    // Gagal karena jaringan/timeout gak di-cache, biar dicoba lagi lain kali
    // (kalau di-cache, emoji itu hilang terus sampai bot direstart).
    if (err.response && err.response.status === 404) {
      emojiImageCache.set(code, null);
    }
    return null;
  }
}

// Pra-load semua emoji unik yang dipakai di sebuah teks (dipanggil sebelum
// render, supaya proses gambar di canvas sendiri tetap synchronous/simpel).
async function preloadEmojisInText(text) {
  if (!text) return;
  const emojis = new Set(
    splitTextEmoji(text)
      .filter((s) => s.type === "emoji")
      .map((s) => s.value),
  );
  await Promise.all([...emojis].map(getEmojiImage));
}

module.exports = {
  MEME_FONT_PATH,
  MEME_FONT_FAMILY,
  EMOJI_IMAGE_BASE_URL,
  ensureFontsRegistered,
  emojiToCodepoints,
  splitTextEmoji,
  getEmojiImage,
  preloadEmojisInText,
  emojiImageCache,
};