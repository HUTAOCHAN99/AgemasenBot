// test_emoji.js
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const fs = require("fs");

console.log("Fonts terdaftar sebelum:", GlobalFonts.families.length);
const ok1 = GlobalFonts.registerFromPath("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "MemeFont");
const ok2 = GlobalFonts.registerFromPath("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "MemeEmoji");
console.log("Register DejaVu:", ok1, " Register Emoji:", ok2);

const canvas = createCanvas(300, 150);
const ctx = canvas.getContext("2d");
ctx.font = 'bold 46px "MemeFont", "MemeEmoji"';
ctx.textBaseline = "middle";
ctx.fillStyle = "black";
ctx.fillText("test😂", 10, 75);

const buf = canvas.toBuffer("image/png");
fs.writeFileSync("test_emoji.png", buf);
console.log("Selesai, cek test_emoji.png. Ukuran:", buf.length, "bytes");