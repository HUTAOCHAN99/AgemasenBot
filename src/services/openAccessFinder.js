"use strict";

/**
 * openAccessFinder.js
 * ------------------------------------------------------------------
 * Cari versi Open Access LEGAL dari sebuah artikel, dipakai sebagai
 * langkah terakhir kalau provider spesifik & generic fallback gak
 * nemu file PDF publik langsung.
 *
 * Sumber yang dipakai -- SEMUA API publik & legal, khusus buat nemuin
 * versi open-access yang memang disediakan resmi (bukan bypass apa pun):
 *   1. Unpaywall API (https://unpaywall.org) -- database open-access
 *      resmi berbasis DOI, dipakai luas oleh perpustakaan & Zotero dll.
 *   2. Crossref API (https://www.crossref.org) -- dipakai buat nemuin
 *      DOI dari judul artikel kalau DOI belum diketahui.
 *
 * PENTING: modul ini TIDAK PERNAH mencoba login, isi captcha, atau
 * "menembus" paywall dengan cara apa pun. Kalau Unpaywall bilang gak
 * ada open-access location, kita cukup nyerah & bilang gak ketemu.
 */

const axios = require("axios");

// Unpaywall MEWAJIBKAN parameter `email` di query (kebijakan pemakaian
// mereka, bukan autentikasi) -- ganti lewat env var kalau perlu.
const CONTACT_EMAIL =
  process.env.OPEN_ACCESS_CONTACT_EMAIL || "bot-contact@example.com";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cari lokasi open-access resmi dari sebuah DOI lewat Unpaywall.
 * Return { pdfUrl, landingPageUrl, title } atau null kalau gak ketemu.
 */
async function findByDoi(doi) {
  if (!doi) return null;

  try {
    const cleanDoi = doi.trim().replace(/^doi:/i, "");
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}`;

    const { data } = await axios.get(url, {
      params: { email: CONTACT_EMAIL },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (s) => s === 200 || s === 404,
    });

    if (!data || data.is_oa !== true) return null;

    const best = data.best_oa_location;
    if (!best) return null;

    return {
      pdfUrl: best.url_for_pdf || null,
      landingPageUrl: best.url || best.url_for_landing_page || null,
      title: data.title || null,
      hostType: best.host_type || null, // "repository" | "publisher"
    };
  } catch (err) {
    // Gagal cari open-access BUKAN error fatal buat keseluruhan alur --
    // cukup anggap "gak ketemu" & biarkan pemanggil fallback ke link asli.
    console.log("[openAccessFinder] Unpaywall gagal:", err.message);
    return null;
  }
}

/**
 * Cari DOI dari judul artikel lewat Crossref, buat kasus di mana
 * metadata halaman gak nyediain DOI secara eksplisit.
 */
async function findDoiByTitle(title) {
  if (!title || title.trim().length < 6) return null;

  try {
    const { data } = await axios.get("https://api.crossref.org/works", {
      params: {
        "query.bibliographic": title,
        rows: 1,
        mailto: CONTACT_EMAIL,
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    const item = data?.message?.items?.[0];
    if (!item?.DOI) return null;

    // Sanity check ringan: judul hasil pencarian harus cukup mirip,
    // biar gak nyasar ke artikel lain yang gak nyambung.
    const foundTitle = Array.isArray(item.title) ? item.title[0] : item.title;
    if (foundTitle && !titlesLooselyMatch(title, foundTitle)) {
      return null;
    }

    return item.DOI;
  } catch (err) {
    console.log("[openAccessFinder] Crossref gagal:", err.message);
    return null;
  }
}

function normalizeTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesLooselyMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Entry point utama: dari objek metadata (title, doi) hasil
 * metadataExtractor, coba temukan versi open-access resmi.
 * Return { pdfUrl, landingPageUrl, title } atau null.
 */
async function findOpenAccess({ title, doi } = {}) {
  let effectiveDoi = doi;

  if (!effectiveDoi && title) {
    effectiveDoi = await findDoiByTitle(title);
  }

  if (!effectiveDoi) return null;

  return findByDoi(effectiveDoi);
}

module.exports = {
  findOpenAccess,
  findByDoi,
  findDoiByTitle,
};
