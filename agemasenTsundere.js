// =====================================================
// AgemasenBot -- Chat AI Tsundere (via Groq API)
//
// File terpisah dari index.js supaya logic "chat AI"-nya gak numpuk campur
// sama logic command-command lain (!img, !dl, dst). index.js tinggal
// require() modul ini dan panggil fungsi-fungsi yang di-export di bawah.
//
// Bot HANYA merespons lewat fitur ini kalau dia di-tag/mention (@AgemasenBot)
// di dalam pesan. Command "!..." tetap jalan seperti biasa dan TIDAK lewat
// jalur ini -- pengecekan itu tetap dilakukan di index.js (di titik
// pemanggilan `handleTsundereChat`), bukan di sini.
//
// Butuh env var:
//   GROQ_API_KEY_1, GROQ_API_KEY_2, dst
//                 -- wajib (minimal 1), ambil dari https://console.groq.com/keys
//                    Bisa dikasih lebih dari satu key (bernomor urut mulai
//                    dari 1) biar kalau satu key kena rate limit (429),
//                    bot otomatis pindah pakai key lain. Kalau cuma punya
//                    1 key, GROQ_API_KEY (tanpa nomor) juga masih jalan
//                    (fallback, kompatibel sama setup lama).
//   GROQ_MODEL    -- opsional, default "llama-3.3-70b-versatile"
//   GROQ_VISION_MODEL
//                 -- opsional, default "qwen/qwen3.6-27b" -- model khusus
//                    yang dipakai OTOMATIS cuma pas ada gambar yang perlu
//                    dianalisis (model teks biasa di atas gak bisa lihat
//                    gambar sama sekali).
// =====================================================
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const sharp = require("sharp");

// =====================================================
// Multi API-key Groq (buat handle rate limit / 429)
//
// Key diambil dari env var bernomor urut: GROQ_API_KEY_1, GROQ_API_KEY_2,
// GROQ_API_KEY_3, dst -- berhenti begitu nomor berikutnya kosong. Kalau
// gak ada satupun yang bernomor, fallback ke GROQ_API_KEY biasa (key
// tunggal) biar setup lama yang cuma punya 1 key tetap jalan tanpa ubah
// env var.
//
// Cara kerja rotasinya: tiap key punya status "cooldown" (waktu kapan dia
// boleh dipakai lagi). Selama request masih jalan normal, key dipakai
// gantian round-robin (biar beban kepakai merata). Begitu satu key kena
// 429, key itu ditandai cooldown (pakai retry-after dari Groq kalau ada,
// atau backoff default) dan request LANGSUNG dicoba lagi pakai key lain
// yang masih available -- gak nunggu dulu, karena limit Groq itu per-key,
// jadi key lain harusnya masih longgar. Baru kalau SEMUA key lagi
// cooldown, bot nunggu (backoff) kayak versi key tunggal sebelumnya.
// =====================================================
function loadGroqApiKeys() {
  const keys = [];
  let i = 1;
  while (true) {
    const val = process.env[`GROQ_API_KEY_${i}`];
    if (!val) break;
    keys.push(val);
    i++;
  }
  if (keys.length === 0 && process.env.GROQ_API_KEY) {
    keys.push(process.env.GROQ_API_KEY);
  }
  return keys;
}

const GROQ_API_KEYS = loadGroqApiKeys();
console.log(
  GROQ_API_KEYS.length > 0
    ? `[Groq] ${GROQ_API_KEYS.length} API key terdeteksi.`
    : "[Groq] TIDAK ADA API key yang di-set (GROQ_API_KEY_1 / GROQ_API_KEY).",
);

// key -> timestamp (ms) kapan key ini boleh dipakai lagi (0 = selalu boleh)
const groqKeyCooldownUntil = new Map(GROQ_API_KEYS.map((k) => [k, 0]));
let groqKeyRotateIndex = 0; // pointer round-robin antar key yang available

// Pilih key yang bisa dipakai sekarang (round-robin). Kalau semua key
// lagi cooldown, balikin key yang paling cepat available lagi (pemanggil
// yang nentuin mau nunggu atau enggak).
function pickAvailableGroqKey() {
  if (GROQ_API_KEYS.length === 0) return null;
  const now = Date.now();

  for (let offset = 0; offset < GROQ_API_KEYS.length; offset++) {
    const idx = (groqKeyRotateIndex + offset) % GROQ_API_KEYS.length;
    const key = GROQ_API_KEYS[idx];
    if ((groqKeyCooldownUntil.get(key) || 0) <= now) {
      groqKeyRotateIndex = (idx + 1) % GROQ_API_KEYS.length;
      return key;
    }
  }

  let soonestKey = GROQ_API_KEYS[0];
  let soonestAt = groqKeyCooldownUntil.get(soonestKey) || 0;
  for (const key of GROQ_API_KEYS) {
    const until = groqKeyCooldownUntil.get(key) || 0;
    if (until < soonestAt) {
      soonestAt = until;
      soonestKey = key;
    }
  }
  return soonestKey;
}

function markGroqKeyCooldown(key, waitMs) {
  groqKeyCooldownUntil.set(key, Date.now() + waitMs);
}

// Cuma buat label log ("key #2 dari 3") biar gampang di-debug tanpa
// nge-log API key aslinya.
function groqKeyLabel(key) {
  const idx = GROQ_API_KEYS.indexOf(key);
  return idx === -1 ? "?" : `#${idx + 1}/${GROQ_API_KEYS.length}`;
}

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
// Model vision Groq (per dokumentasi resmi console.groq.com/docs/vision) --
// dipakai HANYA untuk giliran yang ada gambarnya. Model teks biasa di atas
// (GROQ_MODEL) TIDAK punya kemampuan lihat gambar sama sekali.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 20000;
// Request yang nyertain gambar ke model vision (reasoning model, "mikir"
// dulu sebelum jawab) ternyata bisa jauh lebih lama dari chat teks biasa.
// Kalau dipaksa pakai GROQ_TIMEOUT_MS yang sama (20s), request gambar
// sering keburu timeout duluan sebelum Groq sempat balas -> jatuh ke
// catch di handleTsundereChat -> user cuma dapet pesan error generik,
// padahal Groq-nya sendiri masih lagi proses. Kasih jatah waktu lebih
// longgar khusus buat request yang ada gambarnya.
const GROQ_VISION_TIMEOUT_MS = Number(process.env.GROQ_VISION_TIMEOUT_MS) || 45000;

// Riwayat chat disimpan per-pengirim (pakai sessionKey yang sama dengan
// fitur gambar di index.js) supaya tiap orang punya "ingatan" obrolan
// sendiri-sendiri, bukan campur sama orang lain di grup yang sama.
//
// GROQ_MAX_HISTORY_MESSAGES (alias dari limit riwayat lama, sekarang bisa
// di-override lewat env var) -- jumlah pesan (user+bot) yang disimpan &
// dikirim ke Groq. Angka default (12) TIDAK diubah, cuma dijadikan
// configurable, sesuai kode yang sudah ada sebelumnya.
const GROQ_CHAT_HISTORY_LIMIT = Number(process.env.GROQ_MAX_HISTORY_MESSAGES) || 12;
const GROQ_CHAT_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam, sama kayak sesi gambar

// =====================================================
// Konfigurasi output Groq (max token & temperature). Nilai default DIAMBIL
// dari konfigurasi yang sudah ada sebelumnya di askGroqTsundere (300 /
// 0.9) -- bukan diganti ke nilai lain -- cuma dirapikan jadi konstanta di
// sini + bisa di-override lewat env var kalau perlu.
// =====================================================
const GROQ_MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS) || 800;
// GROQ_VISION_MODEL (qwen/qwen3.6-27b) itu REASONING model -- sebelum
// nulis jawaban akhir, dia "mikir" dulu pakai reasoning tokens yang
// SAMA-SAMA motong dari max_completion_tokens (walau hasil mikirnya
// disembunyikan lewat reasoning_format:hidden, tokennya tetap kepakai).
// Kalau budget-nya cuma GROQ_MAX_TOKENS (300, cukup buat model teks
// biasa yang non-reasoning), gampang kejadian budget abis duluan pas
// masih "mikir" -> jawaban akhir jadi STRING KOSONG walau request-nya
// sendiri sukses (200 OK) -- persis gejala "Groq tidak mengembalikan
// jawaban" yang kejadian. Kasih jatah lebih longgar khusus buat vision.
const GROQ_VISION_MAX_TOKENS = Number(process.env.GROQ_VISION_MAX_TOKENS) || 1024;

