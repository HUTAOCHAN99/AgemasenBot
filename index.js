console.log("Program dimulai");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
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
const { PDFParse } = require("pdf-parse");

// Fitur chat AI tsundere (Groq) -- dipisah dari file ini, lihat
// agemasenTsundere.js untuk semua logic-nya (persona, panggilan API,
// riwayat chat, deteksi mention).
const {
  handleTsundereChat,
  sweepExpiredTsundereChats,
  forgetGroqChat,
  summarizeDocumentText,
  saveDocumentContext,
  DOC_HARD_MAX_CHARS,
  SUMMARY_SINGLE_PASS_MAX_CHARS,
  SUMMARY_CHUNK_CHARS,
  DOC_CONTEXT_TTL_MS,
} = require("./agemasenTsundere");

// =====================================================
// Session per pengguna (bukan per chat/grup)
// key -> { tag, pool: [post,...], lastId, lastUsed }
// pool = sisa kandidat yang belum ditampilkan ke user ini
//
// EXPIRY: tiap session punya `lastUsed` (timestamp), di-update setiap kali
// session itu dipakai/dibuat (!img, !next, ketik kode sesi). Session yang
// sudah 24 jam TIDAK dipakai sama sekali akan otomatis dibuang lewat
// sweepExpiredSessions() -- lihat setInterval di bawah. Ini rolling per
// session (bukan reset serentak semua sesi tiap 24 jam sejak bot nyala),
// jadi sesi yang masih aktif dipakai gak akan hilang tiba-tiba.
// =====================================================
// Owner & saklar aktif/nonaktif bot PER GRUP
//
// - OWNER_NUMBER: nomor WA owner (format: kode negara + nomor, TANPA "+"
//   dan TANPA spasi/strip. Contoh Indonesia: "6281234567890"). Wajib diisi
//   lewat env var OWNER_NUMBER (lihat README/.env) supaya nomor pribadi
//   gak ke-commit ke git. Kalau env var-nya kosong, fitur owner otomatis
//   nonaktif semua (gak ada yang dianggap owner) -- aman by default.
// - Cuma owner yang boleh pakai "!bot on" / "!bot off" / "!bot status".
//   Saklar ini di-scope PER GRUP (per jid grup), jadi grup A bisa aktif
//   sementara grup B nonaktif, gak saling ganggu.
// - Kalau grup lagi dinonaktifin, bot TETAP baca semua pesan yang masuk
//   (biar owner tetap bisa "!bot on" buat nyalain lagi), tapi buat
//   siapa pun SELAIN owner yang ketik command ("!..."), bot cuma bales
//   sekali "ngambek" (nge-tag owner) terus behenti -- gak ada command lain
//   yang diproses. Owner sendiri TIDAK kena blokir ini sama sekali.
// - State-nya ditulis ke file JSON (data/bot_state.json) supaya gak reset
//   ke default tiap kali bot restart/redeploy. Override lokasinya lewat
//   env var BOT_STATE_FILE kalau perlu (sama pola kayak GROQ_HISTORY_FILE
//   di agemasenTsundere.js).
// =====================================================
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "").replace(/\D/g, "");
const OWNER_JID = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;

const BOT_STATE_DATA_DIR = path.join(__dirname, "data");
const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(BOT_STATE_DATA_DIR, "bot_state.json");

// jid grup -> false (nonaktif). Grup yang gak ada di sini dianggap AKTIF
// (default aktif), jadi file-nya cuma perlu nyimpen grup yang DIMATIKAN.
let disabledGroups = new Set();

function loadBotState() {
  try {
    const raw = fs.readFileSync(BOT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.disabledGroups)) {
      disabledGroups = new Set(parsed.disabledGroups);
    }
  } catch {
    // Belum ada file / rusak -> mulai dari kosong (semua grup aktif).
    disabledGroups = new Set();
  }
}

function saveBotState() {
  try {
    fs.mkdirSync(BOT_STATE_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      BOT_STATE_FILE,
      JSON.stringify({ disabledGroups: [...disabledGroups] }, null, 2),
    );
  } catch (err) {
    console.log("Gagal nyimpen bot_state.json:", err);
  }
}

loadBotState();

// Ambil jid pengirim ASLI (bukan jid chat) -- di grup itu participant,
// di chat pribadi ya remoteJid itu sendiri.
//
// PENTING soal @lid: WhatsApp sekarang bisa ngirim jid pengirim dalam
// bentuk "xxxxx@lid" (Linked ID / identitas tersembunyi) bukan
// "nomor@s.whatsapp.net", tergantung setting privasi pengirimnya --
// walaupun itu beneran nomor yang sama. Baileys nyediain field
// participantPn (di grup) / senderPn (di chat pribadi) yang isinya
// SELALU jid berbasis nomor telepon asli, jadi itu yang diprioritaskan
// biar perbandingan ke OWNER_JID gak meleset gara-gara @lid.
function getSenderJid(msg) {
  const raw =
    msg.key.participantPn ||
    msg.key.participant ||
    msg.key.senderPn ||
    msg.key.remoteJid;
  if (!raw) return null;
  try {
    return jidNormalizedUser(raw);
  } catch {
    return raw.split(":")[0];
  }
}

function isOwnerMsg(msg) {
  if (!OWNER_JID) return false;
  const sender = getSenderJid(msg);
  return sender === OWNER_JID;
}

// Command debug kecil -- biar gampang troubleshoot kalau owner check
// meleset lagi (misal gara-gara @lid). Nunjukin jid mentah apa aja yang
// dikirim WhatsApp buat pesan ini, dan jid mana yang akhirnya dipakai
// bot buat nentuin siapa pengirimnya.
async function handleWhoamiCommand(sock, msg, { jid, text }) {
  if (text.toLowerCase() !== "!whoami") return false;

  const resolved = getSenderJid(msg);
  const lines = [
    `🪪 *Jid terdeteksi:* ${resolved || "(gak ketemu)"}`,
    `Owner: ${isOwnerMsg(msg) ? "✅ ya" : "❌ bukan"}`,
    "",
    "_Detail mentah:_",
    `participant: ${msg.key.participant || "-"}`,
    `participantPn: ${msg.key.participantPn || "-"}`,
    `senderPn: ${msg.key.senderPn || "-"}`,
    `remoteJid: ${msg.key.remoteJid || "-"}`,
  ];

  await sock.sendMessage(jid, { text: lines.join("\n") });
  return true;
}

function isBotDisabledFor(jid) {
  return disabledGroups.has(jid);
}

// Cooldown biar bot gak spam bales "ngambek" tiap ada 1 pesan doang kalau
// banyak orang nyoba-nyoba command di grup yang lagi dimatiin.
const NGAMBEK_COOLDOWN_MS = 15 * 1000;
const lastNgambekReply = new Map(); // jid -> timestamp

async function sendNgambekReply(sock, jid) {
  const now = Date.now();
  const last = lastNgambekReply.get(jid) || 0;
  if (now - last < NGAMBEK_COOLDOWN_MS) return;
  lastNgambekReply.set(jid, now);

  const ngambekLines = [
    "Hmph! Aku lagi gak mau aktif, dasar. 😤",
    "Males ah, aku lagi dimatiin. Gak mau kerja dulu sekarang. 🙄",
    "Ish, jangan suruh-suruh aku, aku lagi nonaktif tau!",
  ];
  const line = ngambekLines[Math.floor(Math.random() * ngambekLines.length)];

  if (!OWNER_JID) {
    await sock.sendMessage(jid, { text: line });
    return;
  }

  await sock.sendMessage(jid, {
    text: `${line}\n\nKalau mau aku aktif lagi, hubungin @${OWNER_NUMBER} ya, bukan aku yang nentuin. 💢`,
    mentions: [OWNER_JID],
  });
}

// Cari grup berdasarkan nama (subject), dipakai buat !bot on/off/status
// dari DM (owner gak perlu ada di grupnya). Cocokin exact match dulu
// (case-insensitive), kalau gak ketemu baru coba substring match.
// Return:
//   { type: "none" }               -- gak ketemu sama sekali
//   { type: "ambiguous", matches } -- lebih dari satu grup cocok (substring)
//   { type: "found", group }       -- ketemu tepat satu
async function resolveGroupByName(sock, rawName) {
  const needle = rawName.trim().toLowerCase();
  const groups = await sock.groupFetchAllParticipating();
  const entries = Object.values(groups || {});

  const exact = entries.filter((g) => (g.subject || "").toLowerCase() === needle);
  if (exact.length === 1) return { type: "found", group: exact[0] };
  if (exact.length > 1) return { type: "ambiguous", matches: exact };

  const partial = entries.filter((g) => (g.subject || "").toLowerCase().includes(needle));
  if (partial.length === 1) return { type: "found", group: partial[0] };
  if (partial.length > 1) return { type: "ambiguous", matches: partial };

  return { type: "none" };
}

// Handler command "!bot on / off / status" -- KHUSUS owner.
// Bisa dipakai dua cara:
//   - Di DALAM grup: "!bot on" / "!bot off" / "!bot status" -> ngatur
//     grup yang lagi ditempatin ngetik.
//   - Dari DM (atau grup mana pun): "!bot on <nama grup>" /
//     "!bot off <nama grup>" / "!bot status <nama grup>" -> ngatur grup
//     LAIN lewat nama, owner gak perlu jadi anggota/ada di grup itu.
// Return true kalau pesan ini sudah ditangani sebagai command !bot
// (baik berhasil, ditolak karena bukan owner, dsb) -- caller harus
// return begitu dapat true, JANGAN lanjut proses apa pun lagi.
async function handleBotSwitchCommand(sock, msg, { jid, text }) {
  const match = text.match(/^!bot(?:\s+(on|off|status))?(?:\s+(.+))?\s*$/i);
  if (!match) return false;

  if (!isOwnerMsg(msg)) {
    await sock.sendMessage(jid, {
      text: "🚫 Cuma owner yang boleh atur aktif/nonaktifin aku, dasar.",
    });
    return true;
  }

  const sub = (match[1] || "").toLowerCase();
  const nameArg = (match[2] || "").trim();
  const isGroup = jid.endsWith("@g.us");

  // "!bot <sesuatu>" tanpa on/off/status di depan -- format gak jelas,
  // gak tau itu mau toggle apa cuma nama grup doang.
  if (sub === "" && nameArg !== "") {
    await sock.sendMessage(jid, {
      text: "❓ Format salah.\nGunakan:\n!bot on <nama grup>\n!bot off <nama grup>\n!bot status <nama grup>",
    });
    return true;
  }

  // ---- Mode remote: ada nama grup disebutin -> gak perlu ada di grupnya ----
  if (nameArg !== "") {
    let resolved;
    try {
      resolved = await resolveGroupByName(sock, nameArg);
    } catch (err) {
      console.error("Gagal cari grup by nama:", err);
      await sock.sendMessage(jid, {
        text: "⚠️ Gagal ambil daftar grup buat dicariin namanya. Coba lagi bentar ya.",
      });
      return true;
    }

    if (resolved.type === "none") {
      await sock.sendMessage(jid, {
        text: `❓ Gak nemu grup dengan nama mengandung "${nameArg}". Cek lagi pakai *!listgrup*.`,
      });
      return true;
    }

    if (resolved.type === "ambiguous") {
      const list = resolved.matches
        .map((g, i) => `${i + 1}. ${g.subject || "(tanpa nama)"}`)
        .join("\n");
      await sock.sendMessage(jid, {
        text: `❓ Ada ${resolved.matches.length} grup yang cocok, sebutin nama lebih spesifik:\n\n${list}`,
      });
      return true;
    }

    const group = resolved.group;
    const disabled = isBotDisabledFor(group.id);

    if (sub === "status") {
      await sock.sendMessage(jid, {
        text: `📋 *${group.subject}*\nStatus: ${disabled ? "📴 NONAKTIF" : "✅ AKTIF"}`,
      });
      return true;
    }

    if (sub === "on") {
      disabledGroups.delete(group.id);
      saveBotState();
      await sock.sendMessage(jid, {
        text: `✅ Oke, aku aktifin lagi di grup *${group.subject}*.`,
      });
    } else {
      disabledGroups.add(group.id);
      saveBotState();
      await sock.sendMessage(jid, {
        text: `📴 Oke, aku nonaktifin di grup *${group.subject}*.`,
      });
    }
    return true;
  }

  // ---- Mode lokal (perilaku lama): ngatur grup tempat ngetik sekarang ----
  if (sub === "status" || sub === "") {
    if (!isGroup) {
      await sock.sendMessage(jid, {
        text: "ℹ️ Ketik di dalam grup yang mau dicek, atau sebutin namanya: *!bot status <nama grup>*",
      });
      return true;
    }
    const disabled = isBotDisabledFor(jid);
    await sock.sendMessage(jid, {
      text: disabled
        ? "📴 Status grup ini: NONAKTIF. Ketik *!bot on* buat nyalain lagi."
        : "✅ Status grup ini: AKTIF. Ketik *!bot off* buat matiin.",
    });
    return true;
  }

  if (sub !== "on" && sub !== "off") {
    await sock.sendMessage(jid, {
      text: "❓ Format salah.\nGunakan:\n!bot on\n!bot off\n!bot status\natau dari DM: !bot on/off/status <nama grup>",
    });
    return true;
  }

  if (!isGroup) {
    await sock.sendMessage(jid, {
      text: "ℹ️ Dari DM, sebutin nama grupnya: *!bot on <nama grup>* / *!bot off <nama grup>*. Atau ketik command ini langsung di dalam grup yang mau diatur.",
    });
    return true;
  }

  if (sub === "on") {
    disabledGroups.delete(jid);
    saveBotState();
    await sock.sendMessage(jid, {
      text: "✅ Yaudah, aku aktif lagi di grup ini. Bukan berarti aku seneng ya! 😳",
    });
  } else {
    disabledGroups.add(jid);
    saveBotState();
    await sock.sendMessage(jid, {
      text: "📴 Oke, aku nonaktif di grup ini sekarang. Kalau ada yang manggil-manggil aku juga gak bakal respon.",
    });
  }

  return true;
}

