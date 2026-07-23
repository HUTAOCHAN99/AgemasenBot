console.log("Program dimulai");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// =====================================================
// Session per pengguna (bukan per chat/grup)
// key -> { tag, pool: [post,...], lastId }
// pool = sisa kandidat yang belum ditampilkan ke user ini
// =====================================================
const sessions = new Map();

// Safebooru's dapi menolak permintaan "limit" di atas 100 dalam satu request,
// jadi buat ambil SEMUA post (tanpa batas), kita harus paging pakai "pid"
// (page index, 0-based) sampai halaman yang balik lebih pendek dari
// API_PAGE_SIZE (berarti itu halaman terakhir).
const API_PAGE_SIZE = 100;

// "tokai_teio_(umamusume)" -> "Tokai Teio (Umamusume)"
function prettifyTag(tag) {
    return tag
        .replace(/_/g, " ")
        .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Kunci session unik per pengirim asli.
// Di chat pribadi: remoteJid sudah unik per orang.
// Di grup: remoteJid sama untuk semua anggota, jadi wajib digabung
// dengan participant supaya 2 orang di grup yang sama tidak bentrok.
function getSessionKey(msg) {
    const jid = msg.key.remoteJid;
    const participant = msg.key.participant;
    return participant ? `${jid}::${participant}` : jid;
}

function buildCaption(post, karakterLabel, { isNext = false } = {}) {
    const link = `https://safebooru.org/index.php?page=post&s=view&id=${post.id}`;

    return (
`🖼️ *Hasil Gambar*${isNext ? " (lanjutan)" : ""}

👤 *Karakter:* ${karakterLabel}
🆔 *Kode:* ${post.id}
🔗 *Link:* ${link}

➡️ Ketik *!next* untuk gambar lain dari pencarian ini
🔁 Ketik *!id ${post.id}* untuk lihat gambar ini lagi kapan saja`
    );
}

async function fetchCandidates(tag) {
    const url = "https://safebooru.org/index.php";
    const all = [];
    let pid = 0;

    while (true) {
        const res = await axios.get(url, {
            params: {
                page: "dapi",
                s: "post",
                q: "index",
                json: 1,
                limit: API_PAGE_SIZE,
                pid,
                tags: tag
            }
        });

        if (!Array.isArray(res.data) || res.data.length === 0)
            break;

        all.push(...res.data);

        if (res.data.length < API_PAGE_SIZE)
            break; // halaman terakhir, tidak perlu lanjut

        pid++;
    }

    return all.filter(p => p.file_url);
}

// Safebooru's s=tag&q=index endpoint ignores json=1 and always replies with
// XML (unlike s=post&q=index which does honor json=1). axios won't auto-parse
// that into an object, so res.data comes back as a raw XML string here.
// This pulls the name/count pairs out of <tag ... name="..." count=".../>
// without needing an XML parser dependency.
function parseTagXml(xml) {
    if (typeof xml !== "string")
        return [];

    const tags = [];
    const tagRegex = /<tag\b[^>]*\/>/g;
    const nameRegex = /\bname="([^"]*)"/;
    const countRegex = /\bcount="([^"]*)"/;

    const matches = xml.match(tagRegex) || [];

    for (const raw of matches) {
        const name = raw.match(nameRegex)?.[1];
        const count = raw.match(countRegex)?.[1];

        if (name) {
            tags.push({ name, count: count ?? "0" });
        }
    }

    return tags;
}

