const { OWNER_NUMBER, OWNER_JID } = require("../../config/env");
const { isBotDisabledFor, disableGroup, enableGroup } = require("../../state/botState");
const { getSenderJid, isOwnerMsg } = require("../../utils/whatsapp");

async function handleWhoamiCommand(sock, msg, { jid, text }) {
  if (text.toLowerCase() !== "!whoami") return false;

  const resolved = getSenderJid(msg);
  const lines = [
    `🪪 *Jid terdeteksi:* ${resolved || "(gak ketemu)"}`,
    `Owner: ${isOwnerMsg(msg) ? "✅ ya" : "❌ bukan"}`,
    "",
    "_Detail mentah:_",
    `participant: ${msg.key.participant || "-"}`,
    `participantPn: ${msg.key.participantPn || "-"}`,
    `senderPn: ${msg.key.senderPn || "-"}`,
    `remoteJid: ${msg.key.remoteJid || "-"}`,
  ];

  await sock.sendMessage(jid, { text: lines.join("\n") });
  return true;
}

// Cooldown biar bot gak spam bales "ngambek" tiap ada 1 pesan doang kalau
// banyak orang nyoba-nyoba command di grup yang lagi dimatiin.
const NGAMBEK_COOLDOWN_MS = 15 * 1000;
const lastNgambekReply = new Map(); // jid -> timestamp

async function sendNgambekReply(sock, jid) {
  const now = Date.now();
  const last = lastNgambekReply.get(jid) || 0;
  if (now - last < NGAMBEK_COOLDOWN_MS) return;
  lastNgambekReply.set(jid, now);

  const ngambekLines = [
    "Hmph! Aku lagi gak mau aktif, dasar. 😤",
    "Males ah, aku lagi dimatiin. Gak mau kerja dulu sekarang. 🙄",
    "Ish, jangan suruh-suruh aku, aku lagi nonaktif tau!",
  ];
  const line = ngambekLines[Math.floor(Math.random() * ngambekLines.length)];

  if (!OWNER_JID) {
    await sock.sendMessage(jid, { text: line });
    return;
  }

  await sock.sendMessage(jid, {
    text: `${line}\n\nKalau mau aku aktif lagi, hubungin @${OWNER_NUMBER} ya, bukan aku yang nentuin. 💢`,
    mentions: [OWNER_JID],
  });
}

// Cari grup berdasarkan nama (subject), dipakai buat !bot on/off/status
// dari DM (owner gak perlu ada di grupnya). Cocokin exact match dulu
// (case-insensitive), kalau gak ketemu baru coba substring match.
// Return:
//   { type: "none" }               -- gak ketemu sama sekali
//   { type: "ambiguous", matches } -- lebih dari satu grup cocok (substring)
//   { type: "found", group }       -- ketemu tepat satu
async function resolveGroupByName(sock, rawName) {
  const needle = rawName.trim().toLowerCase();
  const groups = await sock.groupFetchAllParticipating();
  const entries = Object.values(groups || {});

  const exact = entries.filter((g) => (g.subject || "").toLowerCase() === needle);
  if (exact.length === 1) return { type: "found", group: exact[0] };
  if (exact.length > 1) return { type: "ambiguous", matches: exact };

  const partial = entries.filter((g) => (g.subject || "").toLowerCase().includes(needle));
  if (partial.length === 1) return { type: "found", group: partial[0] };
  if (partial.length > 1) return { type: "ambiguous", matches: partial };

  return { type: "none" };
}

