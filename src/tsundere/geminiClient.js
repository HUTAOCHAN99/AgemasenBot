const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { ROOT_DIR } = require("../config/env");
const { sleep } = require("./llmQueue");

// =====================================================
// Gemini client (provider UTAMA)
//
// Pola multi-key + cooldown + retry di sini sengaja dibikin MIRIP
// groqClient.js supaya gampang dibaca berdampingan. Bedanya ada tiga:
//
//  1. Format request/response Gemini BEDA total dari format OpenAI yang
//     dipakai Groq (contents/parts/systemInstruction, bukan messages).
//     Konversinya ada di toGeminiRequest() / parseGeminiResponse() di
//     bawah -- jadi seluruh kode lain (chatReply, summarizer) tetap nulis
//     pakai format OpenAI-style seperti sebelumnya, gak perlu tahu.
//
//  2. Gemini free tier punya batas HARIAN (RPD), bukan cuma per-menit.
//     Sekali kena batas harian, key itu percuma dicoba lagi sampai reset
//     tengah malam waktu Pasifik. Makanya ada counter/penanda harian yang
//     disimpan ke disk -- biar habis restart bot gak nembak API yang sudah
//     pasti nolak, dan langsung lempar ke Groq.
//
//  3. Search Grounding (tools: google_search) diaktifkan by default --
//     ini yang bikin bot bisa jawab info terbaru, bukan cuma dari
//     pengetahuan model.
// =====================================================

function loadGeminiApiKeys() {
  const keys = [];
  let i = 1;
  while (true) {
    const val = process.env[`GEMINI_API_KEY_${i}`];
    if (!val) break;
    keys.push(val.trim());
    i++;
  }
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY.trim());
  }
  return keys;
}

const GEMINI_API_KEYS = loadGeminiApiKeys();
console.log(
  GEMINI_API_KEYS.length > 0
    ? `[Gemini] ${GEMINI_API_KEYS.length} API key terdeteksi.`
    : "[Gemini] TIDAK ADA API key yang di-set -- semua request bakal langsung jatuh ke Groq.",
);

// Model ID SENGAJA dibikin env var, bukan di-hardcode. Nama model Gemini
// sering berubah/nambah varian, dan ID yang salah bikin error 404 yang
// gejalanya mirip "API mati". Cek ID yang valid buat key kamu lewat:
//   curl -H "x-goog-api-key: $GEMINI_API_KEY" \
//     https://generativelanguage.googleapis.com/v1beta/models
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
// Gemini itu natively multimodal -- model teksnya sekalian bisa "lihat"
// gambar, gak perlu model vision terpisah kayak Groq. Tetap dibikin env
// var terpisah kalau-kalau kamu mau pakai model lebih pintar khusus buat
// gambar (mis. Flash biasa buat gambar, Flash-Lite buat chat).
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || GEMINI_MODEL;

const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25000;
// Request bergambar harus di-upload base64-nya dulu + diproses, jadi
// wajar lebih lama dari chat teks biasa.
const GEMINI_VISION_TIMEOUT_MS = Number(process.env.GEMINI_VISION_TIMEOUT_MS) || 45000;

// Search Grounding: ON by default (sesuai keputusan desain). Kuota gratisnya
// 500 request/hari dan DIPAKAI BARENGAN antara Flash & Flash-Lite, jadi
// praktisnya ini yang jadi batas atas beneran, bukan RPD model-nya.
// Set GEMINI_GROUNDING=0 kalau mau matiin sementara.
const GEMINI_GROUNDING_ENABLED = process.env.GEMINI_GROUNDING !== "0";

// Gemini 2.5 ke atas punya "thinking". Buat persona ngobrol santai,
// mikirnya gak kepakai tapi tokennya tetap kepotong dari maxOutputTokens
// -- persis masalah yang dulu bikin jawaban Groq vision jadi string kosong
// (lihat catatan GROQ_VISION_MAX_TOKENS di groqClient.js). Default 0 =
// matiin. Naikkan kalau kamu mau jawaban yang lebih "mikir" buat !ringkas.
const GEMINI_THINKING_BUDGET =
  process.env.GEMINI_THINKING_BUDGET !== undefined
    ? Number(process.env.GEMINI_THINKING_BUDGET)
    : 0;

