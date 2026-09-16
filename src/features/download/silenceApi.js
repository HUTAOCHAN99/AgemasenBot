const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const { ensureWhatsAppCompatibleVideo } = require("./ytdlp");

// =====================================================
// Jalur download YouTube lewat SERVICE TERPISAH: SilenceYTDown
// (project Next.js + BullMQ + Worker sendiri).
//
// KENAPA ADA JALUR KEDUA INI (bukan cukup yt-dlp lokal di ytdlp.js)?
// Masalah utamanya bukan soal argumen yt-dlp, tapi soal IP: YouTube
// makin galak ke IP datacenter (Railway/AWS/GCP dst) -- muncul
// "Sign in to confirm you're not a bot" / LOGIN_REQUIRED, dan bot ini
// sampai punya sistem backoff otomatis 15 menit - 4 jam gara-gara itu
// (lihat komentar backoff di ytdlp.js).
//
// SilenceYTDown sudah nyelesein bagian itu SEKALI di satu tempat:
//   - Worker-nya punya cookies YouTube sendiri (lihat app/api/admin/cookies)
//   - Antreannya concurrency 1, jadi gak pernah nembak YouTube barengan
//   - PO Token / konfigurasi yt-dlp-nya diurus di sana
// Jadi daripada dobel maintain resep anti-bot-detection di dua repo,
// bot ini tinggal NUMPANG ke API itu buat link YouTube. Situs lain
// (TikTok, IG, Facebook, Bilibili, dst) TETAP lewat yt-dlp lokal --
// SilenceYTDown memang khusus YouTube (endpoint-nya nolak non-YouTube).
//
// ALUR API-nya (3 langkah, sesuai app/api/bot/*):
//   1. POST {base}/api/bot/dl          -> { jobId, statusUrl, queuePosition }
//   2. GET  {base}/api/bot/status/{id} -> polling sampai status "done"
//                                          (atau "error")
//   3. GET  {fileUrl}                  -> file binernya. PENTING: fileUrl
//      nunjuk ke WORKER Service, BUKAN Web Service, karena file-nya
//      memang cuma ada di container worker. Dan file itu DIHAPUS BEGITU
//      SELESAI DISEDOT SEKALI (sekali pakai) -- jadi jangan sampai
//      request-nya diulang/di-retry sembarangan.
//
// SETUP (env var di bot ini):
//   SILENCE_API_BASE_URL   -> URL Web Service SilenceYTDown,
//                             mis. https://silenceytdown.up.railway.app
//                             (tanpa trailing slash). KOSONG = fitur ini
//                             mati total, bot balik 100% ke yt-dlp lokal.
//   SILENCE_API_KEY        -> harus SAMA dengan BOT_API_KEY di
//                             SilenceYTDown (Web & Worker Service).
//                             Boleh kosong kalau di sana juga gak diset.
//   SILENCE_TIMEOUT_MS     -> batas total nunggu antrean+download
//                             (default 15 menit).
//   SILENCE_POLL_MS        -> jeda polling status (default 3 detik).
//   SILENCE_MAX_HEIGHT     -> cap resolusi (default 720; API-nya sendiri
//                             default 1080, tapi 720 jauh lebih aman
//                             buat batas ukuran WhatsApp).
//   SILENCE_FALLBACK_YTDLP -> "0" buat MATIIN fallback ke yt-dlp lokal
//                             kalau API-nya gagal (default: nyala).
// =====================================================
const SILENCE_API_BASE_URL = (process.env.SILENCE_API_BASE_URL || "").replace(
  /\/+$/,
  "",
);
const SILENCE_API_KEY = process.env.SILENCE_API_KEY || "";
const SILENCE_TIMEOUT_MS =
  Number(process.env.SILENCE_TIMEOUT_MS) || 15 * 60 * 1000;
const SILENCE_POLL_MS = Number(process.env.SILENCE_POLL_MS) || 3000;
const SILENCE_MAX_HEIGHT = Number(process.env.SILENCE_MAX_HEIGHT) || 720;
const SILENCE_FALLBACK_YTDLP = process.env.SILENCE_FALLBACK_YTDLP !== "0";

// Batas ukuran file yang mau dikirim ke WhatsApp. Sengaja disamain
// semangatnya sama DL_MAX_FILESIZE ("95M") di ytdlp.js -- bedanya, di
// jalur ini batas itu gak bisa dititipin ke yt-dlp (download-nya terjadi
// di server orang lain), jadi ditegakkan di sini: cek Content-Length
// dulu, lalu kompres berjenjang lewat ensureWhatsAppCompatibleVideo().
const SILENCE_MAX_SEND_BYTES =
  (Number(process.env.SILENCE_MAX_SEND_MB) || 95) * 1024 * 1024;

