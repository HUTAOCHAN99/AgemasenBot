const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// =====================================================
// Fitur: Download media dari link ("!dl")
// YouTube (video/short), Bilibili, Facebook (video/reel/postingan video),
// TikTok, Instagram, Twitter/X, dst -- semua situs yang didukung yt-dlp.
//
// Dukungan YouTube awalnya dibangun dari resep "yt-dlp-rescue" (Maret
// 2026) buat 2 masalah utama: SABR throttle (client "web" default cuma
// kasih 1 format 360p) & deteksi bot di IP cloud/datacenter. TAPI per
// Agustus 2026, sebagian resep itu sudah basi -- lihat komentar detail di
// bagian "Khusus YouTube" di bawah (dalam downloadMediaFromUrl) buat
// histori kenapa override player_client dihapus.
//
// Yang MASIH dipakai sekarang:
//   - --js-runtimes node (Node.js SUDAH terinstall buat project ini
//     sendiri) buat nyelesein signature/n challenge.
//   - --force-ipv4, cegah masalah routing IPv6 di beberapa cloud provider.
//   - Opsional PO Token server (lihat YTDLP_POT_BASE_URL) buat kasus
//     yang masih kena deteksi bot -- SANGAT DIREKOMENDASIKAN buat
//     deployment cloud/server (Railway dst), karena IP datacenter jauh
//     lebih sering diblokir YouTube dibanding IP residensial biasa.
//
// PENTING: ini butuh binary "yt-dlp" TERINSTALL DI SERVER, terpisah dari
// dependency npm project ini (npm wrapper yt-dlp-exec ternyata rapuh --
// postinstall-nya sering gagal ambil binary dari GitHub releases). Cara
// paling gampang & paling stabil: `pip install -U yt-dlp` di server, atau
// download binary standalone-nya dari GitHub releases resmi yt-dlp lalu
// taruh di PATH. Kalau nama/lokasi binary-nya beda, override lewat env
// var YTDLP_PATH (sama seperti pola MEME_FONT_PATH di atas).
//
// ffmpeg TIDAK perlu diinstall terpisah untuk fitur ini -- kita pakai
// ffmpeg-static yang sudah jadi dependency project ini (lewat
// --ffmpeg-location), jadi yt-dlp bisa gabungin stream video+audio atau
// convert ke MP3 tanpa butuh ffmpeg sistem.
// =====================================================
const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";
// Binary "gallery-dl" -- TERPISAH dari yt-dlp, dipakai KHUSUS buat jalur
// foto/carousel/slideshow ("!dl" fallback foto & "!dlr"). yt-dlp TERBUKTI
// gak reliable buat foto Instagram/TikTok (lihat komentar panjang di
// downloadGalleryFromUrl di bawah) -- gallery-dl dirancang khusus buat
// gambar/galeri jadi jauh lebih cocok buat kasus ini.
const GALLERYDL_PATH = process.env.GALLERYDL_PATH || "gallery-dl";

// Cookies buat gallery-dl (khusus Instagram) -- sejak pertengahan 2025,
// Instagram makin agresif maksa login bahkan buat postingan PUBLIK kalau
// request-nya datang tanpa cookies/sesi yang valid. Tanpa ini,
// gallery-dl bakal kena redirect ke halaman login ("HTTP redirect to
// login page") dan gagal total, walau link-nya postingan publik biasa.
//
// Cara siapin:
//   1. Login ke instagram.com di browser BIASA (Chrome/Firefox) pakai
//      akun mana aja (disaranin akun "buangan", BUKAN akun utama --
//      cookies ini dipakai bareng buat SEMUA request bot, jadi kalau
//      akunnya kena flag, semua fitur foto IG ikut kena).
//   2. Export cookies-nya ke format Netscape (cookies.txt) pakai
//      extension browser, mis. "Get cookies.txt LOCALLY" (Chrome) atau
//      "cookies.txt" (Firefox).
//   3. Upload file hasil export itu ke server (mis. taruh di repo project
//      -- TAPI JANGAN commit ke git public, tambahin ke .gitignore --
//      atau upload manual ke Railway lewat volume/shell).
//   4. Set env var ini (di Railway tab Variables) ke path file-nya, mis.
//      GALLERYDL_COOKIES_FILE=/app/instagram-cookies.txt
//
// Opsional -- kalau kosong (default), gallery-dl jalan tanpa cookies
// (bakal gagal khusus buat Instagram, TikTok biasanya masih OK tanpa
// ini). Cookies expire dari waktu ke waktu (biasanya beberapa
// minggu/bulan) -- kalau tiba-tiba mulai gagal lagi dengan pesan yang
// sama, kemungkinan besar cookies-nya sudah kadaluarsa, tinggal ulangi
// langkah export di atas.
const GALLERYDL_COOKIES_FILE = process.env.GALLERYDL_COOKIES_FILE || "";

