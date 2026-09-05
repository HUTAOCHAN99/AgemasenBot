console.log("Program dimulai");

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