// Handler command "!listgrup" -- KHUSUS owner. Nampilin daftar nama semua
// grup dimana bot ini jadi member (aktif kehadirannya di WA), sekalian
// status per grup (aktif / nonaktif via !bot on-off). Pakai
// sock.groupFetchAllParticipating() bawaan Baileys yang ngambil semua
// grup yang lagi diikuti akun bot saat ini.
async function handleListGroupsCommand(sock, msg, { jid, text }) {
  if (text.trim().toLowerCase() !== "!listgrup") return false;

  if (!isOwnerMsg(msg)) {
    await sock.sendMessage(jid, {
      text: "🚫 Cuma owner yang boleh liat daftar grup, dasar.",
    });
    return true;
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    const entries = Object.values(groups || {});

    if (entries.length === 0) {
      await sock.sendMessage(jid, {
        text: "ℹ️ Aku belum jadi anggota grup mana pun saat ini.",
      });
      return true;
    }

    entries.sort((a, b) => (a.subject || "").localeCompare(b.subject || ""));

    const lines = entries.map((g, i) => {
      const nama = g.subject || "(tanpa nama)";
      const jumlah = Array.isArray(g.participants) ? g.participants.length : "?";
      const status = isBotDisabledFor(g.id) ? "📴 nonaktif" : "✅ aktif";
      return `${i + 1}. ${nama} (${jumlah} anggota) -- ${status}`;
    });

    const header = `📋 *Daftar grup (${entries.length}):*\n\n`;
    await sock.sendMessage(jid, { text: header + lines.join("\n") });
  } catch (err) {
    console.error("Gagal ambil daftar grup:", err);
    await sock.sendMessage(jid, {
      text: "⚠️ Gagal ambil daftar grup. Coba lagi bentar ya.",
    });
  }

  return true;
}

// =====================================================
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam
const sessions = new Map();

// Tandain session baru saja dipakai/dibuat -- reset hitungan 24 jamnya.
function touchSession(session) {
  session.lastUsed = Date.now();
  return session;
}

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

