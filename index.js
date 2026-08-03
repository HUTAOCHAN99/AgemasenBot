console.log("Program dimulai");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const sharp = require("sharp");

// =====================================================
// Session per pengguna (bukan per chat/grup)
// key -> { tag, pool: [post,...], lastId }
// pool = sisa kandidat yang belum ditampilkan ke user ini
// =====================================================
const sessions = new Map();

// =====================================================
// Kode sesi per-chat (BUKAN per-pengirim)
// Supaya siapa pun di grup yang sama bisa ketik angka kodenya buat lanjut
// (!next) pencarian tertentu -- termasuk pencarian milik orang lain --
// tanpa bentrok dengan pencarian orang lain di grup yang sama.
//
// Objeknya SAMA PERSIS (reference yang sama) dengan yang disimpan di
// `sessions` untuk pemilik aslinya, jadi kalau pool-nya berubah (baik lewat
// "!next" ketik teks oleh pemiliknya, ATAU lewat siapa pun ketik kodenya)
// keduanya otomatis tetap sinkron.
//
// jid -> Map<kode(number), session>
const chatCodeSessions = new Map();
// jid -> kode berikutnya yang akan dipakai
const chatNextCode = new Map();

// Kasih (atau pakai ulang) kode sesi untuk satu hasil pencarian di 1 chat.
// Kode ini SENGAJA di-scope per-chat (bukan global bot), jadi grup A dan
// grup B bisa sama-sama punya "kode 1" tanpa saling ganggu.
function assignSessionCode(jid, session) {
  if (session.code) return session.code; // sesi ini sudah punya kode, pakai lagi

  const next = (chatNextCode.get(jid) || 0) + 1;
  chatNextCode.set(jid, next);
  session.code = next;

  if (!chatCodeSessions.has(jid)) chatCodeSessions.set(jid, new Map());
  chatCodeSessions.get(jid).set(next, session);

  return next;
}

// Safebooru's dapi menolak permintaan "limit" di atas 100 dalam satu request,
// jadi buat ambil SEMUA post (tanpa batas), kita harus paging pakai "pid"
// (page index, 0-based) sampai halaman yang balik lebih pendek dari
// API_PAGE_SIZE (berarti itu halaman terakhir).
const API_PAGE_SIZE = 100;

// "tokai_teio_(umamusume)" -> "Tokai Teio (Umamusume)"
function prettifyTag(tag) {
  return tag
    .replace(/_/g, " ")
    .replace(
      /\w\S*/g,
      (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    );
}

// Kunci session unik per pengirim asli.
// Di chat pribadi: remoteJid sudah unik per orang.
// Di grup: remoteJid sama untuk semua anggota, jadi wajib digabung
// dengan participant supaya 2 orang di grup yang sama tidak bentrok.
function getSessionKey(msg) {
  const jid = msg.key.remoteJid;
  const participant = msg.key.participant;
  return participant ? `${jid}::${participant}` : jid;
}

function buildCaption(post, karakterLabel, { isNext = false, code } = {}) {
  const link = `https://safebooru.org/index.php?page=post&s=view&id=${post.id}`;

  const codeLine = code ? `\n🔢 *Kode Sesi:* ${code}` : "";
  const continueLine = code
    ? `➡️ Ketik *${code}* (siapa saja boleh) atau *!next* untuk gambar lain dari pencarian ini`
    : `➡️ Ketik *!next* untuk gambar lain dari pencarian ini`;

  return `🖼️ *Hasil Gambar*${isNext ? " (lanjutan)" : ""}

👤 *Karakter:* ${karakterLabel}${codeLine}
🆔 *Kode Gambar:* ${post.id}
🔗 *Link:* ${link}

${continueLine}
🔁 Ketik *!id ${post.id}* untuk lihat gambar ini lagi kapan saja`;
}

async function fetchCandidates(tag) {
  const url = "https://safebooru.org/index.php";
  const all = [];
  let pid = 0;

  while (true) {
    const res = await axios.get(url, {
      params: {
        page: "dapi",
        s: "post",
        q: "index",
        json: 1,
        limit: API_PAGE_SIZE,
        pid,
        tags: tag,
      },
    });

    if (!Array.isArray(res.data) || res.data.length === 0) break;

    all.push(...res.data);

    if (res.data.length < API_PAGE_SIZE) break; // halaman terakhir, tidak perlu lanjut

    pid++;
  }

  return all.filter((p) => p.file_url);
}

// Safebooru's s=tag&q=index endpoint ignores json=1 and always replies with
// XML (unlike s=post&q=index which does honor json=1). axios won't auto-parse
// that into an object, so res.data comes back as a raw XML string here.
// This pulls the name/count pairs out of <tag ... name="..." count=".../>
// without needing an XML parser dependency.
function parseTagXml(xml) {
  if (typeof xml !== "string") return [];

  const tags = [];
  const tagRegex = /<tag\b[^>]*\/>/g;
  const nameRegex = /\bname="([^"]*)"/;
  const countRegex = /\bcount="([^"]*)"/;

  const matches = xml.match(tagRegex) || [];

  for (const raw of matches) {
    const name = raw.match(nameRegex)?.[1];
    const count = raw.match(countRegex)?.[1];

    if (name) {
      tags.push({ name, count: count ?? "0" });
    }
  }

  return tags;
}

