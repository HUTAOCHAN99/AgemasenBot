"use strict";

/**
 * Provider: DOAJ (Directory of Open Access Journals -- doaj.org)
 * ------------------------------------------------------------------
 * DOAJ index artikel dari jurnal open-access yang sudah lolos kurasi
 * mereka. DOAJ nyediain REST API publik buat ambil metadata + link
 * fulltext resmi dari penerbit -- itu yang kita pakai di sini, bukan
 * scraping halaman.
 */

const axios = require("axios");
const { ArticleProvider } = require("./base");
const { getNormalizedHostname } = require("../services/urlDetector");
const { DEFAULT_TIMEOUT_MS } = require("../utils/validation");

const DOMAINS = ["doaj.org"];

function extractArticleId(url) {
  const parsed = new URL(url);
  // Bentuk umum: https://doaj.org/article/<id>
  const match = parsed.pathname.match(/\/article\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

async function fetchDoajArticle(id) {
  const apiUrl = `https://doaj.org/api/articles/${encodeURIComponent(id)}`;
  const { data } = await axios.get(apiUrl, { timeout: DEFAULT_TIMEOUT_MS });
  return data;
}

/** Cari link fulltext dari bibjson.link[] milik DOAJ (biasanya type: "fulltext"). */
function pickFulltextUrl(bibjson) {
  const links = bibjson?.link || [];
  const fulltext = links.find((l) => l.type === "fulltext") || links[0];
  return fulltext?.url || null;
}

class DoajProvider extends ArticleProvider {
  constructor() {
    super("DOAJ", DOMAINS);
  }

  async canHandle(url) {
    const hostname = getNormalizedHostname(url);
    if (!hostname || !DOMAINS.includes(hostname)) return false;
    return extractArticleId(url) !== null;
  }

  async getMetadata(url) {
    const id = extractArticleId(url);
    if (!id) return null;

    try {
      const article = await fetchDoajArticle(id);
      const bibjson = article?.bibjson;
      if (!bibjson) return null;

      return {
        title: bibjson.title || null,
        doi: bibjson.identifier?.find((i) => i.type === "doi")?.id || null,
        sourceUrl: url,
        fulltextUrl: pickFulltextUrl(bibjson),
      };
    } catch (err) {
      console.log("[DoajProvider] gagal ambil metadata:", err.message);
      return null;
    }
  }

  async getDownloadUrl(url) {
    const metadata = await this.getMetadata(url);
    return metadata?.fulltextUrl || null;
  }
}

module.exports = { DoajProvider };
