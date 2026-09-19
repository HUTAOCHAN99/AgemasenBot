const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const P = require("pino");

const { handleMessagesUpsert } = require("./router");

async function startBot() {
  console.log("Starting bot...");

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  // Always negotiate the latest supported WA Web version.
  // Skipping this is one of the most common causes of bots that
  // connect then immediately close with a 405/restartRequired loop.
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: P({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.04.4"],
    printQRInTerminal: false,
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
          (shouldReconnect
            ? "Reconnecting..."
            : "Logged out, not reconnecting."),
      );

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    }
  });

  // PENTING: bungkus dengan .catch(). handleMessagesUpsert itu async function --
  // kalau ada error yang gak ketangkep try/catch di dalam salah satu command
  // (router.js/features/*), promise-nya bakal reject. Tanpa .catch() di sini,
  // itu jadi "unhandled rejection" yang bisa MEMATIKAN SELURUH PROSES bot
  // (default Node.js sejak v15) -- efeknya command user lain yang lagi
  // diproses BARENGAN ikut keputus tanpa sempat kekirim balasannya, padahal
  // command dia sendiri gak ada masalah. Dengan .catch() di sini, error dari
  // satu pesan cuma di-log dan gak ganggu pemrosesan pesan/user lain.
  sock.ev.on("messages.upsert", (payload) => {
    handleMessagesUpsert(sock, payload).catch((err) => {
      console.error("[messages.upsert] Unhandled error saat proses pesan:", err);
    });
  });
}

module.exports = { startBot };