// Cari tag-tag yang mengandung query (mis. "uchiha" -> "uchiha_sasuke", dst)
// dipakai saat pencarian tag persis tidak ketemu gambar sama sekali.
async function fetchMatchingTags(query) {
    const url = "https://safebooru.org/index.php";
    const all = [];
    let pid = 0;

    while (true) {
        const res = await axios.get(url, {
            params: {
                page: "dapi",
                s: "tag",
                q: "index",
                json: 1,
                limit: API_PAGE_SIZE,
                pid,
                name_pattern: `%${query}%`
            },
            // Force raw text: if we let axios try to auto-parse and it gets XML
            // back (which it always does for this endpoint), the default
            // transform can throw or hand us something unpredictable.
            responseType: "text",
            transformResponse: (data) => data
        });

        let tags;

        if (Array.isArray(res.data)) {
            // In case Safebooru ever does honor json=1 for this endpoint.
            tags = res.data;
        } else if (typeof res.data === "string" && res.data.trim().startsWith("{")) {
            try {
                const parsed = JSON.parse(res.data);
                tags = Array.isArray(parsed) ? parsed : parsed?.["@attributes"] ? [] : [];
            } catch {
                tags = parseTagXml(res.data);
            }
        } else {
            tags = parseTagXml(res.data);
        }

        if (tags.length === 0)
            break;

        all.push(...tags);

        if (tags.length < API_PAGE_SIZE)
            break; // halaman terakhir

        pid++;
    }

    return all
        .filter(t => Number(t.count) > 0)
        .sort((a, b) => Number(b.count) - Number(a.count));
}

async function fetchById(id) {
    const url = "https://safebooru.org/index.php";

    const res = await axios.get(url, {
        params: {
            page: "dapi",
            s: "post",
            q: "index",
            json: 1,
            limit: 1,
            tags: `id:${id}`
        }
    });

    if (!Array.isArray(res.data) || res.data.length === 0)
        return null;

    const post = res.data[0];
    return post.file_url ? post : null;
}

function buildTagChoiceList(tags) {
    const lines = tags
        .map((t, i) => `[${i + 1}] ${prettifyTag(t.name)}`)
        .join("\n");

    return (
`*KARAKTER DITEMUKAN*
${lines}

_Reply pesan ini dengan nomor urut karakter untuk melihat gambar_`
    );
}

// Eksekusi pencarian gambar untuk satu tag final (dipakai oleh !img langsung
// maupun setelah user memilih dari daftar disambiguasi), lalu simpan pool
// untuk !next dan kirim gambar pertama.
async function searchAndSendImage(sock, jid, sessionKey, tag, candidates) {
    const post = pickRandom(candidates);

    sessions.set(sessionKey, {
        tag,
        pool: candidates,
        lastId: post.id
    });

    const buffer = await downloadImage(post.file_url);
    const karakterLabel = tag
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map(prettifyTag)
        .join(", ");

    await sock.sendMessage(jid, {
        image: buffer,
        caption: buildCaption(post, karakterLabel)
    });
}

function pickRandom(pool) {
    const idx = Math.floor(Math.random() * pool.length);
    const [post] = pool.splice(idx, 1);
    return post;
}

async function downloadImage(fileUrl) {
    const image = await axios.get(fileUrl, { responseType: "arraybuffer" });
    return Buffer.from(image.data);
}

// =====================================================
// Fitur: GIF -> Stiker animasi dengan teks ("!meme")
// =====================================================

// Nama font (family) yang dipakai untuk teks meme. Dicari lewat fontconfig,
// jadi tidak perlu path file eksplisit. Bisa dioverride lewat env var
// MEME_FONT_FAMILY kalau server tidak punya DejaVu Sans (mis. pakai
// Liberation Sans, Arial, dst).
const FONT_FAMILY = process.env.MEME_FONT_FAMILY || "DejaVu Sans";

// Escape teks untuk dipakai di dalam file subtitle .ass.
// Di format ASS, "{" dan "}" punya arti khusus (dipakai untuk tag styling
// seperti \an8), jadi karakter itu perlu di-escape, dan newline literal
// harus jadi "\N".
function escapeAssText(str) {
    return String(str)
        .replace(/\{/g, "\uFF5B")
        .replace(/\}/g, "\uFF5D")
        .replace(/\r?\n/g, "\\N");
}