// Alternatif dari GALLERYDL_COOKIES_FILE di atas -- LEBIH SIMPEL setup-nya
// (gak perlu extension browser & export manual), tapi TRADE-OFF-nya
// password akun IG kesimpen di server (env var) dan gallery-dl login
// sendiri lewat script setiap kali dipanggil -- pola ini lebih gampang
// bikin Instagram curiga & minta verifikasi tambahan ("Suspicious Login
// Attempt" / checkpoint / 2FA) dibanding pakai cookies dari sesi browser
// asli.
//
// WAJIB pakai akun "buangan", BUKAN akun IG utama/pribadi -- akun ini
// dipakai bareng buat SEMUA request bot, jadi paling rawan kena
// flag/suspend duluan kalau bot dipakai banyak orang & sering.
//
// Kalau KEDUANYA (cookies file & username/password) diisi, cookies file
// yang menang (lihat downloadGalleryFromUrl) -- keduanya gak dipakai
// bareng.
//
// Cara pakai: isi 2 env var ini di Railway (tab Variables):
//   GALLERYDL_INSTAGRAM_USERNAME = username akun buangan
//   GALLERYDL_INSTAGRAM_PASSWORD = password akun buangan
//
// Kosongkan (default) buat nonaktifin -- gallery-dl jalan tanpa
// autentikasi Instagram sama sekali (bakal gagal khusus Instagram, lihat
// komentar GALLERYDL_COOKIES_FILE di atas soal kenapa).
const GALLERYDL_INSTAGRAM_USERNAME =
  process.env.GALLERYDL_INSTAGRAM_USERNAME || "";
const GALLERYDL_INSTAGRAM_PASSWORD =
  process.env.GALLERYDL_INSTAGRAM_PASSWORD || "";

// URL base HTTP server "bgutil-ytdlp-pot-provider" (Proof-of-Origin Token
// provider), KALAU mau di-deploy sebagai service terpisah (mis. di
// Railway) buat kasus deteksi bot yang masih lolos walau sudah pakai
// client rotation + --js-runtimes node.
//
// Opsional -- kalau env var ini KOSONG (default), fitur ini gak diaktifin
// dan bot tetap jalan cuma mengandalkan client rotation. Kalau mau aktifin:
//  1. Plugin Python-nya harus terinstall di server yang sama dengan
//     binary yt-dlp: `pip install -U bgutil-ytdlp-pot-provider`
//  2. Service HTTP provider-nya harus jalan terpisah & bisa diakses dari
//     sini, lalu isi env var ini dengan URL-nya (mis. http://127.0.0.1:4416
//     kalau satu container, atau URL publik/private networking Railway
//     kalau service terpisah).
const YTDLP_POT_BASE_URL = process.env.YTDLP_POT_BASE_URL || "";