// Batas token jawaban. Dipisah dari GROQ_MAX_TOKENS karena dua provider
// ini beda karakter: kalau thinking dimatiin, Gemini nulis jawaban yang
// relatif lebih padat untuk jumlah token yang sama.
const GEMINI_MAX_TOKENS = Number(process.env.GEMINI_MAX_TOKENS) || 800;
const GEMINI_VISION_MAX_TOKENS = Number(process.env.GEMINI_VISION_MAX_TOKENS) || 1024;

const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES) || 2;
const GEMINI_RETRY_BACKOFF_MS = [2000, 5000];

// key -> timestamp (ms) kapan key ini boleh dipakai lagi (0 = selalu boleh)
const geminiKeyCooldownUntil = new Map(GEMINI_API_KEYS.map((k) => [k, 0]));
let geminiKeyRotateIndex = 0;

// =====================================================
// Penanda kuota HARIAN per-key.
//
// Google me-reset kuota harian free tier di tengah malam waktu Pasifik
// (bukan waktu lokal kita), jadi "hari" di sini dihitung pakai timezone
// America/Los_Angeles -- kalau pakai tanggal lokal WIB, penanda bakal
// kebuka lebih cepat/lambat dari reset aslinya dan bot nembak API yang
// masih ditolak.
//
// Yang disimpan cuma: tanggal PT + daftar index key yang sudah kena batas
// harian. Bukan hitungan request yang presisi -- itu gak perlu, karena
// yang kita butuh cuma "key ini sudah mentok belum hari ini", dan sumber
// kebenarannya tetap response 429 dari Google sendiri.
// =====================================================
const DATA_DIR = path.join(ROOT_DIR, "data");
const GEMINI_QUOTA_FILE =
  process.env.GEMINI_QUOTA_FILE || path.join(DATA_DIR, "gemini_quota.json");

let quotaState = { day: null, exhausted: [] };

function currentPacificDay() {
  // en-CA ngasih format YYYY-MM-DD yang enak dibandingin sebagai string.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function loadQuotaState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GEMINI_QUOTA_FILE, "utf8"));
    if (parsed && typeof parsed.day === "string" && Array.isArray(parsed.exhausted)) {
      quotaState = { day: parsed.day, exhausted: parsed.exhausted };
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log("[Gemini] gagal load penanda kuota:", err.message);
    }
    // File belum ada itu normal buat first run.
  }
}

function saveQuotaState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GEMINI_QUOTA_FILE, JSON.stringify(quotaState), "utf8");
  } catch (err) {
    console.log("[Gemini] gagal simpan penanda kuota:", err.message);
  }
}

// Buang penanda kalau harinya sudah ganti (kuota sudah di-reset Google).
function refreshQuotaDay() {
  const today = currentPacificDay();
  if (quotaState.day !== today) {
    if (quotaState.exhausted.length > 0) {
      console.log("[Gemini] hari baru (waktu Pasifik) -- penanda kuota harian di-reset.");
    }
    quotaState = { day: today, exhausted: [] };
    saveQuotaState();
  }
}

function markKeyDailyExhausted(key) {
  refreshQuotaDay();
  const idx = GEMINI_API_KEYS.indexOf(key);
  if (idx === -1 || quotaState.exhausted.includes(idx)) return;
  quotaState.exhausted.push(idx);
  saveQuotaState();
  console.log(
    `[Gemini] key ${geminiKeyLabel(key)} kena batas HARIAN -- gak dipakai lagi sampai reset besok.`,
  );
}

function isKeyDailyExhausted(key) {
  refreshQuotaDay();
  return quotaState.exhausted.includes(GEMINI_API_KEYS.indexOf(key));
}

// true kalau SEMUA key sudah mentok kuota harian -- router pakai ini buat
// langsung lompat ke Groq tanpa buang waktu nembak Gemini dulu.
function allKeysDailyExhausted() {
  if (GEMINI_API_KEYS.length === 0) return true;
  refreshQuotaDay();
  return GEMINI_API_KEYS.every((k) => isKeyDailyExhausted(k));
}

loadQuotaState();
refreshQuotaDay();

