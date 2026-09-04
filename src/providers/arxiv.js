"use strict";

/**
 * Provider: arXiv (arxiv.org)
 * ------------------------------------------------------------------
 * arXiv adalah preprint server -- SEMUA artikel di dalamnya memang
 * open-access secara resmi, jadi ini kasus paling sederhana: kita
 * cuma perlu ubah URL abstrak jadi URL PDF resminya.
 */

const axios = require("axios");
const { ArticleProvider } = require("./base");
const { getNormalizedHostname } = require("../services/urlDetector");
const { assertSafeToFetch, DEFAULT_TIMEOUT_MS } = require("../utils/validation");

const DOMAINS = ["arxiv.org"];

/** Ekstrak arXiv id (mis. "2101.00001" atau "2101.00001v2") dari URL apa pun bentuknya. */
function extractArxivId(url) {
  const parsed = new URL(url);
  const path = parsed.pathname; // /abs/2101.00001  atau  /pdf/2101.00001.pdf

  const match = path.match(/(?:abs|pdf)\/([a-zA-Z0-9.\-\/]+?)(?:\.pdf)?\/?$/i);
  if (match) return match[1];

  // Format lama, mis. /abs/hep-th/9901001
  const oldFormat = path.match(/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
  return oldFormat ? oldFormat[1] : null;
}

class ArxivProvider extends ArticleProvider {
  constructor() {
    super("arXiv", DOMAINS);
  }

  async canHandle(url) {
    const hostname = getNormalizedHostname(url);
    if (!hostname) return false;
    if (!DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      return false;
    }
    return extractArxivId(url) !== null;
  }

  async getMetadata(url) {
    const id = extractArxivId(url);
    if (!id) return null;

    try {
      const apiUrl = "http://export.arxiv.org/api/query";
      await assertSafeToFetch(apiUrl); // export.arxiv.org is a fixed, trusted endpoint
      const { data } = await axios.get(apiUrl, {
        params: { id_list: id },
        timeout: DEFAULT_TIMEOUT_MS,
      });

      const titleMatch = data.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
      const title = titleMatch
        ? titleMatch[1].replace(/\s+/g, " ").trim()
        : `arXiv:${id}`;

      return {
        title,
        doi: null,
        arxivId: id,
        sourceUrl: `https://arxiv.org/abs/${id}`,
      };
    } catch (err) {
      // API metadata gagal bukan fatal -- kita masih bisa kasih judul generik.
      return { title: `arXiv:${id}`, doi: null, arxivId: id, sourceUrl: url };
    }
  }

  async getDownloadUrl(url) {
    const id = extractArxivId(url);
    if (!id) return null;
    // URL PDF resmi arXiv -- selalu publik, gak butuh login/paywall apa pun.
    return `https://arxiv.org/pdf/${id}.pdf`;
  }
}

module.exports = { ArxivProvider, extractArxivId };
