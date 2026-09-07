console.log("Program dimulai");

// PENTING: daftarkan folder ffmpeg-static ke system PATH SEBELUM apa pun
// yang butuh spawn("ffmpeg") dijalankan (termasuk Baileys sendiri).
//
// Project ini punya "ffmpeg-static" sebagai dependency, tapi npm package
// itu CUMA ngasih path ke binary-nya (dipakai manual di ytdlp.js lewat
// --ffmpeg-location) -- binary itu TIDAK otomatis masuk ke PATH sistem.
//
// Baileys (@whiskeysockets/baileys) internally manggil "ffmpeg" biasa
// (asumsi ada di PATH) buat generate THUMBNAIL & DURASI video pas kirim
// video message. Kalau ffmpeg beneran gak ketemu di PATH, Baileys gagal
// generate metadata itu secara DIAM-DIAM (gak throw error yang keliatan
// di log bot) -- hasilnya video terkirim TANPA metadata durasi/thumbnail
// yang benar, dan WhatsApp app di HP penerima nolak muter videonya sama
// sekali dengan pesan generic "something is wrong with the video file",
// walau file mp4-nya sendiri sehat kalau dibuka di VLC/media player lain.
//
// Nambahin folder ffmpeg-static ke PATH di sini bikin "ffmpeg" langsung
// ketemu buat SEMUA proses child (termasuk yang dipanggil internal sama
// Baileys), tanpa perlu install ffmpeg terpisah ke sistem/Railway.
try {
  const path = require("path");
  const ffmpegStaticPath = require("ffmpeg-static");
  const ffmpegDir = path.dirname(ffmpegStaticPath);
  const sep = process.platform === "win32" ? ";" : ":";
  if (!process.env.PATH.split(sep).includes(ffmpegDir)) {
    process.env.PATH = `${ffmpegDir}${sep}${process.env.PATH}`;
    console.log(`[ffmpeg] Folder ffmpeg-static ditambahkan ke PATH: ${ffmpegDir}`);
  }
} catch (err) {
  console.error(
    "[ffmpeg] Gagal daftarin ffmpeg-static ke PATH -- video mungkin gagal generate thumbnail/durasi di WhatsApp.",
    err,
  );
}

// Semua logic bot sudah dipecah ke src/ (lihat README/CONTRIBUTING kalau ada,
// atau tinggal susuri src/bot/router.js sebagai peta utama command apa
// ada di file mana):
//
//   src/config/            -> konstanta dari env var (owner, path state)
//   src/state/              -> state persisten (on/off bot per grup)
//   src/utils/              -> helper kecil lintas fitur (jid, session key)
//   src/features/owner/     -> !whoami, !bot on/off/status, !listgrup
//   src/features/booru/     -> !img/!next/!id (Safebooru) + session store
//   src/features/pinterest/ -> !pin (pencarian Pinterest)
//   src/features/menu/      -> !menu & teks bantuan per command
//   src/features/meme/      -> !meme/!smeme (emoji, render teks, sticker)
//   src/features/media/     -> deteksi & konversi media (ffmpeg, sticker)
//   src/features/download/  -> !dl/!dlr (yt-dlp & gallery-dl)
//   src/features/upscale/   -> !hd (Real-ESRGAN / fallback sharp)
//   src/commands/artikel.js -> !artikel (provider registry, lihat src/providers)
//   agemasenTsundere.js     -> chat AI tsundere (Groq) + !ringkas/!lupain
//   src/bot/router.js       -> dispatcher semua command (messages.upsert)
//   src/bot/connection.js   -> koneksi Baileys + auto-reconnect
const { startBot } = require("./src/bot/connection");

startBot();
