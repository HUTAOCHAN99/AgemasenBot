"use strict";

/**
 * Provider: Repository Universitas & Open Journal Systems (OJS)
 * ------------------------------------------------------------------
 * Gak mungkin daftar semua domain repository kampus/OJS satu-satu, jadi
 * provider ini gak dibatasi lewat daftar domain tetap -- dia dikenali
 * dari POLA URL yang khas software repository open-source populer:
 *
 *   - OJS (Open Journal Systems)   -> path mengandung "/index.php/"
 *     dan biasanya "/article/view/"
 *   - DSpace                       -> path mengandung "/xmlui/" atau "/handle/"
 *   - EPrints                      -> path mengandung "/eprint/" atau "/id/eprint/"
 *   - Repository generik lain      -> mengandung "/jspui/" (JSPUI, varian DSpace lama)
 *
 * Begitu polanya cocok, provider ini pakai metadataExtractor (yang baca
 * <meta name="citation_pdf_url">, dsb -- standar de-facto software2 di
 * atas) buat nemuin link PDF resminya.
 */

const { ArticleProvider } = require("./base");
const { extractMetadata } = require("../services/metadataExtractor");

const REPO_PATH_PATTERNS = [
  /\/index\.php\/[^/]+\/article\/view\//i, // OJS
  /\/xmlui\//i, // DSpace (XMLUI)
  /\/jspui\//i, // DSpace (JSPUI, versi lama)
  /\/handle\//i, // DSpace generik
  /\/id\/eprint\//i, // EPrints
  /\/eprint\/\d+/i, // EPrints (bentuk lain)
];

function matchesRepositoryPattern(url) {
  try {
    const parsed = new URL(url);
    return REPO_PATH_PATTERNS.some((re) => re.test(parsed.pathname));
  } catch {
    return false;
  }
}

class RepositoryProvider extends ArticleProvider {
  constructor() {
    // domains: [] karena provider ini dikenali dari pola path, bukan domain tetap.
    super("Repository/OJS", []);
  }

  async canHandle(url) {
    return matchesRepositoryPattern(url);
  }

  async getMetadata(url) {
    try {
      const metadata = await extractMetadata(url);
      return {
        title: metadata.title,
        doi: metadata.doi,
        sourceUrl: url,
        citationPdfUrl: metadata.citationPdfUrl,
      };
    } catch (err) {
      console.log("[RepositoryProvider] gagal ambil metadata:", err.message);
      return null;
    }
  }

  async getDownloadUrl(url) {
    const metadata = await this.getMetadata(url);
    return metadata?.citationPdfUrl || null;
  }
}

module.exports = { RepositoryProvider, matchesRepositoryPattern };
