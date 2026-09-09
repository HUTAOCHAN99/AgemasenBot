const fs = require("fs");
const { BOT_STATE_DATA_DIR, USER_STATE_FILE } = require("../config/env");

// jid pribadi (xxx@s.whatsapp.net) -> { name, count, firstSeen, lastSeen }
// Ini daftar SEMUA orang yang pernah DM bot -- dipakai buat monitoring
// ("!listuser"), gak peduli aktif/nonaktif.
let knownUsers = new Map();

// jid pribadi -> true kalau lagi DIBLOKIR (bot gak bakal bales DM dia).
// Nomor yang gak ada di sini dianggap AKTIF (default aktif), sama pola
// kayak disabledGroups di botState.js.
let disabledUsers = new Set();

function loadUserState() {
  try {
    const raw = fs.readFileSync(USER_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    knownUsers = new Map();
    if (parsed?.knownUsers && typeof parsed.knownUsers === "object") {
      for (const [jid, info] of Object.entries(parsed.knownUsers)) {
        knownUsers.set(jid, {
          name: info?.name || null,
          count: Number(info?.count) || 0,
          firstSeen: info?.firstSeen || null,
          lastSeen: info?.lastSeen || null,
        });
      }
    }

    disabledUsers = new Set(
      Array.isArray(parsed?.disabledUsers) ? parsed.disabledUsers : [],
    );
  } catch {
    // Belum ada file / rusak -> mulai dari kosong.
    knownUsers = new Map();
    disabledUsers = new Set();
  }
}

function saveUserState() {
  try {
    fs.mkdirSync(BOT_STATE_DATA_DIR, { recursive: true });
    const knownUsersObj = Object.fromEntries(knownUsers);
    fs.writeFileSync(
      USER_STATE_FILE,
      JSON.stringify(
        { knownUsers: knownUsersObj, disabledUsers: [...disabledUsers] },
        null,
        2,
      ),
    );
  } catch (err) {
    console.log("Gagal nyimpen user_state.json:", err);
  }
}

// Dipanggil tiap ada DM pribadi masuk (dari router), biar kecatet buat
// monitoring. name opsional (pushName dari WA kalau ada).
function recordUserActivity(jid, name) {
  if (!jid) return;
  const now = new Date().toISOString();
  const existing = knownUsers.get(jid);

  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    if (name) existing.name = name;
  } else {
    knownUsers.set(jid, {
      name: name || null,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    });
  }
  saveUserState();
}

function isUserDisabled(jid) {
  return disabledUsers.has(jid);
}

function disableUser(jid) {
  disabledUsers.add(jid);
  saveUserState();
}

function enableUser(jid) {
  disabledUsers.delete(jid);
  saveUserState();
}

function getKnownUsers() {
  return knownUsers;
}

loadUserState();

module.exports = {
  loadUserState,
  saveUserState,
  recordUserActivity,
  isUserDisabled,
  disableUser,
  enableUser,
  getKnownUsers,
};
