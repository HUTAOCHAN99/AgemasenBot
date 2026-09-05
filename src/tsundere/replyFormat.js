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

module.exports = {
  GROQ_MAX_CONTINUATIONS,
  GROQ_CONTINUE_PROMPT,
  MAX_CHUNK_CHARS,
  splitReplyIntoChunks,
};