// Sticker WA selalu dipaksa jadi kanvas 512x512, sementara GIF/video sumber
// bisa punya rasio aspek apa saja. Karena filter video pakai
// "scale=512:512:force_original_aspect_ratio=decrease" lalu di-pad transparan
// biar pas 512x512, ukuran konten asli yang KELIHATAN (non-transparan) bisa
// lebih kecil dari 512x512 -- bisa ada bar transparan di atas/bawah (video
// landscape) atau di kiri/kanan (video portrait). Fungsi ini menghitung
// seberapa besar bar atas/bawah itu, supaya margin teks bisa disesuaikan
// otomatis untuk SEMUA ukuran/rasio GIF, bukan angka tetap yang cuma pas
// buat satu rasio tertentu.
function probeVideoDimensions(inputPath) {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, ["-i", inputPath]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("error", () => resolve(null));
        proc.on("close", () => {
            // Contoh baris yang mau ditangkap:
            // "Stream #0:0: Video: gif, bgra, 480x270, ..."
            const match = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
            if (!match) return resolve(null);
            resolve({ width: parseInt(match[1], 10), height: parseInt(match[2], 10) });
        });
    });
}

// Hitung MarginV (jarak dari tepi atas/bawah kanvas 512x512) yang aman
// dipakai, berdasarkan ukuran asli video/GIF. Selalu memberi margin minimum
// (MIN_MARGIN) walau videonya kebetulan pas 1:1 (tidak ada bar transparan),
// dan menambah margin ekstra sebesar bar transparan + jarak aman kalau video
// landscape/portrait menyebabkan letterboxing vertikal.
function computeSafeMargins(srcDims) {
    const CANVAS = 512;
    const MIN_MARGIN = 20; // margin dasar biar teks tetap enak dilihat, tidak nempel tepi
    const SAFE_GAP_TOP = 20; // jarak ekstra dari batas area transparan buat teks atas
    const SAFE_GAP_BOTTOM = 25; // jarak ekstra dari batas area transparan buat teks bawah

    if (!srcDims || !srcDims.width || !srcDims.height) {
        // Gagal deteksi ukuran -> fallback ke margin aman generik.
        return { top: MIN_MARGIN + SAFE_GAP_TOP, bottom: MIN_MARGIN + SAFE_GAP_BOTTOM };
    }

    const scale = Math.min(CANVAS / srcDims.width, CANVAS / srcDims.height);
    const scaledHeight = srcDims.height * scale;
    // Setengah dari total bar transparan atas+bawah (pad simetris di tengah).
    const verticalPad = Math.max(0, Math.round((CANVAS - scaledHeight) / 2));

    return {
        top: Math.max(MIN_MARGIN, verticalPad + SAFE_GAP_TOP),
        bottom: Math.max(MIN_MARGIN, verticalPad + SAFE_GAP_BOTTOM)
    };
}

// Bikin file subtitle .ass sederhana: satu style, teks atas (opsional)
// dan teks bawah, ditempatkan pakai tag alignment ASS (\an8 = atas-tengah,
// \an2 = bawah-tengah). Dirender lewat filter "subtitles" (libass),
// yang jauh lebih portable ketimbang "drawtext" karena tidak semua build
// ffmpeg (termasuk ffmpeg-static) menyertakan filter drawtext.
function buildAssSubtitle({ top, bottom, marginTop, marginBottom }) {
    // Waktu akhir digenerosir (10 menit); tidak masalah lebih panjang dari
    // video aslinya karena output tetap dipotong lewat "-t 10" di ffmpeg.
    const endTag = "0:10:00.00";

    const header =
`[Script Info]
ScriptType: v4.00+
PlayResX: 512
PlayResY: 512
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Meme,${FONT_FAMILY},46,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // MarginV per baris (override MarginV di style) supaya teks atas & bawah
    // tidak kepotong area transparan stiker. Nilainya dihitung dinamis lewat
    // computeSafeMargins() berdasarkan rasio aspek GIF/video sumber, jadi
    // selalu aman untuk semua ukuran -- bukan angka tetap yang cuma pas buat
    // satu rasio tertentu. Tetap ada fallback kalau caller tidak mengirim
    // margin (mis. dipanggil langsung tanpa lewat gifToTextSticker).
    const TOP_MARGIN_V = marginTop ?? 40;
    const BOTTOM_MARGIN_V = marginBottom ?? 45;

    const lines = [];

    if (top) {
        lines.push(`Dialogue: 0,0:00:00.00,${endTag},Meme,,0,0,${TOP_MARGIN_V},,{\\an8}${escapeAssText(top)}`);
    }
    if (bottom) {
        lines.push(`Dialogue: 0,0:00:00.00,${endTag},Meme,,0,0,${BOTTOM_MARGIN_V},,{\\an2}${escapeAssText(bottom)}`);
    }

    return header + lines.join("\n") + "\n";
}

// Escape path file untuk dipakai sebagai argumen filter subtitles=...
// (":" dan "\" punya arti khusus di dalam filtergraph ffmpeg).
function escapeFilterPath(p) {
    return p.replace(/\\/g, "\\\\\\\\").replace(/:/g, "\\\\:").replace(/'/g, "\\\\'");
}

// Jalankan ffmpeg dan tunggu sampai selesai.
function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, args);
        let stderr = "";

        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg keluar dengan kode ${code}\n${stderr.slice(-800)}`));
        });
    });
}

