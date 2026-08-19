// test-youtube-dl.js
//
// Script standalone buat NGETES fitur download YouTube dari BotWA-main
// TANPA perlu jalanin bot penuh / scan QR WhatsApp.
//
// Cara pakai:
//   1. Copy file ini ke dalam folder BotWA-main (biar bisa akses
//      node_modules yang sama, khususnya "ffmpeg-static").
//   2. Pastikan "yt-dlp" sudah terinstall & ada di PATH:
//        pip install -U yt-dlp
//   3. Jalankan:
//        node test-youtube-dl.js "https://youtu.be/LINK_VIDEO" video
//        node test-youtube-dl.js "https://youtu.be/LINK_VIDEO" audio
//
// Ini pakai args & logic yang SAMA PERSIS kayak fungsi
// downloadMediaFromUrl() di index.js, jadi hasilnya representatif buat
// nebak apakah fitur !dl di bot bakal berhasil atau nggak.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";
const DL_MAX_FILESIZE = "95M";
const YTDLP_POT_BASE_URL = process.env.YTDLP_POT_BASE_URL || "";

const url = process.argv[2];
const mode = process.argv[3] === "audio" ? "audio" : "video";

if (!url) {
  console.error("Pakai: node test-youtube-dl.js <url-youtube> [video|audio]");
  process.exit(1);
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    console.log("\n>> Menjalankan: yt-dlp", args.join(" "), "\n");
    const proc = spawn(YTDLP_PATH, args, { stdio: "inherit" });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("yt-dlp tidak ditemukan. Install dulu: pip install -U yt-dlp"));
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp keluar dengan kode ${code}`));
    });
  });
}

async function main() {
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const outputTemplate = path.join(tmpDir, `dl-test-${uid}.%(ext)s`);

  const commonArgs = [
    "--no-playlist",
    "--no-warnings",
    "--ffmpeg-location",
    path.dirname(ffmpegPath),
    "--max-filesize",
    DL_MAX_FILESIZE,
    "--sleep-requests",
    "1",
    "--js-runtimes",
    "deno",
    "--remote-components",
    "ejs:github",
    "-o",
    outputTemplate,
  ];

  if (YTDLP_POT_BASE_URL) {
    commonArgs.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${YTDLP_POT_BASE_URL}`);
  }

  const args =
    mode === "audio"
      ? [...commonArgs, "-x", "--audio-format", "mp3", "--audio-quality", "5", url]
      : [
          ...commonArgs,
          "-f",
          "bestvideo[vcodec^=avc1][filesize<95M]+bestaudio[acodec^=mp4a][filesize<95M]/best[vcodec^=avc1][filesize<95M]/best[filesize<95M]/best",
          "--merge-output-format",
          "mp4",
          url,
        ];

  try {
    await runYtDlp(args);
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`dl-test-${uid}`));
    if (files.length === 0) {
      console.error("\n❌ yt-dlp selesai tapi file hasil tidak ditemukan.");
      process.exit(1);
    }
    const outPath = path.join(tmpDir, files[0]);
    const size = fs.statSync(outPath).size;
    console.log(`\n✅ BERHASIL. File: ${outPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    console.log("Hapus manual file ini setelah selesai cek, ya (ada di tmp folder OS).");
  } catch (err) {
    console.error("\n❌ GAGAL:", err.message);
    process.exit(1);
  }
}

main();