// Cari tag-tag yang mengandung query (mis. "uchiha" -> "uchiha_sasuke", dst)
// dipakai saat pencarian tag persis tidak ketemu gambar sama sekali.
async function fetchMatchingTags(query) {
  const url = "https://safebooru.org/index.php";
  const all = [];
  let pid = 0;

  while (true) {
    const res = await axios.get(url, {
      params: {
        page: "dapi",
        s: "tag",
        q: "index",
        json: 1,
        limit: API_PAGE_SIZE,
        pid,
        name_pattern: `%${query}%`,
      },
      // Force raw text: if we let axios try to auto-parse and it gets XML
      // back (which it always does for this endpoint), the default
      // transform can throw or hand us something unpredictable.
      responseType: "text",
      transformResponse: (data) => data,
    });

    let tags;

    if (Array.isArray(res.data)) {
      // In case Safebooru ever does honor json=1 for this endpoint.
      tags = res.data;
    } else if (
      typeof res.data === "string" &&
      res.data.trim().startsWith("{")
    ) {
      try {
        const parsed = JSON.parse(res.data);
        tags = Array.isArray(parsed)
          ? parsed
          : parsed?.["@attributes"]
            ? []
            : [];
      } catch {
        tags = parseTagXml(res.data);
      }
    } else {
      tags = parseTagXml(res.data);
    }

    if (tags.length === 0) break;

    all.push(...tags);

    if (tags.length < API_PAGE_SIZE) break; // halaman terakhir

    pid++;
  }

  return all
    .filter((t) => Number(t.count) > 0)
    .sort((a, b) => Number(b.count) - Number(a.count));
}

async function fetchById(id) {
  const url = "https://safebooru.org/index.php";

  const res = await axios.get(url, {
    params: {
      page: "dapi",
      s: "post",
      q: "index",
      json: 1,
      limit: 1,
      tags: `id:${id}`,
    },
  });

  if (!Array.isArray(res.data) || res.data.length === 0) return null;

  const post = res.data[0];
  return post.file_url ? post : null;
}

function buildTagChoiceList(tags) {
  const lines = tags
    .map((t, i) => `[${i + 1}] ${prettifyTag(t.name)}`)
    .join("\n");

  return `*KARAKTER DITEMUKAN*
${lines}

_Reply pesan ini dengan nomor urut karakter untuk melihat gambar_`;
}

// Eksekusi pencarian gambar untuk satu tag final (dipakai oleh !img langsung
// maupun setelah user memilih dari daftar disambiguasi), lalu simpan pool
// untuk !next dan kirim gambar pertama.
async function searchAndSendImage(sock, jid, sessionKey, tag, candidates) {
  const post = pickRandom(candidates);

  const session = {
    tag,
    pool: candidates,
    lastId: post.id,
  };

  // Objek session yang sama dipakai baik di `sessions` (buat pemiliknya,
  // dipakai untuk "!next" ketik teks) maupun di `chatCodeSessions` (buat
  // siapa saja di chat ini, dipakai untuk lanjut pakai angka kode).
  sessions.set(sessionKey, session);
  const code = assignSessionCode(jid, session);

  const buffer = await downloadImage(post.file_url);
  const karakterLabel = tag
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(prettifyTag)
    .join(", ");

  await sock.sendMessage(jid, {
    image: buffer,
    caption: buildCaption(post, karakterLabel, { code }),
  });
}

function pickRandom(pool) {
  const idx = Math.floor(Math.random() * pool.length);
  const [post] = pool.splice(idx, 1);
  return post;
}

async function downloadImage(fileUrl) {
  const image = await axios.get(fileUrl, { responseType: "arraybuffer" });
  return Buffer.from(image.data);
}

