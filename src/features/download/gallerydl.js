const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const {
  GALLERYDL_PATH,
  GALLERYDL_COOKIES_FILE,
  GALLERYDL_INSTAGRAM_USERNAME,
  GALLERYDL_INSTAGRAM_PASSWORD,
  enqueueDownloadJob,
  isYoutubeUrl,
  downloadMediaFromUrl,
  isRateLimitOrBotDetectionError,
  registerYtdlpSuccess,
  registerYtdlpRateLimitFailure,
  getYtdlpBackoffRemainingMs,
  formatDurationId,
  friendlyDlError,
} = require("./ytdlp");

// =====================================================
// Fitur: download foto/carousel/slideshow ("!dl" fallback foto & "!dlr")
// -- Agustus 2026, migrasi dari yt-dlp ke gallery-dl
// -----------------------------------------------------
// PENTING (kenapa BUKAN pakai yt-dlp lagi): sempat dicoba pakai yt-dlp
// dulu (--yes-playlist dst), TAPI ternyata itu bukan cuma soal argumen
// yang kurang tepat -- yt-dlp memang gak reliable buat narik foto
// carousel Instagram. ini KONFIRMASI dari laporan resmi di GitHub
// yt-dlp (issue #12439, "Cannot retrieve Instagram post data ... Cannot
// download images") yang DITUTUP oleh maintainer-nya sebagai "invalid"
// -- bukan bug yang bakal diperbaiki, karena yt-dlp emang dirancang buat
// video, formatnya maksa nyari "video formats" bahkan buat slide yang
// isinya cuma gambar, makanya error "No video formats found!".
//
// "gallery-dl" (proyek terpisah, TERPISAH dari yt-dlp) didesain khusus
// buat gambar/galeri, dan resmi dukung Instagram (Posts/Reels) & TikTok
// (termasuk mode foto+musik/slideshow, ditambahkan Feb 2025) tanpa
// masalah "no video formats" itu -- makanya jalur foto sekarang pindah
// ke sini, TERPISAH dari runYtDlp/downloadMediaFromUrl yang tetap pakai
// yt-dlp buat video/audio biasa.
//
// Beda dari jalur video: pakai folder tujuan UNIK per job (lewat "-D",
// override total struktur folder bawaan gallery-dl per situs/user) biar
// gampang baca balik semua file hasil download tanpa perlu tebak-tebak
// nama file. Foto & musik latar (kalau ada, khusus TikTok slideshow)
// ke-download dalam SATU proses gallery-dl yang sama -- gak perlu 2 kali
// panggil kayak versi yt-dlp dulu.
// =====================================================
function runGalleryDl(args) {
  return new Promise((resolve, reject) => {
    let proc;

    try {
      proc = spawn(GALLERYDL_PATH, args);
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `gallery-dl tidak ditemukan di server. Install dulu ` +
              `(\`pip install -U gallery-dl\`) lalu pastikan ada di PATH, ` +
              `atau set env var GALLERYDL_PATH ke lokasi binary-nya.`,
          ),
        );
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error("[gallery-dl] gagal, stderr mentah:\n" + stderr);
        const err = new Error(
          `gallery-dl keluar dengan kode ${code}\n${stderr.slice(-800)}`,
        );
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function downloadGalleryFromUrl(url) {
  const uid = crypto.randomBytes(6).toString("hex");
  const jobDir = path.join(os.tmpdir(), `dlgallery-${uid}`);
  fs.mkdirSync(jobDir, { recursive: true });

  const args = [
    "-D",
    jobDir, // simpan SEMUA file langsung di folder ini, gak usah nested per situs/user
    "--no-mtime",
  ];

  // Kalau cookies Instagram udah disiapin (lihat komentar panjang di
  // GALLERYDL_COOKIES_FILE), pakai buat semua request -- ini yang
  // nyelesein error "HTTP redirect to login page" khusus Instagram.
  // TikTok gak butuh ini, tapi gak masalah dikasih bareng karena
  // gallery-dl cuma make cookies yang cocok domain-nya per situs.
  //
  // Cookies file diprioritaskan di atas username/password kalau DUA-
  // duanya keisi -- lebih stabil karena gak nge-trigger login script
  // baru tiap kali dipanggil (lihat komentar GALLERYDL_INSTAGRAM_USERNAME
  // soal kenapa itu lebih rawan checkpoint).
  if (GALLERYDL_COOKIES_FILE) {
    args.push("--cookies", GALLERYDL_COOKIES_FILE);
  } else if (GALLERYDL_INSTAGRAM_USERNAME && GALLERYDL_INSTAGRAM_PASSWORD) {
    args.push(
      "--username",
      GALLERYDL_INSTAGRAM_USERNAME,
      "--password",
      GALLERYDL_INSTAGRAM_PASSWORD,
    );
  }

  args.push(url);

  try {
    await runGalleryDl(args);

    const allFiles = fs.readdirSync(jobDir).sort();
    const imageExtRe = /\.(jpe?g|png|webp|heic|heif)$/i;
    const audioExtRe = /\.(mp3|m4a|aac|ogg)$/i;

    const imageFiles = allFiles.filter((f) => imageExtRe.test(f));
    const audioFiles = allFiles.filter((f) => audioExtRe.test(f));

    if (imageFiles.length === 0) {
      throw new Error("Tidak ada foto yang bisa diunduh dari link ini.");
    }

    const imageBuffers = imageFiles.map((f) =>
      fs.readFileSync(path.join(jobDir, f)),
    );

    let audioBuffer = null;
    let audioExt = null;
    if (audioFiles.length > 0) {
      audioExt = path.extname(audioFiles[0]).slice(1).toLowerCase();
      audioBuffer = fs.readFileSync(path.join(jobDir, audioFiles[0]));
    }

    return { imageBuffers, audioBuffer, audioExt };
  } finally {
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
  }
}

// Inti kirim galeri foto + musik latar (kalau ada) -- dipakai BARENG oleh
// 2 pemanggil: tryHandleAsPhotoPost (fallback otomatis dari "!dl") dan
// handleDlrDownload ("!dlr", command khusus foto/carousel). Return true
// kalau berhasil kirim minimal 1 foto, false kalau ternyata gak ada foto
// yang bisa diambil dari link ini sama sekali.
async function sendPhotoGallery(sock, jid, url) {
  let imageBuffers, audioBuffer, audioExt;
  try {
    const result = await enqueueDownloadJob(() =>
      downloadGalleryFromUrl(url),
    );
    imageBuffers = result.imageBuffers;
    audioBuffer = result.audioBuffer;
    audioExt = result.audioExt;
  } catch (err) {
    console.log("[dl][foto] Gagal download foto:", err.message || err);
    return false;
  }

  for (let i = 0; i < imageBuffers.length; i++) {
    await sock.sendMessage(jid, {
      image: imageBuffers[i],
      caption:
        i === 0
          ? `✅ Berhasil didownload (${imageBuffers.length} foto).\n🔗 ${url}`
          : undefined,
    });
  }

  // Musik latar (kalau ada -- khusus TikTok slideshow) dikirim TERAKHIR,
  // setelah semua foto -- biar urutan pesan di chat rapi.
  if (audioBuffer) {
    const mimetypeByExt = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
    };
    await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: mimetypeByExt[audioExt] || "audio/mp4",
      fileName: `musik.${audioExt || "mp3"}`,
    });
  }

  return true;
}