// Buang semua session yang sudah 24 jam TIDAK disentuh (lihat SESSION_TTL_MS
// & touchSession di atas). Dijalanin berkala lewat setInterval (lihat bawah
// startBot), bukan cuma sekali pas start, supaya sesi lama otomatis kebuang
// walau bot jalan berhari-hari tanpa restart.
function sweepExpiredSessions() {
  const now = Date.now();

  // 1. Sesi utama (key = per-pengirim). pendingTagChoices juga ikut kena
  // sweep di sini karena disimpan di Map yang sama.
  for (const [key, session] of sessions) {
    if (now - (session.lastUsed || 0) > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }

  // 2. Kode sesi per-chat. Objeknya reference yang sama dengan di atas,
  // jadi cukup cek `lastUsed` yang sama juga -- kalau sudah expired,
  // buang entry kodenya, dan kalau map kode chat itu jadi kosong, buang
  // sekalian mapnya (chatNextCode dibiarin jalan terus, aman kalau
  // kepakai lagi nanti -- cuma nomor urut kode, bukan data sensitif).
  for (const [jid, codeMap] of chatCodeSessions) {
    for (const [code, session] of codeMap) {
      if (now - (session.lastUsed || 0) > SESSION_TTL_MS) {
        codeMap.delete(code);
      }
    }
    if (codeMap.size === 0) chatCodeSessions.delete(jid);
  }

  // 3. Riwayat chat tsundere (Groq) per pengirim -- logic & Map-nya ada di
  // agemasenTsundere.js, di sini cukup panggil sweep-nya.
  sweepExpiredTsundereChats();
}

// Jalanin sweep tiap 1 jam (bukan cuma sekali pas start). Ditaruh di scope
// modul -- BUKAN di dalam startBot() -- karena startBot() bisa dipanggil
// ulang tiap kali bot reconnect; kalau interval-nya ditaruh di dalam sana,
// tiap reconnect bakal numpuk interval baru (leak). `unref()` dipakai
// supaya interval ini gak nahan proses Node tetap hidup kalau semua kerjaan
// lain sudah selesai (mis. pas dites via `node -e`, bukan lewat startBot).
setInterval(sweepExpiredSessions, 60 * 60 * 1000).unref();

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

// Pesan error yang lebih jelas kalau penyebabnya timeout ke Safebooru
// (biasa terjadi pada tag yang post-nya sangat banyak) supaya user tahu
// ini bukan tag yang salah, cuma perlu dicoba lagi.
function errorReplyText(err) {
  if (err?.code === "ECONNABORTED" || /timeout/i.test(err?.message || "")) {
    return "⏱️ Server gambar lambat merespons. Coba lagi ya.";
  }
  return "Terjadi kesalahan.";
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
    tag,
    pool: [],
    seenIds: new Set(),
    pid: 0,
    noMorePages: false,
  };
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

// Kategori orientasi yang BOLEH dipakai sebagai banner !menu. Portrait
// (tinggi > lebar) SENGAJA tidak boleh: banner di-crop paksa ke kanvas
// 16:9 (lihat toMenuBanner), jadi sumber portrait bakal ke-crop parah dan
// motong bagian penting gambarnya. Tiga kategori di bawah beririsan pas di
// batasnya jadi nutupin seluruh rentang >= 0.95 tanpa ada celah:
//   - Square         : 0.95 <= ratio <= 1.05
//   - Landscape       : 1.05 <  ratio <= 1.5
//   - Landscape Wide  : ratio > 1.5
function isBannerEligible(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= 0.95; // < 0.95 = portrait, ditolak
}

// Ambil SATU gambar acak yang ORIENTASINYA cocok buat banner !menu
// (landscape/square -- lihat isBannerEligible) -- dipakai cuma buat hiasan
// !menu, jadi cukup cepat & ringan tiap kali user ketik !menu. Gambar
// portrait DILEWATI dan dicari gambar lain (bukan langsung dipakai apa
// adanya), makanya narik beberapa halaman kalau perlu sampai nemu
// setidaknya beberapa kandidat yang layak, atau sampai halamannya habis.
async function fetchRandomImageForHelp(tag) {
  const MAX_PAGES = 3;
  const eligible = [];

  try {
    for (let pid = 0; pid < MAX_PAGES; pid++) {
      const res = await axios.get("https://safebooru.org/index.php", {
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

      const data = Array.isArray(res.data) ? res.data : [];
      if (data.length === 0) break; // gak ada hasil sama sekali / halaman habis

      for (const p of data) {
        if (p.file_url && isBannerEligible(Number(p.width), Number(p.height))) {
          eligible.push(p);
        }
      }

      // Ini cuma hiasan, gak perlu nyisir semua halaman sampai abis --
      // begitu kandidat udah cukup buat dipilih acak, berhenti.
      if (eligible.length >= API_PAGE_SIZE) break;
      if (data.length < API_PAGE_SIZE) break; // halaman terakhir
    }
  } catch (err) {
    console.log(`⚠️ Gagal ambil gambar hiasan !menu ("${tag}"):`, err.message);
    return null;
  }

  if (eligible.length === 0) return null;

  return eligible[Math.floor(Math.random() * eligible.length)];
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
▸ !togif
▸ !toimg

┏━━━━━━━━━━━━━━━┓
┃ 📥 *DOWNLOAD MEDIA*
┗━━━━━━━━━━━━━━━┛
▸ !dl
▸ !dlr

┏━━━━━━━━━━━━━━━┓
┃ 🖼️ *AI UPSCALE*
┗━━━━━━━━━━━━━━━┛
▸ !hd

┏━━━━━━━━━━━━━━━┓
┃ 📄 *DOKUMEN*
┗━━━━━━━━━━━━━━━┛
▸ !ringkas

┏━━━━━━━━━━━━━━━┓
┃ 💬 *CHAT AI*
┗━━━━━━━━━━━━━━━┛
▸ Tag aku (@AgemasenBot) buat ngobrol
▸ Atau reply pesanku buat lanjut obrolan
▸ !lupain

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

  togif: `🎞️ *!togif*

Ubah stiker ANIMASI balik jadi GIF (dikirim sebagai video yang muter-loop kayak GIF).

*Cara pakai:*
• Kirim stikernya dengan caption \`!togif\`.
• Atau kirim stikernya dulu, terus *reply* dengan \`!togif\`.

⚠️ Cuma buat stiker animasi. Kalau stikernya statis (bukan animasi), pakai *!toimg* aja.`,

  toimg: `🖼️ *!toimg*

Ubah stiker jadi gambar biasa (PNG). Kalau stikernya animasi, yang diambil cuma frame pertamanya.

*Cara pakai:*
• Kirim stikernya dengan caption \`!toimg\`.
• Atau kirim stikernya dulu, terus *reply* dengan \`!toimg\`.`,

  dl: `📥 *!dl <link>*

Download video/audio dari sebuah link: YouTube, Bilibili, Facebook (video/reel/postingan video), TikTok, Instagram, X/Twitter, dan situs lain yang didukung.

Kalau link-nya ternyata postingan *foto* (carousel Instagram, atau slideshow foto+musik TikTok), bot otomatis kirim semua fotonya satu-satu, plus musiknya (kalau ada) di akhir. Atau pakai *!dlr* langsung kalau sudah tau link-nya foto/carousel.

*Contoh:*
\`\`\`
!dl https://youtu.be/xxxxxxxxxxx
!dl https://youtu.be/xxxxxxxxxxx mp3
!dl https://www.tiktok.com/@user/video/xxxxxxxxxxx
!dl https://www.bilibili.com/video/xxxxxxxxxxx
!dl https://www.facebook.com/reel/xxxxxxxxxxx
!dl https://www.instagram.com/p/xxxxxxxxxxx
\`\`\`

Bisa langsung tambahin *mp3* atau *mp4* setelah link-nya kalau mau override format audio/video (default: video).

⚠️ Batas ukuran file *95MB*.`,

  dlr: `📷 *!dlr <link>*

Download khusus postingan *foto/carousel* -- Instagram carousel (beberapa foto digeser) atau TikTok mode foto+musik/slideshow. Semua foto dikirim satu-satu sesuai urutan aslinya, terus musiknya (kalau ada) di akhir.

Beda dari *!dl*: langsung ambil jalur foto tanpa nyoba download video dulu -- lebih cepat kalau kamu sudah tau link-nya carousel/slideshow foto (untuk video/reel biasa, tetap pakai *!dl*).

*Contoh:*
\`\`\`
!dlr https://www.instagram.com/p/xxxxxxxxxxx
!dlr https://www.tiktok.com/@user/video/xxxxxxxxxxx
\`\`\`

⚠️ Batas ukuran file *95MB* per foto. Postingan Facebook yang isinya cuma FOTO (bukan video) tidak didukung -- ini murni buat Instagram/TikTok.`,

  ringkas: `📄 *!ringkas [instruksi tambahan]*

Ringkas GARIS BESAR isi dokumen PDF pakai AI (Groq). Dokumen panjang (100+ halaman) otomatis dibaca per-bagian dulu baru digabung jadi 1 ringkasan, jadi tetap kebaca semuanya -- bukan cuma bagian awal doang.

*Cara pakai:*
• Kirim file PDF dengan caption \`!ringkas\`.
• Atau kirim PDF-nya dulu, terus *reply* dengan \`!ringkas\`.
• Boleh tambahin instruksi setelahnya, mis. \`!ringkas fokus ke bagian kesimpulan aja\`.

*Contoh:*
\`\`\`
!ringkas
!ringkas jelasin poin-poin utamanya aja
\`\`\`

💡 Setelah diringkas, kamu bisa nanya-nanya lebih detail soal isi dokumennya lewat chat biasa (tag @AgemasenBot / reply pesan bot) selama beberapa jam ke depan -- bot masih "inget" isi lengkap dokumennya, gak cuma ringkasannya.

⚠️ Cuma baca teks yang ADA di PDF-nya (PDF hasil scan/foto tanpa lapisan teks gak bisa dibaca). Dokumen yang EKSTREM panjang tetap ada batas mutlaknya, sisanya dipotong.`,

  lupain: `🧠 *!lupain*

Hapus ingatan obrolan chat AI (tsundere) kamu sama bot -- termasuk ingatan isi dokumen PDF dari !ringkas kalau ada -- bot bakal "lupa" semuanya dan mulai dari nol lagi.

Command pencarian gambar (!img/!next/!id) TIDAK kepengaruh, ini cuma buat ingatan obrolan chat AI-nya doang.`,
};


// Batas ukuran banner !menu (cuma buat jaga-jaga biar filenya gak
// kegedean/ngirim gambar mentah beresolusi tinggi). BUKAN kanvas tetap --
// rasio asli gambar dipertahankan (lihat toMenuBanner), gak dipaksa 16:9
// lagi. Ini aman dipakai karena fetchRandomImageForHelp sudah menyaring
// cuma gambar landscape/square yang lolos (lihat isBannerEligible), jadi
// gak akan ada sumber portrait yang perlu di-crop.
const MENU_BANNER_MAX_WIDTH = 1280;
const MENU_BANNER_MAX_HEIGHT = 1280;

async function toMenuBanner(buffer) {
  return sharp(buffer)
    .resize(MENU_BANNER_MAX_WIDTH, MENU_BANNER_MAX_HEIGHT, {
      fit: "inside", // cuma diperkecil kalau kelewat besar, TIDAK di-crop/pad -- rasio asli tetap
      withoutEnlargement: true, // gambar yang udah kecil gak dipaksa diperbesar
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

// WhatsApp punya batas ukuran ketat buat stiker WEBP -- animasi maksimal
// sekitar 500KB. Lewat dari situ, WA nolak KIRIM ULANG/forward stiker itu
// dengan pesan "can't send this sticker because it's too large", dan bahkan
// SEBELUM ditolak pun animasinya sering cuma tampil diam (frame pertama
// doang) pas pertama kali diterima -- persis gejala yang kelihatan dari
// bot ini. ffmpeg dengan "-preset default" tanpa "-quality" di-set (default
// 75) dan tanpa batas ukuran sama sekali gampang ngasilin file di atas itu
// buat GIF sumber yang lumayan panjang/detail.
const STICKER_MAX_BYTES = 500 * 1024;

// Tangga kualitas buat stiker ANIMASI: dicoba dari kualitas terbaik dulu,
// makin turun (quality, fps, dan durasi maksimal dipangkas bareng) sampai
// hasilnya muat di bawah STICKER_MAX_BYTES. Stiker STATIS (isStill) jarang
// sekali kebesaran (cuma 1 frame), jadi cukup 1 percobaan kualitas tinggi.
//
// PENTING soal `size`: sebelum ini, tangga cuma pernah menurunkan
// quality/fps/duration -- resolusi kontennya SELALU dipatok 512 (baru
// di-pad transparan ke kanvas 512x512, itu wajib format WA). Masalahnya,
// itu bukan jaminan hasil akhirnya <= STICKER_MAX_BYTES: kalau GIF sumber
// sudah "pas-pasan" (baru muat di tangga PALING BAWAH), nambahin overlay
// teks lewat !meme/!smeme bisa nambah ~40-50% ukuran (teks = informasi
// visual baru yang beneran makan bit), dan waktu itu terjadi TIDAK ADA
// tangga lagi buat diturunin -> hasil akhirnya nyeberang batas WA, animasi
// gagal/keliatan cuma diam pas pertama diterima ("meledak"). Makanya 2
// tangga darurat terakhir sengaja nambah `size` (konten diskalakan ke
// kotak lebih kecil SEBELUM di-pad ke kanvas 512x512 yang tetap wajib) --
// ini lever terakhir yang belum kepake, dan paling ampuh nurunin ukuran
// karena langsung motong jumlah piksel yang perlu di-encode tiap frame.
const ANIMATED_QUALITY_LADDER = [
  { quality: 75, fps: 12, duration: 10, size: 512 },
  { quality: 60, fps: 10, duration: 8, size: 512 },
  { quality: 45, fps: 10, duration: 6, size: 512 },
  { quality: 35, fps: 8, duration: 5, size: 512 },
  { quality: 25, fps: 8, duration: 4, size: 512 },
  { quality: 25, fps: 8, duration: 4, size: 400 }, // darurat: konten diperkecil
  { quality: 20, fps: 6, duration: 3, size: 320 }, // darurat terakhir
];
// Tangga kualitas buat stiker STATIS (isStill). Beda dari animasi: nomor 1
// (quality 90, size 512) cukup buat 99% kasus karena cuma 1 frame. TAPI ada
// jaring pengaman 2 tangga tambahan di bawahnya (size diperkecil) buat
// jaga-jaga kalau kontennya salah kedeteksi "still" padahal sebenarnya
// ANIMASI (mis. gara-gara flag isAnimated gak keisi -- lihat komentar di
// pemanggil sock.sendMessage({sticker,...}) soal ini). Kalau itu terjadi,
// TANPA jaring pengaman ini hasilnya bisa jauh di atas limit WA karena
// filter fps/durasi juga di-skip total buat jalur "still" (lihat
// buildArgs di gifToTextSticker/mediaToSticker).
const STILL_QUALITY_LADDER = [
  { quality: 90, fps: null, duration: null, size: 512 },
  { quality: 75, fps: null, duration: null, size: 400 },
  { quality: 60, fps: null, duration: null, size: 320 },
];

// `buildArgs(step)` harus mengembalikan array argumen ffmpeg lengkap untuk
// satu percobaan encode, memakai `step.quality` / `step.fps` /
// `step.duration`. Dipanggil berulang dengan step yang makin "murah" dari
// tangga kualitas sampai file outputnya <= STICKER_MAX_BYTES, atau sampai
// tangganya habis (dalam hal itu, hasil terkecil yang didapat tetap
// dikembalikan -- mendingan dikirim & mungkin gagal daripada bot diam).
async function runFfmpegUnderSizeLimit(buildArgs, outputPath, isStill) {
  const ladder = isStill ? STILL_QUALITY_LADDER : ANIMATED_QUALITY_LADDER;
  let buffer = null;

  for (let i = 0; i < ladder.length; i++) {
    const step = ladder[i];
    await runFfmpeg(buildArgs(step));
    buffer = fs.readFileSync(outputPath);

    if (buffer.length <= STICKER_MAX_BYTES) return buffer;

    const isLastStep = i === ladder.length - 1;
    console.log(
      `⚠️ [tangga ${i + 1}/${ladder.length}: q=${step.quality} fps=${step.fps ?? "-"} dur=${step.duration ?? "-"}s size=${step.size || 512}] ` +
        `Stiker ${Math.round(buffer.length / 1024)}KB > batas WA (~${STICKER_MAX_BYTES / 1024}KB)` +
        (isLastStep
          ? ", sudah di kualitas paling rendah, tetap dikirim apa adanya."
          : ", coba render ulang dengan kualitas lebih rendah..."),
    );
  }

  return buffer;
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

// Dokumen PDF (dipakai !ringkas) -- HANYA documentMessage bermime
// application/pdf. Beda jalur dari isStaticSource/isAnimatedSource di
// atas (yang khusus stiker/meme), karena PDF bukan media visual.
function isPdfSource(content) {
  if (!content) return false;
  if (!content.documentMessage) return false;
  const mime = content.documentMessage.mimetype || "";
  return mime === "application/pdf";
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

// Dokumen PDF (dipakai !ringkas).
function findPdfSource(msg) {
  return findMediaSource(msg, isPdfSource);
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

// Khusus stiker WA (BEDA dari findStickerSource yang generik, nerima
// stiker ATAUPUN foto -- dipakai !smeme). !togif dan !toimg maunya emang
// spesifik dari stiker, jadi foto/GIF/video yang di-reply sengaja tidak
// dianggap valid di sini.
function isStickerOnlySource(content) {
  return !!(content && content.stickerMessage);
}

function findStickerOnlySource(msg) {
  return findMediaSource(msg, isStickerOnlySource);
}

// Stiker yang aslinya bukan rasio 1:1 (mis. dibikin lewat !s/!meme/!smeme
// dari foto/video non-persegi) disimpan dengan border TRANSPARAN biar pas
// jadi kanvas 512x512 (syarat stiker WA). Masalahnya: MP4 (dipakai buat
// "GIF" WhatsApp lewat gifPlayback) TIDAK support transparansi -- begitu
// di-flatten, border transparan itu otomatis diisi warna solid (biasanya
// PUTIH) oleh ffmpeg, jadi hasilnya kelihatan ada "ruang putih" gak sesuai
// ukuran konten aslinya. Fungsi ini deteksi bounding-box area yang BENERAN
// kelihatan (alpha > threshold) dari 1 frame representatif, supaya nanti
// bisa di-crop dulu sebelum alpha-nya dibuang -- hasilnya pas ukuran
// konten aslinya, gak ada sisa border putih.
async function detectContentBoundingBox(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const ALPHA_THRESHOLD = 10; // toleransi noise kompresi di pinggir gambar

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + (channels - 1)];
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null; // semua transparan, aneh -> skip

  // Konten sudah memenuhi seluruh kanvas (gak ada border) -> gak perlu crop.
  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) {
    return null;
  }

  let cropW = maxX - minX + 1;
  let cropH = maxY - minY + 1;

  // Lebar/tinggi wajib genap buat yuv420p.
  if (cropW % 2 !== 0) cropW = Math.min(width - minX, cropW + 1);
  if (cropH % 2 !== 0) cropH = Math.min(height - minY, cropH + 1);

  return { x: minX, y: minY, width: cropW, height: cropH };
}

// !togif: stiker ANIMASI -> video mp4 yang dikirim dengan flag
// `gifPlayback`, supaya WhatsApp nampilin & muter-loop-in kayak GIF asli
// (WhatsApp gak pernah kirim file .gif mentah, selalu mp4 + flag ini).
async function animatedStickerToGifVideo(buffer) {
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(tmpDir, `togif-in-${uid}`);
  const outputPath = path.join(tmpDir, `togif-out-${uid}.mp4`);

  // Deteksi border transparan dari frame ASLI (sebelum lewat konversi apa
  // pun) -- asumsinya border ini statis/sama persis di semua frame, karena
  // memang begitu cara kerja letterbox/pad (bordernya gak ikut geser-geser
  // pas animasi jalan).
  const bbox = await detectContentBoundingBox(buffer).catch((err) => {
    console.log("⚠️ Gagal deteksi bounding-box, lanjut tanpa crop:", err.message);
    return null;
  });

  // Stiker WA animasi selalu WebP, dan ffmpeg gak bisa decode WebP animasi
  // langsung (lihat catatan panjang di normalizeFfmpegInputBuffer), jadi
  // dikonversi dulu ke GIF pakai sharp sebelum masuk ffmpeg.
  const normalized = await normalizeFfmpegInputBuffer(buffer);
  fs.writeFileSync(inputPath, normalized);

  try {
    const filters = [];

    if (bbox) {
      filters.push(`crop=${bbox.width}:${bbox.height}:${bbox.x}:${bbox.y}`);
    }

    // Lebar/tinggi WAJIB genap buat yuv420p, makanya dibulatkan ke bawah
    // ke kelipatan 2 terdekat (biasanya sudah genap habis crop, ini cuma
    // jaga-jaga).
    filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");

    const args = [
      "-y",
      "-i",
      inputPath,
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      filters.join(","),
      "-an",
      outputPath,
    ];

    await runFfmpeg(args);

    return fs.readFileSync(outputPath);
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

// !toimg: stiker (statis, atau animasi -- kalau animasi cuma diambil
// frame pertamanya) -> buffer gambar PNG biasa. Sharp otomatis kasih
// frame pertama aja buat WebP animasi kalau {animated:true} gak di-set,
// jadi tidak perlu penanganan animasi/statis secara terpisah di sini.
// Border transparan (padding biar pas kanvas persegi stiker WA) juga
// di-crop dulu, supaya ukuran gambar yang keluar itu sesuai konten
// aslinya, bukan ukuran kanvas stiker yang dipaksa persegi.
async function stickerToImageBuffer(buffer) {
  const image = sharp(buffer).png();
  const bbox = await detectContentBoundingBox(buffer).catch(() => null);

  if (bbox) {
    image.extract({
      left: bbox.x,
      top: bbox.y,
      width: bbox.width,
      height: bbox.height,
    });
  }

  return image.toBuffer();
}

// =====================================================
// Fitur: Download media dari link ("!dl")
// YouTube (video/short), Bilibili, Facebook (video/reel/postingan video),
// TikTok, Instagram, Twitter/X, dst -- semua situs yang didukung yt-dlp.
//
// Dukungan YouTube awalnya dibangun dari resep "yt-dlp-rescue" (Maret
// 2026) buat 2 masalah utama: SABR throttle (client "web" default cuma
// kasih 1 format 360p) & deteksi bot di IP cloud/datacenter. TAPI per
// Agustus 2026, sebagian resep itu sudah basi -- lihat komentar detail di
// bagian "Khusus YouTube" di bawah (dalam downloadMediaFromUrl) buat
// histori kenapa override player_client dihapus.
//
// Yang MASIH dipakai sekarang:
//   - --js-runtimes node (Node.js SUDAH terinstall buat project ini
//     sendiri) buat nyelesein signature/n challenge.
//   - --force-ipv4, cegah masalah routing IPv6 di beberapa cloud provider.
//   - Opsional PO Token server (lihat YTDLP_POT_BASE_URL) buat kasus
//     yang masih kena deteksi bot -- SANGAT DIREKOMENDASIKAN buat
//     deployment cloud/server (Railway dst), karena IP datacenter jauh
//     lebih sering diblokir YouTube dibanding IP residensial biasa.
//
// PENTING: ini butuh binary "yt-dlp" TERINSTALL DI SERVER, terpisah dari
// dependency npm project ini (npm wrapper yt-dlp-exec ternyata rapuh --
// postinstall-nya sering gagal ambil binary dari GitHub releases). Cara
// paling gampang & paling stabil: `pip install -U yt-dlp` di server, atau
// download binary standalone-nya dari GitHub releases resmi yt-dlp lalu
// taruh di PATH. Kalau nama/lokasi binary-nya beda, override lewat env
// var YTDLP_PATH (sama seperti pola MEME_FONT_PATH di atas).
//
// ffmpeg TIDAK perlu diinstall terpisah untuk fitur ini -- kita pakai
// ffmpeg-static yang sudah jadi dependency project ini (lewat
// --ffmpeg-location), jadi yt-dlp bisa gabungin stream video+audio atau
// convert ke MP3 tanpa butuh ffmpeg sistem.
// =====================================================
const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";
// Binary "gallery-dl" -- TERPISAH dari yt-dlp, dipakai KHUSUS buat jalur
// foto/carousel/slideshow ("!dl" fallback foto & "!dlr"). yt-dlp TERBUKTI
// gak reliable buat foto Instagram/TikTok (lihat komentar panjang di
// downloadGalleryFromUrl di bawah) -- gallery-dl dirancang khusus buat
// gambar/galeri jadi jauh lebih cocok buat kasus ini.
const GALLERYDL_PATH = process.env.GALLERYDL_PATH || "gallery-dl";

// Cookies buat gallery-dl (khusus Instagram) -- sejak pertengahan 2025,
// Instagram makin agresif maksa login bahkan buat postingan PUBLIK kalau
// request-nya datang tanpa cookies/sesi yang valid. Tanpa ini,
// gallery-dl bakal kena redirect ke halaman login ("HTTP redirect to
// login page") dan gagal total, walau link-nya postingan publik biasa.
//
// Cara siapin:
//   1. Login ke instagram.com di browser BIASA (Chrome/Firefox) pakai
//      akun mana aja (disaranin akun "buangan", BUKAN akun utama --
//      cookies ini dipakai bareng buat SEMUA request bot, jadi kalau
//      akunnya kena flag, semua fitur foto IG ikut kena).
//   2. Export cookies-nya ke format Netscape (cookies.txt) pakai
//      extension browser, mis. "Get cookies.txt LOCALLY" (Chrome) atau
//      "cookies.txt" (Firefox).
//   3. Upload file hasil export itu ke server (mis. taruh di repo project
//      -- TAPI JANGAN commit ke git public, tambahin ke .gitignore --
//      atau upload manual ke Railway lewat volume/shell).
//   4. Set env var ini (di Railway tab Variables) ke path file-nya, mis.
//      GALLERYDL_COOKIES_FILE=/app/instagram-cookies.txt
//
// Opsional -- kalau kosong (default), gallery-dl jalan tanpa cookies
// (bakal gagal khusus buat Instagram, TikTok biasanya masih OK tanpa
// ini). Cookies expire dari waktu ke waktu (biasanya beberapa
// minggu/bulan) -- kalau tiba-tiba mulai gagal lagi dengan pesan yang
// sama, kemungkinan besar cookies-nya sudah kadaluarsa, tinggal ulangi
// langkah export di atas.
const GALLERYDL_COOKIES_FILE = process.env.GALLERYDL_COOKIES_FILE || "";

// Alternatif dari GALLERYDL_COOKIES_FILE di atas -- LEBIH SIMPEL setup-nya
// (gak perlu extension browser & export manual), tapi TRADE-OFF-nya
// password akun IG kesimpen di server (env var) dan gallery-dl login
// sendiri lewat script setiap kali dipanggil -- pola ini lebih gampang
// bikin Instagram curiga & minta verifikasi tambahan ("Suspicious Login
// Attempt" / checkpoint / 2FA) dibanding pakai cookies dari sesi browser
// asli.
//
// WAJIB pakai akun "buangan", BUKAN akun IG utama/pribadi -- akun ini
// dipakai bareng buat SEMUA request bot, jadi paling rawan kena
// flag/suspend duluan kalau bot dipakai banyak orang & sering.
//
// Kalau KEDUANYA (cookies file & username/password) diisi, cookies file
// yang menang (lihat downloadGalleryFromUrl) -- keduanya gak dipakai
// bareng.
//
// Cara pakai: isi 2 env var ini di Railway (tab Variables):
//   GALLERYDL_INSTAGRAM_USERNAME = username akun buangan
//   GALLERYDL_INSTAGRAM_PASSWORD = password akun buangan
//
// Kosongkan (default) buat nonaktifin -- gallery-dl jalan tanpa
// autentikasi Instagram sama sekali (bakal gagal khusus Instagram, lihat
// komentar GALLERYDL_COOKIES_FILE di atas soal kenapa).
const GALLERYDL_INSTAGRAM_USERNAME =
  process.env.GALLERYDL_INSTAGRAM_USERNAME || "";
const GALLERYDL_INSTAGRAM_PASSWORD =
  process.env.GALLERYDL_INSTAGRAM_PASSWORD || "";

// URL base HTTP server "bgutil-ytdlp-pot-provider" (Proof-of-Origin Token
// provider), KALAU mau di-deploy sebagai service terpisah (mis. di
// Railway) buat kasus deteksi bot yang masih lolos walau sudah pakai
// client rotation + --js-runtimes node.
//
// Opsional -- kalau env var ini KOSONG (default), fitur ini gak diaktifin
// dan bot tetap jalan cuma mengandalkan client rotation. Kalau mau aktifin:
//  1. Plugin Python-nya harus terinstall di server yang sama dengan
//     binary yt-dlp: `pip install -U bgutil-ytdlp-pot-provider`
//  2. Service HTTP provider-nya harus jalan terpisah & bisa diakses dari
//     sini, lalu isi env var ini dengan URL-nya (mis. http://127.0.0.1:4416
//     kalau satu container, atau URL publik/private networking Railway
//     kalau service terpisah).
const YTDLP_POT_BASE_URL = process.env.YTDLP_POT_BASE_URL || "";

// Fallback PALING GAMPANG (tapi paling gak scalable) buat kasus deteksi bot
// "Sign in to confirm you're not a bot": --cookies-from-browser, ambil
// cookies YouTube langsung dari browser lokal yang sudah login.
//
// HANYA cocok buat TESTING DI LAPTOP SENDIRI (bukan Railway/cloud server)
// karena:
//   - Butuh browser beneran terinstall & sudah login YouTube di MESIN YANG
//     SAMA tempat yt-dlp jalan -- di container Railway gak ada browser.
//   - Cookies akun pribadi kepakai buat semua request bot -- kalau bot
//     dipakai banyak orang & sering, akun YouTube-nya sendiri yang bisa
//     kena flag/rate-limit, bukan cuma IP server-nya.
//   - Cookies expire & perlu login ulang di browser dari waktu ke waktu.
//
// Isi dengan nama browser yang dipakai: "chrome", "edge", "firefox", dst.
// Opsional -- kosongkan (default) buat nonaktifin.
const YTDLP_COOKIES_FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER || "";

// Batas ukuran file hasil download, biar gak nyoba kirim file raksasa yang
// bakal gagal/lambat banget dikirim lewat WhatsApp.
const DL_MAX_FILESIZE = "95M";

// =====================================================
// QUEUE -- batasin berapa banyak proses yt-dlp yang boleh jalan BERSAMAAN.
// Tanpa ini, kalau 10-20 orang nge-`!dl` bareng, server bisa langsung
// jalanin 10-20 proses yt-dlp sekaligus -> gampang banget kena rate-limit
// (429) atau bikin server kehabisan resource. Dengan queue, cuma
// DL_QUEUE_CONCURRENCY job yang jalan bersamaan, sisanya ngantre giliran.
// =====================================================
const DL_QUEUE_CONCURRENCY = Number(process.env.DL_QUEUE_CONCURRENCY) || 2;
let dlActiveWorkers = 0;
const dlQueue = [];

// =====================================================
// BACKOFF OTOMATIS KHUSUS YOUTUBE -- jawaban buat pertanyaan "gimana cara
// tau kapan boleh coba lagi": daripada nebak-nebak manual atau spam test
// yang malah bikin makin lama redanya, bot ini otomatis "diam" sendiri
// begitu kedeteksi kena rate-limit (429) atau bot-detection (LOGIN_REQUIRED
// / "sign in to confirm"), terus otomatis coba lagi kalau waktunya udah
// lewat -- gak perlu restart bot atau ubah kode manual tiap kali kena.
//
// Cara kerja: exponential backoff. Gagal pertama -> tunggu 15 menit.
// Masih gagal lagi (dalam masa itu ada yang coba lain) -> waktu tunggu
// DIGANDAKAN (30 menit, 60 menit, dst), sampai batas maksimal 4 jam.
// Begitu ada 1 percobaan yang BERHASIL, backoff langsung direset ke 0 --
// jadi gak perlu manual "kasih tau bot udah aman" segala.
// =====================================================
const YTDLP_BACKOFF_INITIAL_MS = 15 * 60 * 1000; // 15 menit
const YTDLP_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000; // 4 jam
let ytdlpBackoffUntil = 0; // timestamp (ms) -- 0 artinya gak lagi backoff
let ytdlpBackoffMs = 0; // durasi backoff TERAKHIR yang dipakai (buat digandain kalau gagal lagi)

function getYtdlpBackoffRemainingMs() {
  return Math.max(0, ytdlpBackoffUntil - Date.now());
}

function formatDurationId(ms) {
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes} menit`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} jam ${minutes} menit` : `${hours} jam`;
}

// Dipanggil tiap kali download YouTube GAGAL karena pola rate-limit/bot-
// detection (lihat pemanggilnya di handleDlDownload). Kalau gagalnya
// karena alasan lain (video private, geo-restricted, dst), JANGAN panggil
// ini -- itu bukan soal IP kena limit, jadi gak perlu ikut nge-backoff.
function registerYtdlpRateLimitFailure() {
  ytdlpBackoffMs = ytdlpBackoffMs
    ? Math.min(ytdlpBackoffMs * 2, YTDLP_BACKOFF_MAX_MS)
    : YTDLP_BACKOFF_INITIAL_MS;
  ytdlpBackoffUntil = Date.now() + ytdlpBackoffMs;
  console.log(
    `[yt-dlp][backoff] Kena rate-limit/bot-detection. Backoff dinaikkan ke ${formatDurationId(ytdlpBackoffMs)}, sampai ${new Date(ytdlpBackoffUntil).toISOString()}`,
  );
}

// Dipanggil tiap kali download YouTube BERHASIL -- reset backoff, karena
// itu bukti IP-nya udah gak lagi kena limit.
function registerYtdlpSuccess() {
  if (ytdlpBackoffMs > 0) {
    console.log("[yt-dlp][backoff] Download berhasil, backoff direset.");
  }
  ytdlpBackoffMs = 0;
  ytdlpBackoffUntil = 0;
}

// Pola stderr yang nandain "ini soal IP/rate-limit", BUKAN soal video-nya
// sendiri (private/geo-restricted/dll -- itu gak ada hubungannya sama
// kondisi IP, jadi gak perlu bikin bot ikut "diam").
function isRateLimitOrBotDetectionError(raw) {
  return /HTTP Error 429|Too Many Requests|sign in to confirm you.?re not a bot|Only images are available|Missing required Visitor Data/i.test(
    raw || "",
  );
}

function processDlQueue() {
  while (dlActiveWorkers < DL_QUEUE_CONCURRENCY && dlQueue.length > 0) {
    const job = dlQueue.shift();
    dlActiveWorkers++;
    job
      .jobFn()
      .then(job.resolve, job.reject)
      .finally(() => {
        dlActiveWorkers--;
        processDlQueue();
      });
  }
}

function enqueueDownloadJob(jobFn) {
  return new Promise((resolve, reject) => {
    dlQueue.push({ jobFn, resolve, reject });
    processDlQueue();
  });
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "yt-dlp tidak ditemukan di server. Install dulu (`pip install -U yt-dlp`) lalu pastikan ada di PATH, atau set env var YTDLP_PATH ke lokasi binary-nya.",
          ),
        );
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        // Log stderr MENTAH ke console (keliatan di Railway Logs) supaya
        // gampang di-debug -- pesan yang dikirim ke WhatsApp sengaja
        // disederhanain (lihat friendlyDlError), jadi tanpa ini kita gak
        // bisa lihat detail teknis aslinya dari luar server.
        console.error("[yt-dlp] gagal, stderr mentah:\n" + stderr);
        const err = new Error(
          `yt-dlp keluar dengan kode ${code}\n${stderr.slice(-800)}`,
        );
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

// Ubah pesan error mentah dari yt-dlp (yang teknis/kadang bahasa lain,
// kadang malah traceback Python) jadi pesan yang gampang dipahami user
// WhatsApp, buat kasus-kasus umum yang sering ketemu. Kalau gak ada pola
// yang dikenal, fallback ke baris pertama pesan error yt-dlp-nya.
function friendlyDlError(err) {
  const raw = err.stderr || "";

  if (
    /版权地区受限|not available in your country|not available in your location|geo.?restrict/i.test(
      raw,
    )
  ) {
    return "🌍 Video ini dibatasi wilayah (geo-restricted) oleh platform aslinya -- server bot tidak bisa akses dari lokasinya. Coba video/link lain.";
  }
  if (/private video|video is private/i.test(raw)) {
    return "🔒 Videonya bersifat privat, gak bisa diakses tanpa login.";
  }
  // PENTING: dicek DULUAN sebelum age-restrict, karena pesan ini pola
  // katanya mirip ("sign in to confirm...") tapi artinya beda total --
  // ini YouTube curiga IP server-nya bot/datacenter, BUKAN video-nya
  // dibatasi umur. Kalau ini yang muncul terus-terusan meski sudah pakai
  // client rotation (lihat komentar downloadMediaFromUrl), coba aktifin
  // PO Token server (YTDLP_POT_BASE_URL).
  if (/sign in to confirm you.?re not a bot/i.test(raw)) {
    return "🤖 YouTube mendeteksi server bot ini sebagai traffic mencurigakan (umum terjadi di IP cloud/datacenter kayak Railway/AWS/GCP) -- ini BUKAN soal video dibatasi umur. Coba lagi beberapa saat, atau aktifin PO Token server (env var YTDLP_POT_BASE_URL) buat solusi lebih permanen.";
  }
  if (/sign in to confirm|age.?restrict/i.test(raw)) {
    return "🔞 Video ini dibatasi umur oleh platformnya dan butuh login -- bot ini gak bisa login akun.";
  }
  if (/bgutil.*(connection refused|econnrefused|failed to fetch|timed? ?out)/i.test(raw)) {
    return "⚙️ POT provider (bgutil) gak bisa dihubungi dari server -- cek apakah service-nya masih jalan & YTDLP_POT_BASE_URL sudah benar.";
  }
  if (
    /video unavailable|content isn.?t available|no longer available|this video (has been removed|is unavailable)/i.test(
      raw,
    )
  ) {
    return "❌ Video/postingannya sudah tidak tersedia (mungkin dihapus atau link-nya salah).";
  }
  if (/unsupported url|no extractor/i.test(raw)) {
    return "❌ Link ini belum didukung buat didownload.";
  }

  if (!err.stderr) {
    // Ini error yang kita lempar sendiri (bukan dari stderr yt-dlp),
    // pesannya udah pasti ramah buat user, tinggal dipakai apa adanya.
    return err.message;
  }

  // Fallback terakhir: baris "ERROR: ..." pertama dari output yt-dlp,
  // dipangkas biar gak nampilin traceback Python yang teknis banget.
  const firstErrorLine =
    raw.split("\n").find((l) => l.trim().startsWith("ERROR:")) ||
    raw.split("\n").find(Boolean);
  return (firstErrorLine || "Terjadi kesalahan saat download.").replace(
    /^ERROR:\s*/,
    "",
  );
}

// Deteksi link YouTube (termasuk youtu.be & Shorts) -- dipakai buat
// nambahin argumen khusus YouTube (client rotation, dst -- lihat
// downloadMediaFromUrl) di "!dl".
function isYoutubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

// mode: "video" -> MP4 (gabungan video+audio terbaik dalam batas ukuran)
//       "audio" -> MP3 (audio-only, hasil ekstraksi)
// Generik untuk YouTube (video/short), Bilibili, Facebook (video/reel/
// postingan video), TikTok, Instagram, X/Twitter, dst -- semua situs yang
// didukung yt-dlp. YouTube dapet argumen tambahan (lihat di bawah).
async function downloadMediaFromUrl(url, mode) {
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const outputTemplate = path.join(tmpDir, `dl-${uid}.%(ext)s`);

  const commonArgs = [
    "--no-playlist",
    // CATATAN: --no-warnings SENGAJA TIDAK dipakai (walau dulu ada). Flag
    // itu nyembunyiin baris WARNING dari stderr yang ditangkap bot --
    // termasuk baris "HTTP Error 429" dan info PO Token yang JUSTRU jadi
    // sinyal utama buat sistem backoff otomatis (lihat
    // isRateLimitOrBotDetectionError) ndeteksi rate-limit. Tanpa warning
    // ini, bot cuma lihat baris ERROR generik ("Requested format is not
    // available") tanpa tau AKAR masalahnya rate-limit atau bukan -- jadi
    // backoff otomatis gak pernah kepicu walau sebenarnya lagi kena 429.
    // Baris WARNING ini cuma masuk ke console.log (Railway Logs), TIDAK
    // ikut dikirim ke user WhatsApp (itu tetap lewat friendlyDlError),
    // jadi aman gak bikin pesan ke user jadi berantakan.
    "--ffmpeg-location",
    path.dirname(ffmpegPath),
    "--max-filesize",
    DL_MAX_FILESIZE,
    // Jeda kecil (detik) antar request internal yt-dlp -- bukan obat buat
    // rate-limit yang udah kejadian, tapi pencegahan biar gak gampang
    // numpuk ke 429 lagi terutama kalau banyak download YouTube beruntun.
    "--sleep-requests",
    "1",
    "-o",
    outputTemplate,
  ];

  // Khusus YouTube.
  //
  // CATATAN (Agustus 2026, update ke-2): sempat dihapus sama sekali (lihat
  // histori komentar di atas), TAPI ternyata di IP Railway (datacenter),
  // client default yang dipilih otomatis yt-dlp (visionos) kena
  // LOGIN_REQUIRED walau PO Token sudah valid -- beda dari test di IP
  // residensial yang mulus tanpa override apa pun.
  //
  // Ditest manual satu-satu langsung di container Railway:
  //   - default/tanpa override (visionos)  -> LOGIN_REQUIRED
  //   - android_vr                          -> GVS PO Token gak didukung
  //                                             provider bgutil sama sekali
  //                                             (semua format di-skip)
  //   - web (+ POT provider yang valid)     -> BERHASIL, download penuh
  //
  // Jadi "web" dipasang eksplisit lagi -- BUKAN rotasi banyak client kayak
  // resep asli, cuma satu client yang sudah terbukti cocok dipasangkan
  // dengan bgutil POT provider. Kalau nanti kualitas hasil download-nya
  // masih suka mentok di format rendah (SABR throttle web client), baru
  // pertimbangkan nambahin visitor_data atau POT context lain -- tapi
  // jangan buru-buru rotasi ke client lain lagi tanpa test manual dulu,
  // karena provider bgutil ini spesifik cuma dukung PO Token buat
  // keluarga client "web" (web, mweb, web_safari, tv), bukan mobile/VR.
  if (isYoutubeUrl(url)) {
    commonArgs.push("--extractor-args", "youtube:player_client=web");

    // Cegah masalah routing IPv6 yang lumayan sering kejadian di
    // beberapa cloud provider (Railway/AWS/GCP dst).
    commonArgs.push("--force-ipv4");

    // Solver signature/n challenge YouTube -- pakai runtime "node" (SUDAH
    // terinstall buat project ini sendiri, jadi TIDAK butuh install Deno
    // terpisah). --remote-components auto-download komponen solver
    // terbaru dari GitHub kalau versi cache lokal ketinggalan zaman.
    commonArgs.push("--js-runtimes", "node");
    commonArgs.push("--remote-components", "ejs:github");

    // Kalau POT provider di-set (lihat komentar YTDLP_POT_BASE_URL di
    // atas), kasih tau yt-dlp lokasinya -- ini buat kasus deteksi bot
    // yang masih lolos walau sudah pakai client rotation di atas.
    if (YTDLP_POT_BASE_URL) {
      commonArgs.push(
        "--extractor-args",
        `youtubepot-bgutilhttp:base_url=${YTDLP_POT_BASE_URL}`,
      );
    }

    // Fallback cookies-from-browser (lihat komentar YTDLP_COOKIES_FROM_BROWSER
    // di atas) -- hanya diaktifin kalau env var-nya di-set.
    if (YTDLP_COOKIES_FROM_BROWSER) {
      commonArgs.push("--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER);
    }
  }

  const args =
    mode === "audio"
      ? [
          ...commonArgs,
          "-x",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "5",
          url,
        ]
      : [
          ...commonArgs,
          "-f",
          // PENTING: paksa codec H.264 (avc1) + AAC (mp4a), BUKAN cuma
          // "terbaik apa adanya". yt-dlp defaultnya sering milih VP9/AV1
          // + Opus (kualitas oke tapi codec modern) yang cuma bisa
          // dimainin di player berbasis browser (WA Web/Chrome), TAPI
          // player video native di app WA HP kebanyakan cuma jamin
          // dukung H.264+AAC -- makanya video ke-download tapi gak bisa
          // dibuka di HP.
          //
          // Kualitas dibatasi 360p-720p (bukan "sebesar-besarnya"):
          //   - Atas (720p): cukup buat nonton normal, gak perlu 1080p/4K
          //     yang bikin file gede & lama diproses/dikirim ke WhatsApp.
          //   - Bawah (360p): ini juga kebetulan pas sama batas bawah
          //     yang masih sering YouTube kasih walau lagi mode SABR
          //     (server cuma ngasih 1 format progresif kayak itag 18,
          //     360p) -- jadi selector ini tetap dapet sesuatu di kasus
          //     video yang paling dibatasin sekalipun, bukannya gagal
          //     total kena "Requested format is not available".
          //
          // CATATAN: filter [filesize<95M] SENGAJA TIDAK dipakai di sini
          // (walau versi sebelumnya ada). Filter itu cuma ngecek field
          // "filesize" PASTI -- format yang cuma punya "filesize_approx"
          // (kayak itag 18 pas mode SABR, ditandai simbol "\u2248" di
          // --list-formats) bakal KETOLAK filter itu walau ukuran
          // aslinya kecil, bikin selector gagal total ("Requested format
          // is not available") padahal ada format yang muat. Batas
          // ukuran file tetap ditegakkan lewat flag --max-filesize
          // (lihat DL_MAX_FILESIZE di atas), yang otomatis
          // mempertimbangkan filesize_approx juga.
          //
          // 4 tingkat fallback: DASH avc1+mp4a max 720p -> progresif
          // avc1 max 720p -> apa pun max 720p (asal masih >=360p) ->
          // pamungkas "apa aja yang penting kebentuk" (kalau video-nya
          // emang cuma punya format di luar rentang itu).
          "bestvideo[height<=720][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=720][vcodec^=avc1]/best[height<=720][height>=360]/best",
          "--merge-output-format",
          "mp4",
          url,
        ];

  try {
    try {
      await runYtDlp(args);
    } catch (err) {
      // Instagram (carousel foto) khususnya SERING keluar exit code 1
      // (BUKAN 0 dengan file kosong seperti kasus di bawah) dengan pesan
      // literal "No video formats found!" per slide -- ini juga tanda
      // postingan foto, bukan cuma pola "sukses tapi file kosong".
      // Ditandai sama kayak di bawah biar handleDlDownload otomatis
      // nyoba jalur foto (tryHandleAsPhotoPost).
      if (/No video formats found/i.test(err.stderr || err.message || "")) {
        err.possiblyPhotoOnly = true;
      }
      throw err;
    }

    // Nama file pastinya baru ketahuan setelah yt-dlp selesai (ekstensi
    // ditentukan otomatis olehnya), jadi dicari lewat prefix uid ini.
    const files = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith(`dl-${uid}`));

    if (files.length === 0) {
      // yt-dlp selesai TANPA error (exit code 0) tapi gak ada file yang
      // dihasilkan -- pola ini paling sering kejadian pas link-nya
      // postingan FOTO (carousel Instagram / slideshow TikTok), bukan
      // video. Ditandai lewat properti ini biar handleDlDownload bisa
      // otomatis nyoba jalur foto (lihat tryHandleAsPhotoPost) sebelum
      // nyerah dan nampilin error ke user.
      const err = new Error(
        "File hasil download tidak ditemukan. Mungkin link-nya tidak mengandung video/audio (mis. postingan berupa foto saja), atau ukurannya melebihi batas 95MB.",
      );
      err.possiblyPhotoOnly = true;
      throw err;
    }

    const outputPath = path.join(tmpDir, files[0]);
    const buffer = fs.readFileSync(outputPath);

    return { buffer };
  } finally {
    // Bersihin semua file sisa dengan prefix uid ini (termasuk file
    // sementara lain yang mungkin ditinggal yt-dlp kalau prosesnya gagal
    // di tengah jalan).
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.startsWith(`dl-${uid}`)) {
          fs.rm(path.join(tmpDir, f), { force: true }, () => {});
        }
      }
    } catch {
      // abaikan -- ini cuma usaha bersih-bersih tmp, bukan hal kritis
    }
  }
}

// =====================================================
// Fitur: download foto/carousel/slideshow ("!dl" fallback foto & "!dlr")
// -- Agustus 2026, migrasi dari yt-dlp ke gallery-dl
// -----------------------------------------------------
// PENTING (kenapa BUKAN pakai yt-dlp lagi): sempat dicoba pakai yt-dlp
// dulu (--yes-playlist dst), TAPI ternyata itu bukan cuma soal argumen
// yang kurang tepat -- yt-dlp memang gak reliable buat narik foto
// carousel Instagram. ini KONFIRMASI dari laporan resmi di GitHub
// yt-dlp (issue #12439, "Cannot retrieve Instagram post data ... Cannot
// download images") yang DITUTUP oleh maintainer-nya sebagai "invalid"
// -- bukan bug yang bakal diperbaiki, karena yt-dlp emang dirancang buat
// video, formatnya maksa nyari "video formats" bahkan buat slide yang
// isinya cuma gambar, makanya error "No video formats found!".
//
// "gallery-dl" (proyek terpisah, TERPISAH dari yt-dlp) didesain khusus
// buat gambar/galeri, dan resmi dukung Instagram (Posts/Reels) & TikTok
// (termasuk mode foto+musik/slideshow, ditambahkan Feb 2025) tanpa
// masalah "no video formats" itu -- makanya jalur foto sekarang pindah
// ke sini, TERPISAH dari runYtDlp/downloadMediaFromUrl yang tetap pakai
// yt-dlp buat video/audio biasa.
//
// Beda dari jalur video: pakai folder tujuan UNIK per job (lewat "-D",
// override total struktur folder bawaan gallery-dl per situs/user) biar
// gampang baca balik semua file hasil download tanpa perlu tebak-tebak
// nama file. Foto & musik latar (kalau ada, khusus TikTok slideshow)
// ke-download dalam SATU proses gallery-dl yang sama -- gak perlu 2 kali
// panggil kayak versi yt-dlp dulu.
// =====================================================
function runGalleryDl(args) {
  return new Promise((resolve, reject) => {
    let proc;

    try {
      proc = spawn(GALLERYDL_PATH, args);
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `gallery-dl tidak ditemukan di server. Install dulu ` +
              `(\`pip install -U gallery-dl\`) lalu pastikan ada di PATH, ` +
              `atau set env var GALLERYDL_PATH ke lokasi binary-nya.`,
          ),
        );
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error("[gallery-dl] gagal, stderr mentah:\n" + stderr);
        const err = new Error(
          `gallery-dl keluar dengan kode ${code}\n${stderr.slice(-800)}`,
        );
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function downloadGalleryFromUrl(url) {
  const uid = crypto.randomBytes(6).toString("hex");
  const jobDir = path.join(os.tmpdir(), `dlgallery-${uid}`);
  fs.mkdirSync(jobDir, { recursive: true });

  const args = [
    "-D",
    jobDir, // simpan SEMUA file langsung di folder ini, gak usah nested per situs/user
    "--no-mtime",
  ];

  // Kalau cookies Instagram udah disiapin (lihat komentar panjang di
  // GALLERYDL_COOKIES_FILE), pakai buat semua request -- ini yang
  // nyelesein error "HTTP redirect to login page" khusus Instagram.
  // TikTok gak butuh ini, tapi gak masalah dikasih bareng karena
  // gallery-dl cuma make cookies yang cocok domain-nya per situs.
  //
  // Cookies file diprioritaskan di atas username/password kalau DUA-
  // duanya keisi -- lebih stabil karena gak nge-trigger login script
  // baru tiap kali dipanggil (lihat komentar GALLERYDL_INSTAGRAM_USERNAME
  // soal kenapa itu lebih rawan checkpoint).
  if (GALLERYDL_COOKIES_FILE) {
    args.push("--cookies", GALLERYDL_COOKIES_FILE);
  } else if (GALLERYDL_INSTAGRAM_USERNAME && GALLERYDL_INSTAGRAM_PASSWORD) {
    args.push(
      "--username",
      GALLERYDL_INSTAGRAM_USERNAME,
      "--password",
      GALLERYDL_INSTAGRAM_PASSWORD,
    );
  }

  args.push(url);

  try {
    await runGalleryDl(args);

    const allFiles = fs.readdirSync(jobDir).sort();
    const imageExtRe = /\.(jpe?g|png|webp|heic|heif)$/i;
    const audioExtRe = /\.(mp3|m4a|aac|ogg)$/i;

    const imageFiles = allFiles.filter((f) => imageExtRe.test(f));
    const audioFiles = allFiles.filter((f) => audioExtRe.test(f));

    if (imageFiles.length === 0) {
      throw new Error("Tidak ada foto yang bisa diunduh dari link ini.");
    }

    const imageBuffers = imageFiles.map((f) =>
      fs.readFileSync(path.join(jobDir, f)),
    );

    let audioBuffer = null;
    let audioExt = null;
    if (audioFiles.length > 0) {
      audioExt = path.extname(audioFiles[0]).slice(1).toLowerCase();
      audioBuffer = fs.readFileSync(path.join(jobDir, audioFiles[0]));
    }

    return { imageBuffers, audioBuffer, audioExt };
  } finally {
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
  }
}

// Inti kirim galeri foto + musik latar (kalau ada) -- dipakai BARENG oleh
// 2 pemanggil: tryHandleAsPhotoPost (fallback otomatis dari "!dl") dan
// handleDlrDownload ("!dlr", command khusus foto/carousel). Return true
// kalau berhasil kirim minimal 1 foto, false kalau ternyata gak ada foto
// yang bisa diambil dari link ini sama sekali.
async function sendPhotoGallery(sock, jid, url) {
  let imageBuffers, audioBuffer, audioExt;
  try {
    const result = await enqueueDownloadJob(() =>
      downloadGalleryFromUrl(url),
    );
    imageBuffers = result.imageBuffers;
    audioBuffer = result.audioBuffer;
    audioExt = result.audioExt;
  } catch (err) {
    console.log("[dl][foto] Gagal download foto:", err.message || err);
    return false;
  }

  for (let i = 0; i < imageBuffers.length; i++) {
    await sock.sendMessage(jid, {
      image: imageBuffers[i],
      caption:
        i === 0
          ? `✅ Berhasil didownload (${imageBuffers.length} foto).\n🔗 ${url}`
          : undefined,
    });
  }

  // Musik latar (kalau ada -- khusus TikTok slideshow) dikirim TERAKHIR,
  // setelah semua foto -- biar urutan pesan di chat rapi.
  if (audioBuffer) {
    const mimetypeByExt = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
    };
    await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: mimetypeByExt[audioExt] || "audio/mp4",
      fileName: `musik.${audioExt || "mp3"}`,
    });
  }

  return true;
}

// Dipanggil dari catch block handleDlDownload sebagai fallback OTOMATIS
// kalau "!dl" biasa ternyata kena link foto/carousel. Return true kalau
// berhasil kirim minimal 1 foto (artinya user SUDAH dapet respons,
// pemanggil gak perlu nampilin pesan error generik lagi) -- return false
// kalau ternyata bukan postingan foto juga, biar pemanggil lanjut ke
// pesan error biasa.
async function tryHandleAsPhotoPost(sock, jid, url) {
  await sock.sendMessage(jid, {
    text: "🖼️ Sepertinya ini postingan foto, bukan video. Coba download fotonya...",
  });

  return sendPhotoGallery(sock, jid, url);
}

// "!dlr <link>" -- command KHUSUS foto/carousel/slideshow, langsung ambil
// jalur foto tanpa nyoba jalur video dulu (beda dari "!dl" yang nyoba
// video dulu baru fallback ke foto kalau gagal). Berguna kalau user sudah
// tau link-nya carousel/slideshow, biar gak buang waktu nunggu percobaan
// video yang pasti gagal duluan.
async function handleDlrDownload(sock, jid, url) {
  try {
    await sock.sendMessage(jid, {
      text: "⏳ Download foto/carousel, tunggu ya...",
    });

    const sent = await sendPhotoGallery(sock, jid, url);

    if (!sent) {
      await sock.sendMessage(jid, {
        text:
          "❌ Gagal download foto.\n\n" +
          "Gak ada foto yang bisa diambil dari link ini -- pastikan ini " +
          "beneran link carousel/slideshow foto (kalau ini video, pakai " +
          "!dl saja).",
      });
    }
  } catch (err) {
    console.log("=== [dlr] gagal ===");
    console.log(err.message || err);
    console.log("===================");
    await sock.sendMessage(jid, {
      text: "❌ Gagal download foto.\n\nSilakan coba lagi atau cek link-nya.",
    });
  }
}

async function handleDlDownload(sock, jid, url, mode) {
  // Cek backoff DULUAN, sebelum buang-buang 1 percobaan yt-dlp lagi kalau
  // memang lagi kena rate-limit. Cuma berlaku buat YouTube -- situs lain
  // (TikTok, Bilibili, dst) gak ikut kena backoff ini karena rate-limit-nya
  // spesifik per-platform, gak nyambung ke YouTube.
  if (isYoutubeUrl(url)) {
    const remainingMs = getYtdlpBackoffRemainingMs();
    if (remainingMs > 0) {
      await sock.sendMessage(jid, {
        text:
          `⏳ Lagi kena rate-limit YouTube (server ini kebanyakan request beberapa saat lalu). ` +
          `Coba lagi dalam ~${formatDurationId(remainingMs)}, bot bakal otomatis nyoba lagi setelah itu -- ` +
          `gak perlu diapa-apain, tinggal kirim !dl lagi nanti.`,
      });
      return;
    }
  }

  try {
    await sock.sendMessage(jid, {
      text:
        mode === "audio"
          ? "⏳ Download audio (MP3), tunggu ya..."
          : "⏳ Download video, tunggu ya...",
    });

    // masuk QUEUE, biar gak numpuk proses yt-dlp jalan bersamaan kalau
    // lagi banyak yang minta download sekaligus.
    const { buffer } = await enqueueDownloadJob(() =>
      downloadMediaFromUrl(url, mode),
    );

    if (isYoutubeUrl(url)) registerYtdlpSuccess();
    await sendDownloadedMedia(sock, jid, buffer, mode, url, false);
  } catch (err) {
    if (isYoutubeUrl(url) && isRateLimitOrBotDetectionError(err.stderr)) {
      registerYtdlpRateLimitFailure();
    }

    // Kemungkinan postingan foto (carousel Instagram / slideshow foto+musik
    // TikTok) -- yt-dlp jalan sukses tapi emang gak ada video/audio buat
    // di-download lewat jalur biasa. Coba jalur foto dulu sebelum nyerah.
    if (err.possiblyPhotoOnly) {
      const handled = await tryHandleAsPhotoPost(sock, jid, url);
      if (handled) return;
    }

    console.log("=== [dl] yt-dlp gagal ===");
    console.log("message:", err.message);
    if (err.stderr) {
      // Ini yang paling penting buat debug di Railway logs -- pesan asli
      // dari yt-dlp sebelum "dihaluskan" friendlyDlError(). Kalau user
      // lapor error tapi kamu bingung penyebab aslinya apa, cek baris ini.
      console.log("raw stderr:\n" + err.stderr);
    }
    console.log("=========================");
    await sock.sendMessage(jid, {
      text: `❌ Gagal download.\n${friendlyDlError(err)}`,
    });
  }
}

async function sendDownloadedMedia(sock, jid, buffer, mode, url, fromCache) {
  if (mode === "audio") {
    await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: "audio/mpeg",
      fileName: "audio.mp3",
    });
  } else {
    await sock.sendMessage(jid, {
      video: buffer,
      mimetype: "video/mp4",
      caption: fromCache
        ? `✅ Berhasil didownload (dari cache).\n🔗 ${url}`
        : `✅ Berhasil didownload.\n🔗 ${url}`,
    });
  }
}

// =====================================================
// Fitur: AI Image Upscaler ("!hd") -- Real-ESRGAN LOKAL (ncnn-vulkan CLI),
// BUKAN API berbayar. Bisa dipakai lewat 3 cara: reply foto + "!hd",
// caption langsung "!hd" di fotonya, atau "!hd 2x" / "!hd 4x" buat pilih
// scale (default 2x kalau gak dikasih argumen).
//
// Alur: WhatsApp -> Baileys -> download media (downloadGifBuffer, dipakai
// bareng !meme/!smeme/!s karena memang generik) -> validasi & re-encode
// PNG lewat sharp -> tulis ke tmp/hd_<uid>_input.png -> spawn (BUKAN
// exec()! args selalu berupa array, jadi aman dari command injection
// walau isinya path/nama file yang "dikontrol" user secara tidak
// langsung) -> tmp/hd_<uid>_output.png -> baca balik -> sendMessage image
// -> semua file tmp dihapus di blok finally, termasuk kalau prosesnya
// gagal di tengah jalan.
//
// Concurrency dibatasi (default 1 proses barengan, lihat
// HD_QUEUE_CONCURRENCY) pola queue-nya sama persis kayak dlQueue punya
// "!dl" di atas -- biar CPU/RAM gak langsung penuh kalau banyak user
// pakai "!hd" bersamaan.
// =====================================================
const REALESRGAN_PATH =
  process.env.REALESRGAN_PATH || "./realesrgan/realesrgan-ncnn-vulkan";
const REALESRGAN_MODEL_DIR = process.env.REALESRGAN_MODEL_DIR || "./models";
// Model default buat foto/gambar umum. JANGAN auto-ganti ke model anime
// (RealESRGAN_x4plus_anime_6B) tanpa alasan -- kalau mau, ganti lewat env
// var ini secara manual/sengaja, biar gak ada kejutan hasil upscale yang
// beda dari ekspektasi user.
const REALESRGAN_MODEL_NAME =
  process.env.REALESRGAN_MODEL_NAME || "realesrgan-x4plus";
const REALESRGAN_DEFAULT_SCALE =
  Number(process.env.REALESRGAN_DEFAULT_SCALE) || 2;
const REALESRGAN_MAX_INPUT_MB = Number(process.env.REALESRGAN_MAX_INPUT_MB) || 10;
const REALESRGAN_MAX_OUTPUT_MB =
  Number(process.env.REALESRGAN_MAX_OUTPUT_MB) || 30;
// Batas sisi terpanjang HASIL upscale (bukan gambar aslinya) -- mis. foto
// 1500x1000 di-"!hd 4x" bakal jadi 6000x4000, kalau itu melebihi batas
// ini, ditolak DULU sebelum buang-buang CPU/RAM buat proses yang hasilnya
// bakal ditolak juga pas mau dikirim.
const REALESRGAN_MAX_OUTPUT_DIMENSION =
  Number(process.env.REALESRGAN_MAX_OUTPUT_DIMENSION) || 4000;
const REALESRGAN_TIMEOUT_MS =
  Number(process.env.REALESRGAN_TIMEOUT_MS) || 120000; // 2 menit
const HD_QUEUE_CONCURRENCY = Number(process.env.HD_QUEUE_CONCURRENCY) || 1;
const HD_TMP_DIR = process.env.HD_TMP_DIR || path.join(__dirname, "tmp");
// Mesin yang dipakai "!hd" -- default "sharp" (CATATAN Agustus 2026: binary
// Real-ESRGAN TIDAK ter-install di server ini -- nixpacks.toml cuma nyiapin
// yt-dlp, gak ada langkah download Real-ESRGAN -- jadi "!hd" pasti gagal
// "executable tidak ditemukan" kalau tetap dipaksa pakai realesrgan). Ganti
// ke "realesrgan" via env var HD_ENGINE cuma kalau binary + model-nya sudah
// beneran di-install manual di server.
const HD_ENGINE = (process.env.HD_ENGINE || "sharp").toLowerCase();

let hdActiveWorkers = 0;
const hdQueue = [];

function processHdQueue() {
  while (hdActiveWorkers < HD_QUEUE_CONCURRENCY && hdQueue.length > 0) {
    const job = hdQueue.shift();
    hdActiveWorkers++;
    job
      .jobFn()
      .then(job.resolve, job.reject)
      .finally(() => {
        hdActiveWorkers--;
        processHdQueue();
      });
  }
}

function enqueueHdJob(jobFn) {
  return new Promise((resolve, reject) => {
    hdQueue.push({ jobFn, resolve, reject });
    processHdQueue();
  });
}

function ensureHdTmpDir() {
  fs.mkdirSync(HD_TMP_DIR, { recursive: true });
}

// Cuma FOTO biasa (imageMessage, atau documentMessage bermime image/*
// selain gif) yang dianggap valid buat "!hd" -- BEDA dari isStaticSource
// (dipakai !smeme) yang juga nerima stiker WA. Stiker sengaja tidak
// didukung di sini karena ukurannya sudah kecil (512x512 WebP) dan hasil
// upscale-nya biasanya kurang berguna/rawan artefak dibanding foto biasa.
function isImageOnlySource(content) {
  if (!content) return false;
  if (content.imageMessage) return true;

  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    return mime.startsWith("image/") && mime !== "image/gif";
  }

  return false;
}