// Ambil SATU gambar acak dari 1 halaman hasil safebooru saja (tanpa paging
// SEMUA halaman kayak fetchCandidates) -- dipakai cuma buat hiasan !menu,
// jadi cukup cepat & ringan tiap kali user ketik !menu.
async function fetchRandomImageForHelp(tag) {
  try {
    const res = await axios.get("https://safebooru.org/index.php", {
      params: {
        page: "dapi",
        s: "post",
        q: "index",
        json: 1,
        limit: API_PAGE_SIZE,
        tags: tag,
      },
    });

    const posts = Array.isArray(res.data)
      ? res.data.filter((p) => p.file_url)
      : [];
    if (posts.length === 0) return null;

    return posts[Math.floor(Math.random() * posts.length)];
  } catch (err) {
    console.log(`⚠️ Gagal ambil gambar hiasan !menu ("${tag}"):`, err.message);
    return null;
  }
}

// Tag khusus buat gambar hiasan di !menu.
const HELP_IMAGE_TAG = "special_week_(umamusume)";

// Teks !menu: cuma sapaan + daftar command singkat. Penjelasan detail per
// command TIDAK ada di sini lagi -- itu baru muncul otomatis kalau user
// salah/kurang lengkap nulis command-nya (lihat COMMAND_DETAILS di bawah).
const MENU_TEXT = `
✨ *AGEMASEN BOT* ✨

Hmph... jangan salah paham. Aku cuma nunjukkin daftar command-nya, bukan berarti aku niat bantuin kamu banget.

┏━━━━━━━━━━━━━━━┓
┃ 🔎 *PENCARIAN GAMBAR*
┗━━━━━━━━━━━━━━━┛
▸ !img
▸ !next
▸ !id

┏━━━━━━━━━━━━━━━┓
┃ 🎨 *STIKER*
┗━━━━━━━━━━━━━━━┛
▸ !meme
▸ !smeme
▸ !s

┏━━━━━━━━━━━━━━━┓
┃ ⚙️ *LAIN-LAIN*
┗━━━━━━━━━━━━━━━┛
▸ !ping
▸ !menu

━━━━━━━━━━━━━━━━━━

Bingung cara pakai command yang mana? Ketik aja command-nya (biar salah/kurang lengkap juga gapapa), nanti aku jelasin sendiri caranya.

...B-bukan karena aku peduli sama kamu atau apa. Cuma males aja kalau pertanyaannya diulang terus.
`;

// Penjelasan detail per command. Dikirim otomatis kapan pun user salah
// nulis command ini (argumen kosong, media gak ketemu, dst), jadi user
// gak perlu buka !menu buat tau cara pakainya.
const COMMAND_DETAILS = {
  img: `🔎 *!img <tag>*

Cari gambar berdasarkan tag.
_(Kalau tag-nya terlalu umum, nanti muncul daftar pilihan. Tinggal balas pakai angkanya.)_

Tiap hasil pencarian dikasih *Kode Sesi* (angka). Siapa pun di grup boleh ketik angka itu buat lanjut ke gambar lain dari pencarian tersebut -- gak harus yang mulai duluan, dan gak akan ketuker sama pencarian orang lain karena tiap pencarian punya kodenya sendiri.

*Contoh:*
\`\`\`
!img umamusume
!img tokai_teio_(umamusume)
!img uchiha
\`\`\`

"Uchiha" itu terlalu banyak hasilnya... ya makanya pilih nomor yang muncul. Masa gitu aja harus dijelasin...`,

  next: `➡️ *!next*

Lanjut ke gambar berikutnya dari pencarian tag yang sama.

💡 Selain ketik *!next*, bisa juga ketik *Kode Sesi*-nya (angka yang muncul di hasil gambar) -- ini bisa dipakai siapa saja di grup, gak cuma yang mulai pencariannya.

⚠️ Pakai *!img <tag>* dulu sebelum pakai ini.`,

  id: `🆔 *!id <kode>*

Buka lagi gambar tertentu berdasarkan kode ID-nya.

*Contoh:*
\`\`\`
!id 12345
\`\`\``,

  meme: `🎨 *!meme <teks>*

Ubah GIF/video jadi stiker animasi dengan teks.

*Cara pakai:*
• Kirim GIF/video dengan caption \`!meme teks\`.
• Atau kirim GIF/video-nya dulu, terus *reply* pakai \`!meme teks\`.

Mau dua baris? Pisahkan pakai \`|\`. Emoji WhatsApp juga bisa dipakai.

*Contoh:*
\`\`\`
!meme HALO DUNIA|SELAMAT PAGI
\`\`\`

(Buat stiker/foto, pakai *!smeme* ya)`,

  smeme: `🎨 *!smeme <teks>*

Ubah stiker (emote) atau foto jadi stiker bertulisan teks.

*Cara pakai:*
• Kirim stiker/foto dengan caption \`!smeme teks\`.
• Atau kirim medianya dulu, terus *reply* pakai \`!smeme teks\`.

Mau dua baris? Pisahkan pakai \`|\`. Emoji WhatsApp juga bisa dipakai.

*Contoh:*
\`\`\`
!smeme awokawokawok😂
\`\`\`

(Buat GIF/video, pakai *!meme* ya)`,

  s: `🎨 *!s*

Ubah GIF/video/stiker/foto apa pun jadi stiker biasa, tanpa teks.

*Cara pakai:*
• Kirim medianya dengan caption \`!s\`.
• Atau kirim medianya dulu, terus *reply* dengan \`!s\`.`,
};


