"use strict";

/**
 * Contoh testing untuk fitur Article/Document Downloader.
 *
 * Pakai node:test bawaan Node.js (gak butuh install dependency test
 * tambahan) -- jalankan dengan:
 *
 *   node --test src/test/artikel.test.js
 *
 * SENGAJA hanya menguji bagian yang TIDAK butuh akses jaringan
 * (validasi URL/SSRF, sanitasi nama file, deteksi provider dari
 * pola URL) supaya test ini bisa jalan di mana saja, termasuk di CI
 * tanpa akses internet. Bagian yang butuh network (download beneran,
 * ambil metadata dari HTML, query Unpaywall/Crossref) sebaiknya diuji
 * lewat integration test terpisah / manual, bukan di sini.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateUrlShape,
  assertSafeToFetch,
  isPrivateOrReservedIp,
} = require("../utils/validation");
const { sanitizeFilename, buildFilename, isPathInsideDir } = require("../utils/filename");
const { extractArxivId } = require("../providers/arxiv");
const { matchesRepositoryPattern } = require("../providers/repository");
const {
  getNormalizedHostname,
  hostnameMatchesDomains,
  looksLikeDirectPdfUrl,
} = require("../services/urlDetector");
const { ArxivProvider } = require("../providers/arxiv");
const { GenericProvider } = require("../providers/generic");
const { findProviderForUrl } = require("../providers");

// ---------------------------------------------------------------------
// utils/validation.js
// ---------------------------------------------------------------------

test("validateUrlShape: menerima URL https yang wajar", () => {
  const result = validateUrlShape("https://arxiv.org/abs/2101.00001");
  assert.equal(result.valid, true);
});

test("validateUrlShape: menolak skema selain http/https", () => {
  const result = validateUrlShape("ftp://example.com/file.pdf");
  assert.equal(result.valid, false);
});

test("validateUrlShape: menolak URL kosong/rusak", () => {
  assert.equal(validateUrlShape("").valid, false);
  assert.equal(validateUrlShape("bukan-url-sama-sekali").valid, false);
});

test("validateUrlShape: menolak URL dengan kredensial (user:pass@)", () => {
  const result = validateUrlShape("https://user:pass@example.com/x.pdf");
  assert.equal(result.valid, false);
});

test("validateUrlShape: menolak hostname 'localhost'", () => {
  const result = validateUrlShape("http://localhost:3000/x.pdf");
  assert.equal(result.valid, false);
});

test("isPrivateOrReservedIp: mendeteksi rentang IPv4 privat/loopback/link-local", () => {
  assert.equal(isPrivateOrReservedIp("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("10.0.0.5"), true);
  assert.equal(isPrivateOrReservedIp("192.168.1.1"), true);
  assert.equal(isPrivateOrReservedIp("172.16.0.1"), true);
  assert.equal(isPrivateOrReservedIp("169.254.169.254"), true); // cloud metadata endpoint
  assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedIp("93.184.216.34"), false);
});

test("isPrivateOrReservedIp: mendeteksi IPv6 loopback & ULA", () => {
  assert.equal(isPrivateOrReservedIp("::1"), true);
  assert.equal(isPrivateOrReservedIp("fd00::1"), true);
  assert.equal(isPrivateOrReservedIp("2001:4860:4860::8888"), false); // Google DNS
});

test("assertSafeToFetch: menolak IP literal privat tanpa perlu DNS lookup", async () => {
  await assert.rejects(
    () => assertSafeToFetch("http://127.0.0.1/admin"),
    /privat|internal/i,
  );
});

test("assertSafeToFetch: menolak IP metadata cloud (169.254.169.254)", async () => {
  await assert.rejects(() => assertSafeToFetch("http://169.254.169.254/latest/meta-data/"));
});

// ---------------------------------------------------------------------
// utils/filename.js
// ---------------------------------------------------------------------

test("sanitizeFilename: buang path traversal & separator", () => {
  const result = sanitizeFilename("../../etc/passwd");
  assert.ok(!result.includes(".."));
  assert.ok(!result.includes("/"));
});

test("sanitizeFilename: fallback ke default kalau input kosong", () => {
  assert.equal(sanitizeFilename(""), "document");
  assert.equal(sanitizeFilename(null), "document");
});

test("sanitizeFilename: buang karakter berbahaya lain", () => {
  const result = sanitizeFilename('judul: "aneh" <script>?*');
  assert.ok(!/[<>:"|?*]/.test(result));
});

test("buildFilename: hasil selalu punya ekstensi yang diminta", () => {
  assert.equal(buildFilename("Judul Artikel", "pdf"), "Judul Artikel.pdf");
});

test("isPathInsideDir: mendeteksi path traversal keluar dari base dir", () => {
  assert.equal(isPathInsideDir("/tmp/artikel-123", "/tmp/artikel-123/file.pdf"), true);
  assert.equal(isPathInsideDir("/tmp/artikel-123", "/tmp/artikel-123/../../etc/passwd"), false);
});

// ---------------------------------------------------------------------
// services/urlDetector.js
// ---------------------------------------------------------------------

test("getNormalizedHostname: lowercase & buang 'www.'", () => {
  assert.equal(getNormalizedHostname("https://WWW.Example.com/x"), "example.com");
});

test("hostnameMatchesDomains: cocok domain persis & subdomain", () => {
  assert.equal(hostnameMatchesDomains("arxiv.org", ["arxiv.org"]), true);
  assert.equal(hostnameMatchesDomains("export.arxiv.org", ["arxiv.org"]), true);
  assert.equal(hostnameMatchesDomains("notarxiv.org", ["arxiv.org"]), false);
});

test("looksLikeDirectPdfUrl: deteksi ekstensi .pdf di path", () => {
  assert.equal(looksLikeDirectPdfUrl("https://example.com/file.pdf"), true);
  assert.equal(looksLikeDirectPdfUrl("https://example.com/file.pdf?x=1"), true);
  assert.equal(looksLikeDirectPdfUrl("https://example.com/page.html"), false);
});

// ---------------------------------------------------------------------
// providers/arxiv.js
// ---------------------------------------------------------------------

test("extractArxivId: dari URL /abs/", () => {
  assert.equal(extractArxivId("https://arxiv.org/abs/2101.00001"), "2101.00001");
});

test("extractArxivId: dari URL /pdf/....pdf", () => {
  assert.equal(extractArxivId("https://arxiv.org/pdf/2101.00001.pdf"), "2101.00001");
});

test("ArxivProvider.canHandle: true untuk domain arxiv.org dengan id valid", async () => {
  const provider = new ArxivProvider();
  assert.equal(await provider.canHandle("https://arxiv.org/abs/2101.00001"), true);
});

test("ArxivProvider.canHandle: false untuk domain lain", async () => {
  const provider = new ArxivProvider();
  assert.equal(await provider.canHandle("https://example.com/abs/2101.00001"), false);
});

// ---------------------------------------------------------------------
// providers/repository.js
// ---------------------------------------------------------------------

test("matchesRepositoryPattern: deteksi pola OJS", () => {
  assert.equal(
    matchesRepositoryPattern("https://jurnal.contoh.ac.id/index.php/jt/article/view/123"),
    true,
  );
});

test("matchesRepositoryPattern: deteksi pola DSpace/EPrints", () => {
  assert.equal(matchesRepositoryPattern("https://repo.contoh.ac.id/xmlui/handle/123/456"), true);
  assert.equal(matchesRepositoryPattern("https://eprints.contoh.ac.id/id/eprint/789"), true);
});

test("matchesRepositoryPattern: false untuk URL biasa", () => {
  assert.equal(matchesRepositoryPattern("https://example.com/blog/post-1"), false);
});

// ---------------------------------------------------------------------
// providers/index.js (Provider Registry)
// ---------------------------------------------------------------------

test("findProviderForUrl: arXiv URL ditangani ArxivProvider", async () => {
  const provider = await findProviderForUrl("https://arxiv.org/abs/2101.00001");
  assert.equal(provider.name, "arXiv");
});

test("findProviderForUrl: URL tak dikenal jatuh ke GenericProvider (fallback)", async () => {
  const provider = await findProviderForUrl("https://contoh-situs-acak.test/halaman");
  assert.equal(provider.name, "Generic");
  assert.ok(provider instanceof GenericProvider);
});