function geminiKeyLabel(key) {
  const idx = GEMINI_API_KEYS.indexOf(key);
  return idx === -1 ? "?" : `#${idx + 1}/${GEMINI_API_KEYS.length}`;
}

// Pilih key yang masih boleh dipakai (round-robin), lewati yang lagi
// cooldown per-menit MAUPUN yang sudah mentok harian. null = gak ada.
function pickAvailableGeminiKey() {
  if (GEMINI_API_KEYS.length === 0) return null;
  const now = Date.now();

  for (let offset = 0; offset < GEMINI_API_KEYS.length; offset++) {
    const idx = (geminiKeyRotateIndex + offset) % GEMINI_API_KEYS.length;
    const key = GEMINI_API_KEYS[idx];
    if (isKeyDailyExhausted(key)) continue;
    if ((geminiKeyCooldownUntil.get(key) || 0) <= now) {
      geminiKeyRotateIndex = (idx + 1) % GEMINI_API_KEYS.length;
      return key;
    }
  }
  return null;
}

// =====================================================
// Konversi format OpenAI-style -> format Gemini.
//
// Ini bagian yang paling gampang bikin bug halus, jadi dicatat detail:
//  - role "system" TIDAK ada di contents Gemini -- semua system message
//    (persona + konteks dokumen dari !ringkas) digabung jadi satu
//    systemInstruction terpisah.
//  - role "assistant" namanya "model" di Gemini.
//  - contents WAJIB mulai dari role "user". Setelah history dipotong
//    (GROQ_CHAT_HISTORY_LIMIT), pesan paling awal bisa saja kebetulan
//    punya assistant -- itu dibuang di sini, bukan dibiarkan bikin 400.
//  - Gambar: Groq minta data URI utuh ("data:image/jpeg;base64,xxx"),
//    Gemini minta mimeType dan base64-nya TERPISAH. Prefix-nya harus
//    dibuang, kalau gak gambarnya dianggap korup.
// =====================================================
function dataUriToInlineData(dataUri) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUri || "");
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function contentToParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content ?? "") }];

  const parts = [];
  for (const item of content) {
    if (item?.type === "text" && item.text) {
      parts.push({ text: item.text });
    } else if (item?.type === "image_url") {
      const inline = dataUriToInlineData(item.image_url?.url);
      if (inline) parts.push(inline);
      else console.log("[Gemini] image_url bukan data URI base64 yang valid, dilewati.");
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

// Instruksi tambahan yang HANYA dipasang saat grounding aktif.
//
// Kenapa perlu: begitu google_search nyala, model cenderung kabur ke gaya
// "laporan hasil pencarian" -- rapi, berpoin, netral, dan persona
// tsundere-nya ilang. Ini nahan supaya hasil pencarian cuma jadi BAHAN,
// bukan ngeganti cara ngomongnya.
const GROUNDING_STYLE_NOTE = `

=== CATATAN SAAT KAMU PUNYA AKSES PENCARIAN ===
Kamu punya akses ke hasil pencarian web terbaru. Aturannya:
- Pakai hasil pencarian cuma sebagai BAHAN jawaban. Cara kamu ngomong TETAP sebagai Special Week -- jangan berubah jadi gaya laporan/artikel berita yang kaku dan netral.
- Jangan nulis ulang hasil pencarian mentah-mentah atau kepanjangan. Ambil intinya, sampaikan dengan gaya kamu sendiri, tetap ringkas (2-5 kalimat kecuali user minta detail).
- Gesture (*aksi karakter*) tetap dipakai natural seperti biasa.
- Kalau info yang ketemu ternyata gak yakin/bertentangan, bilang terus terang -- jangan sok tahu.
- Kalau pertanyaannya jelas-jelas gak butuh info terkini (obrolan santai, curhat, nanya soal kamu sendiri), ABAIKAN hasil pencarian sepenuhnya dan jawab seperti biasa.`;

function toGeminiRequest(messages, { temperature, maxTokens, grounding, thinkingBudget }) {
  const systemTexts = [];
  const contents = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemTexts.push(msg.content);
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = contentToParts(msg.content);

    // Gabung kalau role-nya sama dengan pesan sebelumnya -- Gemini lebih
    // happy dengan giliran user/model yang selang-seling.
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }

  // Buang pesan "model" yang nyangkut di paling depan (lihat catatan di atas).
  while (contents.length > 0 && contents[0].role === "model") contents.shift();

  if (grounding && systemTexts.length > 0) {
    systemTexts[0] = systemTexts[0] + GROUNDING_STYLE_NOTE;
  }

  const payload = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  if (systemTexts.length > 0) {
    payload.systemInstruction = { parts: [{ text: systemTexts.join("\n\n") }] };
  }
  if (Number.isFinite(thinkingBudget)) {
    payload.generationConfig.thinkingConfig = { thinkingBudget };
  }
  if (grounding) {
    payload.tools = [{ google_search: {} }];
  }

  return payload;
}

// Ambil teks + alasan berhenti + sumber dari response Gemini.
//
// finishReason SENGAJA diterjemahin ke istilah OpenAI ("length"/"stop")
// supaya loop auto-continue di chatReply.js gak perlu tahu provider mana
// yang lagi kepakai -- logika "jawaban kepotong" jalan sama persis di
// kedua provider.
function parseGeminiResponse(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  // PENTING: buang part yang ditandai "thought": true. Kalau
  // GEMINI_THINKING_BUDGET diaktifkan (bukan 0), Gemini balikin proses
  // "mikir"-nya sebagai part terpisah SEBELUM part jawaban final -- kalau
  // gak difilter, isi reasoning mentah itu ikut ke-gabung jadi "jawaban"
  // dan bocor ke user (ciri-cirinya: teks berbahasa Inggris, gaya analisis
  // step-by-step / "Determine the ...", gak nyambung sama persona sama
  // sekali). Ini juga yang bikin token cepat abis -> finishReason "length"
  // -> auto-continue kepicu lebih sering dari seharusnya.
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("")
    .trim();

  const rawFinish = candidate?.finishReason;
  const finishReason =
    rawFinish === "MAX_TOKENS" ? "length" : rawFinish === "STOP" ? "stop" : rawFinish;

  // Sumber dari Search Grounding (kalau ada). Di-dedup by URL biar gak
  // nampilin domain yang sama berkali-kali.
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    const uri = c?.web?.uri;
    const title = c?.web?.title;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: title || uri, uri });
  }

  return { text, finishReason, sources, blockReason: data?.promptFeedback?.blockReason };
}

