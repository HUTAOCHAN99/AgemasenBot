"use strict";

/**
 * metadataExtractor.js
 * ------------------------------------------------------------------
 * Ambil HTML sebuah halaman artikel (dengan proteksi SSRF/timeout yang
 * sama kayak pdfDownloader) lalu ekstrak metadata standar yang biasa
 * dipakai situs akademik/jurnal:
 *   - <meta name="citation_pdf_url" content="...">
 *   - <meta name="citation_title" content="...">
 *   - <meta name="DC.identifier" content="...">   (sering berisi DOI)
 *   - <meta name="citation_doi" content="...">
 *   - <link rel="canonical" href="...">
 *   - <meta property="og:title" content="...">
 *   - <title>...</title>  (fallback terakhir)
 *
 * Parsing pakai regex ringan (bukan DOM parser penuh) supaya gak nambah
 * dependency besar -- cukup untuk <meta>/<link> tag standar yang rapi.
 *
 * Ada cache in-memory sederhana (TTL) supaya URL yang sama gak di-fetch
 * berkali-kali dalam waktu singkat (misal user nyoba command beberapa kali).
 */

const { fetchFollowingSafeRedirects } = require("./pdfDownloader");

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 menit
const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3MB cukup buat <head> halaman manapun
const metadataCache = new Map(); // url -> { data, expiresAt }

function getFromCache(url) {
  const entry = metadataCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    metadataCache.delete(url);
    return null;
  }
  return entry.data;
}

function saveToCache(url, data) {
  metadataCache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });

  // Rapikan cache dari waktu ke waktu biar gak numpuk gak dibatasi.
  if (metadataCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of metadataCache) {
      if (now > val.expiresAt) metadataCache.delete(key);
    }
  }
}

function extractMetaContent(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHtmlEntities(match[1].trim());
    }
  }
  return null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

/** Bikin regex buat cari <meta name="X" content="..."> tanpa peduli urutan atribut. */
function metaRegexByName(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(
      `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["']`,
      "i",
    ),
  ];
}

function metaRegexByProperty(prop) {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`,
      "i",
    ),
  ];
}

/**
 * Fetch HTML (dibatasi ukuran) dari URL yang sudah divalidasi aman.
 */
async function fetchHtml(url) {
  const response = await fetchFollowingSafeRedirects(url, { method: "GET" });
  const contentType = (response.headers["content-type"] || "").toLowerCase();

  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    response.data.destroy();
    const err = new Error(`Bukan halaman HTML (Content-Type: ${contentType || "kosong"}).`);
    err.code = "NOT_HTML";
    throw err;
  }

  let html = "";
  let bytes = 0;

  await new Promise((resolve, reject) => {
    response.data.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_HTML_BYTES) {
        response.data.destroy();
        resolve(); // cukup, kita cuma butuh bagian <head> biasanya di awal.
        return;
      }
      html += chunk.toString("utf8");
    });
    response.data.on("end", resolve);
    response.data.on("error", reject);
  });

  return html;
}

/**
 * Ekstrak metadata artikel dari sebuah URL halaman (BUKAN URL file PDF
 * langsung). Return objek metadata; field yang gak ketemu bernilai null.
 */
async function extractMetadata(url) {
  const cached = getFromCache(url);
  if (cached) return cached;

  const html = await fetchHtml(url);

  const citationPdfUrl = extractMetaContent(html, metaRegexByName("citation_pdf_url"));
  const citationTitle = extractMetaContent(html, metaRegexByName("citation_title"));
  const citationDoi = extractMetaContent(html, metaRegexByName("citation_doi"));
  const dcIdentifier = extractMetaContent(html, metaRegexByName("DC.identifier"));
  const dcTitle = extractMetaContent(html, metaRegexByName("DC.title"));
  const ogTitle = extractMetaContent(html, metaRegexByProperty("og:title"));

  const canonicalMatch = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i,
  );
  const canonicalUrl = canonicalMatch ? decodeHtmlEntities(canonicalMatch[1].trim()) : null;

  const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const titleTag = titleTagMatch ? decodeHtmlEntities(titleTagMatch[1].trim()) : null;

  // DC.identifier kadang berisi DOI dalam bentuk "doi:10.xxxx/yyyy" atau
  // URL "https://doi.org/10.xxxx/yyyy" -- ekstrak nomor DOI mentahnya.
  let doi = citationDoi || null;
  if (!doi && dcIdentifier) {
    const doiMatch = dcIdentifier.match(/10\.\d{4,9}\/\S+/);
    if (doiMatch) doi = doiMatch[0].replace(/[.,]$/, "");
  }
  if (!doi) {
    const doiInHtml = html.match(/10\.\d{4,9}\/[A-Za-z0-9._;()/:-]+/);
    if (doiInHtml) doi = doiInHtml[0].replace(/[.,]$/, "");
  }

  const title = citationTitle || dcTitle || ogTitle || titleTag || null;

  const result = {
    title: title ? title.trim() : null,
    doi,
    citationPdfUrl: citationPdfUrl
      ? new URL(citationPdfUrl, canonicalUrl || url).toString()
      : null,
    canonicalUrl: canonicalUrl ? new URL(canonicalUrl, url).toString() : url,
    sourceUrl: url,
  };

  saveToCache(url, result);
  return result;
}

module.exports = {
  extractMetadata,
  fetchHtml,
};
