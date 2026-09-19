const {
  GEMINI_API_KEYS,
  GEMINI_GROUNDING_ENABLED,
  callGeminiWithRetry,
  allKeysDailyExhausted,
} = require("./geminiClient");
const {
  GROQ_API_KEYS,
  GROQ_MODEL,
  GROQ_VISION_MODEL,
  GROQ_TIMEOUT_MS,
  GROQ_VISION_TIMEOUT_MS,
  GROQ_MAX_TOKENS,
  GROQ_VISION_MAX_TOKENS,
  callGroqWithRetry,
} = require("./groqClient");
const { enqueueLlmRequest } = require("./llmQueue");

// =====================================================
// Router LLM: Gemini DULU, Groq cuma cadangan.
//
// Aturan mainnya cuma satu: Groq TIDAK PERNAH dipakai selama Gemini masih
// bisa jawab. Begitu Gemini gagal -- apa pun bentuk gagalnya (timeout,
// jaringan, 429, kuota harian habis, jawaban kosong, kena filter konten,
// nama model salah) -- payload yang SAMA langsung diulang ke Groq supaya
// user tetap dapat balasan, bukan pesan error.
//
// Yang penting dijaga: fungsi ini TIDAK nge-enqueue apa-apa sendiri.
// Pemanggilnya yang tanggung jawab antri (chatReply.js membungkus satu
// siklus penuh baca-history/panggil/tulis-history jadi satu job; summarizer
// pakai askLLMQueued di bawah). Kalau router ikut nge-enqueue, job-nya
// bakal nunggu antrian yang lagi nunggu dirinya sendiri -> DEADLOCK.
//
// Bentuk balikannya sengaja SERAGAM buat kedua provider:
//   { content, finishReason, sources, provider }
// finishReason pakai istilah OpenAI ("length"/"stop") -- Gemini sudah
// diterjemahin di parseGeminiResponse -- supaya loop auto-continue di
// chatReply.js gak perlu tahu lagi jawab pakai provider yang mana.
// =====================================================

// Groq itu reasoning model buat vision, dan kadang masih nyisain tag
// <think> walau sudah diminta hidden. Sama juga dipakai buat jaga-jaga di
// jalur Gemini kalau suatu saat modelnya kelepasan.
function stripThinkTags(raw) {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() || raw;
}

async function callGroqFallback(messages, { temperature, maxTokens, timeoutMs, hasImage }) {
  if (GROQ_API_KEYS.length === 0) {
    throw new Error("Gemini gagal dan GROQ_API_KEY juga belum di-set -- gak ada provider cadangan.");
  }

  const payload = {
    model: hasImage ? GROQ_VISION_MODEL : GROQ_MODEL,
    messages,
    temperature,
    // Kalau pemanggil gak nentuin, pakai batas token milik Groq sendiri
    // (Gemini punya angkanya sendiri di geminiClient.js).
    max_completion_tokens: maxTokens || (hasImage ? GROQ_VISION_MAX_TOKENS : GROQ_MAX_TOKENS),
  };

  // Matikan reasoning buat request bergambar -- tanpa ini, token "mikir"
  // bisa ngabisin max_completion_tokens duluan sampai jawaban akhirnya
  // jadi string kosong (catatan lengkapnya ada di groqClient.js).
  if (hasImage) {
    payload.reasoning_format = "hidden";
    payload.reasoning_effort = "none";
  }

  const effectiveTimeout = timeoutMs || (hasImage ? GROQ_VISION_TIMEOUT_MS : GROQ_TIMEOUT_MS);
  const res = await callGroqWithRetry(payload, effectiveTimeout);

  const rawContent = res.data?.choices?.[0]?.message?.content?.trim();
  const finishReason = res.data?.choices?.[0]?.finish_reason;
  if (!rawContent) {
    console.log(
      "[Groq] content kosong, finish_reason:",
      finishReason,
      "usage:",
      JSON.stringify(res.data?.usage || {}),
    );
    throw new Error("Groq tidak mengembalikan jawaban.");
  }

  return {
    content: stripThinkTags(rawContent),
    finishReason,
    sources: [],
    provider: "groq",
  };
}

// Ringkas alasan kegagalan Gemini buat log -- supaya pas fallback kejadian
// di produksi, ketahuan ini gara-gara kuota, jaringan, atau salah config.
function describeGeminiError(err) {
  if (err.geminiUnavailable) return err.message;
  if (err.geminiEmpty) return "jawaban kosong / kena filter konten";
  const status = err.response?.status;
  if (status) {
    const apiMsg = err.response?.data?.error?.message;
    return `HTTP ${status}${apiMsg ? ` -- ${apiMsg}` : ""}`;
  }
  if (err.code === "ECONNABORTED") return "timeout";
  return err.message || String(err);
}

/**
 * messages: format OpenAI-style (role: system/user/assistant). Konversi ke
 *   format Gemini terjadi di dalam -- pemanggil gak perlu tahu.
 * hasImage: true kalau ada part gambar di messages (nentuin model & timeout).
 * grounding: default ikut GEMINI_GROUNDING_ENABLED. Set false buat tugas
 *   yang jelas gak butuh info dari internet (mis. !ringkas dokumen).
 */
async function askLLM(messages, options = {}) {
  const {
    temperature = 0.9,
    // Biarkan kosong supaya tiap provider pakai default-nya masing-masing.
    maxTokens,
    timeoutMs,
    hasImage = false,
    grounding = GEMINI_GROUNDING_ENABLED,
    // Diteruskan apa adanya ke callGeminiWithRetry -- kalau gak dikasih
    // pemanggil, biar callGeminiWithRetry yang pakai default env-nya
    // sendiri (GEMINI_THINKING_BUDGET). Groq gak punya konsep ini, jadi
    // gak dipakai di callGroqFallback.
    thinkingBudget,
  } = options;

  const geminiUsable = GEMINI_API_KEYS.length > 0 && !allKeysDailyExhausted();

  if (geminiUsable) {
    try {
      const result = await callGeminiWithRetry(messages, {
        temperature,
        maxTokens,
        timeoutMs,
        hasImage,
        grounding,
        thinkingBudget,
      });
      return {
        content: stripThinkTags(result.text),
        finishReason: result.finishReason,
        sources: result.sources,
        provider: "gemini",
      };
    } catch (err) {
      console.log(`[LLM] Gemini gagal (${describeGeminiError(err)}) -- fallback ke Groq.`);
    }
  } else {
    console.log("[LLM] Gemini gak tersedia (key kosong / kuota harian habis) -- langsung ke Groq.");
  }

  const result = await callGroqFallback(messages, {
    temperature,
    maxTokens,
    timeoutMs,
    hasImage,
  });
  console.log("[LLM] Dijawab oleh Groq (fallback).");
  return result;
}

// Versi yang sekalian ngantri -- dipakai pemanggil yang TIDAK punya
// pembungkus queue sendiri (mis. summarizer).
function askLLMQueued(messages, options = {}) {
  return enqueueLlmRequest(() => askLLM(messages, options));
}

module.exports = {
  askLLM,
  askLLMQueued,
};
