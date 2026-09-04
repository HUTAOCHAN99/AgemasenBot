"use strict";

const path = require("path");

/**
 * Ubah string bebas (judul artikel, dsb) jadi nama file yang aman
 * dipakai di filesystem: buang karakter berbahaya, path traversal,
 * kontrol karakter, dan batasi panjangnya.
 */
function sanitizeFilename(name, fallback = "document") {
  let base = (name || "").toString().trim();
  if (!base) base = fallback;

  // Buang path separator & path traversal ("..", "/", "\").
  base = base.replace(/\.\./g, "");
  base = base.replace(/[\/\\]/g, "-");

  // Buang karakter kontrol dan karakter yang bermasalah di banyak OS.
  base = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "");

  // Rapikan whitespace berlebih.
  base = base.replace(/\s+/g, " ").trim();

  if (!base) base = fallback;

  // Batasi panjang nama file (tanpa ekstensi) biar aman di semua filesystem.
  const MAX_BASENAME_LENGTH = 120;
  if (base.length > MAX_BASENAME_LENGTH) {
    base = base.slice(0, MAX_BASENAME_LENGTH).trim();
  }

  return base;
}

/**
 * Bangun nama file lengkap (dengan ekstensi) dari judul + ekstensi yang
 * diinginkan. Ekstensi disanitasi juga (cuma huruf/angka).
 */
function buildFilename(title, extension = "pdf") {
  const safeBase = sanitizeFilename(title);
  const safeExt = (extension || "pdf")
    .toString()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase() || "pdf";
  return `${safeBase}.${safeExt}`;
}

/**
 * Tentukan ekstensi file dari Content-Type response, fallback ke "pdf"
 * kalau tidak dikenali (dipakai hanya untuk file yang sudah lolos
 * validasi Content-Type di pdfDownloader).
 */
function extensionFromContentType(contentType) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "application/pdf": "pdf",
    "application/epub+zip": "epub",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
  };
  return map[ct] || "pdf";
}

/** Pastikan path hasil join tetap di dalam base directory (anti path traversal). */
function isPathInsideDir(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return (
    resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + path.sep)
  );
}

module.exports = {
  sanitizeFilename,
  buildFilename,
  extensionFromContentType,
  isPathInsideDir,
};