// Fallback PALING GAMPANG (tapi paling gak scalable) buat kasus deteksi bot
// "Sign in to confirm you're not a bot": --cookies-from-browser, ambil
// cookies YouTube langsung dari browser lokal yang sudah login.
//
// HANYA cocok buat TESTING DI LAPTOP SENDIRI (bukan Railway/cloud server)
// karena:
//   - Butuh browser beneran terinstall & sudah login YouTube di MESIN YANG
//     SAMA tempat yt-dlp jalan -- di container Railway gak ada browser.
//   - Cookies akun pribadi kepakai buat semua request bot -- kalau bot
//     dipakai banyak orang & sering, akun YouTube-nya sendiri yang bisa
//     kena flag/rate-limit, bukan cuma IP server-nya.
//   - Cookies expire & perlu login ulang di browser dari waktu ke waktu.
//
// Isi dengan nama browser yang dipakai: "chrome", "edge", "firefox", dst.
// Opsional -- kosongkan (default) buat nonaktifin.
const YTDLP_COOKIES_FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER || "";

// Batas ukuran file hasil download, biar gak nyoba kirim file raksasa yang
// bakal gagal/lambat banget dikirim lewat WhatsApp.
const DL_MAX_FILESIZE = "95M";

// =====================================================
// QUEUE -- batasin berapa banyak proses yt-dlp yang boleh jalan BERSAMAAN.
// Tanpa ini, kalau 10-20 orang nge-`!dl` bareng, server bisa langsung
// jalanin 10-20 proses yt-dlp sekaligus -> gampang banget kena rate-limit
// (429) atau bikin server kehabisan resource. Dengan queue, cuma
// DL_QUEUE_CONCURRENCY job yang jalan bersamaan, sisanya ngantre giliran.
// =====================================================
const DL_QUEUE_CONCURRENCY = Number(process.env.DL_QUEUE_CONCURRENCY) || 2;
let dlActiveWorkers = 0;
const dlQueue = [];

// =====================================================
// BACKOFF OTOMATIS KHUSUS YOUTUBE -- jawaban buat pertanyaan "gimana cara
// tau kapan boleh coba lagi": daripada nebak-nebak manual atau spam test
// yang malah bikin makin lama redanya, bot ini otomatis "diam" sendiri
// begitu kedeteksi kena rate-limit (429) atau bot-detection (LOGIN_REQUIRED
// / "sign in to confirm"), terus otomatis coba lagi kalau waktunya udah
// lewat -- gak perlu restart bot atau ubah kode manual tiap kali kena.
//
// Cara kerja: exponential backoff. Gagal pertama -> tunggu 15 menit.
// Masih gagal lagi (dalam masa itu ada yang coba lain) -> waktu tunggu
// DIGANDAKAN (30 menit, 60 menit, dst), sampai batas maksimal 4 jam.
// Begitu ada 1 percobaan yang BERHASIL, backoff langsung direset ke 0 --
// jadi gak perlu manual "kasih tau bot udah aman" segala.
// =====================================================
const YTDLP_BACKOFF_INITIAL_MS = 15 * 60 * 1000; // 15 menit
const YTDLP_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000; // 4 jam
let ytdlpBackoffUntil = 0; // timestamp (ms) -- 0 artinya gak lagi backoff
let ytdlpBackoffMs = 0; // durasi backoff TERAKHIR yang dipakai (buat digandain kalau gagal lagi)

function getYtdlpBackoffRemainingMs() {
  return Math.max(0, ytdlpBackoffUntil - Date.now());
}

function formatDurationId(ms) {
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes} menit`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} jam ${minutes} menit` : `${hours} jam`;
}

// Dipanggil tiap kali download YouTube GAGAL karena pola rate-limit/bot-
// detection (lihat pemanggilnya di handleDlDownload). Kalau gagalnya
// karena alasan lain (video private, geo-restricted, dst), JANGAN panggil
// ini -- itu bukan soal IP kena limit, jadi gak perlu ikut nge-backoff.
function registerYtdlpRateLimitFailure() {
  ytdlpBackoffMs = ytdlpBackoffMs
    ? Math.min(ytdlpBackoffMs * 2, YTDLP_BACKOFF_MAX_MS)
    : YTDLP_BACKOFF_INITIAL_MS;
  ytdlpBackoffUntil = Date.now() + ytdlpBackoffMs;
  console.log(
    `[yt-dlp][backoff] Kena rate-limit/bot-detection. Backoff dinaikkan ke ${formatDurationId(ytdlpBackoffMs)}, sampai ${new Date(ytdlpBackoffUntil).toISOString()}`,
  );
}

