const path = require("path");

// =====================================================
// Owner & saklar aktif/nonaktif bot PER GRUP
//
// - OWNER_NUMBER: nomor WA owner (format: kode negara + nomor, TANPA "+"
//   dan TANPA spasi/strip. Contoh Indonesia: "6281234567890"). Wajib diisi
//   lewat env var OWNER_NUMBER (lihat README/.env) supaya nomor pribadi
//   gak ke-commit ke git. Kalau env var-nya kosong, fitur owner otomatis
//   nonaktif semua (gak ada yang dianggap owner) -- aman by default.
// - Cuma owner yang boleh pakai "!bot on" / "!bot off" / "!bot status".
//   Saklar ini di-scope PER GRUP (per jid grup), jadi grup A bisa aktif
//   sementara grup B nonaktif, gak saling ganggu.
// - Kalau grup lagi dinonaktifin, bot TETAP baca semua pesan yang masuk
//   (biar owner tetap bisa "!bot on" buat nyalain lagi), tapi buat
//   siapa pun SELAIN owner yang ketik command ("!..."), bot cuma bales
//   sekali "ngambek" (nge-tag owner) terus behenti -- gak ada command lain
//   yang diproses. Owner sendiri TIDAK kena blokir ini sama sekali.
// - State-nya ditulis ke file JSON (data/bot_state.json) supaya gak reset
//   ke default tiap kali bot restart/redeploy. Override lokasinya lewat
//   env var BOT_STATE_FILE kalau perlu (sama pola kayak GROQ_HISTORY_FILE
//   di agemasenTsundere.js).
// =====================================================
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "").replace(/\D/g, "");
const OWNER_JID = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;

const ROOT_DIR = path.join(__dirname, "..", "..");

const BOT_STATE_DATA_DIR = path.join(ROOT_DIR, "data");
const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(BOT_STATE_DATA_DIR, "bot_state.json");

module.exports = {
  ROOT_DIR,
  OWNER_NUMBER,
  OWNER_JID,
  BOT_STATE_DATA_DIR,
  BOT_STATE_FILE,
};