// Dipanggil dari catch block handleDlDownload sebagai fallback OTOMATIS
// kalau "!dl" biasa ternyata kena link foto/carousel. Return true kalau
// berhasil kirim minimal 1 foto (artinya user SUDAH dapet respons,
// pemanggil gak perlu nampilin pesan error generik lagi) -- return false
// kalau ternyata bukan postingan foto juga, biar pemanggil lanjut ke
// pesan error biasa.
async function tryHandleAsPhotoPost(sock, jid, url) {
  await sock.sendMessage(jid, {
    text: "🖼️ Sepertinya ini postingan foto, bukan video. Coba download fotonya...",
  });

  return sendPhotoGallery(sock, jid, url);
}

// "!dlr <link>" -- command KHUSUS foto/carousel/slideshow, langsung ambil
// jalur foto tanpa nyoba jalur video dulu (beda dari "!dl" yang nyoba
// video dulu baru fallback ke foto kalau gagal). Berguna kalau user sudah
// tau link-nya carousel/slideshow, biar gak buang waktu nunggu percobaan
// video yang pasti gagal duluan.
async function handleDlrDownload(sock, jid, url) {
  try {
    await sock.sendMessage(jid, {
      text: "⏳ Download foto/carousel, tunggu ya...",
    });

    const sent = await sendPhotoGallery(sock, jid, url);

    if (!sent) {
      await sock.sendMessage(jid, {
        text:
          "❌ Gagal download foto.\n\n" +
          "Gak ada foto yang bisa diambil dari link ini -- pastikan ini " +
          "beneran link carousel/slideshow foto (kalau ini video, pakai " +
          "!dl saja).",
      });
    }
  } catch (err) {
    console.log("=== [dlr] gagal ===");
    console.log(err.message || err);
    console.log("===================");
    await sock.sendMessage(jid, {
      text: "❌ Gagal download foto.\n\nSilakan coba lagi atau cek link-nya.",
    });
  }
}

