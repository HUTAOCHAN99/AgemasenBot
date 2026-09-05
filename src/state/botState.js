const fs = require("fs");
const { BOT_STATE_DATA_DIR, BOT_STATE_FILE } = require("../config/env");

// jid grup -> false (nonaktif). Grup yang gak ada di sini dianggap AKTIF
// (default aktif), jadi file-nya cuma perlu nyimpen grup yang DIMATIKAN.
let disabledGroups = new Set();

function loadBotState() {
  try {
    const raw = fs.readFileSync(BOT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.disabledGroups)) {
      disabledGroups = new Set(parsed.disabledGroups);
    }
  } catch {
    // Belum ada file / rusak -> mulai dari kosong (semua grup aktif).
    disabledGroups = new Set();
  }
}

function saveBotState() {
  try {
    fs.mkdirSync(BOT_STATE_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      BOT_STATE_FILE,
      JSON.stringify({ disabledGroups: [...disabledGroups] }, null, 2),
    );
  } catch (err) {
    console.log("Gagal nyimpen bot_state.json:", err);
  }
}

function isBotDisabledFor(jid) {
  return disabledGroups.has(jid);
}

function disableGroup(jid) {
  disabledGroups.add(jid);
  saveBotState();
}

function enableGroup(jid) {
  disabledGroups.delete(jid);
  saveBotState();
}

loadBotState();

module.exports = {
  loadBotState,
  saveBotState,
  isBotDisabledFor,
  disableGroup,
  enableGroup,
};