// Ambil buffer media dari sebuah "message content" (msg.message ATAU
// contextInfo.quotedMessage), untuk semua jenis media yang bisa dijadiin
// stiker meme: GIF/video (videoMessage, documentMessage bertipe video/gif),
// stiker WA / "emote" (stickerMessage, statis maupun animasi), dan foto biasa
// (imageMessage, documentMessage bertipe image). ffmpeg otomatis bisa nangani
// baik input berupa gambar diam (hasilnya 1 frame) maupun animasi (banyak
// frame) lewat filter yang sama, jadi tidak perlu penanganan khusus di sini.
// Baileys' downloadMediaMessage butuh objek berbentuk { key, message }.
function isGifLike(content) {
    if (!content) return false;

    if (content.videoMessage) return true;
    if (content.stickerMessage) return true;
    if (content.imageMessage) return true;

    if (content.documentMessage) {
        const mime = content.documentMessage.mimetype || "";
        return mime.startsWith("video/") || mime.startsWith("image/");
    }

    return false;
}

async function downloadGifBuffer(content, refKey) {
    const fakeMsg = {
        key: refKey,
        message: content
    };

    return downloadMediaMessage(fakeMsg, "buffer", {});
}

// Cari konten gif dari pesan masuk: bisa dari pesan itu sendiri
// (caption langsung di GIF), atau dari pesan yang di-reply (quoted).
function findGifSource(msg) {
    const jid = msg.key.remoteJid;

    if (isGifLike(msg.message)) {
        return { content: msg.message, refKey: msg.key };
    }

    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    if (quoted && isGifLike(quoted)) {
        return {
            content: quoted,
            refKey: {
                remoteJid: jid,
                id: ctx.stanzaId,
                participant: ctx.participant
            }
        };
    }

    return null;
}

// teks bisa "atas|bawah" (dua baris) atau cuma "teks" (satu baris di bawah)
function parseMemeText(raw) {
    const parts = raw.split("|").map(s => s.trim()).filter(Boolean);

    if (parts.length >= 2) {
        return { top: parts[0], bottom: parts[1] };
    }

    return { top: null, bottom: parts[0] || raw.trim() };
}