async function handleDlDownload(sock, jid, url, mode) {
  // Cek backoff DULUAN, sebelum buang-buang 1 percobaan yt-dlp lagi kalau
  // memang lagi kena rate-limit. Cuma berlaku buat YouTube -- situs lain
  // (TikTok, Bilibili, dst) gak ikut kena backoff ini karena rate-limit-nya
  // spesifik per-platform, gak nyambung ke YouTube.
  if (isYoutubeUrl(url)) {
    const remainingMs = getYtdlpBackoffRemainingMs();
    if (remainingMs > 0) {
      await sock.sendMessage(jid, {
        text:
          `⏳ Lagi kena rate-limit YouTube (server ini kebanyakan request beberapa saat lalu). ` +
          `Coba lagi dalam ~${formatDurationId(remainingMs)}, bot bakal otomatis nyoba lagi setelah itu -- ` +
          `gak perlu diapa-apain, tinggal kirim !dl lagi nanti.`,
      });
      return;
    }
  }

  try {
    await sock.sendMessage(jid, {
      text:
        mode === "audio"
          ? "⏳ Download audio (MP3), tunggu ya..."
          : "⏳ Download video, tunggu ya...",
    });

    // masuk QUEUE, biar gak numpuk proses yt-dlp jalan bersamaan kalau
    // lagi banyak yang minta download sekaligus.
    const { buffer } = await enqueueDownloadJob(() =>
      downloadMediaFromUrl(url, mode),
    );

    if (isYoutubeUrl(url)) registerYtdlpSuccess();
    await sendDownloadedMedia(sock, jid, buffer, mode, url, false);
  } catch (err) {
    if (isYoutubeUrl(url) && isRateLimitOrBotDetectionError(err.stderr)) {
      registerYtdlpRateLimitFailure();
    }

    // Kemungkinan postingan foto (carousel Instagram / slideshow foto+musik
    // TikTok) -- yt-dlp jalan sukses tapi emang gak ada video/audio buat
    // di-download lewat jalur biasa. Coba jalur foto dulu sebelum nyerah.
    if (err.possiblyPhotoOnly) {
      const handled = await tryHandleAsPhotoPost(sock, jid, url);
      if (handled) return;
    }

    console.log("=== [dl] yt-dlp gagal ===");
    console.log("message:", err.message);
    if (err.stderr) {
      // Ini yang paling penting buat debug di Railway logs -- pesan asli
      // dari yt-dlp sebelum "dihaluskan" friendlyDlError(). Kalau user
      // lapor error tapi kamu bingung penyebab aslinya apa, cek baris ini.
      console.log("raw stderr:\n" + err.stderr);
    }
    console.log("=========================");
    await sock.sendMessage(jid, {
      text: `❌ Gagal download.\n${friendlyDlError(err)}`,
    });
  }
}

async function sendDownloadedMedia(sock, jid, buffer, mode, url, fromCache) {
  if (mode === "audio") {
    await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: "audio/mpeg",
      fileName: "audio.mp3",
    });
  } else {
    await sock.sendMessage(jid, {
      video: buffer,
      mimetype: "video/mp4",
      caption: fromCache
        ? `✅ Berhasil didownload (dari cache).\n🔗 ${url}`
        : `✅ Berhasil didownload.\n🔗 ${url}`,
    });
  }
}


module.exports = {
  runGalleryDl,
  downloadGalleryFromUrl,
  sendPhotoGallery,
  tryHandleAsPhotoPost,
  handleDlrDownload,
  handleDlDownload,
  sendDownloadedMedia,
};