// Batas keras berapa besar file yang masih mau kita SEDOT dari worker.
// Di atas ini, percuma didownload -- ngabisin bandwidth & disk buat file
// yang ujungnya tetap gak bisa dikirim utuh ke WhatsApp.
const SILENCE_MAX_FETCH_BYTES =
  (Number(process.env.SILENCE_MAX_FETCH_MB) || 400) * 1024 * 1024;

function isSilenceApiEnabled() {
  return Boolean(SILENCE_API_BASE_URL);
}

function authHeaders(extra = {}) {
  return SILENCE_API_KEY
    ? { "x-api-key": SILENCE_API_KEY, ...extra }
    : { ...extra };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Error yang pesannya SUDAH ramah user (tinggal ditampilin apa adanya
// oleh pemanggil), plus flag buat nentuin apakah masih layak fallback ke
// yt-dlp lokal. Kalau gagalnya karena video-nya sendiri (privat, dihapus,
// geo-block), yt-dlp lokal ya bakal gagal juga -- gak usah buang waktu.
function silenceError(message, { retryable = true } = {}) {
  const err = new Error(message);
  err.fromSilenceApi = true;
  err.silenceRetryable = retryable;
  return err;
}

// Pola error dari worker SilenceYTDown yang artinya "video-nya emang
// bermasalah", bukan "service-nya lagi rewel" -- lihat pemakaiannya di
// pollUntilDone().
function isPermanentVideoError(raw = "") {
  return /private video|video unavailable|no longer available|has been removed|geo.?restrict|not available in your country|members.?only|age.?restrict/i.test(
    raw,
  );
}

async function requestJson(url, options, label) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    // Gagal di level jaringan: service-nya mati, domain salah, atau lagi
    // cold start. Ini justru kasus yang PALING layak fallback ke yt-dlp.
    throw silenceError(
      `Service SilenceYTDown gak bisa dihubungi (${label}): ${err.message}`,
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // biarin null -- ditangani di bawah lewat cek res.ok
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw silenceError(
        "Ditolak SilenceYTDown (401 Unauthorized) -- SILENCE_API_KEY di bot ini beda sama BOT_API_KEY di sana.",
      );
    }
    throw silenceError(
      `SilenceYTDown balas ${res.status} (${label}): ${body?.error || "tanpa detail"}`,
    );
  }

  return body || {};
}

// Langkah 1: masukin job ke antrean SilenceYTDown.
async function enqueueSilenceJob(url, mode) {
  const payload =
    mode === "audio"
      ? { url, type: "audio", quality: "mp3-128" }
      : { url, type: "video", maxHeight: SILENCE_MAX_HEIGHT };

  const data = await requestJson(
    `${SILENCE_API_BASE_URL}/api/bot/dl`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    },
    "POST /api/bot/dl",
  );

  if (!data.jobId) {
    throw silenceError("SilenceYTDown gak balikin jobId -- respons gak sesuai format.");
  }

  return data;
}