// Proses inti: buffer GIF/video input -> buffer stiker WebP animasi bertext.
async function gifToTextSticker(inputBuffer, memeText) {
    const tmpDir = os.tmpdir();
    const uid = crypto.randomBytes(6).toString("hex");
    const inputPath = path.join(tmpDir, `meme-in-${uid}`);
    const assPath = path.join(tmpDir, `meme-${uid}.ass`);
    const outputPath = path.join(tmpDir, `meme-out-${uid}.webp`);

    fs.writeFileSync(inputPath, inputBuffer);

    try {
        const parsed = parseMemeText(memeText);
        const srcDims = await probeVideoDimensions(inputPath);
        const margins = computeSafeMargins(srcDims);
        fs.writeFileSync(
            assPath,
            buildAssSubtitle({ ...parsed, marginTop: margins.top, marginBottom: margins.bottom }),
            "utf8"
        );

        const filters = [
            // WA sticker wajib 512x512. GIF di-scale biar muat penuh tanpa
            // kepotong, sisa ruang di-pad transparan (bukan hitam).
            // "format=rgba" WAJIB di sini: GIF sumber biasanya tidak punya
            // channel alpha sama sekali, jadi kalau langsung di-pad warna
            // "transparan" itu malah dianggap hitam solid oleh encoder.
            "format=rgba",
            "scale=512:512:force_original_aspect_ratio=decrease",
            "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
            "fps=12",
            `subtitles='${escapeFilterPath(assPath)}'`
        ];

        const args = [
            "-y",
            "-i", inputPath,
            "-vf", filters.join(","),
            "-vcodec", "libwebp",
            "-pix_fmt", "yuva420p", // paksa encoder ikut simpan channel alpha
            "-loop", "0",
            "-preset", "default",
            "-an",
            "-fps_mode", "cfr",
            "-t", "10", // batas durasi stiker WA
            outputPath
        ];

        await runFfmpeg(args);

        return fs.readFileSync(outputPath);
    } finally {
        fs.rm(inputPath, { force: true }, () => {});
        fs.rm(assPath, { force: true }, () => {});
        fs.rm(outputPath, { force: true }, () => {});
    }
}

// Proses inti buat "!s": buffer GIF/video/stiker/foto -> buffer stiker WebP
// polos, TANPA teks (tidak lewat tahap subtitle/.ass sama sekali). Filter
// scale+pad+fps-nya sama persis dengan gifToTextSticker supaya hasil
// crop/rasio-nya konsisten antara "!s" dan "!meme"/"!smeme".
async function mediaToSticker(inputBuffer) {
    const tmpDir = os.tmpdir();
    const uid = crypto.randomBytes(6).toString("hex");
    const inputPath = path.join(tmpDir, `s-in-${uid}`);
    const outputPath = path.join(tmpDir, `s-out-${uid}.webp`);

    fs.writeFileSync(inputPath, inputBuffer);

    try {
        const filters = [
            "format=rgba",
            "scale=512:512:force_original_aspect_ratio=decrease",
            "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
            "fps=12"
        ];

        const args = [
            "-y",
            "-i", inputPath,
            "-vf", filters.join(","),
            "-vcodec", "libwebp",
            "-pix_fmt", "yuva420p",
            "-loop", "0",
            "-preset", "default",
            "-an",
            "-fps_mode", "cfr",
            "-t", "10",
            outputPath
        ];

        await runFfmpeg(args);

        return fs.readFileSync(outputPath);
    } finally {
        fs.rm(inputPath, { force: true }, () => {});
        fs.rm(outputPath, { force: true }, () => {});
    }
}

