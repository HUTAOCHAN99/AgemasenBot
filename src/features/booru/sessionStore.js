const { sweepExpiredTsundereChats } = require("../../../agemasenTsundere");

// =====================================================
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam
const sessions = new Map();

// Tandain session baru saja dipakai/dibuat -- reset hitungan 24 jamnya.
function touchSession(session) {
  session.lastUsed = Date.now();
  return session;
}

// =====================================================
// Kode sesi per-chat (BUKAN per-pengirim)
// Supaya siapa pun di grup yang sama bisa ketik angka kodenya buat lanjut
// (!next) pencarian tertentu -- termasuk pencarian milik orang lain --
// tanpa bentrok dengan pencarian orang lain di grup yang sama.
//
// Objeknya SAMA PERSIS (reference yang sama) dengan yang disimpan di
// `sessions` untuk pemilik aslinya, jadi kalau pool-nya berubah (baik lewat
// "!next" ketik teks oleh pemiliknya, ATAU lewat siapa pun ketik kodenya)
// keduanya otomatis tetap sinkron.
//
// jid -> Map<kode(number), session>
const chatCodeSessions = new Map();
// jid -> kode berikutnya yang akan dipakai
const chatNextCode = new Map();

// Kasih (atau pakai ulang) kode sesi untuk satu hasil pencarian di 1 chat.
// Kode ini SENGAJA di-scope per-chat (bukan global bot), jadi grup A dan
// grup B bisa sama-sama punya "kode 1" tanpa saling ganggu.
function assignSessionCode(jid, session) {
  if (session.code) return session.code; // sesi ini sudah punya kode, pakai lagi

  const next = (chatNextCode.get(jid) || 0) + 1;
  chatNextCode.set(jid, next);
  session.code = next;

  if (!chatCodeSessions.has(jid)) chatCodeSessions.set(jid, new Map());
  chatCodeSessions.get(jid).set(next, session);

  return next;
}

// Buang semua session yang sudah 24 jam TIDAK disentuh (lihat SESSION_TTL_MS
// & touchSession di atas). Dijalanin berkala lewat setInterval (lihat bawah
// startBot), bukan cuma sekali pas start, supaya sesi lama otomatis kebuang
// walau bot jalan berhari-hari tanpa restart.
function sweepExpiredSessions() {
  const now = Date.now();

  // 1. Sesi utama (key = per-pengirim). pendingTagChoices juga ikut kena
  // sweep di sini karena disimpan di Map yang sama.
  for (const [key, session] of sessions) {
    if (now - (session.lastUsed || 0) > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }

  // 2. Kode sesi per-chat. Objeknya reference yang sama dengan di atas,
  // jadi cukup cek `lastUsed` yang sama juga -- kalau sudah expired,
  // buang entry kodenya, dan kalau map kode chat itu jadi kosong, buang
  // sekalian mapnya (chatNextCode dibiarin jalan terus, aman kalau
  // kepakai lagi nanti -- cuma nomor urut kode, bukan data sensitif).
  for (const [jid, codeMap] of chatCodeSessions) {
    for (const [code, session] of codeMap) {
      if (now - (session.lastUsed || 0) > SESSION_TTL_MS) {
        codeMap.delete(code);
      }
    }
    if (codeMap.size === 0) chatCodeSessions.delete(jid);
  }

  // 3. Riwayat chat tsundere (Groq) per pengirim -- logic & Map-nya ada di
  // agemasenTsundere.js, di sini cukup panggil sweep-nya.
  sweepExpiredTsundereChats();
}

// Jalanin sweep tiap 1 jam (bukan cuma sekali pas start). Ditaruh di scope
// modul -- BUKAN di dalam startBot() -- karena startBot() bisa dipanggil
// ulang tiap kali bot reconnect; kalau interval-nya ditaruh di dalam sana,
// tiap reconnect bakal numpuk interval baru (leak). `unref()` dipakai
// supaya interval ini gak nahan proses Node tetap hidup kalau semua kerjaan
// lain sudah selesai (mis. pas dites via `node -e`, bukan lewat startBot).
setInterval(sweepExpiredSessions, 60 * 60 * 1000).unref();

module.exports = {
  SESSION_TTL_MS,
  sessions,
  touchSession,
  chatCodeSessions,
  chatNextCode,
  assignSessionCode,
  sweepExpiredSessions,
};
