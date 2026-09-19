// =====================================================
// Koneksi database (opsional) buat riwayat chat tsundere.
//
// KENAPA INI OPSIONAL:
// Bot ini dari awal udah bisa nyimpen riwayat ke file JSON lokal
// (data/tsundere_history.json, lihat chatSession.js). Itu tetap jalan
// dan tetap jadi FALLBACK kalau env var DATABASE_URL kosong -- jadi
// project ini tetap bisa dipakai tanpa setup database sama sekali
// (misal buat coba-coba lokal).
//
// TAPI kalau di-deploy ke platform kayak Railway TANPA Volume yang
// di-mount permanen, filesystem-nya EPHEMERAL -- artinya file JSON tadi
// bisa RESET tiap kali ada redeploy/restart container baru. Riwayat
// obrolan tsundere & "ingatan" dokumen !ringkas jadi ilang mendadak.
//
// Solusinya: simpan ke database eksternal (Postgres) yang hidupnya
// TERPISAH dari container bot. Dua opsi paling gampang:
//   1. Supabase (gratis, punya dashboard web) -- ambil connection
//      string dari Project Settings > Database > Connection string
//      (pakai mode "Session" atau "Transaction pooler", BUKAN yang
//      "Direct connection" kalau IPv6 host-mu gak didukung Railway).
//   2. Railway Postgres plugin -- tinggal "+ New" > "Database" >
//      "PostgreSQL" di project Railway-mu, nanti otomatis kesedia
//      variable `DATABASE_URL` yang bisa langsung di-reference ke
//      service bot-nya (Railway biasanya expose sebagai
//      `${{Postgres.DATABASE_URL}}`).
//
// Keduanya sama-sama Postgres standar, jadi modul ini gak perlu tau
// yang mana yang dipakai -- cukup satu env var `DATABASE_URL`.
// =====================================================

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";

let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Supabase (dan kebanyakan Postgres cloud lain) wajib koneksi SSL,
    // tapi certificate-nya self-signed dari sisi mereka -- kalau
    // rejectUnauthorized dibiarkan default (true), Node bakal nolak
    // koneksinya (error "self signed certificate"). Railway Postgres
    // plugin sendiri juga tetap aman pakai opsi ini walau di jaringan
    // internal-nya sebenarnya gak wajib SSL.
    ssl: { rejectUnauthorized: false },
  });

  // Listener wajib ada -- kalau koneksi idle di pool putus sendiri
  // (mis. provider DB-nya nutup koneksi nganggur), TANPA listener ini
  // Node bakal nganggap itu "unhandled error" dan bisa bikin proses
  // crash walau gak ada query yang lagi jalan.
  pool.on("error", (err) => {
    console.log("[db] error tak terduga di koneksi idle:", err.message);
  });
}

// Dipakai modul lain buat cek "database aktif apa enggak" tanpa perlu
// tau detail Pool-nya.
const DB_ENABLED = Boolean(pool);

// Bikin tabel kalau belum ada -- aman dipanggil berkali-kali tiap start
// (IF NOT EXISTS), jadi gak perlu migration tool terpisah buat project
// sekecil ini.
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tsundere_sessions (
      session_key      TEXT PRIMARY KEY,
      history           JSONB NOT NULL DEFAULT '[]'::jsonb,
      sent_msg_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
      document_context   JSONB,
      last_used          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = {
  pool,
  DB_ENABLED,
  ensureSchema,
};
