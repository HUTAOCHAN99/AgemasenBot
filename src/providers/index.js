"use strict";

/**
 * Provider Registry
 * ------------------------------------------------------------------
 * Satu-satunya tempat provider "didaftarkan". commands/artikel.js TIDAK
 * PERNAH hardcode provider apa pun -- dia cuma panggil
 * `findProviderForUrl(url)` dari sini.
 *
 * Nambah provider baru di masa depan cukup:
 *   1. Buat file baru di src/providers/nama-baru.js, extends ArticleProvider
 *      (lihat src/providers/base.js buat interface-nya).
 *   2. require() lalu push instance-nya ke array `providers` di bawah --
 *      taruh SEBELUM GenericProvider (karena GenericProvider fallback
 *      terakhir dan selalu canHandle() -> true).
 *
 * Urutan array PENTING: provider yang lebih spesifik harus dicek lebih
 * dulu daripada yang generik.
 */

const { ArxivProvider } = require("./arxiv");
const { DoajProvider } = require("./doaj");
const { InternetArchiveProvider } = require("./internetarchive");
const { RepositoryProvider } = require("./repository");
const { GenericProvider } = require("./generic");

const providers = [
  new ArxivProvider(),
  new DoajProvider(),
  new InternetArchiveProvider(),
  new RepositoryProvider(),
  new GenericProvider(), // HARUS PALING TERAKHIR (fallback)
];

/**
 * Cari provider pertama yang bisa menangani URL ini, sesuai urutan
 * pendaftaran di atas.
 */
async function findProviderForUrl(url) {
  for (const provider of providers) {
    try {
      if (await provider.canHandle(url)) {
        return provider;
      }
    } catch (err) {
      console.log(`[ProviderRegistry] canHandle() gagal di ${provider.name}:`, err.message);
      // lanjut ke provider berikutnya, jangan sampai satu provider error
      // menggagalkan seluruh proses deteksi.
    }
  }
  return null; // seharusnya gak pernah kejadian karena GenericProvider selalu true
}

/** Daftarkan provider baru secara terprogram (dipakai buat testing/ekstensi). */
function registerProvider(provider, { before } = {}) {
  const insertIndex = before
    ? providers.findIndex((p) => p.name === before)
    : providers.length - 1; // default: sebelum GenericProvider (posisi terakhir)

  const index = insertIndex === -1 ? providers.length - 1 : insertIndex;
  providers.splice(index, 0, provider);
}

module.exports = {
  providers,
  findProviderForUrl,
  registerProvider,
};
