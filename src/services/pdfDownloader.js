"use strict";

/**
 * pdfDownloader.js
 * ------------------------------------------------------------------
 * Download file (PDF/dokumen) dari URL publik dengan aman:
 *  - Validasi & re-validasi URL di SETIAP hop redirect (anti SSRF /
 *    anti DNS-rebinding), bukan cuma di URL awal.
 *  - Redirect diikuti MANUAL (axios maxRedirects: 0) supaya tiap hop
 *    bisa divalidasi sebelum diikuti.
 *  - Batas jumlah redirect, timeout, dan ukuran file maksimum
 *    (dicek dari header Content-Length DAN selama streaming, karena
 *    Content-Length bisa saja tidak jujur/tidak ada).
 *  - Validasi Content-Type harus salah satu tipe dokumen yang didukung.
 *  - File ditulis ke temporary directory, nama file disanitasi.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  assertSafeToFetch,
  MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  MAX_FILE_SIZE_BYTES,
} = require("../utils/validation");
const { buildFilename, extensionFromContentType } = require("../utils/filename");

// Content-Type yang kita anggap "dokumen valid" untuk fitur ini.
const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "application/x-pdf",
  "application/epub+zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream", // beberapa server generic; divalidasi ulang via magic bytes
];

function contentTypeAllowed(contentType) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.includes(ct);
}

/** Cek magic bytes berkas supaya "application/octet-stream" gak asal diterima. */
function looksLikePdf(buffer) {
  return buffer.length >= 5 && buffer.slice(0, 5).toString("ascii") === "%PDF-";
}

/**
 * Ikuti redirect secara manual, memvalidasi tiap hop terhadap SSRF.
 * Return axios response object dari hop terakhir (status 2xx, stream).
 */
async function fetchFollowingSafeRedirects(url, { method = "GET", headers = {} } = {}) {
  let currentUrl = url;
  let redirectCount = 0;

  for (;;) {
    const safeUrl = await assertSafeToFetch(currentUrl);

    const response = await axios.request({
      url: safeUrl.toString(),
      method,
      headers: {
        "User-Agent": "AgemasenBot-ArticleDownloader/1.0 (+https://github.com/)",
        Accept: "*/*",
        ...headers,
      },
      timeout: DEFAULT_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: method === "GET" ? "stream" : "text",
      validateStatus: (status) => (status >= 200 && status < 400),
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return response;
    }

    redirectCount += 1;
    if (redirectCount > MAX_REDIRECTS) {
      const err = new Error("Terlalu banyak redirect.");
      err.code = "TOO_MANY_REDIRECTS";
      throw err;
    }

    const location = response.headers.location;
    if (!location) {
      const err = new Error("Redirect tanpa header Location.");
      err.code = "BAD_REDIRECT";
      throw err;
    }

    // Resolve relative redirect terhadap URL saat ini.
    currentUrl = new URL(location, currentUrl).toString();

    // Buang stream response redirect ini biar socket dilepas.
    if (response.data && typeof response.data.destroy === "function") {
      response.data.destroy();
    }
  }
}

/**
 * Lakukan request HEAD/GET ringan buat cek Content-Type & Content-Length
 * TANPA menulis file -- dipakai generic provider buat cek "apakah URL ini
 * langsung mengarah ke file PDF" sebelum commit download penuh.
 */
async function probeUrl(url) {
  try {
    const response = await fetchFollowingSafeRedirects(url, { method: "GET" });
    const contentType = response.headers["content-type"] || "";
    const contentLength = Number(response.headers["content-length"] || 0);

    // Sudah dapat stream -- langsung tutup, kita cuma mau tahu header.
    if (response.data && typeof response.data.destroy === "function") {
      response.data.destroy();
    }

    return {
      ok: true,
      finalUrl: response.request?.res?.responseUrl || url,
      contentType,
      contentLength,
      isPdf: contentTypeAllowed(contentType),
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Download file dari URL ke temporary directory.
 *
 * @param {string} url - URL sumber file (sudah harus lolos validasi domain).
 * @param {object} opts
 * @param {string} [opts.suggestedTitle] - dipakai untuk nama file.
 * @param {number} [opts.maxBytes] - override batas ukuran file.
 * @returns {Promise<{filePath: string, contentType: string, bytesWritten: number}>}
 */
async function downloadDocument(url, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_FILE_SIZE_BYTES;

  const response = await fetchFollowingSafeRedirects(url, { method: "GET" });
  const contentType = response.headers["content-type"] || "";

  if (!contentTypeAllowed(contentType)) {
    response.data.destroy();
    const err = new Error(`Content-Type tidak didukung: ${contentType || "(kosong)"}`);
    err.code = "UNSUPPORTED_CONTENT_TYPE";
    throw err;
  }

  const declaredLength = Number(response.headers["content-length"] || 0);
  if (declaredLength && declaredLength > maxBytes) {
    response.data.destroy();
    const err = new Error(
      `File terlalu besar (${(declaredLength / 1024 / 1024).toFixed(1)}MB, batas ${(maxBytes / 1024 / 1024).toFixed(0)}MB).`,
    );
    err.code = "FILE_TOO_LARGE";
    throw err;
  }

  // Tulis ke temporary directory khusus request ini.
  const workDir = path.join(os.tmpdir(), `artikel-${crypto.randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const ext = extensionFromContentType(contentType);
  const fileName = buildFilename(opts.suggestedTitle || "artikel", ext);
  const filePath = path.join(workDir, fileName);

  let bytesWritten = 0;
  let firstChunk = null;

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);

    response.data.on("data", (chunk) => {
      bytesWritten += chunk.length;

      if (firstChunk === null) firstChunk = chunk;

      if (bytesWritten > maxBytes) {
        response.data.destroy();
        writeStream.destroy();
        reject(
          Object.assign(new Error("File melebihi batas ukuran maksimum saat streaming."), {
            code: "FILE_TOO_LARGE",
          }),
        );
        return;
      }
      writeStream.write(chunk);
    });

    response.data.on("end", () => {
      writeStream.end();
    });

    response.data.on("error", (err) => reject(err));
    writeStream.on("error", (err) => reject(err));
    writeStream.on("finish", resolve);
  });

  // Kalau server bilang octet-stream (bukan tipe eksplisit), pastikan
  // isinya beneran PDF lewat magic bytes -- kalau bukan, tolak & bersihkan.
  if (contentType.split(";")[0].trim().toLowerCase() === "application/octet-stream") {
    if (!firstChunk || !looksLikePdf(firstChunk)) {
      safeUnlink(filePath);
      safeRmdir(workDir);
      const err = new Error("Isi file bukan dokumen yang didukung.");
      err.code = "UNSUPPORTED_CONTENT_TYPE";
      throw err;
    }
  }

  return { filePath, workDir, contentType, bytesWritten };
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // sudah gak ada / gagal hapus -- gak fatal, cuma tinggalkan jejak di tmp.
  }
}

function safeRmdir(dirPath) {
  try {
    fs.rmdirSync(dirPath);
  } catch {
    // ada isi lain / gagal -- abaikan, bukan fatal.
  }
}

module.exports = {
  downloadDocument,
  probeUrl,
  fetchFollowingSafeRedirects,
  contentTypeAllowed,
  safeUnlink,
  safeRmdir,
};
