const axios = require("axios");
const sharp = require("sharp");
const {
  API_PAGE_SIZE,
  SAFEBOORU_TIMEOUT_MS,
  downloadImage,
} = require("../booru/safebooru");

function isBannerEligible(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= 0.95; // < 0.95 = portrait, ditolak
}

// Ambil SATU gambar acak yang ORIENTASINYA cocok buat banner !menu
// (landscape/square -- lihat isBannerEligible) -- dipakai cuma buat hiasan
// !menu, jadi cukup cepat & ringan tiap kali user ketik !menu. Gambar
// portrait DILEWATI dan dicari gambar lain (bukan langsung dipakai apa
// adanya), makanya narik beberapa halaman kalau perlu sampai nemu
// setidaknya beberapa kandidat yang layak, atau sampai halamannya habis.
async function fetchRandomImageForHelp(tag) {
  const MAX_PAGES = 3;
  const eligible = [];

  try {
    for (let pid = 0; pid < MAX_PAGES; pid++) {
      const res = await axios.get("https://safebooru.org/index.php", {
        params: {
          page: "dapi",
          s: "post",
          q: "index",
          json: 1,
          limit: API_PAGE_SIZE,
          pid,
          tags: tag,
        },
      });

      const data = Array.isArray(res.data) ? res.data : [];
      if (data.length === 0) break; // gak ada hasil sama sekali / halaman habis

      for (const p of data) {
        if (p.file_url && isBannerEligible(Number(p.width), Number(p.height))) {
          eligible.push(p);
        }
      }

      // Ini cuma hiasan, gak perlu nyisir semua halaman sampai abis --
      // begitu kandidat udah cukup buat dipilih acak, berhenti.
      if (eligible.length >= API_PAGE_SIZE) break;
      if (data.length < API_PAGE_SIZE) break; // halaman terakhir
    }
  } catch (err) {
    console.log(`⚠️ Gagal ambil gambar hiasan !menu ("${tag}"):`, err.message);
    return null;
  }

  if (eligible.length === 0) return null;

  return eligible[Math.floor(Math.random() * eligible.length)];
}

// Tag khusus buat gambar hiasan di !menu.
const HELP_IMAGE_TAG = "special_week_(umamusume)";

// Teks !menu: cuma sapaan + daftar command singkat. Penjelasan detail per
// command TIDAK ada di sini lagi -- itu baru muncul otomatis kalau user
// salah/kurang lengkap nulis command-nya (lihat COMMAND_DETAILS di bawah).
const MENU_TEXT = `
✨ *AGEMASEN BOT* ✨

Hmph... jangan salah paham. Aku cuma nunjukkin daftar command-nya, bukan berarti aku niat bantuin kamu banget.

┏━━━━━━━━━━━━━━━┓
┃ 🔎 *PENCARIAN GAMBAR*
┗━━━━━━━━━━━━━━━┛
▸ !img
▸ !pin
▸ !next
▸ !id

┏━━━━━━━━━━━━━━━┓
┃ 🎨 *STIKER*
┗━━━━━━━━━━━━━━━┛
▸ !meme
▸ !smeme
▸ !s
▸ !togif
▸ !toimg

┏━━━━━━━━━━━━━━━┓
┃ 📥 *DOWNLOAD MEDIA*
┗━━━━━━━━━━━━━━━┛
▸ !dl
▸ !dlr

┏━━━━━━━━━━━━━━━┓
┃ 🖼️ *AI UPSCALE*
┗━━━━━━━━━━━━━━━┛
▸ !hd

┏━━━━━━━━━━━━━━━┓
┃ 📄 *DOKUMEN*
┗━━━━━━━━━━━━━━━┛
▸ !ringkas
▸ !artikel

┏━━━━━━━━━━━━━━━┓
┃ 💬 *CHAT AI*
┗━━━━━━━━━━━━━━━┛
▸ Tag aku (@AgemasenBot) buat ngobrol
▸ Atau reply pesanku buat lanjut obrolan
▸ !lupain

┏━━━━━━━━━━━━━━━┓
┃ ⚙️ *LAIN-LAIN*
┗━━━━━━━━━━━━━━━┛
▸ !ping
▸ !menu

━━━━━━━━━━━━━━━━━━

Bingung cara pakai command yang mana? Ketik aja command-nya (biar salah/kurang lengkap juga gapapa), nanti aku jelasin sendiri caranya.

...B-bukan karena aku peduli sama kamu atau apa. Cuma males aja kalau pertanyaannya diulang terus.
`;

