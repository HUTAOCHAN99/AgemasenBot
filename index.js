console.log("Program dimulai");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");

// =====================================================
// Session per pengguna (bukan per chat/grup)
// key -> { tag, pool: [post,...], lastId }
// pool = sisa kandidat yang belum ditampilkan ke user ini
// =====================================================
const sessions = new Map();

const MAX_CANDIDATES = 100; // batas ambil dari safebooru per pencarian

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

    const res = await axios.get(url, {
        params: {
            page: "dapi",
            s: "post",
            q: "index",
            json: 1,
            limit: MAX_CANDIDATES,
            tags: tag
        }
    });

    if (!Array.isArray(res.data))
        return [];

    return res.data.filter(p => p.file_url);
}

const MAX_TAG_SUGGESTIONS = 60; // batas tampilan list biar chat gak kepanjangan

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

    const res = await axios.get(url, {
        params: {
            page: "dapi",
            s: "tag",
            q: "index",
            json: 1,
            limit: 100,
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

    return tags
        .filter(t => Number(t.count) > 0)
        .sort((a, b) => Number(b.count) - Number(a.count))
        .slice(0, MAX_TAG_SUGGESTIONS);
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

Contoh:
!img umamusume
!img tokai_teio_(umamusume)
!img uchiha      -> muncul daftar karakter, balas dengan angka
!id 12345`
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