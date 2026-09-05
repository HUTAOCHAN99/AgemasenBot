const axios = require("axios");
const { fetchWithRetry } = require("../booru/safebooru");

// =====================================================
// Fitur: Cari gambar di Pinterest berdasarkan keyword ("!pin")
// -----------------------------------------------------
// Pinterest gak punya API publik resmi buat pencarian pin, jadi ini pakai
// endpoint INTERNAL yang dipakai situs pinterest.com sendiri buat nge-load
// hasil pencarian (BaseSearchResource). Ini bukan API resmi/berdokumen --
// bisa berubah atau berhenti kerja kapan saja kalau Pinterest ubah struktur
// internalnya, TAPI gak butuh API key/login sama sekali buat pencarian pin
// publik biasa, jadi cukup buat kebutuhan bot ini.
//
// Alurnya SENGAJA dibikin semirip mungkin sama Safebooru (lihat
// loadMoreCandidates/newCandidateSession di atas) supaya bisa numpang sama
// mekanisme session/"!next"/kode-sesi yang sudah ada -- bedanya cuma
// Safebooru paging pakai nomor halaman (pid), Pinterest paging pakai
// "bookmark" (token cursor buram yang dikasih balik sama responsenya).
// =====================================================
const PINTEREST_TIMEOUT_MS = 15000;
// Batas berapa kali nyoba ambil halaman berikutnya SEKALI PANGGILAN --
// jaga-jaga kalau suatu saat Pinterest balikin banyak halaman kosong
// berturut-turut (hasil sudah kefilter semua karena sudah pernah dikirim)
// tapi bookmark-nya tetap ada, biar gak nyangkut lama nunggu.
const PINTEREST_MAX_PAGES_PER_CALL = 5;

// Ambil satu "halaman" hasil pencarian Pinterest untuk sebuah keyword.
// `bookmark` = cursor dari response sebelumnya (null buat halaman pertama).
// Return { pins, bookmark } -- bookmark null/"-end-" berarti sudah halaman
// terakhir.
async function fetchPinterestPage(query, bookmark) {
  const url = "https://www.pinterest.com/resource/BaseSearchResource/get/";
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`;

  const options = {
    query,
    scope: "pins",
    isPrefetch: false,
    auto_correction_disabled: false,
  };
  if (bookmark) options.bookmarks = [bookmark];

  const res = await fetchWithRetry(url, {
    params: {
      source_url: sourceUrl,
      data: JSON.stringify({ options, context: {} }),
    },
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
      "X-Pinterest-PWS-Handler": "www/search/[scope].js",
      Accept: "application/json, text/javascript, */*, q=0.01",
      Referer: `https://www.pinterest.com${sourceUrl}`,
    },
    timeout: PINTEREST_TIMEOUT_MS,
  });

  const resourceResponse = res.data?.resource_response;
  const results = resourceResponse?.data?.results || [];
  const rawBookmark = resourceResponse?.bookmark || null;
  const nextBookmark = rawBookmark && rawBookmark !== "-end-" ? rawBookmark : null;

  const pins = results
    .filter((r) => r?.type === "pin" && r.images)
    .map((r) => {
      // Ambil resolusi terbesar yang tersedia ("orig" kalau ada, kalau
      // gak ada Pinterest biasanya tetap kasih minimal satu ukuran lain).
      const imgObj =
        r.images.orig || r.images["736x"] || Object.values(r.images)[0];

      return {
        id: r.id,
        file_url: imgObj?.url,
        width: imgObj?.width,
        height: imgObj?.height,
        source_link: `https://www.pinterest.com/pin/${r.id}/`,
      };
    })
    .filter((p) => p.file_url);

  return { pins, bookmark: nextBookmark };
}

// Bikin session baru buat pencarian keyword Pinterest baru (dipakai tiap
// kali user mulai pencarian lewat "!pin <keyword>"). pool masih kosong --
// caller wajib panggil loadMorePinterestCandidates() dulu sebelum kirim
// gambar pertama.
function newPinterestSession(query) {
  return {
    source: "pinterest",
    tag: query,
    pool: [],
    seenIds: new Set(),
    bookmark: null,
    noMore: false,
  };
}

// Isi ulang `session.pool` dengan pin-pin BARU (belum pernah dikirim di
// session ini), sama polanya kayak loadMoreCandidates buat Safebooru.
// Return true kalau pool berhasil terisi, false kalau sudah benar-benar
// habis / tidak ada hasil sama sekali.
async function loadMorePinterestCandidates(session) {
  let pagesTried = 0;

  while (!session.noMore && pagesTried < PINTEREST_MAX_PAGES_PER_CALL) {
    pagesTried++;

    const { pins, bookmark } = await fetchPinterestPage(
      session.tag,
      session.bookmark,
    );

    session.bookmark = bookmark;
    if (!bookmark) session.noMore = true;

    const fresh = pins.filter((p) => !session.seenIds.has(String(p.id)));
    if (fresh.length > 0) {
      session.pool.push(...fresh);
      return true;
    }
  }

  return false;
}

// Safebooru's s=tag&q=index endpoint ignores json=1 and always replies with
// XML (unlike s=post&q=index which does honor json=1). axios won't auto-parse
// that into an object, so res.data comes back as a raw XML string here.
// This pulls the name/count pairs out of <tag ... name="..." count=".../>
// without needing an XML parser dependency.

module.exports = {
  PINTEREST_TIMEOUT_MS,
  PINTEREST_MAX_PAGES_PER_CALL,
  fetchPinterestPage,
  newPinterestSession,
  loadMorePinterestCandidates,
};