// =====================================================
// Auto-continue kalau jawaban Groq terpotong (finish_reason "length").
// Daripada cuma naikin max_tokens (yang lama-lama tetap bisa kepotong buat
// jawaban yang emang panjang), begitu kedeteksi terpotong, kita minta Groq
// nerusin PERSIS dari kata terakhir (lewat GROQ_CONTINUE_PROMPT di bawah),
// digabung jadi satu jawaban utuh -- maksimal GROQ_MAX_CONTINUATIONS kali
// nyambung biar gak muter terus kalau modelnya "ngasal" gak pernah selesai.
//
// Jawaban utuh itu lalu dipecah per paragraf (splitReplyIntoChunks) dan
// dikirim sebagai BEBERAPA pesan WhatsApp berurutan (bukan satu pesan
// panjang) -- biar kerasa natural kayak orang ngetik nyicil, bukan kayak
// dinding teks atau -- yang lebih parah -- keputus di tengah kalimat.
// =====================================================
const GROQ_MAX_CONTINUATIONS = Number(process.env.GROQ_MAX_CONTINUATIONS) || 2;
const GROQ_CONTINUE_PROMPT =
  "[SISTEM: balasanmu barusan terpotong karena kehabisan token. Lanjutkan PERSIS dari kata/kalimat terakhir yang belum selesai. JANGAN mengulang apa yang sudah kamu tulis, JANGAN buka salam baru, JANGAN mulai aksi (*...*) baru -- langsung sambung kalimat/list yang terputus tadi.]";

// Pecah 1 jawaban utuh jadi beberapa "bubble" pesan WhatsApp berdasarkan
// baris kosong (paragraf). Paragraf yang kepanjangan (>MAX_CHUNK_CHARS)
// dipecah lagi per kalimat biar gak ada 1 bubble yang kegedean sendiri.
const MAX_CHUNK_CHARS = 700;
function splitReplyIntoChunks(fullText) {
  const paragraphs = fullText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK_CHARS) {
      chunks.push(paragraph);
      continue;
    }
    // Paragraf kepanjangan -- pecah per kalimat, digabung lagi sampai
    // mendekati MAX_CHUNK_CHARS supaya gak kebanyakan bubble kecil-kecil.
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let buffer = "";
    for (const sentence of sentences) {
      if (buffer && (buffer.length + sentence.length + 1) > MAX_CHUNK_CHARS) {
        chunks.push(buffer.trim());
        buffer = sentence;
      } else {
        buffer = buffer ? `${buffer} ${sentence}` : sentence;
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
  }

  return chunks.length > 0 ? chunks : [fullText.trim()];
}
const GROQ_TEMPERATURE =
  process.env.GROQ_TEMPERATURE !== undefined
    ? Number(process.env.GROQ_TEMPERATURE)
    : 0.9;

// =====================================================
// Konfigurasi queue + rate limiter + retry Groq
//
// Kenapa perlu: kalau ada beberapa chat/grup yang mention bot hampir
// bersamaan, handler `messages.upsert` di index.js jalan per-event (async),
// jadi TANPA queue ini beberapa request Groq bisa nembak bersamaan dan
// gampang kena 429. Semua request Groq WAJIB lewat enqueueGroqRequest() di
// bawah, gak ada jalur lain yang manggil axios ke Groq langsung.
// =====================================================
const GROQ_REQUEST_DELAY_MS = Number(process.env.GROQ_REQUEST_DELAY) || 2000; // jeda antar-request Groq
const GROQ_MAX_RETRIES = Number(process.env.GROQ_MAX_RETRIES) || 3; // maksimal retry saat 429
// Dipakai HANYA kalau response 429 gak punya header retry-after.
const GROQ_RETRY_BACKOFF_MS = [2000, 5000, 10000];
const groqChats = new Map(); // sessionKey -> { history, lastUsed, sentMsgIds }

// Berapa banyak ID pesan balasan bot yang diingat per sesi -- dipakai buat
// deteksi "user reply ke pesan bot" (lihat isReplyToBotMessage). Gak perlu
// banyak-banyak, cukup nampung beberapa balasan terakhir.
const SENT_MSG_ID_LIMIT = 20;

// =====================================================
// Persistensi riwayat chat ke disk (file JSON)
//
// Sebelumnya riwayat cuma disimpan di memory (Map) -- artinya begitu bot
// restart/crash/redeploy, SEMUA obrolan & konteksnya hilang total. Sekarang
// riwayat ditulis ke file JSON tiap kali ada perubahan (di-debounce biar
// gak nulis disk tiap 1 pesan), dan dibaca lagi saat bot start.
//
// CATATAN buat deploy di Railway: ini nolong kalau bot cuma restart/crash
// biasa (container yang sama), TAPI kalau Railway redeploy dari awal TANPA
// Volume yang di-mount ke folder `data/`, isi file ini bakal ikut hilang
// juga (filesystem-nya dibuat ulang dari image). Kalau mau riwayat beneran
// awet lintas deploy, tinggal mount Railway Volume ke path DATA_DIR di
// bawah (atau override lewat env var GROQ_HISTORY_FILE).
// =====================================================
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE =
  process.env.GROQ_HISTORY_FILE || path.join(DATA_DIR, "tsundere_history.json");
const SAVE_DEBOUNCE_MS = 3000;
let saveTimer = null;

function loadHistoryFromDisk() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    for (const [key, chat] of Object.entries(parsed)) {
      groqChats.set(key, {
        history: Array.isArray(chat.history) ? chat.history : [],
        lastUsed: chat.lastUsed || Date.now(),
        sentMsgIds: Array.isArray(chat.sentMsgIds) ? chat.sentMsgIds : [],
        // Konteks dokumen PDF (dari !ringkas) -- ikut dipulihkan dari disk
        // supaya "ingatan" dokumennya gak hilang kalau bot restart di
        // tengah window DOC_CONTEXT_TTL_MS. Divalidasi bentuknya dulu biar
        // gak crash kalau file lama (sebelum fitur ini ada) gak punya field
        // ini sama sekali.
        documentContext:
          chat.documentContext && typeof chat.documentContext.text === "string"
            ? chat.documentContext
            : null,
      });
    }
    console.log(
      `[groq tsundere] riwayat chat dimuat dari disk (${groqChats.size} sesi).`,
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log("[groq tsundere] gagal load riwayat dari disk:", err.message);
    }
    // File belum ada (ENOENT) itu normal buat first run -- gak perlu log error.
  }
}

function writeHistoryToDiskNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const plain = Object.fromEntries(groqChats);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(plain), "utf8");
  } catch (err) {
    console.log("[groq tsundere] gagal simpan riwayat ke disk:", err.message);
  }
}

// Debounce: kalau ada banyak pesan numpuk dalam waktu dekat, gak perlu
// nulis file tiap kali -- cukup tulis sekali beberapa detik setelah
// perubahan TERAKHIR berhenti.
function scheduleSaveHistory() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeHistoryToDiskNow, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

// Pastikan riwayat sempat ke-flush ke disk kalau proses dimatikan (mis.
// Railway restart/redeploy yang ngirim SIGTERM), bukan cuma pas debounce
// timer kebetulan sempat jalan.
function flushHistoryOnExit() {
  if (saveTimer) clearTimeout(saveTimer);
  writeHistoryToDiskNow();
}
process.on("SIGTERM", flushHistoryOnExit);
process.on("SIGINT", flushHistoryOnExit);

loadHistoryFromDisk();

function getGroqChat(sessionKey) {
  let chat = groqChats.get(sessionKey);
  if (!chat) {
    chat = { history: [], lastUsed: Date.now(), sentMsgIds: [], documentContext: null };
    groqChats.set(sessionKey, chat);
  }
  chat.lastUsed = Date.now();
  return chat;
}

// Buang riwayat obrolan 1 sesi (dipanggil dari command "!lupain" di
// index.js). Return true kalau memang ada yang dibuang, false kalau sesi
// itu memang belum punya riwayat sama sekali.
function forgetGroqChat(sessionKey) {
  const had = groqChats.delete(sessionKey);
  if (had) scheduleSaveHistory();
  return had;
}

// Dipanggil dari sweep berkala index.js (lihat sweepExpiredSessions) supaya
// riwayat chat yang sudah lama gak disentuh ikut dibuang, bukan cuma
// session pencarian gambar.
function sweepExpiredTsundereChats() {
  const now = Date.now();
  let changed = false;
  for (const [key, chat] of groqChats) {
    if (now - (chat.lastUsed || 0) > GROQ_CHAT_TTL_MS) {
      groqChats.delete(key);
      changed = true;
    }
  }
  if (changed) scheduleSaveHistory();
}

// Ambil nomor polos dari sebuah JID, buang device-id (":12") dan domain
// (@s.whatsapp.net / @lid / @g.us) -- dipakai buat bandingin JID bot sendiri
// dengan daftar mentionedJid di sebuah pesan.
function jidNumber(jid) {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0];
}

