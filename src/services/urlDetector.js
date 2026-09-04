"use strict";

/**
 * urlDetector.js
 * ------------------------------------------------------------------
 * Util kecil buat urusan "domain apa ini" -- dipakai oleh Provider
 * Registry (providers/index.js) buat mencocokkan URL ke handler yang
 * tepat, dan juga bisa dipakai provider individual kalau perlu.
 */

const { validateUrlShape } = require("../utils/validation");

/** Ambil hostname ternormalisasi (lowercase, tanpa "www.") dari URL. */
function getNormalizedHostname(rawUrl) {
  const shape = validateUrlShape(rawUrl);
  if (!shape.valid) return null;
  return shape.url.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Cek apakah hostname URL cocok dengan salah satu domain di daftar
 * `domains` -- termasuk subdomain (mis. domain "arxiv.org" cocok buat
 * "export.arxiv.org").
 */
function hostnameMatchesDomains(hostname, domains) {
  if (!hostname || !Array.isArray(domains)) return false;
  return domains.some((domain) => {
    const d = domain.toLowerCase().replace(/^www\./, "");
    return hostname === d || hostname.endsWith(`.${d}`);
  });
}

/** Deteksi apakah sebuah URL "kelihatannya" langsung file PDF dari path/query-nya. */
function looksLikeDirectPdfUrl(rawUrl) {
  const shape = validateUrlShape(rawUrl);
  if (!shape.valid) return false;
  const pathname = shape.url.pathname.toLowerCase();
  return pathname.endsWith(".pdf");
}

module.exports = {
  getNormalizedHostname,
  hostnameMatchesDomains,
  looksLikeDirectPdfUrl,
};
