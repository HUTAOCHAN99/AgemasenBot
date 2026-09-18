// =====================================================
// Queue GLOBAL buat SEMUA request LLM (Gemini maupun Groq).
//
// Dulu queue ini tinggal di groqClient.js dan namanya enqueueGroqRequest.
// Sekarang providernya ada dua, tapi queue-nya SENGAJA tetap SATU dan
// concurrency-nya tetap 1. Alasannya bukan soal rate limit doang:
//
//   chatReply.js membungkus seluruh siklus "baca chat.history -> panggil
//   LLM -> tulis balik chat.history" jadi SATU job di queue ini. Jaminan
//   anti-race untuk history itu cuma valid kalau semua job antri di queue
//   YANG SAMA. Kalau Gemini dan Groq punya queue sendiri-sendiri, dua
//   pesan dari user yang sama bisa jalan barengan (satu ke Gemini, satu
//   ke Groq pas Gemini lagi error) dan history-nya balapan lagi.
//
// Jadi: satu queue, satu jalur, urutan FIFO dijamin lintas-provider.
// =====================================================

// Jeda minimum setelah sebuah request SELESAI sebelum request berikutnya
// dikirim. Nama env var-nya sengaja dipertahankan (GROQ_REQUEST_DELAY)
// supaya setup lama yang sudah nge-set itu gak perlu diubah, tapi sekarang
// berlaku buat kedua provider. LLM_REQUEST_DELAY dicek duluan kalau kamu
// mau pakai nama yang lebih netral.
const LLM_REQUEST_DELAY_MS =
  Number(process.env.LLM_REQUEST_DELAY) ||
  Number(process.env.GROQ_REQUEST_DELAY) ||
  2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const llmQueue = [];
let llmQueueRunning = false;
let llmLastRequestEndedAt = 0;

function enqueueLlmRequest(taskFn) {
  return new Promise((resolve, reject) => {
    llmQueue.push({ taskFn, resolve, reject });
    console.log(`[LLM] Queue: ${llmQueue.length} pending`);
    processLlmQueue();
  });
}

async function processLlmQueue() {
  if (llmQueueRunning) return;
  llmQueueRunning = true;

  while (llmQueue.length > 0) {
    // Jaga jeda sejak request SEBELUMNYA selesai (bukan cuma delay tetap
    // antar-item queue) -- supaya tetap kehormat walau queue sempat kosong
    // lalu keisi lagi.
    const waitNeeded = LLM_REQUEST_DELAY_MS - (Date.now() - llmLastRequestEndedAt);
    if (llmLastRequestEndedAt > 0 && waitNeeded > 0) {
      console.log(`[LLM] Waiting ${waitNeeded}ms before next request`);
      await sleep(waitNeeded);
    }

    const { taskFn, resolve, reject } = llmQueue.shift();
    try {
      const result = await taskFn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      llmLastRequestEndedAt = Date.now();
    }
  }

  llmQueueRunning = false;
}

module.exports = {
  LLM_REQUEST_DELAY_MS,
  sleep,
  enqueueLlmRequest,
};