function findImageSource(msg) {
  return findMediaSource(msg, isImageOnlySource);
}

// Parse argumen setelah "!hd": "" (default), "2x", atau "4x". Selain itu
// (termasuk mis. "8x") dianggap tidak valid.
function parseHdScaleArg(raw) {
  const arg = raw.trim().toLowerCase();

  if (arg === "") return { ok: true, scale: REALESRGAN_DEFAULT_SCALE };
  if (arg === "2x") return { ok: true, scale: 2 };
  if (arg === "4x") return { ok: true, scale: 4 };

  return { ok: false };
}

// Jalanin realesrgan-ncnn-vulkan sebagai child process TERPISAH lewat
// spawn() dengan args berbentuk ARRAY (bukan exec() dengan string yang
// digabung manual) -- ini yang bikin aman dari command injection, karena
// tiap elemen args diteruskan apa adanya ke OS, tidak pernah diinterpretasi
// ulang oleh shell.
function runRealEsrgan(args) {
  return new Promise((resolve, reject) => {
    let proc;

    try {
      proc = spawn(REALESRGAN_PATH, args);
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, REALESRGAN_TIMEOUT_MS);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `Real-ESRGAN executable tidak ditemukan di "${REALESRGAN_PATH}". ` +
              `Set env var REALESRGAN_PATH ke lokasi binary yang benar, atau ` +
              `install dulu (lihat dokumentasi "!hd").`,
          ),
        );
        return;
      }
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(`Real-ESRGAN timeout setelah ${REALESRGAN_TIMEOUT_MS}ms.`),
        );
        return;
      }

      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Real-ESRGAN keluar dengan kode ${code}\n${stderr.slice(-800)}`,
          ),
        );
      }
    });
  });
}

// Proses inti "!hd": buffer gambar input -> buffer gambar hasil upscale
// AI. Semua validasi (ukuran file, format/corrupt, dimensi hasil) DAN
// cleanup file tmp (finally, termasuk kalau gagal di tengah jalan)
// ditangani di sini, jadi handler command di messages.upsert cukup
// tangkap satu try/catch besar tanpa perlu tau detail internalnya.
async function upscaleImageWithRealEsrgan(inputBuffer, scale) {
  if (inputBuffer.length > REALESRGAN_MAX_INPUT_MB * 1024 * 1024) {
    throw new Error(
      `Ukuran gambar melebihi batas ${REALESRGAN_MAX_INPUT_MB}MB.`,
    );
  }

  // sharp otomatis melempar error kalau buffer-nya corrupt/bukan gambar
  // yang valid -- ini jadi validasi "gambar corrupt" sekaligus.
  let metadata;
  try {
    metadata = await sharp(inputBuffer).metadata();
  } catch {
    throw new Error("Gambar tidak valid atau corrupt.");
  }

  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error("Gagal membaca dimensi gambar.");
  }

  if (
    width * scale > REALESRGAN_MAX_OUTPUT_DIMENSION ||
    height * scale > REALESRGAN_MAX_OUTPUT_DIMENSION
  ) {
    throw new Error(
      `Resolusi hasil upscale (${width * scale}x${height * scale}) melebihi ` +
        `batas ${REALESRGAN_MAX_OUTPUT_DIMENSION}px. Coba gambar yang lebih ` +
        `kecil atau scale yang lebih rendah.`,
    );
  }

  // Selalu re-encode ke PNG lewat sharp dulu -- selain jadi format yang
  // pasti didukung realesrgan-ncnn-vulkan apa pun format aslinya (jpeg,
  // webp, dst), proses re-encode ini juga "membersihkan" struktur file
  // dari keanehan metadata sumber aslinya.
  const pngBuffer = await sharp(inputBuffer).png().toBuffer();

  ensureHdTmpDir();
  const uid = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(HD_TMP_DIR, `hd_${uid}_input.png`);
  const outputPath = path.join(HD_TMP_DIR, `hd_${uid}_output.png`);

  fs.writeFileSync(inputPath, pngBuffer);

  try {
    const args = [
      "-i",
      inputPath,
      "-o",
      outputPath,
      "-s",
      String(scale),
      "-n",
      REALESRGAN_MODEL_NAME,
      "-m",
      REALESRGAN_MODEL_DIR,
    ];

    await runRealEsrgan(args);

    if (!fs.existsSync(outputPath)) {
      throw new Error(
        "File hasil upscale tidak ditemukan setelah proses selesai.",
      );
    }

    const outputBuffer = fs.readFileSync(outputPath);

    if (outputBuffer.length > REALESRGAN_MAX_OUTPUT_MB * 1024 * 1024) {
      throw new Error(
        `Hasil upscale melebihi batas ukuran ${REALESRGAN_MAX_OUTPUT_MB}MB.`,
      );
    }

    return outputBuffer;
  } finally {
    // Selalu bersihin, baik proses berhasil MAUPUN gagal.
    fs.rm(inputPath, { force: true }, () => {});
    fs.rm(outputPath, { force: true }, () => {});
  }
}

// =====================================================
// Mesin "sharp" -- fallback tanpa Real-ESRGAN (ditambahkan Agustus 2026)
// -----------------------------------------------------
// Real-ESRGAN (ncnn-vulkan) butuh binary + file model terpisah yang berat
// buat di-setup di Railway (apalagi tanpa GPU/Vulkan) -- makanya "!hd"
// selalu gagal "executable tidak ditemukan". Jalur ini pakai "sharp" yang
// SUDAH jadi dependency project ini, TANPA proses/binary eksternal apa pun:
// lebar & tinggi gambar dikali scale yang PERSIS SAMA (jadi rasio/bentuk
// gambar aslinya tetap terjaga, gak ada distorsi), lalu ditajamkan pakai
// filter sharpen biar hasilnya gak blur.
//
// Ini BUKAN AI super resolution beneran (gak "mengarang" detail baru kayak
// Real-ESRGAN) -- cuma resize berkualitas tinggi + penajaman biasa. Tapi
// itu sudah cukup buat kebutuhan "yang penting gak blur" tanpa install
// apa pun tambahan. Validasi ukuran file & batas dimensi hasil TETAP sama
// persis kayak jalur Real-ESRGAN, biar konsisten.
// =====================================================
async function upscaleImageWithSharp(inputBuffer, scale) {
  if (inputBuffer.length > REALESRGAN_MAX_INPUT_MB * 1024 * 1024) {
    throw new Error(
      `Ukuran gambar melebihi batas ${REALESRGAN_MAX_INPUT_MB}MB.`,
    );
  }

  let metadata;
  try {
    metadata = await sharp(inputBuffer).metadata();
  } catch {
    throw new Error("Gambar tidak valid atau corrupt.");
  }

  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error("Gagal membaca dimensi gambar.");
  }

  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);

  if (
    targetWidth > REALESRGAN_MAX_OUTPUT_DIMENSION ||
    targetHeight > REALESRGAN_MAX_OUTPUT_DIMENSION
  ) {
    throw new Error(
      `Resolusi hasil upscale (${targetWidth}x${targetHeight}) melebihi ` +
        `batas ${REALESRGAN_MAX_OUTPUT_DIMENSION}px. Coba gambar yang lebih ` +
        `kecil atau scale yang lebih rendah.`,
    );
  }

  const outputBuffer = await sharp(inputBuffer)
    .resize(targetWidth, targetHeight, {
      fit: "fill", // target sudah proporsional (dikali scale yang sama), jadi aman
      kernel: sharp.kernel.lanczos3, // kernel resize paling tajam yang didukung sharp
    })
    .sharpen({ sigma: 1.2 }) // penajaman tambahan biar hasil upscale gak keliatan blur
    .png()
    .toBuffer();

  if (outputBuffer.length > REALESRGAN_MAX_OUTPUT_MB * 1024 * 1024) {
    throw new Error(
      `Hasil upscale melebihi batas ukuran ${REALESRGAN_MAX_OUTPUT_MB}MB.`,
    );
  }

  return outputBuffer;
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
    const buildArgs = (step) => {
      const size = step.size || 512;
      const bgFilters = [
        "format=rgba",
        // `size` biasanya 512 (konten pas kanvas penuh). Di tangga darurat
        // (lihat ANIMATED_QUALITY_LADDER), size diperkecil (mis. 400/320)
        // supaya konten discale ke kotak lebih kecil DULU sebelum di-pad --
        // kanvas akhirnya tetap wajib 512x512, tapi piksel yang perlu
        // di-encode tiap frame jauh lebih sedikit -> ukuran file lebih kecil.
        `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        ...(isStill || !step.fps ? [] : [`fps=${step.fps}`]),
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
        "-quality",
        String(step.quality),
        "-compression_level",
        "6", // paling pelan tapi paling kecil hasilnya -- worth it, bot yang nunggu bukan user
        "-an",
        "-fps_mode",
        "cfr",
      ];

      if (!isStill && step.duration) args.push("-t", String(step.duration)); // batas durasi stiker WA

      args.push(outputPath);
      return args;
    };

    return await runFfmpegUnderSizeLimit(buildArgs, outputPath, isStill);
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
    const buildArgs = (step) => {
      const size = step.size || 512;
      const filters = [
        "format=rgba",
        `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        ...(isStill || !step.fps ? [] : [`fps=${step.fps}`]),
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
        "-quality",
        String(step.quality),
        "-compression_level",
        "6",
        "-an",
        "-fps_mode",
        "cfr",
      ];

      if (!isStill && step.duration) args.push("-t", String(step.duration));

      args.push(outputPath);
      return args;
    };

    return await runFfmpegUnderSizeLimit(buildArgs, outputPath, isStill);
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
    // !whoami -- debug: cek jid apa yang kedeteksi buat pengirim pesan ini
    // (berguna kalau owner check meleset gara-gara @lid dsb). Ditaruh
    // paling atas juga biar bisa dipakai walau grup lagi dinonaktifin.
    // =====================
    if (await handleWhoamiCommand(sock, msg, { jid, text })) {
      return;
    }

    // =====================
    // !bot on / !bot off / !bot status -- KHUSUS owner, PALING ATAS
    // supaya tetap jalan walaupun grup lagi dinonaktifin (owner harus
    // selalu bisa nyalain lagi).
    // =====================
    if (await handleBotSwitchCommand(sock, msg, { jid, text })) {
      return;
    }

    // =====================
    // !listgrup -- KHUSUS owner, PALING ATAS juga (sama kayak !bot),
    // biar owner tetap bisa cek daftar grup walau lagi di grup yang
    // dinonaktifin.
    // =====================
    if (await handleListGroupsCommand(sock, msg, { jid, text })) {
      return;
    }

    // =====================
    // Saklar aktif/nonaktif per grup: kalau grup ini lagi DIMATIIN dan
    // pengirimnya BUKAN owner, bot "ngambek" -- gak proses command/fitur
    // apa pun lagi (termasuk chat AI tsundere di bawah). Owner sendiri
    // gak kena blokir ini sama sekali.
    // =====================
    if (isBotDisabledFor(jid) && !isOwnerMsg(msg)) {
      if (text.startsWith("!")) {
        await sendNgambekReply(sock, jid);
      }
      return;
    }

    // =====================
    // !ping
    // =====================
    if (text === "!ping") {
      await sock.sendMessage(jid, { text: "🏓 Pong!" });
      return;
    }

    // =====================
    // !lupain -- reset ingatan obrolan chat AI (tsundere) buat pengirim ini
    // =====================
    if (text === "!lupain") {
      const had = forgetGroqChat(sessionKey);
      await sock.sendMessage(jid, {
        text: had
          ? "Hmph, oke... sudah aku lupain semua obrolan kita. Mulai dari nol lagi ya. 😤"
          : "Lho, kita kan belum pernah ngobrol apa-apa. Gak ada yang perlu dilupain, dasar. 🙄",
      });
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
    // !ringkas [instruksi tambahan] -> baca teks dari dokumen PDF (langsung
    // dikirim dengan caption, atau reply ke PDF yang sudah ada), lalu minta
    // Groq bikin ringkasan GARIS BESARnya (dokumen panjang otomatis diproses
    // per-bagian dulu, lihat summarizeDocumentText di agemasenTsundere.js).
    // Teks lengkap dokumennya ikut "diinget" di sesi ini (lihat
    // saveDocumentContext) selama DOC_CONTEXT_TTL_MS, jadi user bisa nanya
    // lebih lanjut soal isi dokumennya lewat chat AI (tag bot/reply) setelah
    // ini, gak cuma dapet ringkasannya doang.
    //
    // Kalau PDF-nya hasil scan/foto tanpa lapisan teks, pdf-parse gak bakal
    // nemu teks apa-apa -- kita kasih tau user daripada maksain ringkasan
    // kosong/ngasal.
    // =====================
    if (text === "!ringkas" || text.startsWith("!ringkas ")) {
      const userInstruction = text.slice("!ringkas".length).trim();
      const pdfSource = findPdfSource(msg);

      if (!pdfSource) {
        await sendCommandDetail(sock, jid, "ringkas");
        return;
      }

      try {
        await sock.sendMessage(jid, {
          text: "Hmph, tunggu bentar, aku bacain dulu dokumennya... 📄",
        });

        const fakeMsg = { key: pdfSource.refKey, message: pdfSource.content };
        const pdfBuffer = await downloadMediaMessage(fakeMsg, "buffer", {});
        const fileName = pdfSource.content.documentMessage?.fileName || "dokumen.pdf";

        const parser = new PDFParse({ data: pdfBuffer });
        let rawText;
        try {
          const result = await parser.getText();
          rawText = result.text || "";
        } finally {
          await parser.destroy();
        }

        // Buang penanda antar-halaman ("-- N of M --") yang disisipkan
        // pdf-parse -- itu bukan bagian isi dokumen, cuma bikin bising
        // buat model pas diringkas.
        const cleanedTextFull = rawText
          .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        // Jaring pengaman terakhir buat dokumen yang BENERAN ekstrem
        // (ratusan-ribuan halaman) -- di luar ini dipotong total, gak ikut
        // diproses maupun disimpan sebagai ingatan.
        const hardTruncated = cleanedTextFull.length > DOC_HARD_MAX_CHARS;
        const cleanedText = hardTruncated
          ? cleanedTextFull.slice(0, DOC_HARD_MAX_CHARS)
          : cleanedTextFull;

        // Kalau bakal lewat proses map-reduce (dokumen panjang), kasih tau
        // user duluan biar gak bingung nunggu -- sekalian estimasi jumlah
        // bagian yang bakal diproses satu-satu.
        if (cleanedText.length > SUMMARY_SINGLE_PASS_MAX_CHARS) {
          const estChunks = Math.ceil(cleanedText.length / SUMMARY_CHUNK_CHARS);
          await sock.sendMessage(jid, {
            text:
              `Dokumennya lumayan panjang (kira-kira ${estChunks} bagian yang aku baca satu-satu), ` +
              `jadi agak lama dikit ya, sabar! Bukan berarti aku males, cuma... yah, gitu deh. 😤`,
          });
        }

        const senderName = msg.pushName || "";
        let lastProgressSentAt = 0;
        const { chunks } = await summarizeDocumentText(cleanedText, {
          senderName,
          fileName,
          userInstruction,
          truncated: hardTruncated,
          // Update presence "typing..." tiap beberapa bagian biar user tau
          // bot masih proses (bukan macet), tanpa spam pesan tiap bagian.
          onProgress: async (current, total) => {
            const now = Date.now();
            if (now - lastProgressSentAt < 8000 && current !== total) return;
            lastProgressSentAt = now;
            await sock.sendPresenceUpdate("composing", jid);
          },
        });

        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(
            jid,
            { text: chunks[i] },
            i === 0 ? { quoted: msg } : {},
          );
        }

        // Simpan teks lengkapnya (bukan ringkasannya) ke sesi ini biar bisa
        // dipakai lagi kalau user nanya-nanya lanjutan soal isi dokumennya.
        saveDocumentContext(sessionKey, { text: cleanedText, fileName });

        const ttlHours = Math.round(DOC_CONTEXT_TTL_MS / (60 * 60 * 1000));
        await sock.sendMessage(jid, {
          text:
            `💡 Kalau mau nanya-nanya lebih detail soal isi dokumen ini, tinggal tag aku (@AgemasenBot) atau ` +
            `reply pesanku -- masih inget isinya kok, sekitar ${ttlHours} jam ke depan. ...B-bukan berarti aku niat ` +
            `bantuin lama-lama, ya!`,
        });
      } catch (err) {
        console.log("[!ringkas] gagal:", err.message || err);
        const isConfigError = /GROQ_API_KEY/.test(err.message || "");
        await sock.sendMessage(jid, {
          text: isConfigError
            ? "Hmph, aku belum dikasih GROQ_API_KEY sama pemilikku. Bukan salahku ya! 😤"
            : "Duh, aku gagal bacain/ringkas dokumennya. Coba cek lagi filenya bener PDF & gak rusak, terus coba lagi. 💢",
        });
      }

      return;
    }

    // =====================
    // !hd / !hd 2x / !hd 4x  -> AI Image Upscaler (Real-ESRGAN lokal).
    // Lihat komentar lengkap di definisi upscaleImageWithRealEsrgan() di
    // atas buat detail alur & alasan desainnya.
    // =====================
    if (text === "!hd" || text.startsWith("!hd ")) {
      const argPart = text.slice(4).trim();
      const parsedScale = parseHdScaleArg(argPart);

      if (!parsedScale.ok) {
        await sock.sendMessage(jid, {
          text: "❌ Scale tidak tersedia.\n\nGunakan:\n!hd\n!hd 2x\n!hd 4x",
        });
        return;
      }

      const source = findImageSource(msg);

      if (!source) {
        await sock.sendMessage(jid, {
          text:
            "📷 Kirim atau reply gambar yang ingin dibuat lebih HD.\n" +
            "Contoh:\n!hd\n!hd 2x\n!hd 4x",
        });
        return;
      }

      const { scale } = parsedScale;

      // Kasih tau DULUAN kalau bakal ngantre (sebelum enqueueHdJob),
      // biar user gak nunggu diem tanpa kabar kalau lagi ada proses
      // "!hd" lain yang jalan.
      if (hdActiveWorkers >= HD_QUEUE_CONCURRENCY) {
        await sock.sendMessage(jid, {
          text:
            "⏳ Server sedang memproses gambar lain.\n\n" +
            "Permintaanmu masuk antrean.",
        });
      }

      const engineLabel =
        HD_ENGINE === "realesrgan"
          ? "🤖 AI Super Resolution"
          : "✨ Upscale + Penajaman";

      try {
        const resultBuffer = await enqueueHdJob(async () => {
          await sock.sendMessage(jid, {
            text: `⏳ Memproses gambar...\n\n${engineLabel}\n📐 Scale: ${scale}x`,
          });

          const inputBuffer = await downloadGifBuffer(
            source.content,
            source.refKey,
          );

          return HD_ENGINE === "realesrgan"
            ? upscaleImageWithRealEsrgan(inputBuffer, scale)
            : upscaleImageWithSharp(inputBuffer, scale);
        });

        const successLine =
          HD_ENGINE === "realesrgan"
            ? "✨ Gambar berhasil di-upscale menggunakan AI."
            : "✨ Gambar berhasil di-upscale & dipertajam.";

        await sock.sendMessage(jid, {
          image: resultBuffer,
          caption: `✅ Berhasil!\n\n${successLine}\n📐 Scale: ${scale}x`,
        });
      } catch (err) {
        console.log("=== [!hd] gagal ===");
        console.log(err.message || err);
        console.log("===================");
        await sock.sendMessage(jid, {
          text: "❌ Gagal memproses gambar.\n\nSilakan coba lagi dengan gambar lain.",
        });
      }

      return;
    }

    // =====================
    // Balasan angka untuk memilih karakter dari daftar disambiguasi
    // ATAU untuk lanjut (!next) pakai kode sesi.
    //
    // KEDUANYA sama-sama "ketik angka" jadi wajib dibedakan biar gak
    // bentrok satu sama lain:
    //   - Pilihan karakter: HARUS reply (quote) ke pesan daftar tag-nya
    //     (dicek lewat ctx.stanzaId === session.promptMsgId). Ini juga
    //     yang bikin gak ke-trigger cuma gara-gara kebetulan session milik
    //     pengirim ini masih ada pendingTagChoices lama yang belum expired.
    //   - Kode sesi: ketik angka POLOS (bukan reply ke daftar tag), dicek
    //     ke chatCodeSessions seperti biasa.
    // Dipakai oleh "!next" dan lanjut-pakai-kode-sesi: pool session ini
    // kosong (semua post yang sudah di-load sudah pernah dikirim), jadi
    // coba ambil halaman berikutnya dari Safebooru. Kalau ternyata SEMUA
    // halaman untuk tag ini sudah habis (berarti user sudah lihat semua
    // gambar yang ada), siklus direset dari awal (boleh muncul ulang)
    // supaya user tetap dapat gambar, bukan mentok dead-end.
    async function refillPool(session) {
      if (session.pool.length > 0) return true;

      if (await loadMoreCandidates(session)) return true;

      session.seenIds.clear();
      session.pid = 0;
      session.noMorePages = false;

      if (await loadMoreCandidates(session)) {
        await sock.sendMessage(jid, {
          text: "🔁 Semua gambar untuk tag ini sudah pernah ditampilkan. Mulai ulang dari awal ya.",
        });
        return true;
      }

      return false; // tag ini memang tidak punya gambar sama sekali
    }

    // =====================
    if (/^\d+$/.test(text)) {
      const session = sessions.get(sessionKey);
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const isReplyToTagPrompt =
        session?.pendingTagChoices &&
        ctx?.stanzaId &&
        session.promptMsgId &&
        ctx.stanzaId === session.promptMsgId;

      if (isReplyToTagPrompt) {
        touchSession(session);
        const idx = parseInt(text, 10) - 1;
        const choice = session.pendingTagChoices[idx];

        if (!choice) {
          await sock.sendMessage(jid, {
            text: `⚠️ Nomor tidak valid. Pilih 1-${session.pendingTagChoices.length}.`,
          });
          return;
        }

        try {
          const candidateSession = newCandidateSession(choice.name);
          const hasCandidates = await loadMoreCandidates(candidateSession);

          if (!hasCandidates) {
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
            candidateSession,
          );
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: errorReplyText(err),
          });
        }

        return;
      }

      // Bukan reply ke daftar disambiguasi -> cek apakah angka ini KODE
      // SESI pencarian yang lagi aktif di chat ini. Kode sesi ini
      // scope-nya per-chat (bukan per-pengirim), jadi siapa pun di grup
      // yang sama boleh pakai kode punya orang lain buat lanjut (!next)
      // pencarian itu, dan ini tidak bentrok dengan kode punya pencarian
      // lain karena tiap pencarian dapat nomor kodenya sendiri-sendiri.
      const codeNum = parseInt(text, 10);
      const codeSession = chatCodeSessions.get(jid)?.get(codeNum);

      if (codeSession) {
        touchSession(codeSession);
        try {
          const ok = await refillPool(codeSession);

          if (!ok) {
            await sock.sendMessage(jid, {
              text: "❌ Tidak ada gambar lain untuk tag ini.",
            });
            return;
          }

          const post = pickRandom(codeSession);
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
            text: errorReplyText(err),
          });
        }

        return;
      }

      // angka tanpa daftar pending & bukan kode sesi yang aktif -> biarkan
      // lewat, bukan command. TAPI kalau ternyata dia sebenarnya PUNYA
      // daftar tag pending (cuma gak reply pesannya), kasih tau caranya
      // biar gak bingung kenapa gak ada respons sama sekali.
      if (session?.pendingTagChoices) {
        await sock.sendMessage(jid, {
          text:
            "⚠️ Masih ada daftar karakter yang belum dipilih.\n\n" +
            "➡️ Buat *pilih karakter*: reply pesan daftarnya, lalu ketik nomor urutnya.\n" +
            "➡️ Buat *lanjut sesi lain* pakai kode: ketik kodenya langsung tanpa reply.",
        });
        return;
      }
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

        // isAnimated WAJIB diisi manual -- Baileys TIDAK auto-deteksi dari
        // isi buffer webp-nya. Kalau ini kelewat, reply ke stiker ini nanti
        // (mis. lewat !smeme) bakal salah dianggap "gambar diam" oleh
        // isStillMedia(), yang berakibat fps/durasi GAK dipangkas sama
        // sekali pas di-render ulang -> ukurannya meledak jauh di atas
        // limit WA. !meme sumbernya selalu GIF/video (lihat findGifSource),
        // jadi selalu animasi.
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: true,
        });
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
        const isStill = isStillMedia(source.content);
        const stickerBuffer = await gifToTextSticker(
          mediaBuffer,
          memeText,
          isStill,
        );

        // Sama kayak di !meme: isAnimated wajib diisi manual sesuai hasil
        // deteksi sumbernya sendiri, biar kalau stiker INI di-reply lagi
        // nanti, klasifikasinya benar (lihat komentar di !meme).
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: !isStill,
        });
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
        const isStill = isStillMedia(source.content);
        const stickerBuffer = await mediaToSticker(mediaBuffer, isStill);

        // Sama kayak di !meme/!smeme -- isAnimated wajib diisi manual.
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: !isStill,
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !togif  -> stiker ANIMASI jadi "GIF" (dikirim sbg video+gifPlayback,
    // karena WhatsApp memang selalu begitu buat GIF).
    // Bisa dari caption langsung di stikernya, atau reply ke stikernya.
    // =====================
    if (text === "!togif") {
      const source = findStickerOnlySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "togif");
        return;
      }

      if (!source.content.stickerMessage.isAnimated) {
        await sock.sendMessage(jid, {
          text:
            "⚠️ Itu stiker biasa (bukan animasi), jadi gak ada apa-apanya buat dijadiin GIF.\n" +
            "Mau dijadiin gambar? Pakai *!toimg*.",
        });
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat GIF..." });

        const stickerBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const gifVideoBuffer = await animatedStickerToGifVideo(stickerBuffer);

        await sock.sendMessage(jid, {
          video: gifVideoBuffer,
          gifPlayback: true,
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat GIF.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !toimg  -> stiker (biasa/statis, atau animasi -> ambil frame
    // pertamanya) jadi gambar biasa.
    // Bisa dari caption langsung di stikernya, atau reply ke stikernya.
    // =====================
    if (text === "!toimg") {
      const source = findStickerOnlySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "toimg");
        return;
      }

      try {
        const stickerBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const imageBuffer = await stickerToImageBuffer(stickerBuffer);

        await sock.sendMessage(jid, { image: imageBuffer });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat gambar.\n${err.message || ""}`,
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
        const directSession = newCandidateSession(tag);
        const hasDirectHit = await loadMoreCandidates(directSession);

        if (hasDirectHit) {
          await searchAndSendImage(sock, jid, sessionKey, tag, directSession);
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
          const onlySession = newCandidateSession(matches[0].name);
          const hasOnly = await loadMoreCandidates(onlySession);

          if (!hasOnly) {
            await sock.sendMessage(jid, {
              text: "❌ Gambar tidak ditemukan.",
            });
            return;
          }

          await searchAndSendImage(
            sock,
            jid,
            sessionKey,
            matches[0].name,
            onlySession,
          );
          return;
        }

        const pendingSession = touchSession({ pendingTagChoices: matches });
        sessions.set(sessionKey, pendingSession);

        const sentMsg = await sock.sendMessage(jid, {
          text: buildTagChoiceList(matches),
        });
        // Simpan ID pesan daftar tag ini, dipakai buat mastiin nanti angka
        // balasan BENERAN nge-reply pesan ini (bukan sekadar ketik angka
        // polos) -- lihat pengecekan `ctx.stanzaId` di handler balasan
        // angka. Ini yang bikin gak bentrok sama kode sesi (!next pakai
        // angka juga, tapi tanpa reply).
        pendingSession.promptMsgId = sentMsg?.key?.id || null;
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err),
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

      touchSession(session);

      try {
        const ok = await refillPool(session);

        if (!ok) {
          await sock.sendMessage(jid, {
            text: "❌ Tidak ada gambar lain untuk tag ini.",
          });
          return;
        }

        const post = pickRandom(session);
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
          text: errorReplyText(err),
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
    // !dlstatus -- cek status backoff rate-limit YouTube langsung dari
    // WhatsApp, gak perlu buka Railway Logs buat tau kondisinya.
    // =====================
    if (text === "!dlstatus") {
      const remainingMs = getYtdlpBackoffRemainingMs();
      if (remainingMs > 0) {
        await sock.sendMessage(jid, {
          text:
            `⏳ Lagi backoff (kena rate-limit YouTube). ` +
            `Sisa waktu tunggu: ~${formatDurationId(remainingMs)}.\n` +
            `Bot bakal otomatis coba lagi setelah waktu itu lewat -- ` +
            `!dl YouTube bakal ditolak dulu sementara ini biar gak nambah beban ke IP-nya.`,
        });
      } else {
        await sock.sendMessage(jid, {
          text:
            "✅ Gak lagi kena backoff. !dl YouTube seharusnya bisa dicoba normal.\n" +
            "(Catatan: ini status TERAKHIR YANG TERCATAT dari percobaan sebelumnya -- " +
            "kalau dari deploy terakhir belum ada yang pernah nyoba !dl sama sekali, " +
            "status ini belum tentu mencerminkan kondisi IP yang sebenarnya.)",
        });
      }
      return;
    }

    // =====================
    // !dl <link> [mp3|mp4]
    // =====================
    if (text === "!dl" || text.startsWith("!dl ")) {
      const rest = text.slice(3).trim();
      const urlMatch = rest.match(/https?:\/\/\S+/i);

      if (!urlMatch) {
        await sendCommandDetail(sock, jid, "dl");
        return;
      }

      const url = urlMatch[0];
      // Sisa teks setelah link (kalau ada) dipakai buat override format,
      // mis. "!dl <link> mp3" -- biar gak perlu balas angka lagi.
      const hint = rest
        .slice(urlMatch.index + urlMatch[0].length)
        .trim()
        .toLowerCase();

      try {
        new URL(url); // validasi cepat, lempar kalau bukan URL valid
      } catch {
        await sock.sendMessage(jid, { text: "❌ Link tidak valid." });
        return;
      }

      // Link YouTube ikut alur sama seperti situs lain -- argumen khusus
      // (client rotation, force-ipv4, dst) ditangani otomatis di dalam
      // downloadMediaFromUrl(), gak perlu logic tambahan di sini.
      const mode = hint === "mp3" || hint === "audio" ? "audio" : "video";
      await handleDlDownload(sock, jid, url, mode);
      return;
    }

    // =====================
    // !dlr <link> -- khusus foto/carousel/slideshow (Instagram carousel,
    // TikTok mode foto+musik). Beda dari "!dl": langsung ambil jalur foto
    // tanpa nyoba video dulu.
    // =====================
    if (text === "!dlr" || text.startsWith("!dlr ")) {
      const rest = text.slice(4).trim();
      const urlMatch = rest.match(/https?:\/\/\S+/i);

      if (!urlMatch) {
        await sendCommandDetail(sock, jid, "dlr");
        return;
      }

      const url = urlMatch[0];

      try {
        new URL(url); // validasi cepat, lempar kalau bukan URL valid
      } catch {
        await sock.sendMessage(jid, { text: "❌ Link tidak valid." });
        return;
      }

      await handleDlrDownload(sock, jid, url);
      return;
    }

    // =====================
    // AgemasenBot -- Chat AI Tsundere (Groq)
    //
    // Semua logic-nya ada di agemasenTsundere.js. handleTsundereChat sendiri
    // yang ngecek apakah bot di-tag & teksnya bukan command "!..." --
    // return true kalau pesan ini sudah ditangani (berarti kita return di
    // sini juga), false kalau tidak relevan (lanjut ke pengecekan bawah).
    // =====================
    if (await handleTsundereChat(sock, msg, { jid, text, sessionKey })) {
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