// Dipanggil tiap kali download YouTube BERHASIL -- reset backoff, karena
// itu bukti IP-nya udah gak lagi kena limit.
function registerYtdlpSuccess() {
  if (ytdlpBackoffMs > 0) {
    console.log("[yt-dlp][backoff] Download berhasil, backoff direset.");
  }
  ytdlpBackoffMs = 0;
  ytdlpBackoffUntil = 0;
}

// Pola stderr yang nandain "ini soal IP/rate-limit", BUKAN soal video-nya
// sendiri (private/geo-restricted/dll -- itu gak ada hubungannya sama
// kondisi IP, jadi gak perlu bikin bot ikut "diam").
function isRateLimitOrBotDetectionError(raw) {
  return /HTTP Error 429|Too Many Requests|sign in to confirm you.?re not a bot|Only images are available|Missing required Visitor Data/i.test(
    raw || "",
  );
}

function processDlQueue() {
  while (dlActiveWorkers < DL_QUEUE_CONCURRENCY && dlQueue.length > 0) {
    const job = dlQueue.shift();
    dlActiveWorkers++;
    job
      .jobFn()
      .then(job.resolve, job.reject)
      .finally(() => {
        dlActiveWorkers--;
        processDlQueue();
      });
  }
}

function enqueueDownloadJob(jobFn) {
  return new Promise((resolve, reject) => {
    dlQueue.push({ jobFn, resolve, reject });
    processDlQueue();
  });
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "yt-dlp tidak ditemukan di server. Install dulu (`pip install -U yt-dlp`) lalu pastikan ada di PATH, atau set env var YTDLP_PATH ke lokasi binary-nya.",
          ),
        );
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        // Log stderr MENTAH ke console (keliatan di Railway Logs) supaya
        // gampang di-debug -- pesan yang dikirim ke WhatsApp sengaja
        // disederhanain (lihat friendlyDlError), jadi tanpa ini kita gak
        // bisa lihat detail teknis aslinya dari luar server.
        console.error("[yt-dlp] gagal, stderr mentah:\n" + stderr);
        const err = new Error(
          `yt-dlp keluar dengan kode ${code}\n${stderr.slice(-800)}`,
        );
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

// Ubah pesan error mentah dari yt-dlp (yang teknis/kadang bahasa lain,
// kadang malah traceback Python) jadi pesan yang gampang dipahami user
// WhatsApp, buat kasus-kasus umum yang sering ketemu. Kalau gak ada pola
// yang dikenal, fallback ke baris pertama pesan error yt-dlp-nya.
function friendlyDlError(err) {
  const raw = err.stderr || "";

  if (
    /版权地区受限|not available in your country|not available in your location|geo.?restrict/i.test(
      raw,
    )
  ) {
    return "🌍 Video ini dibatasi wilayah (geo-restricted) oleh platform aslinya -- server bot tidak bisa akses dari lokasinya. Coba video/link lain.";
  }
  if (/private video|video is private/i.test(raw)) {
    return "🔒 Videonya bersifat privat, gak bisa diakses tanpa login.";
  }
  // PENTING: dicek DULUAN sebelum age-restrict, karena pesan ini pola
  // katanya mirip ("sign in to confirm...") tapi artinya beda total --
  // ini YouTube curiga IP server-nya bot/datacenter, BUKAN video-nya
  // dibatasi umur. Kalau ini yang muncul terus-terusan meski sudah pakai
  // client rotation (lihat komentar downloadMediaFromUrl), coba aktifin
  // PO Token server (YTDLP_POT_BASE_URL).
  if (/sign in to confirm you.?re not a bot/i.test(raw)) {
    return "🤖 YouTube mendeteksi server bot ini sebagai traffic mencurigakan (umum terjadi di IP cloud/datacenter kayak Railway/AWS/GCP) -- ini BUKAN soal video dibatasi umur. Coba lagi beberapa saat, atau aktifin PO Token server (env var YTDLP_POT_BASE_URL) buat solusi lebih permanen.";
  }
  if (/sign in to confirm|age.?restrict/i.test(raw)) {
    return "🔞 Video ini dibatasi umur oleh platformnya dan butuh login -- bot ini gak bisa login akun.";
  }
  if (/bgutil.*(connection refused|econnrefused|failed to fetch|timed? ?out)/i.test(raw)) {
    return "⚙️ POT provider (bgutil) gak bisa dihubungi dari server -- cek apakah service-nya masih jalan & YTDLP_POT_BASE_URL sudah benar.";
  }
  if (
    /video unavailable|content isn.?t available|no longer available|this video (has been removed|is unavailable)/i.test(
      raw,
    )
  ) {
    return "❌ Video/postingannya sudah tidak tersedia (mungkin dihapus atau link-nya salah).";
  }
  if (/unsupported url|no extractor/i.test(raw)) {
    return "❌ Link ini belum didukung buat didownload.";
  }

  if (!err.stderr) {
    // Ini error yang kita lempar sendiri (bukan dari stderr yt-dlp),
    // pesannya udah pasti ramah buat user, tinggal dipakai apa adanya.
    return err.message;
  }

  // Fallback terakhir: baris "ERROR: ..." pertama dari output yt-dlp,
  // dipangkas biar gak nampilin traceback Python yang teknis banget.
  const firstErrorLine =
    raw.split("\n").find((l) => l.trim().startsWith("ERROR:")) ||
    raw.split("\n").find(Boolean);
  return (firstErrorLine || "Terjadi kesalahan saat download.").replace(
    /^ERROR:\s*/,
    "",
  );
}

