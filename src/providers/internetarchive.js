"use strict";

/**
 * Provider: Internet Archive (archive.org)
 * ------------------------------------------------------------------
 * Untuk item archive.org yang memang dipublikasikan publik (public
 * domain / open access), Internet Archive nyediain Metadata API resmi
 * yang bisa dipakai buat nemuin file PDF/teks yang tersedia buat
 * didownload langsung -- tanpa perlu login sama sekali.
 *
 * CATATAN: kalau item-nya "restricted" (butuh peminjaman/login lewat
 * Controlled Digital Lending), API metadata akan menandai item itu
 * sebagai lending-only dan provider ini SENGAJA tidak mencoba
 * mengambil filenya -- itu di luar cakupan "publik & legal".
 */

const axios = require("axios");
const { ArticleProvider } = require("./base");
const { getNormalizedHostname } = require("../services/urlDetector");
const { DEFAULT_TIMEOUT_MS } = require("../utils/validation");

const DOMAINS = ["archive.org"];

function extractIdentifier(url) {
  const parsed = new URL(url);
  // Bentuk umum: https://archive.org/details/<identifier>
  const match = parsed.pathname.match(/\/details\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchItemMetadata(identifier) {
  const apiUrl = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
  const { data } = await axios.get(apiUrl, { timeout: DEFAULT_TIMEOUT_MS });
  return data;
}

/** Pilih file PDF terbaik dari daftar file item Internet Archive. */
function pickBestPdfFile(files) {
  if (!Array.isArray(files)) return null;
  const pdfFiles = files.filter(
    (f) => f.format === "Text PDF" || (f.name && f.name.toLowerCase().endsWith(".pdf")),
  );
  if (!pdfFiles.length) return null;

  // Prioritaskan file yang bukan "_text.pdf" turunan OCR kalau ada yang lain.
  pdfFiles.sort((a, b) => (a.name.length || 0) - (b.name.length || 0));
  return pdfFiles[0];
}

class InternetArchiveProvider extends ArticleProvider {
  constructor() {
    super("Internet Archive", DOMAINS);
  }

  async canHandle(url) {
    const hostname = getNormalizedHostname(url);
    if (!hostname || !DOMAINS.includes(hostname)) return false;
    return extractIdentifier(url) !== null;
  }

  async getMetadata(url) {
    const identifier = extractIdentifier(url);
    if (!identifier) return null;

    try {
      const item = await fetchItemMetadata(identifier);
      const metadata = item?.metadata || {};

      return {
        title: metadata.title || identifier,
        doi: null,
        sourceUrl: url,
        identifier,
        isLendingOnly:
          metadata["access-restricted-item"] === "true" ||
          metadata["access-restricted-item"] === true,
        files: item?.files || [],
      };
    } catch (err) {
      console.log("[InternetArchiveProvider] gagal ambil metadata:", err.message);
      return null;
    }
  }

  async getDownloadUrl(url) {
    const metadata = await this.getMetadata(url);
    if (!metadata) return null;

    // Item lending-only (Controlled Digital Lending) TIDAK dilayani --
    // itu butuh "peminjaman"/login, di luar cakupan publik & legal fitur ini.
    if (metadata.isLendingOnly) return null;

    const file = pickBestPdfFile(metadata.files);
    if (!file) return null;

    return `https://archive.org/download/${encodeURIComponent(metadata.identifier)}/${encodeURIComponent(file.name)}`;
  }
}

module.exports = { InternetArchiveProvider };
