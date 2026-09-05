const axios = require("axios");
const { touchSession } = require("./sessionStore");

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

// Pesan error yang lebih jelas kalau penyebabnya timeout ke Safebooru
// (biasa terjadi pada tag yang post-nya sangat banyak) supaya user tahu
// ini bukan tag yang salah, cuma perlu dicoba lagi.
function errorReplyText(err) {
  if (err?.code === "ECONNABORTED" || /timeout/i.test(err?.message || "")) {
    return "⏱️ Server gambar lambat merespons. Coba lagi ya.";
  }
  return "Terjadi kesalahan.";
}

// `source` bedain Safebooru ("safebooru", default -- demi kompatibilitas
// kode lama yang belum pernah ngirim opsi ini) dari Pinterest ("pinterest",
// dipakai !pin). Bedanya cuma di link, label, dan baris "!id" (Pinterest
// gak punya command !id karena ID pin gak bisa dipakai ulang lewat API
// pencarian yang dipakai bot ini).
function buildCaption(
  post,
  karakterLabel,
  { isNext = false, code, source = "safebooru" } = {},
) {
  const isPinterest = source === "pinterest";

  const link = isPinterest
    ? post.source_link || `https://www.pinterest.com/pin/${post.id}/`
    : `https://safebooru.org/index.php?page=post&s=view&id=${post.id}`;

  const labelLine = isPinterest
    ? `🔎 *Keyword:* ${karakterLabel}`
    : `👤 *Karakter:* ${karakterLabel}`;

  const codeLine = code ? `\n🔢 *Kode Sesi:* ${code}` : "";
  const continueLine = code
    ? `➡️ Ketik *${code}* (siapa saja boleh) atau *!next* untuk gambar lain dari pencarian ini`
    : `➡️ Ketik *!next* untuk gambar lain dari pencarian ini`;

  const idLine = isPinterest
    ? ""
    : `\n🔁 Ketik *!id ${post.id}* untuk lihat gambar ini lagi kapan saja`;

  return `🖼️ *Hasil Gambar*${isNext ? " (lanjutan)" : ""}${isPinterest ? " (Pinterest)" : ""}

${labelLine}${codeLine}
🆔 *Kode Gambar:* ${post.id}
🔗 *Link:* ${link}

${continueLine}${idLine}`;
}

// Label yang ditampilin di caption buat pemilik pencarian ini (dipakai di
// !img/!next/kode-sesi & !pin/next). Safebooru: tag mentah di-"prettify"
// (underscore -> spasi, tiap kata dikapital). Pinterest: keyword asli
// user apa adanya, gak perlu di-prettify.
function sessionLabel(session) {
  if (session.source === "pinterest") return session.tag;

  return session.tag
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(prettifyTag)
    .join(", ");
}

