"use strict";

/**
 * commands/artikel.js
 * ------------------------------------------------------------------
 * Command "!artikel <URL>" -- Article/Document Downloader.
 *
 * File ini punya DUA lapisan yang sengaja dipisah:
 *
 *   1. handleArticleCommand(message, url)  -- LOGIC MURNI, gak nyentuh
 *      Baileys/WhatsApp sama sekali. Return objek terstruktur (lihat
 *      README/spesifikasi). Ini yang gampang di-unit-test.
 *
 *   2. runArtikelCommand(sock, jid, url, senderId) -- WRAPPER integrasi
 *      WhatsApp: kirim pesan progress, panggil handleArticleCommand(),
 *      lalu kirim hasil akhirnya (dokumen atau teks) + bersihkan file
 *      temporary + rate limiting per user.
 *
 * Alur lengkap (lihat juga diagram di spesifikasi fitur):
 *   validasi URL -> deteksi provider -> ambil metadata -> cek file
 *   publik langsung -> kalau ada: download & kirim -> kalau gak ada:
 *   cari Open Access resmi -> kalau ketemu: kirim link -> kalau gak:
 *   kirim link artikel asli.
 */

const fs = require("fs");

const { assertSafeToFetch } = require("../utils/validation");
const { findProviderForUrl } = require("../providers");
const { downloadDocument, safeUnlink, safeRmdir } = require("../services/pdfDownloader");
const { findOpenAccess } = require("../services/openAccessFinder");

// =====================================================
// Rate limiting per user (in-memory, sederhana).
// -- Batasi: minimal jeda N detik antar request, dan gak boleh nembak
//    request baru selagi request sebelumnya (dari user yang sama)
//    masih diproses.
// =====================================================
const RATE_LIMIT_COOLDOWN_MS = 20_000; // 20 detik antar-request per user
const lastRequestAt = new Map(); // senderId -> timestamp
const inFlight = new Set(); // senderId yang requestnya lagi jalan

