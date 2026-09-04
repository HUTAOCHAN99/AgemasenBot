"use strict";

/**
 * Validasi URL untuk fitur Article/Document Downloader.
 *
 * Tujuan util ini SATU hal: pastikan URL yang mau kita fetch/download
 * beneran aman -- bukan localhost, bukan IP privat/internal, bukan
 * skema aneh-aneh (cuma http/https). Ini garis pertahanan utama
 * terhadap SSRF (Server-Side Request Forgery), jadi jangan dilonggarin
 * tanpa alasan kuat.
 */

const dns = require("dns").promises;
const net = require("net");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Beberapa hostname yang jelas-jelas nunjuk ke diri sendiri / metadata
// cloud provider (AWS/GCP/Azure metadata endpoint) -- diblokir eksplisit
// di luar pengecekan IP, karena beberapa provider metadata endpoint
// (169.254.169.254) juga sudah ke-cover oleh cek link-local di bawah,
// tapi kita tetap tulis eksplisit biar jelas.
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "169.254.169.254",
]);

/**
 * Cek apakah sebuah alamat IP (v4/v6) termasuk kategori privat/internal
 * yang HARUS diblokir buat outbound request dari server.
 */
function isPrivateOrReservedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;

    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast/reserved (224+)
    return false;
  }

  if (type === 6) {
    const norm = ip.toLowerCase();
    if (norm === "::1") return true; // loopback
    if (norm === "::") return true;
    if (norm.startsWith("fe80:")) return true; // link-local
    if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // ULA fc00::/7
    if (norm.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 -- cek bagian IPv4-nya juga.
      const v4 = norm.split(":").pop();
      if (net.isIP(v4) === 4) return isPrivateOrReservedIp(v4);
    }
    return false;
  }

  // Bukan IP valid sama sekali -> anggap tidak aman, biar pemanggil nolak.
  return true;
}

/**
 * Validasi bentuk & keamanan URL SEBELUM melakukan request apa pun.
 * Mengembalikan { valid: true, url: URL } atau { valid: false, reason }.
 * Ini cuma validasi sintaks + hostname literal; resolusi DNS dicek
 * terpisah lewat assertSafeToFetch() karena butuh async.
 */
function validateUrlShape(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { valid: false, reason: "URL kosong." };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: "Format URL tidak valid." };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      valid: false,
      reason: "Hanya URL http:// atau https:// yang didukung.",
    };
  }

  // Tolak userinfo di URL (contoh: http://user:pass@host/) -- sering
  // dipakai buat trik bypass parser/SSRF filter yang naif.
  if (parsed.username || parsed.password) {
    return { valid: false, reason: "URL dengan kredensial tidak diizinkan." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: "Host ini tidak diizinkan." };
  }

  // Kalau hostname-nya literal IP, langsung cek privat/reserved di sini.
  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    return { valid: false, reason: "Akses ke alamat IP privat/internal ditolak." };
  }

  return { valid: true, url: parsed };
}

/**
 * Resolve DNS dari hostname lalu pastikan SEMUA alamat hasil resolve
 * bukan IP privat/internal. Ini penting buat nyegah DNS rebinding
 * (hostname publik yang di-resolve ke IP privat).
 *
 * Melempar Error kalau tidak aman; kalau aman, tidak return apa-apa.
 */
async function assertSafeToFetch(rawUrl) {
  const shape = validateUrlShape(rawUrl);
  if (!shape.valid) {
    const err = new Error(shape.reason);
    err.code = "INVALID_URL";
    throw err;
  }

  const hostname = shape.url.hostname;

  // Kalau hostname-nya sudah IP literal, validateUrlShape() sudah cukup.
  if (net.isIP(hostname)) return shape.url;

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    const e = new Error(`Gagal resolve domain: ${hostname}`);
    e.code = "DNS_LOOKUP_FAILED";
    throw e;
  }

  if (!records.length) {
    const e = new Error(`Domain tidak punya alamat: ${hostname}`);
    e.code = "DNS_LOOKUP_FAILED";
    throw e;
  }

  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      const e = new Error(
        `Domain "${hostname}" mengarah ke alamat privat/internal -- ditolak.`,
      );
      e.code = "SSRF_BLOCKED";
      throw e;
    }
  }

  return shape.url;
}

/**
 * Batasi jumlah redirect yang boleh diikuti. Dipakai oleh pdfDownloader
 * & metadataExtractor supaya konsisten satu angka.
 */
const MAX_REDIRECTS = 5;

/** Timeout default untuk request HTTP (ms). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Batas ukuran file maksimum yang boleh didownload (bytes). Default 25MB. */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

module.exports = {
  validateUrlShape,
  assertSafeToFetch,
  isPrivateOrReservedIp,
  MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  MAX_FILE_SIZE_BYTES,
};