// Kasih timeout eksplisit per-request. Tanpa ini, satu request yang
// menggantung bisa bikin keseluruhan pencarian terasa "diam" lama sebelum
// akhirnya gagal.
const SAFEBOORU_TIMEOUT_MS = 15000;
// Tag populer (mis. "umamusume" -- yang justru paling sering jadi PILIHAN
// NOMOR 1 di daftar disambiguasi, karena daftar itu diurutkan dari count
// terbesar) bisa punya ribuan post -> puluhan/ratusan request berurutan ke
// Safebooru per pencarian, jadi lebih rawan sesekali timeout/gangguan
// jaringan di tengah jalan. Daripada langsung gagal total dan bikin user
// dapat "Terjadi kesalahan.", tiap halaman yang gagal dicoba ulang dulu
// beberapa kali (dengan jeda) sebelum benar-benar menyerah.
const SAFEBOORU_MAX_RETRIES = 3;
const SAFEBOORU_RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrapper axios.get dengan retry otomatis kalau kena timeout/error jaringan.
// Error non-jaringan (mis. 4xx dari server) tidak di-retry, langsung dilempar.
async function fetchWithRetry(url, config) {
  let lastErr;

  for (let attempt = 1; attempt <= SAFEBOORU_MAX_RETRIES; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      lastErr = err;

      const isNetworkIssue =
        err.code === "ECONNABORTED" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ECONNRESET" ||
        !err.response; // request tidak pernah dapat balasan sama sekali

      if (!isNetworkIssue || attempt === SAFEBOORU_MAX_RETRIES) throw err;

      console.log(
        `[safebooru] percobaan ${attempt} gagal (${err.code || err.message}), coba lagi...`,
      );
      await sleep(SAFEBOORU_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastErr;
}

// Ambil SATU halaman post untuk sebuah tag dari Safebooru (maks 100 post).
// Dulu `fetchCandidates` narik SEMUA halaman sekaligus sebelum bisa kirim 1
// gambar pun -- buat tag populer (yang justru sering jadi pilihan [1] di
// daftar disambiguasi, karena diurutkan dari count terbesar) itu bisa puluhan
// request berurutan sebelum user dapat balasan, jadi rawan timeout/gagal.
// Sekarang narik per halaman aja (lazy), baru nambah halaman lagi kalau
// stok di pool session sudah habis (lihat loadMoreCandidates).
async function fetchCandidatesPage(tag, pid) {
  const url = "https://safebooru.org/index.php";

  const res = await fetchWithRetry(url, {
    params: {
      page: "dapi",
      s: "post",
      q: "index",
      json: 1,
      limit: API_PAGE_SIZE,
      pid,
      tags: tag,
    },
    timeout: SAFEBOORU_TIMEOUT_MS,
  });

  const data = Array.isArray(res.data) ? res.data : [];
  const posts = data.filter((p) => p.file_url);
  const isLastPage = data.length < API_PAGE_SIZE;

  return { posts, isLastPage };
}

// Isi ulang `session.pool` dengan post-post BARU (belum pernah dikirim di
// session ini -- dicek lewat `session.seenIds`) dengan narik halaman
// berikutnya satu-satu, berhenti begitu dapat minimal 1 post baru. Kalau
// sampai halaman terakhir Safebooru tetap nggak dapat apa-apa, berarti
// semua gambar untuk tag ini sudah habis (atau memang tidak ada sama
// sekali kalau ini pemanggilan pertama).
//
// Return true kalau pool berhasil terisi (ada gambar baru buat dikirim),
// false kalau sudah benar-benar habis / tidak ada gambar.
async function loadMoreCandidates(session) {
  while (!session.noMorePages) {
    const { posts, isLastPage } = await fetchCandidatesPage(
      session.tag,
      session.pid,
    );

    session.pid++;
    if (isLastPage) session.noMorePages = true;

    const fresh = posts.filter((p) => !session.seenIds.has(String(p.id)));
    if (fresh.length > 0) {
      session.pool.push(...fresh);
      return true;
    }
  }

  return false;
}

// Bikin session baru buat pencarian tag baru (dipakai tiap kali user mulai
// pencarian: !img langsung, hasil disambiguasi tunggal, atau pilih dari
// daftar disambiguasi). pool masih kosong -> caller wajib panggil
// loadMoreCandidates() setelah ini sebelum kirim gambar pertama.
function newCandidateSession(tag) {
  return {
    source: "safebooru",
    tag,
    pool: [],
    seenIds: new Set(),
    pid: 0,
    noMorePages: false,
  };
}


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
    const res = await fetchWithRetry(url, {
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
      timeout: SAFEBOORU_TIMEOUT_MS,
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
// maupun setelah user memilih dari daftar disambiguasi), lalu simpan session
// (pool + progres paging) untuk !next dan kirim gambar pertama.
//
// `candidateSession` HARUS sudah dibuat lewat newCandidateSession() dan
// pool-nya sudah diisi minimal 1 post lewat loadMoreCandidates() sebelum
// fungsi ini dipanggil.
async function searchAndSendImage(sock, jid, sessionKey, tag, candidateSession) {
  const post = pickRandom(candidateSession);
  candidateSession.lastId = post.id;

  const session = touchSession(candidateSession);

  // Objek session yang sama dipakai baik di `sessions` (buat pemiliknya,
  // dipakai untuk "!next" ketik teks) maupun di `chatCodeSessions` (buat
  // siapa saja di chat ini, dipakai untuk lanjut pakai angka kode).
  sessions.set(sessionKey, session);
  const code = assignSessionCode(jid, session);

  const buffer = await downloadImage(post.file_url);
  const karakterLabel = sessionLabel(session);

  await sock.sendMessage(jid, {
    image: buffer,
    caption: buildCaption(post, karakterLabel, { code, source: session.source }),
  });
}

// Ambil 1 post random dari pool session, keluarkan dari pool, dan tandai
// ID-nya di `seenIds` supaya post yang sama tidak pernah dipilih lagi
// selama session ini masih hidup (baik dari pool sekarang maupun dari
// halaman-halaman baru yang di-load belakangan lewat loadMoreCandidates).
function pickRandom(session) {
  const idx = Math.floor(Math.random() * session.pool.length);
  const [post] = session.pool.splice(idx, 1);
  session.seenIds.add(String(post.id));
  return post;
}

async function downloadImage(fileUrl) {
  const image = await fetchWithRetry(fileUrl, {
    responseType: "arraybuffer",
    timeout: SAFEBOORU_TIMEOUT_MS,
  });
  return Buffer.from(image.data);
}

module.exports = {
  API_PAGE_SIZE,
  prettifyTag,
  errorReplyText,
  buildCaption,
  sessionLabel,
  SAFEBOORU_TIMEOUT_MS,
  SAFEBOORU_MAX_RETRIES,
  SAFEBOORU_RETRY_DELAY_MS,
  fetchWithRetry,
  fetchCandidatesPage,
  loadMoreCandidates,
  newCandidateSession,
  parseTagXml,
  fetchMatchingTags,
  fetchById,
  buildTagChoiceList,
  searchAndSendImage,
  pickRandom,
  downloadImage,
};