// Panggil Gemini SEKALI (dengan rotasi key + retry 429).
//
// Lempar error kalau gagal -- pemanggilnya (llmRouter) yang mutusin
// apakah error ini layak di-fallback ke Groq atau enggak.
async function callGeminiWithRetry(messages, options = {}) {
  const {
    temperature = 0.9,
    // maxTokens sengaja BOLEH kosong -- kalau pemanggil gak nentuin,
    // dipakai default milik Gemini sendiri, bukan default milik Groq.
    maxTokens,
    timeoutMs,
    hasImage = false,
    grounding = GEMINI_GROUNDING_ENABLED,
    // Boleh di-override per-pemanggil (mis. chatReply.js matiin thinking
    // buat obrolan santai). Kalau gak dikasih, pakai default global env
    // GEMINI_THINKING_BUDGET.
    thinkingBudget = GEMINI_THINKING_BUDGET,
  } = options;

  if (GEMINI_API_KEYS.length === 0) {
    const err = new Error("GEMINI_API_KEY belum di-set.");
    err.geminiUnavailable = true;
    throw err;
  }
  if (allKeysDailyExhausted()) {
    const err = new Error("Semua Gemini API key sudah mentok kuota harian.");
    err.geminiUnavailable = true;
    throw err;
  }

  const model = hasImage ? GEMINI_VISION_MODEL : GEMINI_MODEL;
  const effectiveMaxTokens =
    maxTokens || (hasImage ? GEMINI_VISION_MAX_TOKENS : GEMINI_MAX_TOKENS);
  const effectiveTimeout =
    timeoutMs || (hasImage ? GEMINI_VISION_TIMEOUT_MS : GEMINI_TIMEOUT_MS);
  const payload = toGeminiRequest(messages, {
    temperature,
    maxTokens: effectiveMaxTokens,
    grounding,
    thinkingBudget,
  });

  let attempt = 0;
  while (true) {
    const apiKey = pickAvailableGeminiKey();
    if (!apiKey) {
      // Semua key lagi cooldown per-menit atau mentok harian. Gak usah
      // nunggu di sini -- lebih baik langsung fallback ke Groq daripada
      // bikin user nunggu lama-lama.
      const err = new Error("Gak ada Gemini API key yang available sekarang.");
      err.geminiUnavailable = true;
      throw err;
    }

    try {
      const res = await axios.post(
        `${GEMINI_API_BASE}/models/${model}:generateContent`,
        payload,
        {
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          timeout: effectiveTimeout,
        },
      );
      const parsed = parseGeminiResponse(res.data);

      if (!parsed.text) {
        // Diagnostik penting: kalau ini sering kejadian dengan finishReason
        // "length", berarti thinking/maxOutputTokens-nya kurang. Kalau
        // "SAFETY"/blockReason terisi, itu kena filter konten -- di kasus
        // itu fallback ke Groq justru masuk akal (filter tiap provider beda).
        console.log(
          "[Gemini] jawaban kosong. finishReason:",
          parsed.finishReason,
          "blockReason:",
          parsed.blockReason,
          "usage:",
          JSON.stringify(res.data?.usageMetadata || {}),
        );
        const err = new Error("Gemini tidak mengembalikan jawaban.");
        err.geminiEmpty = true;
        throw err;
      }

      if (parsed.sources.length > 0) {
        console.log(`[Gemini] grounding aktif, ${parsed.sources.length} sumber.`);
      }
      return parsed;
    } catch (err) {
      if (err.geminiEmpty) throw err;

      const status = err.response?.status;
      const apiMessage = err.response?.data?.error?.message || "";

      if (status === 429) {
        // Bedakan limit PER-MENIT (bisa ditunggu sebentar) dari limit
        // HARIAN (percuma ditunggu, harus nunggu besok). Google nyantumin
        // jenis quota-nya di pesan error / quotaViolations.
        const isDaily = /per\s*day|PerDay|daily/i.test(
          apiMessage + JSON.stringify(err.response?.data?.error?.details || ""),
        );

        if (isDaily) {
          markKeyDailyExhausted(apiKey);
        } else {
          const waitMs =
            GEMINI_RETRY_BACKOFF_MS[attempt] ??
            GEMINI_RETRY_BACKOFF_MS[GEMINI_RETRY_BACKOFF_MS.length - 1];
          geminiKeyCooldownUntil.set(apiKey, Date.now() + waitMs);
          console.log(`[Gemini] 429 per-menit (key ${geminiKeyLabel(apiKey)}), cooldown ${waitMs}ms`);
        }

        // Masih ada key lain yang available? Langsung coba pakai itu.
        // Kalau enggak dan jatah retry masih ada, tunggu sebentar lalu
        // ulangi. Kalau sudah mentok, lempar -- biar jatuh ke Groq.
        if (pickAvailableGeminiKey()) continue;
        if (!isDaily && attempt < GEMINI_MAX_RETRIES) {
          attempt++;
          await sleep(GEMINI_RETRY_BACKOFF_MS[attempt - 1] || 2000);
          continue;
        }
        const quotaErr = new Error("Gemini kena rate limit / kuota habis.");
        quotaErr.geminiUnavailable = true;
        throw quotaErr;
      }

      if (status === 400 || status === 404) {
        // 400 = payload salah, 404 = nama model gak valid. Dua-duanya BUG
        // di sisi kita, bukan gangguan sesaat -- retry gak bakal nolong.
        // Di-log jelas biar ketahuan pas debugging.
        console.log(`[Gemini] HTTP ${status}: ${apiMessage}`);
      }
      throw err;
    }
  }
}

module.exports = {
  GEMINI_API_KEYS,
  GEMINI_MODEL,
  GEMINI_VISION_MODEL,
  GEMINI_MAX_TOKENS,
  GEMINI_VISION_MAX_TOKENS,
  GEMINI_GROUNDING_ENABLED,
  GEMINI_TIMEOUT_MS,
  GEMINI_VISION_TIMEOUT_MS,
  callGeminiWithRetry,
  allKeysDailyExhausted,
  toGeminiRequest,
  parseGeminiResponse,
};
