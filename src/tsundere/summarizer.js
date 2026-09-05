const { GROQ_API_KEYS, GROQ_MODEL, enqueueGroqRequest, callGroqWithRetry } = require("./groqClient");
const { splitReplyIntoChunks } = require("./replyFormat");

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

module.exports = {
  GROQ_SUMMARY_MAX_TOKENS,
  GROQ_SUMMARY_TIMEOUT_MS,
  SUMMARY_SINGLE_PASS_MAX_CHARS,
  SUMMARY_CHUNK_CHARS,
  SUMMARY_CHUNK_MAX_TOKENS,
  SUMMARY_CHUNK_TIMEOUT_MS,
  DOC_HARD_MAX_CHARS,
  splitTextIntoChunks,
  extractChunkPoints,
  summarizeDocumentText,
};
