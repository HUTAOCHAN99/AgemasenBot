"use strict";

/**
 * Provider: Generic (fallback terakhir)
 * ------------------------------------------------------------------
 * Dipakai kalau tidak ada provider spesifik yang cocok. Urutan cek:
 *   1. Apakah URL-nya sendiri langsung mengarah ke file PDF? (cek
 *      Content-Type via request ringan, bukan cuma tebak dari ".pdf")
 *   2. Kalau bukan, anggap ini halaman HTML -- baca metadata standar
 *      (citation_pdf_url, DC.identifier, canonical) buat nemuin link
 *      PDF publik ATAU informasi (judul/DOI) buat dipakai Open Access
 *      Finder di command layer.
 *
 * Provider ini SELALU `canHandle() -> true` karena memang fallback --
 * providers/index.js mendaftarkannya PALING TERAKHIR di registry.
 */

const { ArticleProvider } = require("./base");
const { probeUrl } = require("../services/pdfDownloader");
const { extractMetadata } = require("../services/metadataExtractor");
const { looksLikeDirectPdfUrl } = require("../services/urlDetector");

class GenericProvider extends ArticleProvider {
  constructor() {
    super("Generic", []);
  }

  async canHandle(_url) {
    return true; // fallback -- selalu bisa "dicoba"
  }

  async getMetadata(url) {
    // Kalau URL kelihatannya langsung file (dari ekstensi), gak usah
    // dianggap halaman HTML -- judulnya cukup diambil dari nama filenya.
    if (looksLikeDirectPdfUrl(url)) {
      const filename = decodeURIComponent(
        new URL(url).pathname.split("/").pop() || "document.pdf",
      );
      return { title: filename.replace(/\.pdf$/i, ""), doi: null, sourceUrl: url };
    }

    try {
      const metadata = await extractMetadata(url);
      return {
        title: metadata.title,
        doi: metadata.doi,
        sourceUrl: url,
        citationPdfUrl: metadata.citationPdfUrl,
      };
    } catch (err) {
      console.log("[GenericProvider] gagal ambil metadata:", err.message);
      return { title: null, doi: null, sourceUrl: url };
    }
  }

  async getDownloadUrl(url) {
    // 1) Cek apakah URL ini SENDIRI langsung file dokumen (verifikasi
    //    lewat Content-Type asli, bukan cuma nebak dari path).
    const probe = await probeUrl(url);
    if (probe.ok && probe.isPdf) {
      return url;
    }

    // 2) Kalau bukan, coba baca metadata halaman buat nemuin citation_pdf_url.
    try {
      const metadata = await extractMetadata(url);
      if (metadata.citationPdfUrl) {
        const pdfProbe = await probeUrl(metadata.citationPdfUrl);
        if (pdfProbe.ok && pdfProbe.isPdf) {
          return metadata.citationPdfUrl;
        }
      }
    } catch (err) {
      console.log("[GenericProvider] gagal cek metadata untuk PDF:", err.message);
    }

    return null;
  }
}

module.exports = { GenericProvider };