// Penjelasan detail per command. Dikirim otomatis kapan pun user salah
// nulis command ini (argumen kosong, media gak ketemu, dst), jadi user
// gak perlu buka !menu buat tau cara pakainya.
const COMMAND_DETAILS = {
  img: `🔎 *!img <tag>*

Cari gambar berdasarkan tag.
_(Kalau tag-nya terlalu umum, nanti muncul daftar pilihan. Tinggal balas pakai angkanya.)_

Tiap hasil pencarian dikasih *Kode Sesi* (angka). Siapa pun di grup boleh ketik angka itu buat lanjut ke gambar lain dari pencarian tersebut -- gak harus yang mulai duluan, dan gak akan ketuker sama pencarian orang lain karena tiap pencarian punya kodenya sendiri.

*Contoh:*
\`\`\`
!img umamusume
!img tokai_teio_(umamusume)
!img uchiha
\`\`\`

"Uchiha" itu terlalu banyak hasilnya... ya makanya pilih nomor yang muncul. Masa gitu aja harus dijelasin...`,

  pin: `📌 *!pin <keyword>*

Cari gambar di Pinterest berdasarkan keyword.

Sama kayak *!img*, tiap hasil pencarian dikasih *Kode Sesi*. Siapa pun di grup boleh ketik angka itu (atau *!next*) buat lanjut ke gambar lain dari pencarian yang sama.

*Contoh:*
\`\`\`
!pin sunset aesthetic
!pin kucing lucu
!pin desain kamar minimalis
\`\`\`

⚠️ Ini pakai fitur pencarian internal Pinterest (bukan API resmi), jadi sesekali bisa gagal/berubah sewaktu-waktu -- kalau gitu coba lagi beberapa saat.`,

  next: `➡️ *!next*

Lanjut ke gambar berikutnya dari pencarian tag/keyword yang sama (baik dari *!img* maupun *!pin*).

💡 Selain ketik *!next*, bisa juga ketik *Kode Sesi*-nya (angka yang muncul di hasil gambar) -- ini bisa dipakai siapa saja di grup, gak cuma yang mulai pencariannya.

⚠️ Pakai *!img <tag>* atau *!pin <keyword>* dulu sebelum pakai ini.`,

  id: `🆔 *!id <kode>*

Buka lagi gambar tertentu berdasarkan kode ID-nya.

*Contoh:*
\`\`\`
!id 12345
\`\`\``,

  meme: `🎨 *!meme <teks>*

Ubah GIF/video jadi stiker animasi dengan teks.

*Cara pakai:*
• Kirim GIF/video dengan caption \`!meme teks\`.
• Atau kirim GIF/video-nya dulu, terus *reply* pakai \`!meme teks\`.

Mau dua baris? Pisahkan pakai \`|\`. Emoji WhatsApp juga bisa dipakai.

*Contoh:*
\`\`\`
!meme HALO DUNIA|SELAMAT PAGI
\`\`\`

(Buat stiker/foto, pakai *!smeme* ya)`,

  smeme: `🎨 *!smeme <teks>*

Ubah stiker (emote) atau foto jadi stiker bertulisan teks.

*Cara pakai:*
• Kirim stiker/foto dengan caption \`!smeme teks\`.
• Atau kirim medianya dulu, terus *reply* pakai \`!smeme teks\`.

Mau dua baris? Pisahkan pakai \`|\`. Emoji WhatsApp juga bisa dipakai.

*Contoh:*
\`\`\`
!smeme awokawokawok😂
\`\`\`

(Buat GIF/video, pakai *!meme* ya)`,

  s: `🎨 *!s*

Ubah GIF/video/stiker/foto apa pun jadi stiker biasa, tanpa teks.

*Cara pakai:*
• Kirim medianya dengan caption \`!s\`.
• Atau kirim medianya dulu, terus *reply* dengan \`!s\`.`,

  togif: `🎞️ *!togif*

Ubah stiker ANIMASI balik jadi GIF (dikirim sebagai video yang muter-loop kayak GIF).

*Cara pakai:*
• Kirim stikernya dengan caption \`!togif\`.
• Atau kirim stikernya dulu, terus *reply* dengan \`!togif\`.

⚠️ Cuma buat stiker animasi. Kalau stikernya statis (bukan animasi), pakai *!toimg* aja.`,

  toimg: `🖼️ *!toimg*

Ubah stiker jadi gambar biasa (PNG). Kalau stikernya animasi, yang diambil cuma frame pertamanya.

*Cara pakai:*
• Kirim stikernya dengan caption \`!toimg\`.
• Atau kirim stikernya dulu, terus *reply* dengan \`!toimg\`.`,

  dl: `📥 *!dl <link>*

Download video/audio dari sebuah link: YouTube, Bilibili, Facebook (video/reel/postingan video), TikTok, Instagram, X/Twitter, dan situs lain yang didukung.

Kalau link-nya ternyata postingan *foto* (carousel Instagram, atau slideshow foto+musik TikTok), bot otomatis kirim semua fotonya satu-satu, plus musiknya (kalau ada) di akhir. Atau pakai *!dlr* langsung kalau sudah tau link-nya foto/carousel.

*Contoh:*
\`\`\`
!dl https://youtu.be/xxxxxxxxxxx
!dl https://youtu.be/xxxxxxxxxxx mp3
!dl https://www.tiktok.com/@user/video/xxxxxxxxxxx
!dl https://www.bilibili.com/video/xxxxxxxxxxx
!dl https://www.facebook.com/reel/xxxxxxxxxxx
!dl https://www.instagram.com/p/xxxxxxxxxxx
\`\`\`

Bisa langsung tambahin *mp3* atau *mp4* setelah link-nya kalau mau override format audio/video (default: video).

⚠️ Batas ukuran file *95MB*.`,

  dlr: `📷 *!dlr <link>*

Download khusus postingan *foto/carousel* -- Instagram carousel (beberapa foto digeser) atau TikTok mode foto+musik/slideshow. Semua foto dikirim satu-satu sesuai urutan aslinya, terus musiknya (kalau ada) di akhir.

Beda dari *!dl*: langsung ambil jalur foto tanpa nyoba download video dulu -- lebih cepat kalau kamu sudah tau link-nya carousel/slideshow foto (untuk video/reel biasa, tetap pakai *!dl*).

*Contoh:*
\`\`\`
!dlr https://www.instagram.com/p/xxxxxxxxxxx
!dlr https://www.tiktok.com/@user/video/xxxxxxxxxxx
\`\`\`

⚠️ Batas ukuran file *95MB* per foto. Postingan Facebook yang isinya cuma FOTO (bukan video) tidak didukung -- ini murni buat Instagram/TikTok.`,

  ringkas: `📄 *!ringkas [instruksi tambahan]*

Ringkas GARIS BESAR isi dokumen PDF pakai AI (Groq). Dokumen panjang (100+ halaman) otomatis dibaca per-bagian dulu baru digabung jadi 1 ringkasan, jadi tetap kebaca semuanya -- bukan cuma bagian awal doang.

*Cara pakai:*
• Kirim file PDF dengan caption \`!ringkas\`.
• Atau kirim PDF-nya dulu, terus *reply* dengan \`!ringkas\`.
• Boleh tambahin instruksi setelahnya, mis. \`!ringkas fokus ke bagian kesimpulan aja\`.

*Contoh:*
\`\`\`
!ringkas
!ringkas jelasin poin-poin utamanya aja
\`\`\`

💡 Setelah diringkas, kamu bisa nanya-nanya lebih detail soal isi dokumennya lewat chat biasa (tag @AgemasenBot / reply pesan bot) selama beberapa jam ke depan -- bot masih "inget" isi lengkap dokumennya, gak cuma ringkasannya.

⚠️ Cuma baca teks yang ADA di PDF-nya (PDF hasil scan/foto tanpa lapisan teks gak bisa dibaca). Dokumen yang EKSTREM panjang tetap ada batas mutlaknya, sisanya dipotong.`,

  artikel: `📚 *!artikel <URL>*

Download artikel/dokumen dari link yang PUBLIK dan LEGAL aja (arXiv, DOAJ, Internet Archive, repository kampus, OJS, atau link PDF langsung). Kalau file-nya gak tersedia langsung, bot bakal cari versi Open Access resminya dulu lewat DOI/judul sebelum nyerah.

*Contoh:*
\`\`\`
!artikel https://arxiv.org/abs/2101.00001
!artikel https://doaj.org/article/xxxxxxxx
\`\`\`

⚠️ Bot ini SENGAJA gak bakal nyoba nembus paywall, login, CAPTCHA, atau DRM. Kalau memang gak ada versi publiknya, kamu bakal dikasih link ke artikel aslinya aja.`,

  lupain: `🧠 *!lupain*

Hapus ingatan obrolan chat AI (tsundere) kamu sama bot -- termasuk ingatan isi dokumen PDF dari !ringkas kalau ada -- bot bakal "lupa" semuanya dan mulai dari nol lagi.

Command pencarian gambar (!img/!next/!id) TIDAK kepengaruh, ini cuma buat ingatan obrolan chat AI-nya doang.`,
};