// Ukuran banner !menu, rasio 16:9. "cover" = crop biar penuh tanpa distorsi
// (bagian tengah gambar yang dipertahankan), bukan sekadar di-squeeze.
const MENU_BANNER_WIDTH = 1280;
const MENU_BANNER_HEIGHT = 720; // 1280:720 = 16:9

async function toMenuBanner(buffer) {
  return sharp(buffer)
    .resize(MENU_BANNER_WIDTH, MENU_BANNER_HEIGHT, {
      fit: "cover",
      position: "attention", // fokus crop ke area paling "menarik" (biasanya wajah/subjek)
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function sendMenu(sock, jid) {
  const post = await fetchRandomImageForHelp(HELP_IMAGE_TAG);

  if (post) {
    try {
      const rawBuffer = await downloadImage(post.file_url);
      const bannerBuffer = await toMenuBanner(rawBuffer);
      await sock.sendMessage(jid, { image: bannerBuffer, caption: MENU_TEXT });
      return;
    } catch (err) {
      console.log(
        "⚠️ Gagal kirim gambar hiasan !menu, fallback ke teks polos:",
        err.message,
      );
    }
  }

  // Fallback: kalau gambar gagal diambil/dikirim, tetap kirim teksnya saja
  // supaya !menu tidak pernah gagal total gara-gara masalah di sisi gambar.
  await sock.sendMessage(jid, { text: MENU_TEXT });
}

// Kirim penjelasan detail command tertentu (dipanggil otomatis saat user
// salah/kurang lengkap nulis command itu).
async function sendCommandDetail(sock, jid, commandKey) {
  await sock.sendMessage(jid, { text: COMMAND_DETAILS[commandKey] });
}

// =====================================================
// Fitur: GIF -> Stiker animasi dengan teks ("!meme")
// =====================================================

// =====================================================
// Render teks meme (+ emoji WA) ke PNG lewat canvas, lalu di-overlay ke
// video/gif pakai ffmpeg.
//
// Catatan penting: sempat dicoba render emoji lewat FONT emoji berwarna
// (NotoColorEmoji.ttf) langsung di canvas, tapi @napi-rs/canvas (berbasis
// Skia) ternyata tidak bisa render bitmap warna dari font itu (format
// CBDT/CBLC) -- hasilnya jatuh ke outline hitam-putih saja, gak
// berwarna. Jadi sekarang emoji TIDAK dirender lewat font sama sekali:
// tiap emoji di teks dideteksi, gambarnya (PNG asli, dari Twemoji) di-
// download & di-cache, lalu ditempel (drawImage) di canvas persis di
// posisi emoji itu. Teks biasa tetap pakai font seperti biasa.
// =====================================================
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

// Regex Unicode buat nangkep 1 "cluster" emoji utuh, termasuk emoji
// gabungan (mis. 👨‍👩‍👧, atau emoji+variation selector ❤️) supaya tidak
// kepotong jadi beberapa gambar terpisah.
const EMOJI_REGEX =
  /\p{Extended_Pictographic}(\u200D\p{Extended_Pictographic})*\uFE0F?/gu;

// "😂" -> "1f602" (dipakai buat nama file Twemoji). Variation selector
// (U+FE0F) dibuang karena Twemoji umumnya tidak menyertakannya di nama file,
// kecuali untuk emoji gabungan pakai ZWJ (U+200D) yang justru harus tetap ada.
function emojiToCodepoints(emoji) {
  return Array.from(emoji)
    .map((ch) => ch.codePointAt(0))
    .filter((cp) => cp !== 0xfe0f)
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
    emojiImageCache.set(code, null);
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

// Sticker WA selalu dipaksa jadi kanvas 512x512, sementara GIF/video sumber
// bisa punya rasio aspek apa saja. Karena filter video pakai
// "scale=512:512:force_original_aspect_ratio=decrease" lalu di-pad transparan
// biar pas 512x512, ukuran konten asli yang KELIHATAN (non-transparan) bisa
// lebih kecil dari 512x512 -- bisa ada bar transparan di atas/bawah (video
// landscape) atau di kiri/kanan (video portrait). Fungsi ini menghitung
// seberapa besar bar atas/bawah itu, supaya margin teks bisa disesuaikan
// otomatis untuk SEMUA ukuran/rasio GIF, bukan angka tetap yang cuma pas
// buat satu rasio tertentu.
function probeVideoDimensions(inputPath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-i", inputPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      // Contoh baris yang mau ditangkap:
      // "Stream #0:0: Video: gif, bgra, 480x270, ..."
      const match = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!match) return resolve(null);
      resolve({
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10),
      });
    });
  });
}

