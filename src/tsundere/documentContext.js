const { getGroqChat, scheduleSaveHistory } = require("./chatSession");

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


module.exports = {
  DOC_CONTEXT_TTL_MS,
  DOC_CONTEXT_FOR_CHAT_MAX_CHARS,
  saveDocumentContext,
  getActiveDocumentContext,
};
