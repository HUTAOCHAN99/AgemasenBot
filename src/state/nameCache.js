// =====================================================
// Cache in-memory: jid -> pushName TERAKHIR yang diketahui.
//
// Kenapa ini perlu (khusus buat !schat): kalau user nge-tag/reply orang
// lain pakai fitur @mention WhatsApp, TEKS PESAN yang beneran dikirim ke
// bot itu isinya "@<angka ID>" mentah (mis. "@262796902162504") -- WhatsApp
// TIDAK PERNAH nyisipin nama kontak asli ke isi teks, nama itu cuma
// ditampilin di sisi UI klien resmi lewat kontak masing-masing orang.
// Baileys juga gak nyediain API buat "cari nama orang dari jid-nya"
// begitu aja.
//
// Solusinya: tiap kali ADA pesan masuk (dari siapa pun, grup atau
// pribadi), kita "nyolong dengar" pushName pengirimnya (field ini SELALU
// ada tiap pesan WA masuk -- itu nama profil WA si pengirim) dan disimpan
// di sini. Jadi kalau nanti ada yang nge-tag orang itu di !schat, asal
// orang yang di-tag PERNAH kelihatan ngirim pesan sebelumnya, kita punya
// nama aslinya buat dipakai gantiin angka ID mentah.
//
// Disimpan di beberapa bentuk jid sekaligus (lihat rememberNamesFromMsg di
// router.js) karena satu orang bisa muncul dalam 2 bentuk jid berbeda
// (nomor asli vs "@lid" / Linked ID tersembunyi) tergantung privasi WA-nya
// -- lihat komentar panjang soal ini di utils/whatsapp.js.
//
// Cuma di memory (reset kalau bot restart) -- sama seperti state lain di
// folder ini (botState.js, userState.js). Gak masalah, ini cuma fitur
// kosmetik (nama di stiker), bukan sesuatu yang kritikal buat disimpan
// permanen.
// =====================================================

const nameCache = new Map();

function rememberName(jid, pushName) {
  if (!jid || !pushName) return;
  const trimmed = String(pushName).trim();
  if (!trimmed) return;
  nameCache.set(jid, trimmed);
}

function getCachedName(jid) {
  if (!jid) return null;
  return nameCache.get(jid) || null;
}

module.exports = { rememberName, getCachedName };
