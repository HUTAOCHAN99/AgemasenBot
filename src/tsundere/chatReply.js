const {
  GROQ_API_KEYS,
  GROQ_MODEL,
  GROQ_VISION_MODEL,
  GROQ_TIMEOUT_MS,
  GROQ_VISION_TIMEOUT_MS,
  GROQ_MAX_TOKENS,
  GROQ_VISION_MAX_TOKENS,
  GROQ_TEMPERATURE,
  enqueueGroqRequest,
  callGroqWithRetry,
} = require("./groqClient");
const { GROQ_MAX_CONTINUATIONS, GROQ_CONTINUE_PROMPT, splitReplyIntoChunks } = require("./replyFormat");
const { TSUNDERE_SYSTEM_PROMPT } = require("./persona");
const { getActiveDocumentContext, DOC_CONTEXT_FOR_CHAT_MAX_CHARS } = require("./documentContext");
const { scheduleSaveHistory } = require("./chatSession");

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

module.exports = {
  askGroqTsundere,
};