async function startBot() {
    console.log("Starting bot...");

    const { state, saveCreds } =
        await useMultiFileAuthState("auth_info");

    // Always negotiate the latest supported WA Web version.
    // Skipping this is one of the most common causes of bots that
    // connect then immediately close with a 405/restartRequired loop.
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: P({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.04.4"],
        printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrcode = require("qrcode-terminal");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            console.log("✅ Bot Connected!");
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(
                `Connection closed (code: ${statusCode ?? "unknown"}). ` +
                (shouldReconnect ? "Reconnecting..." : "Logged out, not reconnecting.")
            );

            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify")
            return;

        const msg = messages[0];

        if (!msg?.message)
            return;

        if (msg.key.fromMe)
            return;

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
        // !ping
        // =====================
        if (text === "!ping") {
            await sock.sendMessage(jid, { text: "🏓 Pong!" });
            return;
        }

        // =====================
        // !help
        // =====================
        if (text === "!help") {
            await sock.sendMessage(jid, {
                text:
`📖 Safebooru Bot

!ping
!help
!img <tag>      cari gambar baru (kalau tag umum, akan muncul pilihan karakter)
!next           gambar berikutnya dari pencarian terakhirmu
!id <kode>      buka ulang gambar pakai kode
!meme <teks>    ubah GIF/video/stiker/foto jadi stiker bertext
!smeme <teks>   sama seperti !meme (alias)
!s              ubah GIF/video/stiker/foto jadi stiker polos (tanpa teks)

Contoh:
!img umamusume
!img tokai_teio_(umamusume)
!img uchiha      -> muncul daftar karakter, balas dengan angka
!id 12345

Cara pakai !meme / !smeme:
1) Kirim GIF/video/stiker (emote)/foto dengan caption "!meme teks kamu"
   atau
2) Kirim media itu dulu, lalu balas (reply) dengan "!meme teks kamu"
Mau 2 baris (atas & bawah)? Pisahkan dengan "|":
!meme HALO DUNIA|SELAMAT PAGI

Cara pakai !s:
Kirim GIF/video/stiker/foto dengan caption "!s", atau reply media itu dengan "!s"`
            });
            return;
        }

        // =====================
        // Balasan angka untuk memilih karakter dari daftar disambiguasi
        // (hanya diproses kalau memang sedang ada daftar pending untuk user ini)
        // =====================
        if (/^\d+$/.test(text)) {
            const session = sessions.get(sessionKey);

            if (session?.pendingTagChoices) {
                const idx = parseInt(text, 10) - 1;
                const choice = session.pendingTagChoices[idx];

                if (!choice) {
                    await sock.sendMessage(jid, {
                        text: `⚠️ Nomor tidak valid. Pilih 1-${session.pendingTagChoices.length}.`
                    });
                    return;
                }

                try {
                    const candidates = await fetchCandidates(choice.name);

                    if (candidates.length === 0) {
                        await sock.sendMessage(jid, {
                            text: "❌ Gambar untuk karakter ini tidak ditemukan."
                        });
                        return;
                    }

                    await searchAndSendImage(sock, jid, sessionKey, choice.name, candidates);

                } catch (err) {
                    console.log(err);
                    await sock.sendMessage(jid, {
                        text: "Terjadi kesalahan."
                    });
                }

                return;
            }

            // angka tanpa daftar pending -> biarkan lewat, bukan command
        }

        // =====================
        // !meme / !smeme <teks>  -> GIF/video/stiker(emote)/foto jadi stiker
        // bertext. Keduanya alias, fungsinya identik. Bisa dari caption
        // langsung di medianya, atau reply ke medianya.
        // =====================
        const memeMatch = text.match(/^!(?:meme|smeme)(?:\s+([\s\S]*))?$/);

        if (memeMatch) {
            const memeText = (memeMatch[1] || "").trim();

            if (!memeText) {
                await sock.sendMessage(jid, {
                    text: "⚠️ Sertakan teksnya. Contoh: !meme HALO DUNIA\n" +
                          "(atau kirim sebagai caption/reply ke GIF/video/stiker/fotonya)"
                });
                return;
            }

            const source = findGifSource(msg);

            if (!source) {
                await sock.sendMessage(jid, {
                    text: "⚠️ Tidak ada GIF/video/stiker/foto terdeteksi.\n" +
                          "Kirim salah satunya dengan caption *!meme teks*, atau reply dengan *!meme teks*."
                });
                return;
            }

            try {
                await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

                const gifBuffer = await downloadGifBuffer(source.content, source.refKey);
                const stickerBuffer = await gifToTextSticker(gifBuffer, memeText);

                await sock.sendMessage(jid, { sticker: stickerBuffer });

            } catch (err) {
                console.log(err);
                await sock.sendMessage(jid, {
                    text: `❌ Gagal membuat stiker.\n${err.message || ""}`
                });
            }

            return;
        }

        // =====================
        // !s  -> GIF/video/stiker(emote)/foto jadi stiker polos, TANPA teks.
        // Bisa dari caption langsung di medianya, atau reply ke medianya.
        // =====================
        if (text === "!s") {
            const source = findGifSource(msg);

            if (!source) {
                await sock.sendMessage(jid, {
                    text: "⚠️ Tidak ada GIF/video/stiker/foto terdeteksi.\n" +
                          "Kirim salah satunya dengan caption *!s*, atau reply dengan *!s*."
                });
                return;
            }

            try {
                await sock.sendMessage(jid, { text: "⏳ Membuat stiker..." });

                const mediaBuffer = await downloadGifBuffer(source.content, source.refKey);
                const stickerBuffer = await mediaToSticker(mediaBuffer);

                await sock.sendMessage(jid, { sticker: stickerBuffer });

            } catch (err) {
                console.log(err);
                await sock.sendMessage(jid, {
                    text: `❌ Gagal membuat stiker.\n${err.message || ""}`
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
                await sock.sendMessage(jid, {
                    text: "⚠️ Sertakan tag. Contoh: !img umamusume"
                });
                return;
            }

            try {
                const candidates = await fetchCandidates(tag);

                if (candidates.length > 0) {
                    await searchAndSendImage(sock, jid, sessionKey, tag, candidates);
                    return;
                }

                // Tag persis tidak ketemu -> cari tag-tag serupa untuk dipilih
                const matches = await fetchMatchingTags(tag);

                if (matches.length === 0) {
                    await sock.sendMessage(jid, {
                        text: "❌ Gambar tidak ditemukan."
                    });
                    return;
                }

                if (matches.length === 1) {
                    // cuma ada 1 kandidat, langsung pakai tanpa nanya
                    const only = await fetchCandidates(matches[0].name);
                    await searchAndSendImage(sock, jid, sessionKey, matches[0].name, only);
                    return;
                }

                sessions.set(sessionKey, { pendingTagChoices: matches });

                await sock.sendMessage(jid, {
                    text: buildTagChoiceList(matches)
                });

            } catch (err) {
                console.log(err);
                await sock.sendMessage(jid, {
                    text: "Terjadi kesalahan."
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
                await sock.sendMessage(jid, {
                    text: "⚠️ Belum ada pencarian aktif. Pakai *!img <tag>* dulu."
                });
                return;
            }

            try {
                // pool habis -> refill otomatis dari tag yang sama
                if (session.pool.length === 0) {
                    session.pool = await fetchCandidates(session.tag);

                    if (session.pool.length === 0) {
                        await sock.sendMessage(jid, {
                            text: "❌ Tidak ada gambar lain untuk tag ini."
                        });
                        return;
                    }
                }

                const post = pickRandom(session.pool);
                session.lastId = post.id;

                const buffer = await downloadImage(post.file_url);
                const karakterLabel = session.tag
                    .toLowerCase()
                    .split(/\s+/)
                    .filter(Boolean)
                    .map(prettifyTag)
                    .join(", ");

                await sock.sendMessage(jid, {
                    image: buffer,
                    caption: buildCaption(post, karakterLabel, { isNext: true })
                });

            } catch (err) {
                console.log(err);
                await sock.sendMessage(jid, {
                    text: "Terjadi kesalahan."
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
                await sock.sendMessage(jid, {
                    text: "⚠️ Sertakan kode angka. Contoh: !id 12345"
                });
                return;
            }

            try {
                const post = await fetchById(id);

                if (!post) {
                    await sock.sendMessage(jid, {
                        text: "❌ Kode gambar tidak ditemukan."
                    });
                    return;
                }

                const buffer = await downloadImage(post.file_url);

                await sock.sendMessage(jid, {
                    image: buffer,
                    caption: buildCaption(post, "-")
                });

            } catch (err) {
                console.log(err);
                await sock.sendMessage(jid, {
                    text: "Terjadi kesalahan."
                });
            }
        }
    });
}

startBot();