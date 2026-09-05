const axios = require("axios");

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

const GROQ_TEMPERATURE =
  process.env.GROQ_TEMPERATURE !== undefined
    ? Number(process.env.GROQ_TEMPERATURE)
    : 0.9;


const GROQ_REQUEST_DELAY_MS = Number(process.env.GROQ_REQUEST_DELAY) || 2000; // jeda antar-request Groq
const GROQ_MAX_RETRIES = Number(process.env.GROQ_MAX_RETRIES) || 3; // maksimal retry saat 429
// Dipakai HANYA kalau response 429 gak punya header retry-after.
const GROQ_RETRY_BACKOFF_MS = [2000, 5000, 10000];

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

module.exports = {
  GROQ_API_KEYS,
  GROQ_MODEL,
  GROQ_VISION_MODEL,
  GROQ_TIMEOUT_MS,
  GROQ_VISION_TIMEOUT_MS,
  GROQ_MAX_TOKENS,
  GROQ_VISION_MAX_TOKENS,
  GROQ_TEMPERATURE,
  GROQ_MAX_RETRIES,
  GROQ_RETRY_BACKOFF_MS,
  sleep,
  enqueueGroqRequest,
  callGroqWithRetry,
};