// Handler command "!bot on / off / status" -- KHUSUS owner.
// Bisa dipakai dua cara:
//   - Di DALAM grup: "!bot on" / "!bot off" / "!bot status" -> ngatur
//     grup yang lagi ditempatin ngetik.
//   - Dari DM (atau grup mana pun): "!bot on <nama grup>" /
//     "!bot off <nama grup>" / "!bot status <nama grup>" -> ngatur grup
//     LAIN lewat nama, owner gak perlu jadi anggota/ada di grup itu.
// Return true kalau pesan ini sudah ditangani sebagai command !bot
// (baik berhasil, ditolak karena bukan owner, dsb) -- caller harus
// return begitu dapat true, JANGAN lanjut proses apa pun lagi.
async function handleBotSwitchCommand(sock, msg, { jid, text }) {
  const match = text.match(/^!bot(?:\s+(on|off|status))?(?:\s+(.+))?\s*$/i);
  if (!match) return false;

  if (!isOwnerMsg(msg)) {
    await sock.sendMessage(jid, {
      text: "🚫 Cuma owner yang boleh atur aktif/nonaktifin aku, dasar.",
    });
    return true;
  }

  const sub = (match[1] || "").toLowerCase();
  const nameArg = (match[2] || "").trim();
  const isGroup = jid.endsWith("@g.us");

  // "!bot <sesuatu>" tanpa on/off/status di depan -- format gak jelas,
  // gak tau itu mau toggle apa cuma nama grup doang.
  if (sub === "" && nameArg !== "") {
    await sock.sendMessage(jid, {
      text: "❓ Format salah.\nGunakan:\n!bot on <nama grup>\n!bot off <nama grup>\n!bot status <nama grup>",
    });
    return true;
  }

  // ---- Mode remote: ada nama grup disebutin -> gak perlu ada di grupnya ----
  if (nameArg !== "") {
    let resolved;
    try {
      resolved = await resolveGroupByName(sock, nameArg);
    } catch (err) {
      console.error("Gagal cari grup by nama:", err);
      await sock.sendMessage(jid, {
        text: "⚠️ Gagal ambil daftar grup buat dicariin namanya. Coba lagi bentar ya.",
      });
      return true;
    }

    if (resolved.type === "none") {
      await sock.sendMessage(jid, {
        text: `❓ Gak nemu grup dengan nama mengandung "${nameArg}". Cek lagi pakai *!listgrup*.`,
      });
      return true;
    }

    if (resolved.type === "ambiguous") {
      const list = resolved.matches
        .map((g, i) => `${i + 1}. ${g.subject || "(tanpa nama)"}`)
        .join("\n");
      await sock.sendMessage(jid, {
        text: `❓ Ada ${resolved.matches.length} grup yang cocok, sebutin nama lebih spesifik:\n\n${list}`,
      });
      return true;
    }

    const group = resolved.group;
    const disabled = isBotDisabledFor(group.id);

    if (sub === "status") {
      await sock.sendMessage(jid, {
        text: `📋 *${group.subject}*\nStatus: ${disabled ? "📴 NONAKTIF" : "✅ AKTIF"}`,
      });
      return true;
    }

    if (sub === "on") {
      enableGroup(group.id);
      await sock.sendMessage(jid, {
        text: `✅ Oke, aku aktifin lagi di grup *${group.subject}*.`,
      });
    } else {
      disableGroup(group.id);
      await sock.sendMessage(jid, {
        text: `📴 Oke, aku nonaktifin di grup *${group.subject}*.`,
      });
    }
    return true;
  }

  // ---- Mode lokal (perilaku lama): ngatur grup tempat ngetik sekarang ----
  if (sub === "status" || sub === "") {
    if (!isGroup) {
      await sock.sendMessage(jid, {
        text: "ℹ️ Ketik di dalam grup yang mau dicek, atau sebutin namanya: *!bot status <nama grup>*",
      });
      return true;
    }
    const disabled = isBotDisabledFor(jid);
    await sock.sendMessage(jid, {
      text: disabled
        ? "📴 Status grup ini: NONAKTIF. Ketik *!bot on* buat nyalain lagi."
        : "✅ Status grup ini: AKTIF. Ketik *!bot off* buat matiin.",
    });
    return true;
  }

  if (sub !== "on" && sub !== "off") {
    await sock.sendMessage(jid, {
      text: "❓ Format salah.\nGunakan:\n!bot on\n!bot off\n!bot status\natau dari DM: !bot on/off/status <nama grup>",
    });
    return true;
  }

  if (!isGroup) {
    await sock.sendMessage(jid, {
      text: "ℹ️ Dari DM, sebutin nama grupnya: *!bot on <nama grup>* / *!bot off <nama grup>*. Atau ketik command ini langsung di dalam grup yang mau diatur.",
    });
    return true;
  }

  if (sub === "on") {
    enableGroup(jid);
    await sock.sendMessage(jid, {
      text: "✅ Yaudah, aku aktif lagi di grup ini. Bukan berarti aku seneng ya! 😳",
    });
  } else {
    disableGroup(jid);
    await sock.sendMessage(jid, {
      text: "📴 Oke, aku nonaktif di grup ini sekarang. Kalau ada yang manggil-manggil aku juga gak bakal respon.",
    });
  }

  return true;
}

// Handler command "!listgrup" -- KHUSUS owner. Nampilin daftar nama semua
// grup dimana bot ini jadi member (aktif kehadirannya di WA), sekalian
// status per grup (aktif / nonaktif via !bot on-off). Pakai
// sock.groupFetchAllParticipating() bawaan Baileys yang ngambil semua
// grup yang lagi diikuti akun bot saat ini.
async function handleListGroupsCommand(sock, msg, { jid, text }) {
  if (text.trim().toLowerCase() !== "!listgrup") return false;

  if (!isOwnerMsg(msg)) {
    await sock.sendMessage(jid, {
      text: "🚫 Cuma owner yang boleh liat daftar grup, dasar.",
    });
    return true;
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    const entries = Object.values(groups || {});

    if (entries.length === 0) {
      await sock.sendMessage(jid, {
        text: "ℹ️ Aku belum jadi anggota grup mana pun saat ini.",
      });
      return true;
    }

    entries.sort((a, b) => (a.subject || "").localeCompare(b.subject || ""));

    const lines = entries.map((g, i) => {
      const nama = g.subject || "(tanpa nama)";
      const jumlah = Array.isArray(g.participants) ? g.participants.length : "?";
      const status = isBotDisabledFor(g.id) ? "📴 nonaktif" : "✅ aktif";
      return `${i + 1}. ${nama} (${jumlah} anggota) -- ${status}`;
    });

    const header = `📋 *Daftar grup (${entries.length}):*\n\n`;
    await sock.sendMessage(jid, { text: header + lines.join("\n") });
  } catch (err) {
    console.error("Gagal ambil daftar grup:", err);
    await sock.sendMessage(jid, {
      text: "⚠️ Gagal ambil daftar grup. Coba lagi bentar ya.",
    });
  }

  return true;
}


module.exports = {
  handleWhoamiCommand,
  sendNgambekReply,
  resolveGroupByName,
  handleBotSwitchCommand,
  handleListGroupsCommand,
};