// Hitung MarginV (jarak dari tepi atas/bawah kanvas 512x512) yang aman
// dipakai, berdasarkan ukuran asli video/GIF. Selalu memberi margin minimum
// (MIN_MARGIN) walau videonya kebetulan pas 1:1 (tidak ada bar transparan),
// dan menambah margin ekstra sebesar bar transparan + jarak aman kalau video
// landscape/portrait menyebabkan letterboxing vertikal.
function computeSafeMargins(srcDims) {
  const CANVAS = 512;
  const MIN_MARGIN = 20; // margin dasar biar teks tetap enak dilihat, tidak nempel tepi
  const SAFE_GAP_TOP = 20; // jarak ekstra dari batas area transparan buat teks atas
  const SAFE_GAP_BOTTOM = 25; // jarak ekstra dari batas area transparan buat teks bawah

  if (!srcDims || !srcDims.width || !srcDims.height) {
    // Gagal deteksi ukuran -> fallback ke margin aman generik.
    return {
      top: MIN_MARGIN + SAFE_GAP_TOP,
      bottom: MIN_MARGIN + SAFE_GAP_BOTTOM,
    };
  }

  const scale = Math.min(CANVAS / srcDims.width, CANVAS / srcDims.height);
  const scaledHeight = srcDims.height * scale;
  // Setengah dari total bar transparan atas+bawah (pad simetris di tengah).
  const verticalPad = Math.max(0, Math.round((CANVAS - scaledHeight) / 2));

  return {
    top: Math.max(MIN_MARGIN, verticalPad + SAFE_GAP_TOP),
    bottom: Math.max(MIN_MARGIN, verticalPad + SAFE_GAP_BOTTOM),
  };
}

// Jalankan ffmpeg dan tunggu sampai selesai.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg keluar dengan kode ${code}\n${stderr.slice(-800)}`),
        );
    });
  });
}

// Ambil buffer media dari sebuah "message content" (msg.message ATAU
// contextInfo.quotedMessage). Dipecah jadi dua kategori karena sekarang
// !meme (GIF/video) dan !smeme (stiker/foto) sengaja dipisah sumbernya:
//
// - "animated": GIF/video (videoMessage, documentMessage bertipe video/*
//   atau image/gif) -> dipakai !meme.
// - "static": stiker WA / "emote" (stickerMessage, statis maupun animasi)
//   dan foto biasa (imageMessage, documentMessage bertipe image/* selain
//   gif) -> dipakai !smeme.
//
// ffmpeg otomatis bisa nangani baik input berupa gambar diam (hasilnya 1
// frame) maupun animasi (banyak frame) lewat filter yang sama, jadi tidak
// perlu penanganan khusus di ffmpeg-nya sendiri, cuma di deteksi sumbernya.
// Baileys' downloadMediaMessage butuh objek berbentuk { key, message }.
function isAnimatedSource(content) {
  if (!content) return false;

  if (content.videoMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("video/") || mime === "image/gif";
  }

  return false;
}

function isStaticSource(content) {
  if (!content) return false;

  if (content.stickerMessage) return true;
  if (content.imageMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("image/") && mime !== "image/gif";
  }

  return false;
}

function isAnyMediaSource(content) {
  return isAnimatedSource(content) || isStaticSource(content);
}