// Batas ukuran banner !menu (cuma buat jaga-jaga biar filenya gak
// kegedean/ngirim gambar mentah beresolusi tinggi). BUKAN kanvas tetap --
// rasio asli gambar dipertahankan (lihat toMenuBanner), gak dipaksa 16:9
// lagi. Ini aman dipakai karena fetchRandomImageForHelp sudah menyaring
// cuma gambar landscape/square yang lolos (lihat isBannerEligible), jadi
// gak akan ada sumber portrait yang perlu di-crop.
const MENU_BANNER_MAX_WIDTH = 1280;
const MENU_BANNER_MAX_HEIGHT = 1280;

async function toMenuBanner(buffer) {
  return sharp(buffer)
    .resize(MENU_BANNER_MAX_WIDTH, MENU_BANNER_MAX_HEIGHT, {
      fit: "inside", // cuma diperkecil kalau kelewat besar, TIDAK di-crop/pad -- rasio asli tetap
      withoutEnlargement: true, // gambar yang udah kecil gak dipaksa diperbesar
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function sendMenu(sock, jid) {
  const post = await fetchRandomImageForHelp(HELP_IMAGE_TAG);

  if (post) {
    try {
      const rawBuffer = await downloadImage(post.file_url);
      const bannerBuffer = await toMenuBanner(rawBuffer);
      await sock.sendMessage(jid, { image: bannerBuffer, caption: MENU_TEXT });
      return;
    } catch (err) {
      console.log(
        "⚠️ Gagal kirim gambar hiasan !menu, fallback ke teks polos:",
        err.message,
      );
    }
  }

  // Fallback: kalau gambar gagal diambil/dikirim, tetap kirim teksnya saja
  // supaya !menu tidak pernah gagal total gara-gara masalah di sisi gambar.
  await sock.sendMessage(jid, { text: MENU_TEXT });
}

// Kirim penjelasan detail command tertentu (dipanggil otomatis saat user
// salah/kurang lengkap nulis command itu).
async function sendCommandDetail(sock, jid, commandKey) {
  await sock.sendMessage(jid, { text: COMMAND_DETAILS[commandKey] });
}

module.exports = {
  HELP_IMAGE_TAG,
  MENU_TEXT,
  COMMAND_DETAILS,
  MENU_BANNER_MAX_WIDTH,
  MENU_BANNER_MAX_HEIGHT,
  isBannerEligible,
  fetchRandomImageForHelp,
  toMenuBanner,
  sendMenu,
  sendCommandDetail,
};