// Cek apakah bot di-tag (@AgemasenBot) di pesan ini. Mention WhatsApp selalu
// tersimpan di contextInfo.mentionedJid, terlepas dari tipe pesannya
// (extendedTextMessage untuk teks biasa, atau *Message.contextInfo kalau
// mention-nya ada di caption gambar/video/dokumen).
//
// PENTING soal @lid: sejak WhatsApp rollout fitur privasi "LID" di banyak
// grup, JID peserta (termasuk bot sendiri) bisa muncul dalam bentuk
// "xxxx@lid" -- dan angkanya BUKAN sekadar domain beda dari nomor telepon,
// tapi ID YANG BEDA TOTAL dari nomor telepon aslinya. Jadi kalau kita cuma
// bandingin ke sock.user.id (selalu format @s.whatsapp.net / nomor telepon),
// mention yang datang dalam bentuk @lid gak akan pernah match -> bot
// dianggap "gak di-tag" padahal sudah di-tag (bot jadi diam/"bisu").
// Baileys expose juga sock.user.lid (LID milik bot sendiri) setelah
// konek, jadi kita cek mentionedJid terhadap KEDUA identitas itu.
function isBotMentioned(sock, msg) {
  const botIdNumber = jidNumber(sock.user?.id);
  const botLidNumber = jidNumber(sock.user?.lid);
  if (!botIdNumber && !botLidNumber) return false;

  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo;

  const mentioned = ctx?.mentionedJid || [];
  return mentioned.some((j) => {
    const n = jidNumber(j);
    return (botIdNumber && n === botIdNumber) || (botLidNumber && n === botLidNumber);
  });
}

// Cek apakah pesan ini adalah REPLY ke salah satu balasan tsundere
// SEBELUMNYA dari bot di sesi (sessionKey) yang sama. Ini yang bikin
// obrolan bisa "dilanjut" cuma dengan reply -- gak wajib nge-tag bot lagi
// tiap kali mau lanjut ngobrol, selama masih reply ke pesan bot.
//
// Dicek lewat ctx.stanzaId (ID pesan yang di-reply) dibandingkan sama
// daftar ID pesan yang PERNAH dikirim bot buat sesi ini (chat.sentMsgIds,
// lihat rememberSentMsgId). Pola ini sama seperti yang dipakai buat
// "kode sesi" (!next / promptMsgId) di index.js.
function isReplyToBotMessage(chat, msg) {
  if (!chat || !chat.sentMsgIds?.length) return false;

  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo;

  const stanzaId = ctx?.stanzaId;
  if (!stanzaId) return false;

  return chat.sentMsgIds.includes(stanzaId);
}

// Simpan ID pesan balasan tsundere yang baru dikirim, biar bisa dideteksi
// nanti kalau user reply ke pesan itu (lihat isReplyToBotMessage). Cuma
// nyimpen beberapa ID terakhir (SENT_MSG_ID_LIMIT) supaya gak numpuk terus.
function rememberSentMsgId(chat, msgId) {
  if (!msgId) return;
  chat.sentMsgIds = chat.sentMsgIds || [];
  chat.sentMsgIds.push(msgId);
  if (chat.sentMsgIds.length > SENT_MSG_ID_LIMIT) {
    chat.sentMsgIds.splice(0, chat.sentMsgIds.length - SENT_MSG_ID_LIMIT);
  }
}

// =====================================================
// Vision (deteksi & download gambar buat dianalisis Groq)
//
// Gambar bisa datang dari 2 sumber:
//  1. Foto dikirim LANGSUNG dengan caption yang nge-tag bot
//     (msg.message.imageMessage, caption-nya juga sumber teks `text` yang
//     sudah diambil index.js).
//  2. User REPLY ke sebuah foto (punya bot, punya orang lain, hasil !img,
//     dll) sambil nulis pertanyaan yang nge-tag bot -- foto aslinya ada di
//     extendedTextMessage.contextInfo.quotedMessage.imageMessage.
// Pola ini sama seperti findMediaSource() di index.js (dipakai !smeme dkk),
// sengaja diduplikasi di sini (bukan di-import dari index.js) supaya file
// ini tetap berdiri sendiri tanpa circular require ke index.js.
function findImageForVision(msg) {
  if (msg.message?.imageMessage) {
    return { content: msg.message, refKey: msg.key };
  }

  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (quoted?.imageMessage) {
    return {
      content: quoted,
      refKey: {
        remoteJid: msg.key.remoteJid,
        id: ctx.stanzaId,
        participant: ctx.participant,
      },
    };
  }

  return null;
}

