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

  sock.ev.on("messages.upsert", (payload) => handleMessagesUpsert(sock, payload));
}

module.exports = { startBot };
