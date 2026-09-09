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

// =====================================================
// Monitoring & saklar aktif/nonaktif bot PER NOMOR (DM pribadi)
//
// - Setiap orang yang pernah DM bot ini bakal otomatis kecatet
//   (nomor, jumlah pesan, terakhir kontak) di file JSON ini.
// - Owner bisa lihat daftarnya lewat "!listuser", dan bisa
//   block/unblock nomor tertentu lewat "!user on/off/status <nomor>"
//   dari MANA PUN (DM lain, grup owner, dll) -- gak perlu ngetik
//   langsung dari nomor WA yang jadi bot.
// - State-nya kepisah dari bot_state.json (yang itu buat grup),
//   supaya on/off grup dan on/off per-nomor gak nyampur.
// =====================================================
const USER_STATE_FILE =
  process.env.USER_STATE_FILE ||
  path.join(BOT_STATE_DATA_DIR, "user_state.json");

module.exports = {
  ROOT_DIR,
  OWNER_NUMBER,
  OWNER_JID,
  BOT_STATE_DATA_DIR,
  BOT_STATE_FILE,
  USER_STATE_FILE,
};
