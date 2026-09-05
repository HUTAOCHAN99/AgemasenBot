const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { PDFParse } = require("pdf-parse");

const { runArtikelCommand } = require("../commands/artikel");
const {
  handleTsundereChat,
  forgetGroqChat,
  summarizeDocumentText,
  saveDocumentContext,
  DOC_HARD_MAX_CHARS,
  SUMMARY_SINGLE_PASS_MAX_CHARS,
  SUMMARY_CHUNK_CHARS,
  DOC_CONTEXT_TTL_MS,
} = require("../../agemasenTsundere");

const { getSenderJid, getSessionKey, isOwnerMsg } = require("../utils/whatsapp");
const { isBotDisabledFor } = require("../state/botState");
const {
  handleWhoamiCommand,
  sendNgambekReply,
  handleBotSwitchCommand,
  handleListGroupsCommand,
} = require("../features/owner/ownerCommands");

const { sendMenu, sendCommandDetail } = require("../features/menu/menu");

const {
  sessions,
  touchSession,
  chatCodeSessions,
  assignSessionCode,
} = require("../features/booru/sessionStore");
const {
  searchAndSendImage,
  pickRandom,
  downloadImage,
  buildCaption,
  sessionLabel,
  errorReplyText,
  newCandidateSession,
  loadMoreCandidates,
  fetchMatchingTags,
  fetchById,
  buildTagChoiceList,
} = require("../features/booru/safebooru");
const {
  newPinterestSession,
  loadMorePinterestCandidates,
} = require("../features/pinterest/pinterest");

const {
  findPdfSource,
  findGifSource,
  findStickerSource,
  findAnySource,
  findStickerOnlySource,
  downloadGifBuffer,
  isStillMedia,
} = require("../features/media/detect");
const {
  animatedStickerToGifVideo,
  stickerToImageBuffer,
} = require("../features/media/sticker");
const { gifToTextSticker, mediaToSticker } = require("../features/meme/stickerBuilder");

const {
  findImageSource,
  parseHdScaleArg,
  upscaleImageWithRealEsrgan,
  enqueueHdJob,
  getHdActiveWorkers,
  HD_ENGINE,
  HD_QUEUE_CONCURRENCY,
} = require("../features/upscale/realesrgan");
const { upscaleImageWithSharp } = require("../features/upscale/sharpUpscale");

const {
  getYtdlpBackoffRemainingMs,
  formatDurationId,
} = require("../features/download/ytdlp");
const {
  handleDlDownload,
  handleDlrDownload,
} = require("../features/download/gallerydl");