// PENTING: apakah medianya cuma 1 frame (gambar diam)?
// Filter ffmpeg "fps=12" (dipakai bareng "-fps_mode cfr") butuh minimal 2
// frame buat bisa nentuin durasi/timing antar-frame. Kalau sumbernya cuma
// SATU frame (foto biasa, atau stiker WA yang statis/bukan animasi), filter
// "fps=12" itu malah gagal ngeluarin frame sama sekali -> file output jadi
// kosong (0 byte) dan dikirim sebagai stiker rusak ("Sticker with no
// label" di WhatsApp). Makanya sebelum bikin stiker, kita cek dulu: kalau
// medianya "still" (gambar diam), filter "fps=12" di-skip total di
// gifToTextSticker/mediaToSticker.
function isStillMedia(content) {
  if (!content) return false;

  if (content.stickerMessage) return !content.stickerMessage.isAnimated;
  if (content.imageMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("image/") && mime !== "image/gif";
  }

  return false; // videoMessage, dokumen video/gif -> selalu dianggap stream, bukan still
}

async function downloadGifBuffer(content, refKey) {
  const fakeMsg = {
    key: refKey,
    message: content,
  };

  return downloadMediaMessage(fakeMsg, "buffer", {});
}

// Cari konten media dari pesan masuk: bisa dari pesan itu sendiri
// (caption langsung di medianya), atau dari pesan yang di-reply (quoted).
// `matcher` menentukan jenis media apa yang dianggap valid buat command
// yang lagi diproses (lihat isAnimatedSource / isStaticSource / isAnyMediaSource).
function findMediaSource(msg, matcher) {
  const jid = msg.key.remoteJid;

  if (matcher(msg.message)) {
    return { content: msg.message, refKey: msg.key };
  }

  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;

  if (quoted && matcher(quoted)) {
    return {
      content: quoted,
      refKey: {
        remoteJid: jid,
        id: ctx.stanzaId,
        participant: ctx.participant,
      },
    };
  }

  return null;
}

// Alias biar kode lama yang manggil findGifSource tetap jalan -> khusus
// GIF/video (dipakai !meme).
function findGifSource(msg) {
  return findMediaSource(msg, isAnimatedSource);
}

// Khusus stiker/foto (dipakai !smeme).
function findStickerSource(msg) {
  return findMediaSource(msg, isStaticSource);
}

// Semua jenis media (dipakai !s, karena !s memang generik).
function findAnySource(msg) {
  return findMediaSource(msg, isAnyMediaSource);
}

// ffmpeg (termasuk build "ffmpeg-static" yang dipakai bot ini) BISA encode
// WebP animasi (dipakai buat OUTPUT stiker), tapi decoder bawaannya TIDAK
// bisa baca WebP animasi sebagai INPUT (cuma baca frame pertama atau
// langsung gagal total dengan "Invalid data found when processing input").
// Stiker WA (baik yang dikirim user maupun quoted/reply) formatnya WebP,
// dan yang animasi otomatis bikin ffmpeg gagal proses -> "Gagal membuat
// stiker" walau teksnya sudah benar. Makanya sebelum masuk ffmpeg, WebP
// animasi dideteksi & dikonversi dulu ke GIF pakai sharp/libvips (yang
// decode WebP animasinya beres). Stiker statis & GIF/video biasa tidak
// kena ini sama sekali, langsung lewat jalur lama seperti biasa.
function isAnimatedWebpBuffer(buffer) {
  if (!buffer || buffer.length < 16) return false;

  const isRiffWebp =
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP";

  if (!isRiffWebp) return false;

  // WebP animasi selalu punya chunk "ANIM" (beda dari WebP statis biasa).
  return buffer.includes(Buffer.from("ANIM"));
}

// Konversi buffer WebP animasi -> buffer GIF animasi (frame & timing tetap
// terjaga), supaya bisa dipakai sebagai input ffmpeg seperti GIF biasa.
async function normalizeFfmpegInputBuffer(buffer) {
  if (!isAnimatedWebpBuffer(buffer)) return buffer;

  try {
    return await sharp(buffer, { animated: true }).gif().toBuffer();
  } catch (err) {
    console.log(
      "⚠️ Gagal convert stiker WebP animasi ke GIF, coba pakai buffer asli:",
      err.message,
    );
    return buffer;
  }
}

// teks bisa "atas|bawah" (dua baris) atau cuma "teks" (satu baris di bawah)
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
    const bgFilters = [
      "format=rgba",
      "scale=512:512:force_original_aspect_ratio=decrease",
      "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
      ...(isStill ? [] : ["fps=12"]),
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
      "-an",
      "-fps_mode",
      "cfr",
      "-t",
      "10", // batas durasi stiker WA
      outputPath,
    ];

    await runFfmpeg(args);

    return fs.readFileSync(outputPath);
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
    const filters = [
      "format=rgba",
      "scale=512:512:force_original_aspect_ratio=decrease",
      "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
      ...(isStill ? [] : ["fps=12"]),
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
      "-an",
      "-fps_mode",
      "cfr",
      "-t",
      "10",
      outputPath,
    ];

    await runFfmpeg(args);

    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

