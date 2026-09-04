"use strict";

/**
 * Kelas dasar untuk semua provider artikel/dokumen.
 * Provider baru cukup extends kelas ini lalu daftar ke registry
 * (lihat providers/index.js) -- gak perlu ubah apa pun di command
 * utama (commands/artikel.js).
 */
class ArticleProvider {
  /**
   * @param {string} name - nama provider buat ditampilkan ke user, mis. "arXiv".
   * @param {string[]} domains - daftar domain yang ditangani provider ini,
   *   mis. ["arxiv.org"]. Subdomain otomatis ikut cocok.
   */
  constructor(name, domains) {
    this.name = name;
    this.domains = domains;
  }

  /** Apakah provider ini bisa menangani URL tersebut? */
  async canHandle(url) {
    return false;
  }

  /**
   * Ambil metadata artikel (judul, DOI kalau ada, dll).
   * Return null kalau gagal/tidak relevan.
   */
  async getMetadata(url) {
    return null;
  }

  /**
   * Cari URL file yang bisa didownload langsung (PDF, dsb).
   * Return null kalau tidak ada file publik langsung -- pemanggil akan
   * lanjut ke Open Access Finder sebagai fallback.
   */
  async getDownloadUrl(url) {
    return null;
  }
}

module.exports = { ArticleProvider };