// Langkah 2: polling status sampai selesai/gagal/timeout.
//
// onProgress dipanggil TIAP KALI status atau persentasenya berubah --
// dipakai pemanggil buat update pesan "lagi antre nomor 3..." ke user,
// tanpa nge-spam chat tiap 3 detik.
async function pollUntilDone(jobId, onProgress) {
  const deadline = Date.now() + SILENCE_TIMEOUT_MS;
  let lastSignature = "";

  while (Date.now() < deadline) {
    await sleep(SILENCE_POLL_MS);

    const data = await requestJson(
      `${SILENCE_API_BASE_URL}/api/bot/status/${encodeURIComponent(jobId)}`,
      { headers: authHeaders() },
      "GET /api/bot/status",
    );

    if (data.status === "error") {
      const raw = data.error || "";
      console.error(`[silence] job ${jobId} gagal di worker:`, raw);
      throw silenceError(
        isPermanentVideoError(raw)
          ? "Videonya gak bisa diproses (mungkin privat, dihapus, atau dibatasi wilayah/umur)."
          : "Server download-nya gagal memproses video ini.",
        { retryable: !isPermanentVideoError(raw) },
      );
    }

    if (data.status === "done" || data.done) {
      if (!data.fileUrl) {
        // Kasus khas: WORKER_PUBLIC_URL belum diset di Web Service
        // SilenceYTDown, jadi file-nya sukses dibikin tapi gak ada
        // alamat buat ngambilnya.
        throw silenceError(
          data.error ||
            "Download selesai tapi file-nya gak bisa diambil (WORKER_PUBLIC_URL belum diset di SilenceYTDown).",
        );
      }
      return data;
    }

    // Masih queued/downloading/converting -- laporin progresnya.
    const signature = `${data.status}:${data.queuePosition ?? ""}:${Math.floor((data.percent || 0) / 25)}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      onProgress?.(data);
    }
  }

  throw silenceError(
    `Kelamaan nunggu SilenceYTDown (lewat ${Math.round(SILENCE_TIMEOUT_MS / 60000)} menit) -- antreannya mungkin lagi padat banget.`,
  );
}

// Langkah 3: sedot file binernya dari Worker Service.
//
// CATATAN PENTING: file di worker dihapus BEGITU stream-nya selesai
// dibaca (sekali pakai). Jadi kalau langkah ini gagal di tengah jalan,
// JANGAN retry GET yang sama -- file-nya udah gak ada. Harus job baru.
async function fetchResultFile(fileUrl, destPath) {
  let res;
  try {
    res = await fetch(fileUrl, { headers: authHeaders() });
  } catch (err) {
    throw silenceError(
      `Gagal ngambil file dari worker SilenceYTDown: ${err.message}`,
    );
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw silenceError(
        "File-nya udah gak ada di server (kadung kedaluwarsa atau sudah terambil sebelumnya). Coba !dl lagi.",
      );
    }
    throw silenceError(`Worker SilenceYTDown balas ${res.status} waktu ambil file.`);
  }

  // Cek ukuran SEBELUM disedot -- worker selalu kirim Content-Length
  // (lihat fileServer di worker.js), jadi kita bisa nolak lebih awal
  // daripada boros bandwidth buat file yang pasti ketolak WhatsApp.
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > SILENCE_MAX_FETCH_BYTES) {
    throw silenceError(
      `Filenya ${(declared / 1024 / 1024).toFixed(0)}MB -- kegedean buat dikirim lewat WhatsApp. Coba video yang lebih pendek, atau pakai "!dl <link> mp3".`,
      { retryable: false },
    );
  }

  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));

  const size = fs.statSync(destPath).size;
  console.log(
    `[silence] File diterima: ${(size / 1024 / 1024).toFixed(2)}MB -> ${destPath}`,
  );
  return size;
}

// =====================================================
// API publik modul ini.
//
// Return: { buffer, source: "silence" } -- sengaja dibikin bentuknya
// SAMA PERSIS kayak downloadMediaFromUrl() di ytdlp.js, biar pemanggil
// (handleDlDownload) bisa tukar-pasang jalur tanpa ubah apa pun setelahnya.
// =====================================================
async function downloadViaSilenceApi(url, mode, { onProgress } = {}) {
  if (!isSilenceApiEnabled()) {
    throw silenceError("SILENCE_API_BASE_URL belum diset.");
  }

  const uid = crypto.randomBytes(6).toString("hex");
  const tmpDir = os.tmpdir();
  const prefix = `silence-${uid}`;

  const job = await enqueueSilenceJob(url, mode);
  console.log(
    `[silence] Job ${job.jobId} masuk antrean (posisi ${job.queuePosition ?? "?"}).`,
  );
  onProgress?.({ status: "queued", queuePosition: job.queuePosition });

  const finished = await pollUntilDone(job.jobId, onProgress);

  const isAudio = mode === "audio";
  const rawPath = path.join(tmpDir, `${prefix}-raw.${isAudio ? "mp3" : "mp4"}`);

  try {
    await fetchResultFile(finished.fileUrl, rawPath);

    // Audio langsung kirim apa adanya (worker sudah convert ke
    // mp3/m4a 128k -- ukurannya aman & codec-nya jelas didukung WA).
    // Video HARUS lewat pemeriksaan codec/ukuran yang sama persis
    // dengan jalur yt-dlp lokal: worker SilenceYTDown cuma remux
    // "-c copy +faststart", jadi kalau yt-dlp di sana kebetulan milih
    // VP9/AV1, file-nya bakal gagal diputar di WA persis kayak kasus
    // yang dulu bikin transcode ini ada.
    const finalPath = isAudio
      ? rawPath
      : await ensureWhatsAppCompatibleVideo(rawPath, {
          workDir: tmpDir,
          prefix,
          maxBytes: SILENCE_MAX_SEND_BYTES,
        });

    const buffer = fs.readFileSync(finalPath);
    console.log(
      `[silence] Siap dikirim: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
    );
    return { buffer, source: "silence" };
  } finally {
    // Bersihin SEMUA sisa file dengan prefix ini (raw + hasil transcode
    // tiap tier), termasuk kalau prosesnya gagal di tengah jalan.
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.startsWith(prefix)) {
          fs.rm(path.join(tmpDir, f), { force: true }, () => {});
        }
      }
    } catch {
      // abaikan -- cuma bersih-bersih tmp, bukan hal kritis
    }
  }
}

module.exports = {
  SILENCE_API_BASE_URL,
  SILENCE_MAX_HEIGHT,
  SILENCE_FALLBACK_YTDLP,
  isSilenceApiEnabled,
  downloadViaSilenceApi,
};