async function startBot() {
  console.log("Starting bot...");

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  // Always negotiate the latest supported WA Web version.
  // Skipping this is one of the most common causes of bots that
  // connect then immediately close with a 405/restartRequired loop.
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: P({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.04.4"],
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrcode = require("qrcode-terminal");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Bot Connected!");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `Connection closed (code: ${statusCode ?? "unknown"}). ` +
          (shouldReconnect
            ? "Reconnecting..."
            : "Logged out, not reconnecting."),
      );

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];

    if (!msg?.message) return;

    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const sessionKey = getSessionKey(msg);

    const text = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.videoMessage?.caption ||
      msg.message.imageMessage?.caption ||
      msg.message.documentMessage?.caption ||
      ""
    ).trim();

    // =====================
    // !ping
    // =====================
    if (text === "!ping") {
      await sock.sendMessage(jid, { text: "🏓 Pong!" });
      return;
    }

    // =====================
    // !menu
    // =====================
    if (text === "!menu") {
      await sendMenu(sock, jid);
      return;
    }

    // =====================
    // Balasan angka untuk memilih karakter dari daftar disambiguasi
    // (hanya diproses kalau memang sedang ada daftar pending untuk user ini)
    // =====================
    if (/^\d+$/.test(text)) {
      const session = sessions.get(sessionKey);

      if (session?.pendingTagChoices) {
        const idx = parseInt(text, 10) - 1;
        const choice = session.pendingTagChoices[idx];

        if (!choice) {
          await sock.sendMessage(jid, {
            text: `⚠️ Nomor tidak valid. Pilih 1-${session.pendingTagChoices.length}.`,
          });
          return;
        }

        try {
          const candidates = await fetchCandidates(choice.name);

          if (candidates.length === 0) {
            await sock.sendMessage(jid, {
              text: "❌ Gambar untuk karakter ini tidak ditemukan.",
            });
            return;
          }

          await searchAndSendImage(
            sock,
            jid,
            sessionKey,
            choice.name,
            candidates,
          );
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: "Terjadi kesalahan.",
          });
        }

        return;
      }

      // Bukan lagi soal daftar disambiguasi milik pengirim ini -> cek apakah
      // angka ini KODE SESI pencarian yang lagi aktif di chat ini. Kode sesi
      // ini scope-nya per-chat (bukan per-pengirim), jadi siapa pun di grup
      // yang sama boleh pakai kode punya orang lain buat lanjut (!next)
      // pencarian itu, dan ini tidak bentrok dengan kode punya pencarian
      // lain karena tiap pencarian dapat nomor kodenya sendiri-sendiri.
      const codeNum = parseInt(text, 10);
      const codeSession = chatCodeSessions.get(jid)?.get(codeNum);

      if (codeSession) {
        try {
          // pool habis -> refill otomatis dari tag yang sama
          if (codeSession.pool.length === 0) {
            codeSession.pool = await fetchCandidates(codeSession.tag);

            if (codeSession.pool.length === 0) {
              await sock.sendMessage(jid, {
                text: "❌ Tidak ada gambar lain untuk tag ini.",
              });
              return;
            }
          }

          const post = pickRandom(codeSession.pool);
          codeSession.lastId = post.id;

          const buffer = await downloadImage(post.file_url);
          const karakterLabel = codeSession.tag
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean)
            .map(prettifyTag)
            .join(", ");

          await sock.sendMessage(jid, {
            image: buffer,
            caption: buildCaption(post, karakterLabel, {
              isNext: true,
              code: codeNum,
            }),
          });
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: "Terjadi kesalahan.",
          });
        }

        return;
      }

      // angka tanpa daftar pending & bukan kode sesi yang aktif -> biarkan
      // lewat, bukan command
    }

    // =====================
    // !meme <teks>  -> KHUSUS GIF/video jadi stiker bertext.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!meme" || text.startsWith("!meme ")) {
      const memeText = text.slice(5).trim();

      if (!memeText) {
        await sendCommandDetail(sock, jid, "meme");
        return;
      }

      const source = findGifSource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "meme");
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

        const gifBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const stickerBuffer = await gifToTextSticker(gifBuffer, memeText);

        await sock.sendMessage(jid, { sticker: stickerBuffer });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !smeme <teks>  -> KHUSUS stiker (emote)/foto jadi stiker bertext.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!smeme" || text.startsWith("!smeme ")) {
      const memeText = text.slice(7).trim();

      if (!memeText) {
        await sendCommandDetail(sock, jid, "smeme");
        return;
      }

      const source = findStickerSource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "smeme");
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

        const mediaBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const stickerBuffer = await gifToTextSticker(
          mediaBuffer,
          memeText,
          isStillMedia(source.content),
        );

        await sock.sendMessage(jid, { sticker: stickerBuffer });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !s  -> GIF/video/stiker(emote)/foto jadi stiker polos, TANPA teks.
    // Ini tetap generik (nerima semua jenis media), karena tujuannya
    // cuma bikin stiker biasa tanpa teks, bukan soal animasi vs statis.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!s") {
      const source = findAnySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "s");
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

        const mediaBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const stickerBuffer = await mediaToSticker(
          mediaBuffer,
          isStillMedia(source.content),
        );

        await sock.sendMessage(jid, { sticker: stickerBuffer });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !img <tag>
    // =====================
    if (text === "!img" || text.startsWith("!img ")) {
      const tag = text.slice(4).trim();

      if (!tag) {
        await sendCommandDetail(sock, jid, "img");
        return;
      }

      try {
        const candidates = await fetchCandidates(tag);

        if (candidates.length > 0) {
          await searchAndSendImage(sock, jid, sessionKey, tag, candidates);
          return;
        }

        // Tag persis tidak ketemu -> cari tag-tag serupa untuk dipilih
        const matches = await fetchMatchingTags(tag);

        if (matches.length === 0) {
          await sock.sendMessage(jid, {
            text: "❌ Gambar tidak ditemukan.",
          });
          return;
        }

        if (matches.length === 1) {
          // cuma ada 1 kandidat, langsung pakai tanpa nanya
          const only = await fetchCandidates(matches[0].name);
          await searchAndSendImage(
            sock,
            jid,
            sessionKey,
            matches[0].name,
            only,
          );
          return;
        }

        sessions.set(sessionKey, { pendingTagChoices: matches });

        await sock.sendMessage(jid, {
          text: buildTagChoiceList(matches),
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: "Terjadi kesalahan.",
        });
      }

      return;
    }

    // =====================
    // !next
    // =====================
    if (text === "!next") {
      const session = sessions.get(sessionKey);

      if (!session) {
        await sendCommandDetail(sock, jid, "next");
        return;
      }

      try {
        // pool habis -> refill otomatis dari tag yang sama
        if (session.pool.length === 0) {
          session.pool = await fetchCandidates(session.tag);

          if (session.pool.length === 0) {
            await sock.sendMessage(jid, {
              text: "❌ Tidak ada gambar lain untuk tag ini.",
            });
            return;
          }
        }

        const post = pickRandom(session.pool);
        session.lastId = post.id;

        const buffer = await downloadImage(post.file_url);
        const karakterLabel = session.tag
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .map(prettifyTag)
          .join(", ");

        await sock.sendMessage(jid, {
          image: buffer,
          caption: buildCaption(post, karakterLabel, {
            isNext: true,
            code: session.code,
          }),
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: "Terjadi kesalahan.",
        });
      }

      return;
    }

    // =====================
    // !id <kode>
    // =====================
    if (text === "!id" || text.startsWith("!id ")) {
      const id = text.slice(3).trim();

      if (!id || !/^\d+$/.test(id)) {
        await sendCommandDetail(sock, jid, "id");
        return;
      }

      try {
        const post = await fetchById(id);

        if (!post) {
          await sock.sendMessage(jid, {
            text: "❌ Kode gambar tidak ditemukan.",
          });
          return;
        }

        const buffer = await downloadImage(post.file_url);

        await sock.sendMessage(jid, {
          image: buffer,
          caption: buildCaption(post, "-"),
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: "Terjadi kesalahan.",
        });
      }

      return;
    }

    // =====================
    // Command tidak dikenal (mis. salah ketik "!ing", "!imgg", dst).
    // Cuma dicek kalau memang diawali "!" -- teks biasa (bukan niat jadi
    // command) dibiarkan lewat tanpa respons.
    // =====================
    if (text.startsWith("!")) {
      await sock.sendMessage(jid, {
        text:
          "❓ Command tidak dikenal.\n" +
          "Ketik *!menu* buat lihat daftar command yang ada.",
      });
    }
  });
}

startBot();
