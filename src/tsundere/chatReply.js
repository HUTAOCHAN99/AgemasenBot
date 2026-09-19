const { GROQ_API_KEYS, GROQ_TEMPERATURE, GROQ_REQUEST_DELAY_MS, sleep } = require("./groqClient");
const { GEMINI_API_KEYS } = require("./geminiClient");
const { enqueueLlmRequest } = require("./llmQueue");
const { askLLM } = require("./llmRouter");
const { GROQ_MAX_CONTINUATIONS, GROQ_CONTINUE_PROMPT, splitReplyIntoChunks } = require("./replyFormat");
const { TSUNDERE_SYSTEM_PROMPT } = require("./persona");
const { getActiveDocumentContext, DOC_CONTEXT_FOR_CHAT_MAX_CHARS } = require("./documentContext");
const { scheduleSaveHistory, GROQ_CHAT_HISTORY_LIMIT } = require("./chatSession");

// Maksimal sumber grounding yang ditampilkan di akhir jawaban. Gemini
// kadang balikin belasan sumber buat satu pertanyaan -- kalau ditampilin
// semua, bubble WhatsApp-nya jadi kepanjangan dan malah nutupin
// jawabannya sendiri.
const MAX_SOURCES_SHOWN = Number(process.env.MAX_SOURCES_SHOWN) || 3;

async function askGroqTsundere(chat, userText, senderName, imageDataUri) {
  if (GEMINI_API_KEYS.length === 0 && GROQ_API_KEYS.length === 0) {
    throw new Error(
      "Belum ada API key sama sekali -- set GEMINI_API_KEY (utama) dan/atau GROQ_API_KEY (cadangan).",
    );
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
  return enqueueLlmRequest(async () => {
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

    // Model, batas token, dan timeout SEKARANG ditentukan router per
    // provider (Gemini punya angkanya sendiri, Groq punya sendiri) -- di
    // sini cukup kasih tahu "giliran ini ada gambarnya atau enggak".
    const hasImage = Boolean(imageDataUri);

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

    // Panggil LLM SEKALI lewat router (Gemini dulu, Groq kalau Gemini
    // gagal). Dipakai berulang di loop auto-continue di bawah.
    //
    // Panggil askLLM LANGSUNG, bukan askLLMQueued -- kita sudah ada DI
    // DALAM slot eksekusi antrian (lihat komentar besar di awal fungsi
    // ini); nge-enqueue lagi di sini bakal deadlock.
    async function callOnce(msgs) {
      const { content, finishReason, sources, provider } = await askLLM(msgs, {
        temperature: GROQ_TEMPERATURE,
        hasImage,
        // Matikan Gemini "thinking" khusus buat obrolan tsundere ini,
        // TERLEPAS dari nilai GEMINI_THINKING_BUDGET di env (dipakai lagi
        // oleh !ringkas di summarizer.js kalau env-nya diisi bukan 0).
        // Alasan: persona ini didesain buat balasan pendek & cepat (2-5
        // kalimat), bukan reasoning berlapis -- thinking cuma numpang
        // makan jatah GEMINI_MAX_TOKENS yang sama dengan jawaban, bikin
        // jawaban gampang kepotong (finishReason "length") dan kepicu
        // auto-continue padahal gak perlu.
        thinkingBudget: 0,
      });
      return { content, finishReason, sources, provider };
    }

    // Loop auto-continue: kalau finish_reason "length" (kepotong kehabisan
    // token), minta Groq nerusin persis dari kata terakhir, digabung jadi
    // satu jawaban utuh. Riwayat sesi (chat.history) TIDAK ikut dicemari
    // pesan "lanjutin dong" ini -- itu cuma dipakai lokal di loop ini, yang
    // disimpan ke history nanti cuma hasil gabungannya yang sudah utuh.
    //
    // Antar-panggilan continue ini dikasih jeda GROQ_REQUEST_DELAY_MS
    // manual (karena udah gak lewat enqueueGroqRequest) -- biar tetap
    // sopan ke rate-limit provider walau beberapa continue kepakai buat 1
    // giliran jawaban yang sama.
    let workingMessages = messages;
    const first = await callOnce(workingMessages);
    let reply = first.content;
    let finishReason = first.finishReason;
    // Sumber dari Search Grounding cuma diambil dari panggilan PERTAMA --
    // panggilan lanjutan (auto-continue) cuma nyambungin kalimat, gak
    // nyari ulang, jadi sumbernya sama saja.
    const sources = first.sources || [];
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

    // Tempelkan sumber (kalau grounding nemu) sebagai baris terpisah di
    // akhir. Ditaruh SETELAH loop auto-continue supaya gak kesisipan di
    // tengah jawaban yang kepotong, dan dipisah paragraf sendiri supaya
    // splitReplyIntoChunks ngirimnya jadi bubble terakhir tersendiri.
    if (sources.length > 0) {
      const list = sources
        .slice(0, MAX_SOURCES_SHOWN)
        .map((s, i) => `${i + 1}. ${s.title}`)
        .join("\n");
      reply += `\n\n_Sumber:_\n${list}`;
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