// Tangani satu event "messages.upsert" dari Baileys. Ini adalah router
// utama semua command (!ping, !img, !meme, !dl, dst) -- pisahan logic
// tiap fitur sendiri ada di src/features/*, di sini cuma orkestrasinya.
async function handleMessagesUpsert(sock, { messages, type }) {
    if (type !== "notify") return;

    const msg = messages[0];

    if (!msg?.message) return;

    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const sessionKey = getSessionKey(msg);

    const text = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.videoMessage?.caption ||
      msg.message.imageMessage?.caption ||
      msg.message.documentMessage?.caption ||
      ""
    ).trim();

    // =====================
    // !whoami -- debug: cek jid apa yang kedeteksi buat pengirim pesan ini
    // (berguna kalau owner check meleset gara-gara @lid dsb). Ditaruh
    // paling atas juga biar bisa dipakai walau grup lagi dinonaktifin.
    // =====================
    if (await handleWhoamiCommand(sock, msg, { jid, text })) {
      return;
    }

    // =====================
    // !bot on / !bot off / !bot status -- KHUSUS owner, PALING ATAS
    // supaya tetap jalan walaupun grup lagi dinonaktifin (owner harus
    // selalu bisa nyalain lagi).
    // =====================
    if (await handleBotSwitchCommand(sock, msg, { jid, text })) {
      return;
    }

    // =====================
    // !listgrup -- KHUSUS owner, PALING ATAS juga (sama kayak !bot),
    // biar owner tetap bisa cek daftar grup walau lagi di grup yang
    // dinonaktifin.
    // =====================
    if (await handleListGroupsCommand(sock, msg, { jid, text })) {
      return;
    }

    // =====================
    // Saklar aktif/nonaktif per grup: kalau grup ini lagi DIMATIIN dan
    // pengirimnya BUKAN owner, bot "ngambek" -- gak proses command/fitur
    // apa pun lagi (termasuk chat AI tsundere di bawah). Owner sendiri
    // gak kena blokir ini sama sekali.
    // =====================
    if (isBotDisabledFor(jid) && !isOwnerMsg(msg)) {
      if (text.startsWith("!")) {
        await sendNgambekReply(sock, jid);
      }
      return;
    }

    // =====================
    // !ping
    // =====================
    if (text === "!ping") {
      await sock.sendMessage(jid, { text: "🏓 Pong!" });
      return;
    }

    // =====================
    // !lupain -- reset ingatan obrolan chat AI (tsundere) buat pengirim ini
    // =====================
    if (text === "!lupain") {
      const had = forgetGroqChat(sessionKey);
      await sock.sendMessage(jid, {
        text: had
          ? "Hmph, oke... sudah aku lupain semua obrolan kita. Mulai dari nol lagi ya. 😤"
          : "Lho, kita kan belum pernah ngobrol apa-apa. Gak ada yang perlu dilupain, dasar. 🙄",
      });
      return;
    }

    // =====================
    // !menu
    // =====================
    if (text === "!menu") {
      await sendMenu(sock, jid);
      return;
    }

    // =====================
    // !artikel <URL> -> Article/Document Downloader. Deteksi sumber
    // (arXiv/DOAJ/Internet Archive/repository kampus/OJS/dll lewat
    // Provider Registry di src/providers), coba download PDF publiknya,
    // atau cari versi Open Access resmi kalau gak ada file langsung.
    // Gak pernah nyoba bypass paywall/login/CAPTCHA -- lihat src/commands/artikel.js.
    // =====================
    if (text === "!artikel" || text.startsWith("!artikel ")) {
      const articleUrl = text.slice("!artikel".length).trim();
      const senderId = getSenderJid(msg);
      await runArtikelCommand(sock, jid, articleUrl, senderId);
      return;
    }

    // =====================
    // !ringkas [instruksi tambahan] -> baca teks dari dokumen PDF (langsung
    // dikirim dengan caption, atau reply ke PDF yang sudah ada), lalu minta
    // Groq bikin ringkasan GARIS BESARnya (dokumen panjang otomatis diproses
    // per-bagian dulu, lihat summarizeDocumentText di agemasenTsundere.js).
    // Teks lengkap dokumennya ikut "diinget" di sesi ini (lihat
    // saveDocumentContext) selama DOC_CONTEXT_TTL_MS, jadi user bisa nanya
    // lebih lanjut soal isi dokumennya lewat chat AI (tag bot/reply) setelah
    // ini, gak cuma dapet ringkasannya doang.
    //
    // Kalau PDF-nya hasil scan/foto tanpa lapisan teks, pdf-parse gak bakal
    // nemu teks apa-apa -- kita kasih tau user daripada maksain ringkasan
    // kosong/ngasal.
    // =====================
    if (text === "!ringkas" || text.startsWith("!ringkas ")) {
      const userInstruction = text.slice("!ringkas".length).trim();
      const pdfSource = findPdfSource(msg);

      if (!pdfSource) {
        await sendCommandDetail(sock, jid, "ringkas");
        return;
      }

      try {
        await sock.sendMessage(jid, {
          text: "Hmph, tunggu bentar, aku bacain dulu dokumennya... 📄",
        });

        const fakeMsg = { key: pdfSource.refKey, message: pdfSource.content };
        const pdfBuffer = await downloadMediaMessage(fakeMsg, "buffer", {});
        const fileName = pdfSource.content.documentMessage?.fileName || "dokumen.pdf";

        const parser = new PDFParse({ data: pdfBuffer });
        let rawText;
        try {
          const result = await parser.getText();
          rawText = result.text || "";
        } finally {
          await parser.destroy();
        }

        // Buang penanda antar-halaman ("-- N of M --") yang disisipkan
        // pdf-parse -- itu bukan bagian isi dokumen, cuma bikin bising
        // buat model pas diringkas.
        const cleanedTextFull = rawText
          .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        // Jaring pengaman terakhir buat dokumen yang BENERAN ekstrem
        // (ratusan-ribuan halaman) -- di luar ini dipotong total, gak ikut
        // diproses maupun disimpan sebagai ingatan.
        const hardTruncated = cleanedTextFull.length > DOC_HARD_MAX_CHARS;
        const cleanedText = hardTruncated
          ? cleanedTextFull.slice(0, DOC_HARD_MAX_CHARS)
          : cleanedTextFull;

        // Kalau bakal lewat proses map-reduce (dokumen panjang), kasih tau
        // user duluan biar gak bingung nunggu -- sekalian estimasi jumlah
        // bagian yang bakal diproses satu-satu.
        if (cleanedText.length > SUMMARY_SINGLE_PASS_MAX_CHARS) {
          const estChunks = Math.ceil(cleanedText.length / SUMMARY_CHUNK_CHARS);
          await sock.sendMessage(jid, {
            text:
              `Dokumennya lumayan panjang (kira-kira ${estChunks} bagian yang aku baca satu-satu), ` +
              `jadi agak lama dikit ya, sabar! Bukan berarti aku males, cuma... yah, gitu deh. 😤`,
          });
        }

        const senderName = msg.pushName || "";
        let lastProgressSentAt = 0;
        const { chunks } = await summarizeDocumentText(cleanedText, {
          senderName,
          fileName,
          userInstruction,
          truncated: hardTruncated,
          // Update presence "typing..." tiap beberapa bagian biar user tau
          // bot masih proses (bukan macet), tanpa spam pesan tiap bagian.
          onProgress: async (current, total) => {
            const now = Date.now();
            if (now - lastProgressSentAt < 8000 && current !== total) return;
            lastProgressSentAt = now;
            await sock.sendPresenceUpdate("composing", jid);
          },
        });

        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(
            jid,
            { text: chunks[i] },
            i === 0 ? { quoted: msg } : {},
          );
        }

        // Simpan teks lengkapnya (bukan ringkasannya) ke sesi ini biar bisa
        // dipakai lagi kalau user nanya-nanya lanjutan soal isi dokumennya.
        saveDocumentContext(sessionKey, { text: cleanedText, fileName });

        const ttlHours = Math.round(DOC_CONTEXT_TTL_MS / (60 * 60 * 1000));
        await sock.sendMessage(jid, {
          text:
            `💡 Kalau mau nanya-nanya lebih detail soal isi dokumen ini, tinggal tag aku (@AgemasenBot) atau ` +
            `reply pesanku -- masih inget isinya kok, sekitar ${ttlHours} jam ke depan. ...B-bukan berarti aku niat ` +
            `bantuin lama-lama, ya!`,
        });
      } catch (err) {
        console.log("[!ringkas] gagal:", err.message || err);
        const isConfigError = /GROQ_API_KEY/.test(err.message || "");
        await sock.sendMessage(jid, {
          text: isConfigError
            ? "Hmph, aku belum dikasih GROQ_API_KEY sama pemilikku. Bukan salahku ya! 😤"
            : "Duh, aku gagal bacain/ringkas dokumennya. Coba cek lagi filenya bener PDF & gak rusak, terus coba lagi. 💢",
        });
      }

      return;
    }

    // =====================
    // !hd / !hd 2x / !hd 4x  -> AI Image Upscaler (Real-ESRGAN lokal).
    // Lihat komentar lengkap di definisi upscaleImageWithRealEsrgan() di
    // atas buat detail alur & alasan desainnya.
    // =====================
    if (text === "!hd" || text.startsWith("!hd ")) {
      const argPart = text.slice(4).trim();
      const parsedScale = parseHdScaleArg(argPart);

      if (!parsedScale.ok) {
        await sock.sendMessage(jid, {
          text: "❌ Scale tidak tersedia.\n\nGunakan:\n!hd\n!hd 2x\n!hd 4x",
        });
        return;
      }

      const source = findImageSource(msg);

      if (!source) {
        await sock.sendMessage(jid, {
          text:
            "📷 Kirim atau reply gambar yang ingin dibuat lebih HD.\n" +
            "Contoh:\n!hd\n!hd 2x\n!hd 4x",
        });
        return;
      }

      const { scale } = parsedScale;

      // Kasih tau DULUAN kalau bakal ngantre (sebelum enqueueHdJob),
      // biar user gak nunggu diem tanpa kabar kalau lagi ada proses
      // "!hd" lain yang jalan.
      if (getHdActiveWorkers() >= HD_QUEUE_CONCURRENCY) {
        await sock.sendMessage(jid, {
          text:
            "⏳ Server sedang memproses gambar lain.\n\n" +
            "Permintaanmu masuk antrean.",
        });
      }

      const engineLabel =
        HD_ENGINE === "realesrgan"
          ? "🤖 AI Super Resolution"
          : "✨ Upscale + Penajaman";

      try {
        const resultBuffer = await enqueueHdJob(async () => {
          await sock.sendMessage(jid, {
            text: `⏳ Memproses gambar...\n\n${engineLabel}\n📐 Scale: ${scale}x`,
          });

          const inputBuffer = await downloadGifBuffer(
            source.content,
            source.refKey,
          );

          return HD_ENGINE === "realesrgan"
            ? upscaleImageWithRealEsrgan(inputBuffer, scale)
            : upscaleImageWithSharp(inputBuffer, scale);
        });

        const successLine =
          HD_ENGINE === "realesrgan"
            ? "✨ Gambar berhasil di-upscale menggunakan AI."
            : "✨ Gambar berhasil di-upscale & dipertajam.";

        await sock.sendMessage(jid, {
          image: resultBuffer,
          caption: `✅ Berhasil!\n\n${successLine}\n📐 Scale: ${scale}x`,
        });
      } catch (err) {
        console.log("=== [!hd] gagal ===");
        console.log(err.message || err);
        console.log("===================");
        await sock.sendMessage(jid, {
          text: "❌ Gagal memproses gambar.\n\nSilakan coba lagi dengan gambar lain.",
        });
      }

      return;
    }

    // =====================
    // Balasan angka untuk memilih karakter dari daftar disambiguasi
    // ATAU untuk lanjut (!next) pakai kode sesi.
    //
    // KEDUANYA sama-sama "ketik angka" jadi wajib dibedakan biar gak
    // bentrok satu sama lain:
    //   - Pilihan karakter: HARUS reply (quote) ke pesan daftar tag-nya
    //     (dicek lewat ctx.stanzaId === session.promptMsgId). Ini juga
    //     yang bikin gak ke-trigger cuma gara-gara kebetulan session milik
    //     pengirim ini masih ada pendingTagChoices lama yang belum expired.
    //   - Kode sesi: ketik angka POLOS (bukan reply ke daftar tag), dicek
    //     ke chatCodeSessions seperti biasa.
    // Dipakai oleh "!next" dan lanjut-pakai-kode-sesi: pool session ini
    // kosong (semua post yang sudah di-load sudah pernah dikirim), jadi
    // coba ambil halaman berikutnya dari Safebooru. Kalau ternyata SEMUA
    // halaman untuk tag ini sudah habis (berarti user sudah lihat semua
    // gambar yang ada), siklus direset dari awal (boleh muncul ulang)
    // supaya user tetap dapat gambar, bukan mentok dead-end.
    async function refillPool(session) {
      if (session.pool.length > 0) return true;

      const isPinterest = session.source === "pinterest";
      const loader = isPinterest
        ? loadMorePinterestCandidates
        : loadMoreCandidates;

      if (await loader(session)) return true;

      session.seenIds.clear();
      if (isPinterest) {
        session.bookmark = null;
        session.noMore = false;
      } else {
        session.pid = 0;
        session.noMorePages = false;
      }

      if (await loader(session)) {
        await sock.sendMessage(jid, {
          text: "🔁 Semua gambar untuk tag/keyword ini sudah pernah ditampilkan. Mulai ulang dari awal ya.",
        });
        return true;
      }

      return false; // tag/keyword ini memang tidak punya gambar sama sekali
    }

    // =====================
    if (/^\d+$/.test(text)) {
      const session = sessions.get(sessionKey);
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const isReplyToTagPrompt =
        session?.pendingTagChoices &&
        ctx?.stanzaId &&
        session.promptMsgId &&
        ctx.stanzaId === session.promptMsgId;

      if (isReplyToTagPrompt) {
        touchSession(session);
        const idx = parseInt(text, 10) - 1;
        const choice = session.pendingTagChoices[idx];

        if (!choice) {
          await sock.sendMessage(jid, {
            text: `⚠️ Nomor tidak valid. Pilih 1-${session.pendingTagChoices.length}.`,
          });
          return;
        }

        try {
          const candidateSession = newCandidateSession(choice.name);
          const hasCandidates = await loadMoreCandidates(candidateSession);

          if (!hasCandidates) {
            await sock.sendMessage(jid, {
              text: "❌ Gambar untuk karakter ini tidak ditemukan.",
            });
            return;
          }

          await searchAndSendImage(
            sock,
            jid,
            sessionKey,
            choice.name,
            candidateSession,
          );
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: errorReplyText(err),
          });
        }

        return;
      }

      // Bukan reply ke daftar disambiguasi -> cek apakah angka ini KODE
      // SESI pencarian yang lagi aktif di chat ini. Kode sesi ini
      // scope-nya per-chat (bukan per-pengirim), jadi siapa pun di grup
      // yang sama boleh pakai kode punya orang lain buat lanjut (!next)
      // pencarian itu, dan ini tidak bentrok dengan kode punya pencarian
      // lain karena tiap pencarian dapat nomor kodenya sendiri-sendiri.
      const codeNum = parseInt(text, 10);
      const codeSession = chatCodeSessions.get(jid)?.get(codeNum);

      if (codeSession) {
        touchSession(codeSession);
        try {
          const ok = await refillPool(codeSession);

          if (!ok) {
            await sock.sendMessage(jid, {
              text: "❌ Tidak ada gambar lain untuk tag ini.",
            });
            return;
          }

          const post = pickRandom(codeSession);
          codeSession.lastId = post.id;

          const buffer = await downloadImage(post.file_url);
          const karakterLabel = sessionLabel(codeSession);

          await sock.sendMessage(jid, {
            image: buffer,
            caption: buildCaption(post, karakterLabel, {
              isNext: true,
              code: codeNum,
              source: codeSession.source,
            }),
          });
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: errorReplyText(err),
          });
        }

        return;
      }

      // angka tanpa daftar pending & bukan kode sesi yang aktif -> biarkan
      // lewat, bukan command. TAPI kalau ternyata dia sebenarnya PUNYA
      // daftar tag pending (cuma gak reply pesannya), kasih tau caranya
      // biar gak bingung kenapa gak ada respons sama sekali.
      if (session?.pendingTagChoices) {
        await sock.sendMessage(jid, {
          text:
            "⚠️ Masih ada daftar karakter yang belum dipilih.\n\n" +
            "➡️ Buat *pilih karakter*: reply pesan daftarnya, lalu ketik nomor urutnya.\n" +
            "➡️ Buat *lanjut sesi lain* pakai kode: ketik kodenya langsung tanpa reply.",
        });
        return;
      }
    }

    // =====================
    // !meme <teks>  -> KHUSUS GIF/video jadi stiker bertext.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!meme" || text.startsWith("!meme ")) {
      const memeText = text.slice(5).trim();

      if (!memeText) {
        await sendCommandDetail(sock, jid, "meme");
        return;
      }

      const source = findGifSource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "meme");
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

        const gifBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const stickerBuffer = await gifToTextSticker(gifBuffer, memeText);

        // isAnimated WAJIB diisi manual -- Baileys TIDAK auto-deteksi dari
        // isi buffer webp-nya. Kalau ini kelewat, reply ke stiker ini nanti
        // (mis. lewat !smeme) bakal salah dianggap "gambar diam" oleh
        // isStillMedia(), yang berakibat fps/durasi GAK dipangkas sama
        // sekali pas di-render ulang -> ukurannya meledak jauh di atas
        // limit WA. !meme sumbernya selalu GIF/video (lihat findGifSource),
        // jadi selalu animasi.
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: true,
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !smeme <teks>  -> KHUSUS stiker (emote)/foto jadi stiker bertext.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!smeme" || text.startsWith("!smeme ")) {
      const memeText = text.slice(7).trim();

      if (!memeText) {
        await sendCommandDetail(sock, jid, "smeme");
        return;
      }

      const source = findStickerSource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "smeme");
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

        const mediaBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const isStill = isStillMedia(source.content);
        const stickerBuffer = await gifToTextSticker(
          mediaBuffer,
          memeText,
          isStill,
        );

        // Sama kayak di !meme: isAnimated wajib diisi manual sesuai hasil
        // deteksi sumbernya sendiri, biar kalau stiker INI di-reply lagi
        // nanti, klasifikasinya benar (lihat komentar di !meme).
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: !isStill,
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !s  -> GIF/video/stiker(emote)/foto jadi stiker polos, TANPA teks.
    // Ini tetap generik (nerima semua jenis media), karena tujuannya
    // cuma bikin stiker biasa tanpa teks, bukan soal animasi vs statis.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!s") {
      const source = findAnySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "s");
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

        const mediaBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const isStill = isStillMedia(source.content);
        const stickerBuffer = await mediaToSticker(mediaBuffer, isStill);

        // Sama kayak di !meme/!smeme -- isAnimated wajib diisi manual.
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: !isStill,
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !togif  -> stiker ANIMASI jadi "GIF" (dikirim sbg video+gifPlayback,
    // karena WhatsApp memang selalu begitu buat GIF).
    // Bisa dari caption langsung di stikernya, atau reply ke stikernya.
    // =====================
    if (text === "!togif") {
      const source = findStickerOnlySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "togif");
        return;
      }

      if (!source.content.stickerMessage.isAnimated) {
        await sock.sendMessage(jid, {
          text:
            "⚠️ Itu stiker biasa (bukan animasi), jadi gak ada apa-apanya buat dijadiin GIF.\n" +
            "Mau dijadiin gambar? Pakai *!toimg*.",
        });
        return;
      }

      try {
        await sock.sendMessage(jid, { text: "⏳ Membuat GIF..." });

        const stickerBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const gifVideoBuffer = await animatedStickerToGifVideo(stickerBuffer);

        await sock.sendMessage(jid, {
          video: gifVideoBuffer,
          gifPlayback: true,
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat GIF.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !toimg  -> stiker (biasa/statis, atau animasi -> ambil frame
    // pertamanya) jadi gambar biasa.
    // Bisa dari caption langsung di stikernya, atau reply ke stikernya.
    // =====================
    if (text === "!toimg") {
      const source = findStickerOnlySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "toimg");
        return;
      }

      try {
        const stickerBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const imageBuffer = await stickerToImageBuffer(stickerBuffer);

        await sock.sendMessage(jid, { image: imageBuffer });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat gambar.\n${err.message || ""}`,
        });
      }

      return;
    }

    // =====================
    // !img <tag>
    // =====================
    if (text === "!img" || text.startsWith("!img ")) {
      const tag = text.slice(4).trim();

      if (!tag) {
        await sendCommandDetail(sock, jid, "img");
        return;
      }

      try {
        const directSession = newCandidateSession(tag);
        const hasDirectHit = await loadMoreCandidates(directSession);

        if (hasDirectHit) {
          await searchAndSendImage(sock, jid, sessionKey, tag, directSession);
          return;
        }

        // Tag persis tidak ketemu -> cari tag-tag serupa untuk dipilih
        const matches = await fetchMatchingTags(tag);

        if (matches.length === 0) {
          await sock.sendMessage(jid, {
            text: "❌ Gambar tidak ditemukan.",
          });
          return;
        }

        if (matches.length === 1) {
          // cuma ada 1 kandidat, langsung pakai tanpa nanya
          const onlySession = newCandidateSession(matches[0].name);
          const hasOnly = await loadMoreCandidates(onlySession);

          if (!hasOnly) {
            await sock.sendMessage(jid, {
              text: "❌ Gambar tidak ditemukan.",
            });
            return;
          }

          await searchAndSendImage(
            sock,
            jid,
            sessionKey,
            matches[0].name,
            onlySession,
          );
          return;
        }

        const pendingSession = touchSession({ pendingTagChoices: matches });
        sessions.set(sessionKey, pendingSession);

        const sentMsg = await sock.sendMessage(jid, {
          text: buildTagChoiceList(matches),
        });
        // Simpan ID pesan daftar tag ini, dipakai buat mastiin nanti angka
        // balasan BENERAN nge-reply pesan ini (bukan sekadar ketik angka
        // polos) -- lihat pengecekan `ctx.stanzaId` di handler balasan
        // angka. Ini yang bikin gak bentrok sama kode sesi (!next pakai
        // angka juga, tapi tanpa reply).
        pendingSession.promptMsgId = sentMsg?.key?.id || null;
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err),
        });
      }

      return;
    }

    // =====================
    // !pin <keyword>  -> cari gambar di Pinterest berdasarkan keyword.
    // Numpang sama mekanisme session/"!next"/kode-sesi yang dipakai !img
    // (lihat searchAndSendImage & sessionLabel) -- bedanya cuma sumber
    // datanya (lihat komentar panjang di newPinterestSession/
    // fetchPinterestPage soal caranya).
    // =====================
    if (text === "!pin" || text.startsWith("!pin ")) {
      const keyword = text.slice(4).trim();

      if (!keyword) {
        await sendCommandDetail(sock, jid, "pin");
        return;
      }

      try {
        const pinSession = newPinterestSession(keyword);
        const hasHit = await loadMorePinterestCandidates(pinSession);

        if (!hasHit) {
          await sock.sendMessage(jid, {
            text: "❌ Gambar tidak ditemukan di Pinterest untuk keyword ini.",
          });
          return;
        }

        await searchAndSendImage(sock, jid, sessionKey, keyword, pinSession);
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err),
        });
      }

      return;
    }

    // =====================
    // !next
    // =====================
    if (text === "!next") {
      const session = sessions.get(sessionKey);

      if (!session) {
        await sendCommandDetail(sock, jid, "next");
        return;
      }

      touchSession(session);

      try {
        const ok = await refillPool(session);

        if (!ok) {
          await sock.sendMessage(jid, {
            text: "❌ Tidak ada gambar lain untuk tag ini.",
          });
          return;
        }

        const post = pickRandom(session);
        session.lastId = post.id;

        const buffer = await downloadImage(post.file_url);
        const karakterLabel = sessionLabel(session);

        await sock.sendMessage(jid, {
          image: buffer,
          caption: buildCaption(post, karakterLabel, {
            isNext: true,
            code: session.code,
            source: session.source,
          }),
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err),
        });
      }

      return;
    }

    // =====================
    // !id <kode>
    // =====================
    if (text === "!id" || text.startsWith("!id ")) {
      const id = text.slice(3).trim();

      if (!id || !/^\d+$/.test(id)) {
        await sendCommandDetail(sock, jid, "id");
        return;
      }

      try {
        const post = await fetchById(id);

        if (!post) {
          await sock.sendMessage(jid, {
            text: "❌ Kode gambar tidak ditemukan.",
          });
          return;
        }

        const buffer = await downloadImage(post.file_url);

        await sock.sendMessage(jid, {
          image: buffer,
          caption: buildCaption(post, "-"),
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: "Terjadi kesalahan.",
        });
      }

      return;
    }

    // =====================
    // !dlstatus -- cek status backoff rate-limit YouTube langsung dari
    // WhatsApp, gak perlu buka Railway Logs buat tau kondisinya.
    // =====================
    if (text === "!dlstatus") {
      const remainingMs = getYtdlpBackoffRemainingMs();
      if (remainingMs > 0) {
        await sock.sendMessage(jid, {
          text:
            `⏳ Lagi backoff (kena rate-limit YouTube). ` +
            `Sisa waktu tunggu: ~${formatDurationId(remainingMs)}.\n` +
            `Bot bakal otomatis coba lagi setelah waktu itu lewat -- ` +
            `!dl YouTube bakal ditolak dulu sementara ini biar gak nambah beban ke IP-nya.`,
        });
      } else {
        await sock.sendMessage(jid, {
          text:
            "✅ Gak lagi kena backoff. !dl YouTube seharusnya bisa dicoba normal.\n" +
            "(Catatan: ini status TERAKHIR YANG TERCATAT dari percobaan sebelumnya -- " +
            "kalau dari deploy terakhir belum ada yang pernah nyoba !dl sama sekali, " +
            "status ini belum tentu mencerminkan kondisi IP yang sebenarnya.)",
        });
      }
      return;
    }

    // =====================
    // !dl <link> [mp3|mp4]
    // =====================
    if (text === "!dl" || text.startsWith("!dl ")) {
      const rest = text.slice(3).trim();
      const urlMatch = rest.match(/https?:\/\/\S+/i);

      if (!urlMatch) {
        await sendCommandDetail(sock, jid, "dl");
        return;
      }

      const url = urlMatch[0];
      // Sisa teks setelah link (kalau ada) dipakai buat override format,
      // mis. "!dl <link> mp3" -- biar gak perlu balas angka lagi.
      const hint = rest
        .slice(urlMatch.index + urlMatch[0].length)
        .trim()
        .toLowerCase();

      try {
        new URL(url); // validasi cepat, lempar kalau bukan URL valid
      } catch {
        await sock.sendMessage(jid, { text: "❌ Link tidak valid." });
        return;
      }

      // Link YouTube ikut alur sama seperti situs lain -- argumen khusus
      // (client rotation, force-ipv4, dst) ditangani otomatis di dalam
      // downloadMediaFromUrl(), gak perlu logic tambahan di sini.
      const mode = hint === "mp3" || hint === "audio" ? "audio" : "video";
      await handleDlDownload(sock, jid, url, mode);
      return;
    }

    // =====================
    // !dlr <link> -- khusus foto/carousel/slideshow (Instagram carousel,
    // TikTok mode foto+musik). Beda dari "!dl": langsung ambil jalur foto
    // tanpa nyoba video dulu.
    // =====================
    if (text === "!dlr" || text.startsWith("!dlr ")) {
      const rest = text.slice(4).trim();
      const urlMatch = rest.match(/https?:\/\/\S+/i);

      if (!urlMatch) {
        await sendCommandDetail(sock, jid, "dlr");
        return;
      }

      const url = urlMatch[0];

      try {
        new URL(url); // validasi cepat, lempar kalau bukan URL valid
      } catch {
        await sock.sendMessage(jid, { text: "❌ Link tidak valid." });
        return;
      }

      await handleDlrDownload(sock, jid, url);
      return;
    }

    // =====================
    // AgemasenBot -- Chat AI Tsundere (Groq)
    //
    // Semua logic-nya ada di agemasenTsundere.js. handleTsundereChat sendiri
    // yang ngecek apakah bot di-tag & teksnya bukan command "!..." --
    // return true kalau pesan ini sudah ditangani (berarti kita return di
    // sini juga), false kalau tidak relevan (lanjut ke pengecekan bawah).
    // =====================
    if (await handleTsundereChat(sock, msg, { jid, text, sessionKey })) {
      return;
    }

    // =====================
    // Command tidak dikenal (mis. salah ketik "!ing", "!imgg", dst).
    // Cuma dicek kalau memang diawali "!" -- teks biasa (bukan niat jadi
    // command) dibiarkan lewat tanpa respons.
    // =====================
    if (text.startsWith("!")) {
      await sock.sendMessage(jid, {
        text:
          "❓ Command tidak dikenal.\n" +
          "Ketik *!menu* buat lihat daftar command yang ada.",
      });
    }
}

module.exports = { handleMessagesUpsert };