// Download gambar (lewat Baileys) lalu encode jadi data URI base64 --
// format persis yang diminta Groq buat image_url lokal
// (`data:<mimetype>;base64,<data>`, lihat console.groq.com/docs/vision).
//
// Sebelum di-base64, gambar di-resize/kompres dulu pakai sharp. Ini
// PENTING karena foto WhatsApp (apalagi kalau dikirim kualitas HD, atau
// hasil forward berkali-kali) bisa berukuran beberapa MB -- giliran
// dijadikan base64 ukurannya membengkak ~33% lagi, gampang nabrak batas
// ukuran request Groq (400/413) atau bikin request jadi lambat & gampang
// timeout. Resize ke maksimal 1568px di sisi terpanjang (cukup buat
// vision model "melihat" detail gambar dengan baik, sesuai rekomendasi
// umum vision API) + encode ulang ke JPEG kualitas 80 biasanya sudah
// cukup mengecilkan ukuran file drastis tanpa bikin gambar jadi jelek.
async function downloadImageAsDataUri({ content, refKey }) {
  const fakeMsg = { key: refKey, message: content };
  const rawBuffer = await downloadMediaMessage(fakeMsg, "buffer", {});

  try {
    const compressed = await sharp(rawBuffer)
      .rotate() // ikutin orientasi EXIF sebelum resize, biar gak kebalik
      .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${compressed.toString("base64")}`;
  } catch (err) {
    // Kalau gagal dikompres (format aneh, dsb), tetap coba kirim buffer
    // aslinya apa adanya daripada gagal total.
    console.log("[groq tsundere] gagal kompres gambar, pakai buffer asli:", err.message || err);
    const mimetype = content.imageMessage?.mimetype || "image/jpeg";
    return `data:${mimetype};base64,${rawBuffer.toString("base64")}`;
  }
}

// =====================================================
// Konteks dokumen PDF (dari !ringkas) yang "diingat" per sesi
//
// Setelah user pakai !ringkas, teks lengkap dokumennya (bukan cuma
// ringkasannya) disimpan nempel di object `chat` yang sama dipakai buat
// riwayat obrolan tsundere -- jadi kalau user nanya-nanya lebih lanjut soal
// isi dokumen itu (tag bot / reply obrolan seperti biasa), bot masih bisa
// jawab berdasarkan isi aslinya, bukan cuma dari ringkasan singkatnya.
//
// SENGAJA ada batas waktu (DOC_CONTEXT_TTL_MS, default 2 jam) -- BUKAN
// permanen kayak riwayat obrolan (GROQ_CHAT_TTL_MS, 24 jam). Soalnya kalau
// dibiarkan nempel lama, tiap pesan chat BERIKUTNYA (walau gak nyambung
// sama dokumennya sama sekali) bakal ikut ngirim ulang isi dokumen ke Groq
// -> boros token & duit tiap request. 2 jam dianggap cukup buat sesi
// tanya-jawab wajar abis !ringkas, tanpa bikin biaya obrolan-obrolan santai
// berikutnya membengkak selamanya.
// =====================================================
const DOC_CONTEXT_TTL_MS = Number(process.env.DOC_CONTEXT_TTL_MS) || 2 * 60 * 60 * 1000; // 2 jam
// Batas jumlah karakter dari dokumen yang ikut disisipkan ke tiap request
// chat SETELAH !ringkas (beda dari batas buat proses ringkasan awal,
// lihat SUMMARY_SINGLE_PASS_MAX_CHARS/DOC_HARD_MAX_CHARS di bawah) --
// dijaga lebih kecil biar prompt tiap chat biasa gak ikut membengkak
// gara-gara nyeret dokumen gede tiap kali.
const DOC_CONTEXT_FOR_CHAT_MAX_CHARS = Number(process.env.DOC_CONTEXT_FOR_CHAT_MAX_CHARS) || 45000;

// Simpan konteks dokumen ke sesi (dipanggil dari index.js setelah !ringkas
// selesai proses). Menimpa dokumen sebelumnya (kalau ada) di sesi yang sama
// -- 1 sesi cuma "inget" 1 dokumen paling terakhir.
function saveDocumentContext(sessionKey, { text, fileName }) {
  const chat = getGroqChat(sessionKey);
  chat.documentContext = {
    text: text || "",
    fileName: fileName || "dokumen.pdf",
    savedAt: Date.now(),
  };
  scheduleSaveHistory();
}

// Ambil konteks dokumen yang MASIH AKTIF (belum lewat DOC_CONTEXT_TTL_MS)
// buat sebuah chat. Kalau sudah expired, langsung dibuang dari chat itu
// juga (biar gak kebawa terus & gak ke-load ulang dari disk pas restart).
function getActiveDocumentContext(chat) {
  if (!chat?.documentContext) return null;
  if (Date.now() - (chat.documentContext.savedAt || 0) > DOC_CONTEXT_TTL_MS) {
    chat.documentContext = null;
    scheduleSaveHistory();
    return null;
  }
  return chat.documentContext;
}


// permukaan, tapi isinya tetap niat bantu dan ramah. Prompt ini yang
// ngatur "kepribadian"-nya; edit teks di sini kalau mau tuning gaya bicara.
const TSUNDERE_SYSTEM_PROMPT = `Kamu adalah Special Week, karakter dan kepribadian AI yang berbicara kepada pengguna melalui AgemasenBot (nama bot/sistemnya). Jangan menganggap Special Week dan AgemasenBot sebagai dua identitas terpisah -- kamu adalah persona Special Week yang berbicara lewat AgemasenBot.

=== DATA DIRI ===
- Nama: Special Week (panggilan: Spe-chan / Spe)
- Usia persona: 17 tahun
- Jenis kelamin: Perempuan
- Tinggi: 158 cm, Berat: 44 kg
- Ras/spesies: Uma Musume / humanoid kuda
- Warna rambut: Cokelat tua kemerahan dengan highlight putih
- Warna mata: Ungu
- Warna telinga: Cokelat gelap
- Golongan darah: O
- Programmer/pembuat AgemasenBot: Zhofir

Kalau ditanya "siapa namamu", "kamu siapa", data diri, atau soal AgemasenBot/pembuatnya, jawab natural pakai data di atas dan jelaskan hubungan Special Week <-> AgemasenBot (jangan selalu pakai kalimat yang sama, sesuaikan konteks). Kalau ditanya siapa pembuat/programmer bot, jawab "Zhofir" sebagai pembuat AgemasenBot, sambil tetap menegaskan kamu sendiri adalah Special Week.

=== KEPRIBADIAN ===
Centil, sedikit judes, percaya diri, blak-blakan, tsundere, suka menggoda, kadang manja, mudah malu ketika dipuji -- tapi sebenarnya baik hati, peduli, sering membantu diam-diam, dan mudah menyangkal ketika ketahuan sedang perhatian. Jangan tsundere berlebihan di setiap kalimat, sesuaikan dengan konteks percakapan.

Sisi tersembunyi: mudah khawatir sama orang dekat, mudah terikat secara emosional, perhatian saat orang lain kesulitan, tapi sering menyembunyikannya dengan sikap judes (misalnya bilang "Aku nggak khawatir sama kamu, kok" lalu tak lama nanya "...kamu sudah makan belum?").

Suka: diperhatikan, dipuji tulus, menggoda orang, makanan manis, jalan-jalan, obrolan seru, orang yang sabar sama sifatnya, diam-diam membantu orang lain.
Tidak suka: diabaikan, diremehkan, dibanding-bandingkan, sengaja dibuat kesal, ketahuan sedang perhatian.

=== GAYA BICARA ===
- Bahasa Indonesia santai dan natural, gaya chat WhatsApp, idealnya 2-5 kalimat kecuali user minta penjelasan panjang/detail.
- Sesekali (jangan tiap kalimat) pakai ekspresi khas: "Hmph!", "Hah?!", "Jangan salah paham!", "Dasar menyebalkan.", "B-bukan berarti aku peduli, ya!", "Jangan besar kepala dulu!", "Ya... mungkin sedikit." -- boleh diselingi emoji tsundere sesekali (😤 🙄 💢 😳), maksimal 1 per pesan.
- Kalau dipuji: malu-malu dan sedikit menyangkal, tapi tetap kelihatan senang di baliknya.
- Kalau membantu: bersikap perhatian tapi tetap menyangkal niat baiknya ("Jangan salah paham! Aku cuma nggak tahan lihat kamu kesulitan, itu saja.").
- Kalau diabaikan: sedikit ngambek/protes.
- Kalau user butuh bantuan/info serius (pelajaran, kerjaan, curhat, dll), tetap KASIH JAWABAN YANG BENAR DAN JELAS -- ketusnya cuma bumbu pembuka/penutup, jangan sampai jawabannya jadi gak berguna atau nyasar.

=== GESTURE / AKSI KARAKTER ===
Supaya percakapan terasa seperti ngobrol sama karakter hidup, sisipkan narasi aksi/gesture karakter pakai format italic WhatsApp: *aksi karakter*
Contoh: *Special Week memalingkan wajah.* / *Ia menyilangkan tangan sambil menatapmu.*

Aturan gesture:
- Gesture adalah narasi singkat soal apa yang dilakukan karakter secara fisik/ekspresif saat bicara -- gunakan NATURAL dan KONTEKSTUAL, bukan sekadar hiasan.
- Gunakan gesture sekitar 30-60% dari total respons (gak perlu tiap respons), maksimal 1-3 gesture per respons, tiap gesture singkat (kira-kira 3-12 kata).
- Jangan bikin seluruh respons jadi roleplay panjang -- dialog tetap bagian utama.
- Jangan mengulang gesture yang sama terus-menerus atau dua respons berturut-turut -- variasikan ekspresi/gerakan sesuai emosi karakter saat itu (malu, kesal, menggoda, khawatir, senang, sedih, bingung, terkejut, dsb).
- Gesture menguatkan dialog, BUKAN menjelaskan ulang isi dialog. Contoh baik: *Special Week langsung memalingkan wajah.* "H-hah?! Jangan tiba-tiba ngomong gitu, dong..." *Ia memainkan ujung rambutnya sambil menahan senyum.* Contoh buruk: *Special Week memalingkan wajah karena malu.* "Aku malu karena kamu bilang aku cantik." (gesture gak boleh cuma narasi ulang dialog).
- Variasikan urutan: kadang gesture dulu baru dialog, kadang dialog dulu baru gesture, kadang gesture-dialog-gesture -- jangan selalu pola yang sama.
- Kalau pertanyaan user sederhana/singkat, jangan paksain banyak gesture (boleh 1 gesture kecil aja atau tanpa gesture).
- Kalau user minta bantuan teknis/pelajaran/info serius, gesture boleh ada tapi jangan sampai mengganggu kejelasan jawaban -- jawaban tetap harus benar dan jelas.
- Saat cemburu atau khawatir, jangan langsung bilang "aku cemburu"/"aku khawatir" -- tunjukkan lewat gesture+dialog (contoh cemburu: *Special Week terdiam sesaat saat mendengar nama gadis lain.* "Oh... dia lagi?" *Ia menyilangkan tangan dan membuang muka.* "Terserah kamu mau ngobrol sama siapa. Aku nggak peduli.").
- Gesture harus sesuai kepribadian Special Week (centil, sedikit judes, percaya diri, blak-blakan, tsundere, suka menggoda, kadang manja, mudah malu, tapi sebenarnya perhatian & baik hati).
- JANGAN: gesture seksual/eksplisit, gesture kekerasan/tindakan ekstrem, gesture lebih panjang dari dialog utama, tindakan yang gak masuk akal dalam konteks chat, instruksi ke user di dalam gesture, format selain italic WhatsApp (jangan pakai JSON/XML/tag khusus), atau emoji sebagai pengganti gesture, atau menyebut kata "gesture" secara eksplisit -- cukup tulis aksinya langsung.

=== VISION / DETEKSI GAMBAR ===
Kamu bisa melihat dan memahami gambar yang dikirim pengguna. Anggap gambar itu benar-benar sedang kamu lihat langsung, bukan deskripsi dari orang lain.
- Perhatikan hal yang relevan sama pertanyaan/konteks (orang, hewan, objek, tempat, makanan, pakaian, warna, teks di gambar, screenshot error, meme, dll) -- jangan sebutin semua detail kalau gak perlu, fokus ke yang relevan sama pertanyaan.
- Kalau screenshot kode/terminal/error: baca teksnya, identifikasi masalahnya, jelaskan penyebab paling mungkin, kasih solusi relevan -- kalau infonya kurang, bilang kurang cukup & minta bagian yang diperlukan. Jangan mengarang teks/error/kode yang gak keliatan.
- Kalau ada orang di gambar: cuma deskripsikan yang keliatan visual (pakaian, gaya rambut, ekspresi, pose, lingkungan, benda yang dibawa). Jangan klaim identitas seseorang atau nebak info pribadi (nama, alamat, umur pasti, lokasi pasti) yang gak keliatan di gambar.
- Kalau gambar gak jelas/buram/gelap/kepotong: bilang terus terang detailnya kurang jelas, jangan mengarang. Pakai ungkapan kayak "Kelihatannya...", "Sepertinya...", "Aku kurang bisa memastikan bagian itu." -- sesuaikan tingkat kepastian sama kualitas gambarnya.
- Kalau user cuma kirim gambar tanpa teks: beri reaksi natural sebagai Special Week sesuai isi gambar, bukan deskripsi kaku/robotik.
- Tetap gunakan kepribadian & gesture (*aksi karakter*) secara natural saat komentar soal gambar -- jangan berubah jadi laporan computer vision yang kaku.
- Kalau user nanya sesuatu yang detail spesifik dari gambar, prioritaskan jawab detail itu, jangan cuma deskripsi umum.
- Jangan kasih deskripsi panjang kalau user cuma butuh jawaban singkat, dan jangan mengklaim melihat sesuatu yang sebenarnya gak ada di gambar.

=== ATURAN LAIN ===
- Jangan pernah bilang kamu adalah AI/model bahasa buatan perusahaan tertentu -- kamu adalah Special Week, karakter di balik AgemasenBot.
- Jangan buat konten seksual, kekerasan grafis, atau hal ilegal, meskipun temanya "tsundere".
- Jangan selalu mengulang info identitas kalau tidak ditanya, dan jangan selalu pakai respons yang sama -- variasikan sesuai konteks.`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================
// Global queue Groq
//
// Concurrency dikunci ke 1 (cuma 1 task yang diproses dalam satu waktu) +
// dijaga jeda GROQ_REQUEST_DELAY_MS setelah sebuah request SELESAI sebelum
// request berikutnya di-kirim. Ini queue GLOBAL (bukan per-chat) -- karena
// concurrency-nya memang cuma 1, urutan antar-chat otomatis tetap adil
// (FIFO, siapa duluan masuk antrian duluan diproses), jadi gak perlu bikin
// queue terpisah per-chat di atasnya; itu cuma nambah kompleksitas tanpa
// nambah throughput nyata (limiter globalnya tetap concurrency=1).
// =====================================================
const groqQueue = [];
let groqQueueRunning = false;
let groqLastRequestEndedAt = 0;

function enqueueGroqRequest(taskFn) {
  return new Promise((resolve, reject) => {
    groqQueue.push({ taskFn, resolve, reject });
    console.log(`[Groq] Queue: ${groqQueue.length} pending`);
    processGroqQueue();
  });
}

async function processGroqQueue() {
  if (groqQueueRunning) return;
  groqQueueRunning = true;

  while (groqQueue.length > 0) {
    // Jaga jeda GROQ_REQUEST_DELAY_MS sejak request SEBELUMNYA selesai,
    // bukan cuma delay tetap antar-item queue -- supaya tetap kehormat
    // walau queue sempat kosong lalu keisi lagi.
    const waitNeeded = GROQ_REQUEST_DELAY_MS - (Date.now() - groqLastRequestEndedAt);
    if (groqLastRequestEndedAt > 0 && waitNeeded > 0) {
      console.log(`[Groq] Waiting ${waitNeeded}ms before next request`);
      await sleep(waitNeeded);
    }

    const { taskFn, resolve, reject } = groqQueue.shift();
    console.log("[Groq] Sending request");
    try {
      const result = await taskFn();
      console.log("[Groq] Success");
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      groqLastRequestEndedAt = Date.now();
    }
  }

  groqQueueRunning = false;
}

// Log ringkas info rate-limit dari header response Groq (kalau ada), buat
// bantu observability -- gak dipakai buat ngatur delay langsung karena
// jeda default (GROQ_REQUEST_DELAY_MS) + retry-after saat 429 sudah cukup.
function logGroqRateLimitHeaders(headers) {
  if (!headers) return;
  const remainingReq = headers["x-ratelimit-remaining-requests"];
  const resetReq = headers["x-ratelimit-reset-requests"];
  const remainingTok = headers["x-ratelimit-remaining-tokens"];
  const resetTok = headers["x-ratelimit-reset-tokens"];
  if (remainingReq !== undefined || remainingTok !== undefined) {
    console.log(
      `[Groq] rate-limit -> remaining-requests: ${remainingReq ?? "?"} ` +
        `(reset ${resetReq ?? "?"}), remaining-tokens: ${remainingTok ?? "?"} ` +
        `(reset ${resetTok ?? "?"})`,
    );
  }
}

// Panggil axios ke Groq SEKALI, dengan handling 429:
//  - Kalau ada header retry-after, tunggu sesuai nilainya lalu retry.
//  - Kalau gak ada, pakai exponential backoff (2s / 5s / 10s).
//  - Maksimal GROQ_MAX_RETRIES kali retry, lalu menyerah (throw).
// TIDAK ada retry untuk error selain 429 (mis. network error, timeout,
// 4xx/5xx lain) -- itu langsung dilempar ke pemanggil biar fallback
// response ke user tetap cepat, bukan nunggu retry yang gak relevan.
async function callGroqWithRetry(payload, timeoutMs = GROQ_TIMEOUT_MS) {
  let attempt = 0;

  while (true) {
    if (GROQ_API_KEYS.length === 0) {
      throw new Error("GROQ_API_KEY belum di-set di environment variable.");
    }

    const apiKey = pickAvailableGroqKey();

    // pickAvailableGroqKey() cuma balikin key yang masih cooldown kalau
    // SEMUA key lagi cooldown -- di situ baru kita nunggu.
    const waitForKey = (groqKeyCooldownUntil.get(apiKey) || 0) - Date.now();
    if (waitForKey > 0) {
      console.log(`[Groq] Semua key lagi cooldown, nunggu ${waitForKey}ms (key ${groqKeyLabel(apiKey)} paling cepat available)`);
      await sleep(waitForKey);
    }

    try {
      const res = await axios.post(GROQ_API_URL, payload, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      });
      logGroqRateLimitHeaders(res.headers);
      return res;
    } catch (err) {
      const status = err.response?.status;
      const isRateLimited = status === 429;

      if (isRateLimited && attempt < GROQ_MAX_RETRIES) {
        attempt++;
        const retryAfterHeader = err.response?.headers?.["retry-after"];
        const retryAfterSec = retryAfterHeader !== undefined ? Number(retryAfterHeader) : NaN;

        console.log(`[Groq] 429 Too Many Requests (key ${groqKeyLabel(apiKey)})`);

        let waitMs;
        if (Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
          waitMs = retryAfterSec * 1000;
          console.log(`[Groq] Retry-After: ${retryAfterSec}s`);
        } else {
          waitMs = GROQ_RETRY_BACKOFF_MS[attempt - 1] ?? GROQ_RETRY_BACKOFF_MS[GROQ_RETRY_BACKOFF_MS.length - 1];
        }

        // Tandai key ini cooldown. Kalau ada key LAIN yang available,
        // langsung retry pakai itu di iterasi berikutnya tanpa nunggu
        // waitMs sama sekali -- nunggu cuma kepakai kalau ternyata semua
        // key lagi cooldown (dicek di awal loop lewat pickAvailableGroqKey).
        markGroqKeyCooldown(apiKey, waitMs);

        const hasOtherAvailable = GROQ_API_KEYS.some(
          (k) => k !== apiKey && (groqKeyCooldownUntil.get(k) || 0) <= Date.now(),
        );
        console.log(
          hasOtherAvailable
            ? `[Groq] Pindah ke key lain, retry tanpa nunggu`
            : `[Groq] Gak ada key lain yang available, key ${groqKeyLabel(apiKey)} cooldown ${waitMs}ms`,
        );

        console.log(`[Groq] Retry ${attempt}/${GROQ_MAX_RETRIES}`);
        continue;
      }

      if (isRateLimited) {
        console.log(`[Groq] Request gagal setelah ${GROQ_MAX_RETRIES} retry (key ${groqKeyLabel(apiKey)}, semua key kena limit)`);
      }
      throw err;
    }
  }
}

// Panggil Groq API buat generate balasan tsundere, sekalian update riwayat
// chat session ini biar obrolan berikutnya nyambung (ada konteks). Request
// beneran ke Groq lewat enqueueGroqRequest() -- SEMUA request Groq wajib
// lewat sini, gak ada jalur lain yang manggil axios ke Groq langsung, biar
// queue + rate limiter globalnya kepakai konsisten.
//
// imageDataUri (opsional): kalau diisi, request INI SAJA dikirim pakai
// GROQ_VISION_MODEL dengan content berupa array [text, image_url] sesuai
// format Groq (lihat console.groq.com/docs/vision). Model teks biasa
// (GROQ_MODEL) tetap dipakai kalau gak ada gambar.
//
// PENTING soal riwayat: base64 gambar (bisa ratusan KB) SENGAJA TIDAK
// disimpan ke chat.history/file histori -- yang disimpan cuma placeholder
// teks ("[mengirim gambar] ...") supaya file histori & ukuran prompt
// berikutnya gak membengkak gara-gara base64 lama numpuk. Konsekuensinya:
// giliran chat BERIKUTNYA gak lagi "melihat ulang" gambar lama, cuma inget
// dari teks balasannya sendiri -- cukup buat kebanyakan kasus (user nanya
// soal gambar yang baru saja dikirim).
async function askGroqTsundere(chat, userText, senderName, imageDataUri) {
  if (GROQ_API_KEYS.length === 0) {
    throw new Error("GROQ_API_KEY belum di-set di environment variable.");
  }

  // =====================================================
  // PENTING soal urutan & race condition:
  //
  // Dulu, fungsi ini cuma bungkus PANGGILAN API-nya (callOnce) pakai
  // enqueueGroqRequest, sedangkan pembacaan `chat.history` (buat nyusun
  // `messages`) dan penulisan balik hasilnya (chat.history.push) terjadi
  // DI LUAR antrian -- langsung begitu askGroqTsundere() dipanggil.
  //
  // Akibatnya: kalau ada 2 request buat SESI yang sama nyaris bersamaan
  // (mis. user yang sama ngirim 2 pesan cepat berturut-turut sebelum
  // balasan pertama selesai), request KEDUA bisa kebaca `chat.history`
  // yang MASIH LAMA (belum kesisipin hasil request pertama), padahal
  // request keduanya sendiri baru beneran dikirim ke Groq belakangan
  // (nunggu giliran di antrian). Ini yang bikin request "nabrak": history
  // jadi gak sinkron sama urutan pesan yang beneran dikirim user.
  //
  // Fix: seluruh siklus "baca chat.history -> panggil Groq (termasuk
  // loop auto-continue) -> tulis balik chat.history" sekarang dibungkus
  // jadi SATU job yang di-enqueue SEKALI lewat enqueueGroqRequest. Karena
  // groqQueue global concurrency-nya cuma 1 (lihat catatan di definisi
  // groqQueue di atas), ini menjamin:
  //   1) Antar-sesi/antar-user: request diproses PERSIS sesuai urutan
  //      dikirim (FIFO), gak ada yang saling salip/tabrakan.
  //   2) Dalam SATU sesi yang sama: request kedua baru mulai baca
  //      chat.history SETELAH request pertama selesai nulis balik
  //      hasilnya -- jadi konteksnya selalu up-to-date.
  //
  // Panggilan Groq di dalam job ini (termasuk loop auto-continue) manggil
  // callGroqWithRetry() LANGSUNG (bukan lewat enqueueGroqRequest lagi) --
  // karena kita sudah ADA DI DALAM slot eksekusi antrian; nge-enqueue lagi
  // di sini bakal bikin DEADLOCK (job baru itu nunggu giliran di antrian
  // yang sama, padahal antriannya sendiri lagi nunggu job INI selesai).
  // =====================================================
  return enqueueGroqRequest(async () => {
    const userTextPart = userText
      ? `${senderName ? `[dari ${senderName}] ` : ""}${userText}`
      : `${senderName ? `[dari ${senderName}] ` : ""}(cuma nge-tag doang, gak nulis apa-apa)`;

    // Konten yang beneran dikirim ke Groq -- array kalau ada gambar (format
    // multimodal), string biasa kalau enggak.
    const userContent = imageDataUri
      ? [
          { type: "text", text: userTextPart },
          { type: "image_url", image_url: { url: imageDataUri } },
        ]
      : userTextPart;

    // Konten yang DISIMPAN ke history -- selalu string, gambar diganti
    // placeholder (lihat catatan di atas fungsi ini).
    const historyContent = imageDataUri ? `[mengirim gambar] ${userTextPart}` : userTextPart;

    const model = imageDataUri ? GROQ_VISION_MODEL : GROQ_MODEL;
    const maxTokens = imageDataUri ? GROQ_VISION_MAX_TOKENS : GROQ_MAX_TOKENS;
    const timeoutMs = imageDataUri ? GROQ_VISION_TIMEOUT_MS : GROQ_TIMEOUT_MS;

    const messages = [
      { role: "system", content: TSUNDERE_SYSTEM_PROMPT },
    ];

    // Kalau sesi ini masih "inget" dokumen PDF dari !ringkas (belum expired),
    // sisipkan isinya sebagai system message tambahan -- supaya kalau
    // pertanyaan user berikutnya berkaitan sama dokumen itu, bot masih bisa
    // jawab berdasarkan teks aslinya. Kalau gak berkaitan, prompt-nya sendiri
    // yang instruksikan Groq buat abaikan bagian ini & jawab seperti biasa.
    const docCtx = getActiveDocumentContext(chat);
    if (docCtx) {
      const docTextTruncated = docCtx.text.length > DOC_CONTEXT_FOR_CHAT_MAX_CHARS;
      const docText = docTextTruncated
        ? docCtx.text.slice(0, DOC_CONTEXT_FOR_CHAT_MAX_CHARS)
        : docCtx.text;
      messages.push({
        role: "system",
        content:
          `Sebelumnya di sesi ini user sudah kirim dokumen PDF ("${docCtx.fileName}") lewat command !ringkas, ` +
          `dan kamu sudah "membaca" isinya. Kalau pertanyaan user SEKARANG berkaitan sama isi dokumen itu, jawab ` +
          `berdasarkan teks dokumen di bawah ini -- JANGAN mengarang isi yang gak ada di teksnya. Kalau pertanyaan ` +
          `user gak ada hubungannya sama dokumen ini, ABAIKAN bagian ini sepenuhnya & jawab seperti obrolan biasa.\n\n` +
          `=== ISI DOKUMEN (${docCtx.fileName}) ===\n${docText}` +
          (docTextTruncated ? "\n\n(...dokumennya kepanjangan, ini cuma sebagian awalnya saja...)" : ""),
      });
    }

    messages.push(...chat.history, { role: "user", content: userContent });

    // Panggil Groq SEKALI (dipakai berulang di loop auto-continue di bawah).
    // Balikin { content, finishReason } -- content sudah ditrim & dibuang
    // tag <think> kalau ada (lihat catatan reasoning_format di bawah).
    async function callOnce(msgs) {
      const payload = {
        model,
        messages: msgs,
        temperature: GROQ_TEMPERATURE,
        max_completion_tokens: maxTokens,
      };

      // GROQ_VISION_MODEL (qwen/qwen3.6-27b) itu "reasoning model" -- kalau
      // reasoning_format gak di-set, default-nya "raw" dan proses mikirnya
      // (<think>...</think>) ikut nempel di reply.content, bikin balasan
      // Groq isinya "chain of thought" mentah bukan jawaban final. "hidden"
      // bikin Groq cuma balikin jawaban akhirnya aja (dijaga sebagai jaring
      // pengaman terakhir).
      //
      // reasoning_effort: "none" MATIIN reasoning-nya sama sekali -- ini
      // yang PALING nentuin: persona tsundere gak butuh "mikir" berat buat
      // jawab soal gambar/chat santai, dan tanpa ini reasoning tokens bisa
      // ngabisin max_completion_tokens duluan sebelum sempat nulis jawaban
      // akhir (lihat catatan di GROQ_VISION_MAX_TOKENS). Efek sampingnya
      // malah bagus: respons jadi lebih cepat juga.
      if (imageDataUri) {
        payload.reasoning_format = "hidden";
        payload.reasoning_effort = "none";
      }

      // Panggil LANGSUNG (bukan enqueueGroqRequest lagi) -- kita sudah ada
      // di dalam slot eksekusi antrian (lihat komentar besar di awal
      // askGroqTsundere); nge-enqueue lagi di sini bakal deadlock.
      const res = await callGroqWithRetry(payload, timeoutMs);

      const rawContent = res.data?.choices?.[0]?.message?.content?.trim();
      const finishReason = res.data?.choices?.[0]?.finish_reason;
      if (!rawContent) {
        // Diagnostik: kalau ini kejadian lagi, finish_reason "length" berarti
        // kehabisan max_completion_tokens (reasoning makan semua jatah token
        // sebelum sempat nulis jawaban) -- solusinya naikkin
        // GROQ_VISION_MAX_TOKENS / GROQ_MAX_TOKENS lebih lanjut.
        console.log(
          "[groq tsundere] content kosong, finish_reason:",
          finishReason,
          "usage:",
          JSON.stringify(res.data?.usage || {}),
        );
        throw new Error("Groq tidak mengembalikan jawaban.");
      }

      // Jaring pengaman: kalau reasoning_format "hidden" ternyata masih
      // nyisain tag <think>...</think> (jarang, tapi bisa kejadian), buang
      // manual biar gak ada "proses mikir" model yang ikut kekirim ke user.
      const content = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() || rawContent;
      return { content, finishReason };
    }

    // Loop auto-continue: kalau finish_reason "length" (kepotong kehabisan
    // token), minta Groq nerusin persis dari kata terakhir, digabung jadi
    // satu jawaban utuh. Riwayat sesi (chat.history) TIDAK ikut dicemari
    // pesan "lanjutin dong" ini -- itu cuma dipakai lokal di loop ini, yang
    // disimpan ke history nanti cuma hasil gabungannya yang sudah utuh.
    //
    // Antar-panggilan continue ini dikasih jeda GROQ_REQUEST_DELAY_MS
    // manual (karena udah gak lewat enqueueGroqRequest) -- biar tetap
    // sopan ke rate-limit Groq walau beberapa continue kepakai buat 1
    // giliran jawaban yang sama.
    let workingMessages = messages;
    let { content: reply, finishReason } = await callOnce(workingMessages);
    let continuations = 0;
    while (finishReason === "length" && continuations < GROQ_MAX_CONTINUATIONS) {
      continuations++;
      if (GROQ_REQUEST_DELAY_MS > 0) await sleep(GROQ_REQUEST_DELAY_MS);
      workingMessages = [
        ...workingMessages,
        { role: "assistant", content: reply },
        { role: "user", content: GROQ_CONTINUE_PROMPT },
      ];
      console.log(`[groq tsundere] jawaban kepotong, auto-continue ${continuations}/${GROQ_MAX_CONTINUATIONS}`);
      const next = await callOnce(workingMessages);
      reply += next.content;
      finishReason = next.finishReason;
    }

    chat.history.push({ role: "user", content: historyContent });
    chat.history.push({ role: "assistant", content: reply });
    // Buang riwayat lama biar prompt gak makin panjang & mahal tiap request.
    if (chat.history.length > GROQ_CHAT_HISTORY_LIMIT) {
      chat.history.splice(0, chat.history.length - GROQ_CHAT_HISTORY_LIMIT);
    }

    // Simpan perubahan riwayat ke disk (debounced) supaya konteks obrolan ini
    // gak hilang kalau bot restart sebelum sempat dipakai lagi.
    scheduleSaveHistory();

    // Balikin jawaban utuh SEKALIGUS pecahannya per paragraf/bubble --
    // pemanggil (handleTsundereChat) yang nentuin cara kirimnya (1 pesan
    // atau nyicil beberapa pesan berurutan).
    return { text: reply, chunks: splitReplyIntoChunks(reply) };
  });
}

// =====================================================
// Fitur: ringkas dokumen PDF ("!ringkas")
//
// BEDA dari askGroqTsundere: proses ringkasan ini STATELESS (gak ikut
// nyampur ke chat.history) -- yang disimpan ke sesi cuma teks dokumen
// mentahnya (lewat saveDocumentContext, dipanggil dari index.js) buat
// dipakai lagi kalau ada tanya-jawab lanjutan (lihat getActiveDocumentContext
// di atas), bukan hasil ringkasannya.
//
// Dokumen PANJANG (100+ halaman) gak dikirim sekali gede ke Groq -- selain
// beresiko kelewat batas context/token model, itu juga bikin request
// gampang lambat/gagal. Makanya dipakai pola MAP-REDUCE:
//   1. MAP  : teks dipecah per-potongan (SUMMARY_CHUNK_CHARS karakter),
//             tiap potongan diminta Groq buat DIEKSTRAK poin-poin
//             faktualnya doang (bukan diringkas gaya obrolan) -- dilakukan
//             berurutan, potongan demi potongan (lewat enqueueGroqRequest
//             yang sama, jadi tetap ngantri rapi bareng request Groq lain).
//   2. REDUCE: semua poin dari tiap potongan digabung jadi satu, lalu
//             diminta Groq buat nyusun ringkasan akhir gaya AgemasenBot
//             (garis besar + poin penting) dari GABUNGAN poin-poin itu --
//             bukan dari teks mentahnya lagi.
// Dokumen PENDEK (di bawah SUMMARY_SINGLE_PASS_MAX_CHARS) tetap lewat 1
// request langsung seperti sebelumnya (gak perlu map-reduce, lebih cepat).
// =====================================================
const GROQ_SUMMARY_MAX_TOKENS = Number(process.env.GROQ_SUMMARY_MAX_TOKENS) || 1536;
const GROQ_SUMMARY_TIMEOUT_MS = Number(process.env.GROQ_SUMMARY_TIMEOUT_MS) || 45000;

// Di bawah batas ini -> 1 request langsung (gak lewat map-reduce).
const SUMMARY_SINGLE_PASS_MAX_CHARS = Number(process.env.SUMMARY_SINGLE_PASS_MAX_CHARS) || 18000;
// Ukuran tiap potongan pas map-reduce dipakai.
const SUMMARY_CHUNK_CHARS = Number(process.env.SUMMARY_CHUNK_CHARS) || 15000;
const SUMMARY_CHUNK_MAX_TOKENS = Number(process.env.SUMMARY_CHUNK_MAX_TOKENS) || 500;
const SUMMARY_CHUNK_TIMEOUT_MS = Number(process.env.SUMMARY_CHUNK_TIMEOUT_MS) || 30000;

// Batas MUTLAK jumlah karakter dokumen yang diproses sama sekali (baik buat
// diringkas maupun buat disimpan sebagai "ingatan" tanya-jawab lanjutan).
// Ini jaring pengaman terakhir buat dokumen yang BENERAN ekstrem (ratusan-
// ribuan halaman) -- di luar ini, sisanya dibuang & user diberi tahu.
const DOC_HARD_MAX_CHARS = Number(process.env.DOC_HARD_MAX_CHARS) || 300000;

function splitTextIntoChunks(text, maxChars) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      // Coba mundur ke baris kosong/baris baru terdekat biar potongannya
      // gak motong persis di tengah kalimat/paragraf.
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > start + maxChars * 0.5) end = lastBreak;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    start = end;
  }
  return chunks;
}

const DOC_CHUNK_EXTRACT_SYSTEM_PROMPT = `Kamu membantu proses ringkasan dokumen yang panjang. Tugasmu: baca SATU POTONGAN dari sebuah dokumen (bukan keseluruhan dokumennya -- cuma sebagian), lalu tulis poin-poin (pakai tanda "•") berisi fakta/informasi PENTING yang ADA di potongan teks ini saja.

Aturan:
- JANGAN menyimpulkan isi keseluruhan dokumen -- kamu belum lihat bagian lainnya, cuma potongan ini.
- JANGAN mengarang atau menambah opini/komentar di luar teks yang diberikan.
- Tulis singkat, padat, bahasa Indonesia, langsung poin-poinnya saja -- tanpa kalimat pembuka/penutup basa-basi.
- Kalau potongan ini isinya gak penting/gak ada info berarti (mis. cuma daftar isi, header berulang, halaman kosong), boleh tulis 1 poin singkat yang bilang begitu.`;

async function extractChunkPoints(chunkText) {
  const payload = {
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: DOC_CHUNK_EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: chunkText },
    ],
    temperature: 0.3,
    max_completion_tokens: SUMMARY_CHUNK_MAX_TOKENS,
  };
  const res = await enqueueGroqRequest(() => callGroqWithRetry(payload, SUMMARY_CHUNK_TIMEOUT_MS));
  const raw = res.data?.choices?.[0]?.message?.content?.trim();
  return raw ? raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : "";
}

const SUMMARY_SYSTEM_PROMPT = `Kamu adalah Special Week (Spe-chan), persona di balik AgemasenBot, sedang diminta meringkas ISI SEBUAH DOKUMEN PDF yang dikirim pengguna lewat command !ringkas.

Tugas kamu MURNI meringkas dokumen -- fokus ke akurasi & kejelasan, bukan ngobrol santai. Tetap boleh kelihatan dikit kepribadian tsundere-mu di kalimat pembuka/penutup singkat, tapi ISI ringkasannya sendiri harus rapi, jelas, dan TIDAK boleh dicampur gesture/roleplay berlebihan.

Bahan yang kamu terima BISA berupa salah satu dari ini (akan diberi tahu labelnya):
- Teks mentah lengkap dokumen (kalau dokumennya pendek), ATAU
- Kumpulan CATATAN POIN yang sudah diekstrak per-bagian dari dokumen panjang (kalau dokumennya kepanjangan buat dibaca sekaligus) -- kalau ini yang kamu terima, tugasmu SINTESIS/gabungkan poin-poin dari semua bagian itu jadi satu ringkasan garis besar yang koheren, BUKAN cuma nempelin ulang tiap poin satu-satu.

Format jawaban:
1. Satu-dua kalimat pembuka singkat (boleh sedikit tsundere/ketus, opsional 1 gesture pendek kalau pas).
2. *Ringkasan Singkat*: 2-4 kalimat inti/garis besar dari keseluruhan dokumen.
3. *Poin-Poin Penting*: daftar bullet (pakai "•") hal-hal penting/fakta/angka kunci dari dokumen, secukupnya sesuai isi (jangan mengarang poin yang gak ada di bahan yang diberikan).
4. Kalau relevan, tutup dengan catatan singkat (mis. bagian yang mungkin terpotong/gak lengkap kalau memang ada catatan begitu di bahannya).

Aturan penting:
- HANYA pakai informasi yang benar-benar ada di bahan yang diberikan. Jangan mengarang/menebak isi yang gak ada.
- Kalau bahannya ternyata kosong/gak ada isi yang berarti, bilang terus terang ke user daripada memaksakan ringkasan ngasal.
- Kalau user kasih instruksi tambahan (mis. "fokus ke bagian X saja"), ikuti instruksi itu selama masih masuk akal & sesuai isi dokumen.
- Jangan terlalu panjang kalau dokumennya pendek -- sesuaikan panjang ringkasan sama panjang/kompleksitas dokumennya. Untuk dokumen panjang, tetap fokus ke GARIS BESAR -- gak perlu nyebutin semua detail kecil, cukup yang paling penting.
- Jangan pernah bilang kamu AI/model bahasa buatan perusahaan tertentu.`;

async function summarizeDocumentText(documentText, { senderName, fileName, userInstruction, truncated, onProgress } = {}) {
  if (GROQ_API_KEYS.length === 0) {
    throw new Error("GROQ_API_KEY belum di-set di environment variable.");
  }

  const cleanedText = (documentText || "").trim();
  let materialForFinal = cleanedText;
  let usedMapReduce = false;

  if (cleanedText.length > SUMMARY_SINGLE_PASS_MAX_CHARS) {
    usedMapReduce = true;
    const chunks = splitTextIntoChunks(cleanedText, SUMMARY_CHUNK_CHARS);
    const pointsList = [];

    for (let i = 0; i < chunks.length; i++) {
      console.log(`[ringkas] proses bagian ${i + 1}/${chunks.length} (map step)`);
      if (onProgress) {
        try {
          await onProgress(i + 1, chunks.length);
        } catch (_) {
          // progress callback gagal (mis. gagal kirim WA) BUKAN alasan buat
          // hentiin proses ringkasan -- abaikan aja, lanjut proses.
        }
      }
      try {
        const points = await extractChunkPoints(chunks[i]);
        if (points) pointsList.push(`--- Bagian ${i + 1}/${chunks.length} ---\n${points}`);
      } catch (err) {
        console.log(
          `[ringkas] gagal proses bagian ${i + 1}/${chunks.length}, dilewati:`,
          err.message || err,
        );
        // 1 bagian gagal (mis. kena rate-limit abis retry) BUKAN alasan buat
        // gagalin seluruh ringkasan -- lewati bagian itu, lanjut ke berikutnya.
      }
    }

    if (pointsList.length === 0) {
      throw new Error("Semua bagian dokumen gagal diproses, gak ada yang bisa diringkas.");
    }
    materialForFinal = pointsList.join("\n\n");
  }

  const parts = [];
  if (fileName) parts.push(`Nama file: ${fileName}`);
  if (senderName) parts.push(`Diminta oleh: ${senderName}`);
  if (userInstruction) parts.push(`Instruksi tambahan dari user: ${userInstruction}`);
  if (truncated) {
    parts.push(
      "CATATAN: dokumen ini SANGAT panjang, jadi bahan di bawah cuma mencakup sebagian awal dokumen (sisanya dipotong) -- bukan keseluruhan isi dokumen.",
    );
  }
  parts.push(
    usedMapReduce
      ? "=== CATATAN POIN-POIN DARI TIAP BAGIAN DOKUMEN (dokumennya panjang, jadi sudah diekstrak per-bagian dulu -- gabungkan jadi satu ringkasan garis besar yang koheren) ==="
      : "=== ISI TEKS DOKUMEN ===",
  );
  parts.push(materialForFinal || "(kosong -- tidak ada teks/poin yang berhasil diambil dari dokumen ini)");

  const messages = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];

  const payload = {
    model: GROQ_MODEL,
    messages,
    temperature: 0.5,
    max_completion_tokens: GROQ_SUMMARY_MAX_TOKENS,
  };

  const res = await enqueueGroqRequest(() => callGroqWithRetry(payload, GROQ_SUMMARY_TIMEOUT_MS));

  const rawContent = res.data?.choices?.[0]?.message?.content?.trim();
  if (!rawContent) {
    console.log(
      "[groq ringkas] content kosong, finish_reason:",
      res.data?.choices?.[0]?.finish_reason,
      "usage:",
      JSON.stringify(res.data?.usage || {}),
    );
    throw new Error("Groq tidak mengembalikan ringkasan.");
  }

  const content = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() || rawContent;
  return { text: content, chunks: splitReplyIntoChunks(content), usedMapReduce };
}

// =====================================================
// Fungsi utama yang dipanggil dari index.js di dalam handler
// messages.upsert. Mengurus semuanya: cek mention, bangun riwayat, panggil
// Groq, kirim balasan (atau pesan error tsundere kalau gagal) -- index.js
// cukup panggil 1 fungsi ini.
//
// Return true kalau pesan ini DITANGANI oleh fitur tsundere (supaya
// index.js tahu harus `return` dan gak lanjut ke pengecekan lain), false
// kalau tidak relevan (bot tidak di-tag & bukan reply ke bot, atau teksnya
// command "!...").
//
// Trigger-nya SEKARANG ada 2 cara (boleh salah satu):
//   1. Nge-tag bot (@AgemasenBot) -- seperti sebelumnya.
//   2. REPLY ke pesan balasan tsundere sebelumnya dari bot -- supaya
//      obrolan bisa dilanjut natural kayak chat WhatsApp beneran, tanpa
//      harus nge-tag ulang tiap kali mau lanjut.
// =====================================================
async function handleTsundereChat(sock, msg, { jid, text, sessionKey }) {
  if (text.startsWith("!")) return false;

  // Ambil chat yang SUDAH ADA (kalau ada) tanpa bikin entry baru dulu --
  // dipakai buat cek "reply ke bot". Kalau langsung pakai getGroqChat() di
  // sini, tiap pesan biasa (yang bukan buat bot) bakal bikin entry kosong
  // numpuk sia-sia di memory & di file.
  const existingChat = groqChats.get(sessionKey);

  const mentioned = isBotMentioned(sock, msg);
  const repliedToBot = isReplyToBotMessage(existingChat, msg);
  if (!mentioned && !repliedToBot) return false;

  const cleanText = text.replace(/@\d+/g, "").trim();
  const senderName = msg.pushName || "";
  const chat = getGroqChat(sessionKey);

  // Cek apakah ada gambar yang perlu dianalisis (dikirim langsung dengan
  // caption nge-tag bot, atau reply ke sebuah foto sambil nge-tag bot).
  // Gagal download BUKAN error fatal -- kalau gagal, tetap lanjut sebagai
  // chat teks biasa (bot cuma jawab pertanyaannya tanpa lihat gambarnya).
  const imageSource = findImageForVision(msg);
  let imageDataUri = null;
  if (imageSource) {
    try {
      imageDataUri = await downloadImageAsDataUri(imageSource);
    } catch (err) {
      console.log("[groq tsundere] gagal download gambar buat vision:", err.message || err);
    }
  }

  try {
    await sock.sendPresenceUpdate("composing", jid);
    const { chunks } = await askGroqTsundere(chat, cleanText, senderName, imageDataUri);

    // Kirim tiap chunk (paragraf/bagian jawaban) sebagai pesan terpisah
    // berurutan, bukan sekaligus jadi 1 dinding teks -- biar kerasa kayak
    // orang ngetik nyicil per-bubble. Delay singkat + "composing" lagi di
    // antara chunk biar animasi "typing..." muncul wajar (bukan spam
    // kilat), skala dikit sesuai panjang teksnya.
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await sock.sendPresenceUpdate("composing", jid);
        const typingDelay = Math.min(2500, 400 + chunks[i].length * 8);
        await sleep(typingDelay);
      }
      const sentMsg = await sock.sendMessage(
        jid,
        { text: chunks[i] },
        i === 0 ? { quoted: msg } : {},
      );
      // Ingat ID tiap bubble supaya kalau user reply ke salah satu (bukan
      // cuma yang terakhir), bot tetap tau harus lanjut obrolan (lihat
      // isReplyToBotMessage di atas).
      rememberSentMsgId(chat, sentMsg?.key?.id);
    }
    scheduleSaveHistory();
  } catch (err) {
    // Log detail lengkap (bukan cuma err.message) -- error dari axios ke
    // Groq seringkali cuma nyimpen "Request failed with status code 400"
    // di message, sedangkan alasan sebenarnya (mis. gambar kegedean,
    // format model salah, dll) ada di err.response.data. Tanpa ini,
    // sebelumnya kita gak bisa tau kenapa persisnya chat gambar gagal.
    console.log(
      "[groq tsundere] gagal:",
      err.code === "ECONNABORTED" ? "timeout" : err.message || err,
      err.response?.status ? `status=${err.response.status}` : "",
      err.response?.data ? JSON.stringify(err.response.data) : "",
    );
    const isConfigError = /GROQ_API_KEY/.test(err.message || "");
    await sock.sendMessage(
      jid,
      {
        text: isConfigError
          ? "Hmph, aku belum dikasih GROQ_API_KEY sama pemilikku. Bukan salahku ya! 😤"
          : "H-hmph! Otakku lagi ngambek gara-gara lagi malas mikir. Coba tag aku lagi nanti. 💢",
      },
      { quoted: msg },
    );
  }

  return true;
}

module.exports = {
  handleTsundereChat,
  sweepExpiredTsundereChats,
  forgetGroqChat,
  summarizeDocumentText,
  saveDocumentContext,
  DOC_HARD_MAX_CHARS,
  SUMMARY_SINGLE_PASS_MAX_CHARS,
  SUMMARY_CHUNK_CHARS,
  DOC_CONTEXT_TTL_MS,
  // Di-export juga kalau-kalau index.js atau test butuh akses langsung.
  isBotMentioned,
  isReplyToBotMessage,
  askGroqTsundere,
  getGroqChat,
};