function checkRateLimit(senderId) {
  if (!senderId) return { allowed: true };

  if (inFlight.has(senderId)) {
    return {
      allowed: false,
      reason: "Masih ada proses !artikel kamu yang belum selesai, tunggu dulu ya.",
    };
  }

  const last = lastRequestAt.get(senderId);
  if (last && Date.now() - last < RATE_LIMIT_COOLDOWN_MS) {
    const remainingSec = Math.ceil((RATE_LIMIT_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return {
      allowed: false,
      reason: `Tunggu ${remainingSec} detik lagi sebelum pakai !artikel lagi ya.`,
    };
  }

  return { allowed: true };
}

// =====================================================
// 1) LOGIC MURNI -- tidak menyentuh Baileys sama sekali.
// =====================================================

/**
 * @param {object} message - konteks pesan asal (opsional, dipakai buat logging).
 * @param {string} url - URL artikel/dokumen yang mau diproses.
 * @param {object} [opts]
 * @param {(text: string) => void} [opts.onProgress] - callback dipanggil
 *   di tiap tahap proses (buat kirim status "⏳ ..." ke user).
 * @returns {Promise<object>} salah satu dari:
 *   { success: true, title, provider, filePath, sourceUrl }               (file didownload)
 *   { success: true, title, provider, filePath: null, pdfUrl, sourceUrl } (cuma link OA)
 *   { success: false, reason, sourceUrl, message }                        (gagal)
 */
async function handleArticleCommand(message, url, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  // --- Validasi URL (bentuk + anti-SSRF) ---
  try {
    await assertSafeToFetch(url);
  } catch (err) {
    return {
      success: false,
      reason: "INVALID_URL",
      sourceUrl: url,
      message: err.message,
    };
  }

  onProgress("🔍 Mendeteksi sumber...");

  // --- Deteksi provider yang cocok ---
  let provider;
  try {
    provider = await findProviderForUrl(url);
  } catch (err) {
    return {
      success: false,
      reason: "PROVIDER_DETECTION_FAILED",
      sourceUrl: url,
      message: err.message,
    };
  }

  if (!provider) {
    // Seharusnya gak pernah kejadian (GenericProvider selalu fallback),
    // tapi dijaga juga buat keamanan.
    return { success: false, reason: "NO_PROVIDER", sourceUrl: url };
  }

  // --- Ambil metadata (judul, DOI, dll) ---
  let metadata = null;
  try {
    metadata = await provider.getMetadata(url);
  } catch (err) {
    console.log(`[artikel] getMetadata gagal (${provider.name}):`, err.message);
  }
  const title = metadata?.title || null;
  const doi = metadata?.doi || null;

  onProgress("📄 Mencari file PDF publik...");

  // --- Cek apakah ada file publik langsung dari provider ---
  let downloadUrl = null;
  try {
    downloadUrl = await provider.getDownloadUrl(url);
  } catch (err) {
    console.log(`[artikel] getDownloadUrl gagal (${provider.name}):`, err.message);
  }

  if (downloadUrl) {
    try {
      const { filePath } = await downloadDocument(downloadUrl, { suggestedTitle: title });
      return {
        success: true,
        title: title || "Tanpa judul",
        provider: provider.name,
        filePath,
        sourceUrl: url,
      };
    } catch (err) {
      console.log(`[artikel] download file gagal:`, err.message);
      // Jangan langsung nyerah -- lanjut coba Open Access Finder di bawah,
      // siapa tahu ada versi lain yang lebih bisa diakses.
    }
  }

  // --- Fallback: cari versi Open Access resmi lewat DOI/judul ---
  onProgress("🔎 Mencari versi Open Access resmi...");

  let openAccess = null;
  try {
    openAccess = await findOpenAccess({ title, doi });
  } catch (err) {
    console.log("[artikel] openAccessFinder gagal:", err.message);
  }

  if (openAccess?.pdfUrl) {
    return {
      success: true,
      title: title || openAccess.title || "Tanpa judul",
      provider: "Open Access",
      filePath: null,
      pdfUrl: openAccess.pdfUrl,
      sourceUrl: url,
    };
  }

  // --- Gak ketemu apa pun yang bisa diakses publik & legal ---
  return {
    success: false,
    reason: "PUBLIC_FILE_NOT_FOUND",
    sourceUrl: url,
    title,
  };
}

// =====================================================
// 2) WRAPPER integrasi WhatsApp (Baileys) -- panggil ini dari index.js.
// =====================================================

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid - chat tujuan (grup atau pribadi).
 * @param {string} url - URL yang dikirim user setelah "!artikel".
 * @param {string} [senderId] - jid pengirim ASLI, dipakai buat rate limiting per user.
 */
async function runArtikelCommand(sock, jid, url, senderId) {
  const effectiveSender = senderId || jid;

  if (!url) {
    await sock.sendMessage(jid, {
      text: "❗ Format: *!artikel <URL>*\n\nContoh:\n!artikel https://arxiv.org/abs/2101.00001",
    });
    return;
  }

  const rateCheck = checkRateLimit(effectiveSender);
  if (!rateCheck.allowed) {
    await sock.sendMessage(jid, { text: `⏳ ${rateCheck.reason}` });
    return;
  }

  inFlight.add(effectiveSender);
  lastRequestAt.set(effectiveSender, Date.now());

  let workDirToClean = null;

  try {
    await sock.sendMessage(jid, { text: "⏳ Sedang memproses artikel..." });

    const result = await handleArticleCommand({ jid }, url, {
      onProgress: (text) => {
        // fire-and-forget -- gak perlu di-await berurutan biar gak nge-blok,
        // tapi tetap ditangkap errornya biar gak jadi unhandled rejection.
        sock.sendMessage(jid, { text }).catch((err) => {
          console.log("[artikel] gagal kirim progress:", err.message);
        });
      },
    });

    if (result.success && result.filePath) {
      workDirToClean = require("path").dirname(result.filePath);

      await sock.sendMessage(jid, {
        text:
          `✅ Artikel ditemukan\n\n` +
          `📄 Judul: ${result.title}\n` +
          `🌐 Sumber: ${result.provider}\n\n` +
          `📥 Sedang mengirim dokumen...`,
      });

      const buffer = fs.readFileSync(result.filePath);
      const fileName = require("path").basename(result.filePath);

      await sock.sendMessage(jid, {
        document: buffer,
        mimetype: "application/pdf",
        fileName,
        caption: `📄 ${result.title}\n🔗 Sumber asli: ${result.sourceUrl}`,
      });

      // Spec: hapus file setelah berhasil dikirim.
      safeUnlink(result.filePath);
      safeRmdir(workDirToClean);
      return;
    }

    if (result.success && result.pdfUrl) {
      await sock.sendMessage(jid, {
        text:
          `✅ Versi Open Access ditemukan\n\n` +
          `📄 Judul: ${result.title}\n` +
          `🔗 PDF: ${result.pdfUrl}`,
      });
      return;
    }

    // Gagal total.
    if (result.reason === "INVALID_URL") {
      await sock.sendMessage(jid, {
        text: `❌ URL tidak valid.\n${result.message ? "Alasan: " + result.message : ""}`,
      });
      return;
    }

    await sock.sendMessage(jid, {
      text:
        `❌ File PDF publik tidak tersedia.\n\n` +
        `🔗 Kamu bisa membuka artikel asli di:\n${result.sourceUrl}`,
    });
  } catch (err) {
    console.log("=== [!artikel] error tak terduga ===");
    console.log(err.message || err);
    console.log("=====================================");
    await sock.sendMessage(jid, {
      text: "❌ Terjadi kesalahan saat memproses artikel. Coba lagi nanti ya.",
    });

    // Jaga-jaga: kalau error terjadi setelah file sempat ke-download
    // tapi sebelum sempat dibersihkan di jalur normal.
    if (workDirToClean) safeRmdir(workDirToClean);
  } finally {
    inFlight.delete(effectiveSender);
  }
}

module.exports = {
  handleArticleCommand,
  runArtikelCommand,
};