// Deteksi link YouTube (termasuk youtu.be & Shorts) -- dipakai buat
// nambahin argumen khusus YouTube (client rotation, dst -- lihat
// downloadMediaFromUrl) di "!dl".
function isYoutubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

// mode: "video" -> MP4 (gabungan video+audio terbaik dalam batas ukuran)
//       "audio" -> MP3 (audio-only, hasil ekstraksi)
// Generik untuk YouTube (video/short), Bilibili, Facebook (video/reel/
// postingan video), TikTok, Instagram, X/Twitter, dst -- semua situs yang
// didukung yt-dlp. YouTube dapet argumen tambahan (lihat di bawah).
async function downloadMediaFromUrl(url, mode) {
  const tmpDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString("hex");
  const outputTemplate = path.join(tmpDir, `dl-${uid}.%(ext)s`);

  const commonArgs = [
    "--no-playlist",
    // CATATAN: --no-warnings SENGAJA TIDAK dipakai (walau dulu ada). Flag
    // itu nyembunyiin baris WARNING dari stderr yang ditangkap bot --
    // termasuk baris "HTTP Error 429" dan info PO Token yang JUSTRU jadi
    // sinyal utama buat sistem backoff otomatis (lihat
    // isRateLimitOrBotDetectionError) ndeteksi rate-limit. Tanpa warning
    // ini, bot cuma lihat baris ERROR generik ("Requested format is not
    // available") tanpa tau AKAR masalahnya rate-limit atau bukan -- jadi
    // backoff otomatis gak pernah kepicu walau sebenarnya lagi kena 429.
    // Baris WARNING ini cuma masuk ke console.log (Railway Logs), TIDAK
    // ikut dikirim ke user WhatsApp (itu tetap lewat friendlyDlError),
    // jadi aman gak bikin pesan ke user jadi berantakan.
    "--ffmpeg-location",
    path.dirname(ffmpegPath),
    "--max-filesize",
    DL_MAX_FILESIZE,
    // Jeda kecil (detik) antar request internal yt-dlp -- bukan obat buat
    // rate-limit yang udah kejadian, tapi pencegahan biar gak gampang
    // numpuk ke 429 lagi terutama kalau banyak download YouTube beruntun.
    "--sleep-requests",
    "1",
    "-o",
    outputTemplate,
  ];

  // Khusus YouTube.
  //
  // CATATAN (Agustus 2026, update ke-2): sempat dihapus sama sekali (lihat
  // histori komentar di atas), TAPI ternyata di IP Railway (datacenter),
  // client default yang dipilih otomatis yt-dlp (visionos) kena
  // LOGIN_REQUIRED walau PO Token sudah valid -- beda dari test di IP
  // residensial yang mulus tanpa override apa pun.
  //
  // Ditest manual satu-satu langsung di container Railway:
  //   - default/tanpa override (visionos)  -> LOGIN_REQUIRED
  //   - android_vr                          -> GVS PO Token gak didukung
  //                                             provider bgutil sama sekali
  //                                             (semua format di-skip)
  //   - web (+ POT provider yang valid)     -> BERHASIL, download penuh
  //
  // Jadi "web" dipasang eksplisit lagi -- BUKAN rotasi banyak client kayak
  // resep asli, cuma satu client yang sudah terbukti cocok dipasangkan
  // dengan bgutil POT provider. Kalau nanti kualitas hasil download-nya
  // masih suka mentok di format rendah (SABR throttle web client), baru
  // pertimbangkan nambahin visitor_data atau POT context lain -- tapi
  // jangan buru-buru rotasi ke client lain lagi tanpa test manual dulu,
  // karena provider bgutil ini spesifik cuma dukung PO Token buat
  // keluarga client "web" (web, mweb, web_safari, tv), bukan mobile/VR.
  if (isYoutubeUrl(url)) {
    commonArgs.push("--extractor-args", "youtube:player_client=web");

    // Cegah masalah routing IPv6 yang lumayan sering kejadian di
    // beberapa cloud provider (Railway/AWS/GCP dst).
    commonArgs.push("--force-ipv4");

    // Solver signature/n challenge YouTube -- pakai runtime "node" (SUDAH
    // terinstall buat project ini sendiri, jadi TIDAK butuh install Deno
    // terpisah). --remote-components auto-download komponen solver
    // terbaru dari GitHub kalau versi cache lokal ketinggalan zaman.
    commonArgs.push("--js-runtimes", "node");
    commonArgs.push("--remote-components", "ejs:github");

    // Kalau POT provider di-set (lihat komentar YTDLP_POT_BASE_URL di
    // atas), kasih tau yt-dlp lokasinya -- ini buat kasus deteksi bot
    // yang masih lolos walau sudah pakai client rotation di atas.
    if (YTDLP_POT_BASE_URL) {
      commonArgs.push(
        "--extractor-args",
        `youtubepot-bgutilhttp:base_url=${YTDLP_POT_BASE_URL}`,
      );
    }

    // Fallback cookies-from-browser (lihat komentar YTDLP_COOKIES_FROM_BROWSER
    // di atas) -- hanya diaktifin kalau env var-nya di-set.
    if (YTDLP_COOKIES_FROM_BROWSER) {
      commonArgs.push("--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER);
    }
  }

  const args =
    mode === "audio"
      ? [
          ...commonArgs,
          "-x",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "5",
          url,
        ]
      : [
          ...commonArgs,
          "-f",
          // PENTING: paksa codec H.264 (avc1) + AAC (mp4a), BUKAN cuma
          // "terbaik apa adanya". yt-dlp defaultnya sering milih VP9/AV1
          // + Opus (kualitas oke tapi codec modern) yang cuma bisa
          // dimainin di player berbasis browser (WA Web/Chrome), TAPI
          // player video native di app WA HP kebanyakan cuma jamin
          // dukung H.264+AAC -- makanya video ke-download tapi gak bisa
          // dibuka di HP.
          //
          // Kualitas dibatasi 360p-720p (bukan "sebesar-besarnya"):
          //   - Atas (720p): cukup buat nonton normal, gak perlu 1080p/4K
          //     yang bikin file gede & lama diproses/dikirim ke WhatsApp.
          //   - Bawah (360p): ini juga kebetulan pas sama batas bawah
          //     yang masih sering YouTube kasih walau lagi mode SABR
          //     (server cuma ngasih 1 format progresif kayak itag 18,
          //     360p) -- jadi selector ini tetap dapet sesuatu di kasus
          //     video yang paling dibatasin sekalipun, bukannya gagal
          //     total kena "Requested format is not available".
          //
          // CATATAN: filter [filesize<95M] SENGAJA TIDAK dipakai di sini
          // (walau versi sebelumnya ada). Filter itu cuma ngecek field
          // "filesize" PASTI -- format yang cuma punya "filesize_approx"
          // (kayak itag 18 pas mode SABR, ditandai simbol "\u2248" di
          // --list-formats) bakal KETOLAK filter itu walau ukuran
          // aslinya kecil, bikin selector gagal total ("Requested format
          // is not available") padahal ada format yang muat. Batas
          // ukuran file tetap ditegakkan lewat flag --max-filesize
          // (lihat DL_MAX_FILESIZE di atas), yang otomatis
          // mempertimbangkan filesize_approx juga.
          //
          // 4 tingkat fallback: DASH avc1+mp4a max 720p -> progresif
          // avc1 max 720p -> apa pun max 720p (asal masih >=360p) ->
          // pamungkas "apa aja yang penting kebentuk" (kalau video-nya
          // emang cuma punya format di luar rentang itu).
          "bestvideo[height<=720][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=720][vcodec^=avc1]/best[height<=720][height>=360]/best",
          "--merge-output-format",
          "mp4",
          url,
        ];

  try {
    try {
      await runYtDlp(args);
    } catch (err) {
      // Instagram (carousel foto) khususnya SERING keluar exit code 1
      // (BUKAN 0 dengan file kosong seperti kasus di bawah) dengan pesan
      // literal "No video formats found!" per slide -- ini juga tanda
      // postingan foto, bukan cuma pola "sukses tapi file kosong".
      // Ditandai sama kayak di bawah biar handleDlDownload otomatis
      // nyoba jalur foto (tryHandleAsPhotoPost).
      if (/No video formats found/i.test(err.stderr || err.message || "")) {
        err.possiblyPhotoOnly = true;
      }
      throw err;
    }

    // Nama file pastinya baru ketahuan setelah yt-dlp selesai (ekstensi
    // ditentukan otomatis olehnya), jadi dicari lewat prefix uid ini.
    const files = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith(`dl-${uid}`));

    if (files.length === 0) {
      // yt-dlp selesai TANPA error (exit code 0) tapi gak ada file yang
      // dihasilkan -- pola ini paling sering kejadian pas link-nya
      // postingan FOTO (carousel Instagram / slideshow TikTok), bukan
      // video. Ditandai lewat properti ini biar handleDlDownload bisa
      // otomatis nyoba jalur foto (lihat tryHandleAsPhotoPost) sebelum
      // nyerah dan nampilin error ke user.
      const err = new Error(
        "File hasil download tidak ditemukan. Mungkin link-nya tidak mengandung video/audio (mis. postingan berupa foto saja), atau ukurannya melebihi batas 95MB.",
      );
      err.possiblyPhotoOnly = true;
      throw err;
    }

    const outputPath = path.join(tmpDir, files[0]);
    const buffer = fs.readFileSync(outputPath);

    return { buffer };
  } finally {
    // Bersihin semua file sisa dengan prefix uid ini (termasuk file
    // sementara lain yang mungkin ditinggal yt-dlp kalau prosesnya gagal
    // di tengah jalan).
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.startsWith(`dl-${uid}`)) {
          fs.rm(path.join(tmpDir, f), { force: true }, () => {});
        }
      }
    } catch {
      // abaikan -- ini cuma usaha bersih-bersih tmp, bukan hal kritis
    }
  }
}


module.exports = {
  GALLERYDL_PATH,
  GALLERYDL_COOKIES_FILE,
  GALLERYDL_INSTAGRAM_USERNAME,
  GALLERYDL_INSTAGRAM_PASSWORD,
  getYtdlpBackoffRemainingMs,
  formatDurationId,
  registerYtdlpRateLimitFailure,
  registerYtdlpSuccess,
  isRateLimitOrBotDetectionError,
  enqueueDownloadJob,
  runYtDlp,
  friendlyDlError,
  isYoutubeUrl,
  downloadMediaFromUrl,
};
