import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const buf = Buffer.alloc(S * S * 4);

function px(x, y, r, g, b, a) {
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

const cx = S / 2, cy = S / 2;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {

    const m = 90;
    const rr = 180;
    let inside = true;
    const dx = Math.max(m - x, 0, x - (S - m));
    const dy = Math.max(m - y, 0, y - (S - m));
    if (dx > 0 && dy > 0) inside = dx * dx + dy * dy <= (m) * (m) ? true : false;
    if (x < m - rr || x > S - m + rr || y < m - rr || y > S - m + rr) inside = false;

    inside = roundedRect(x, y, m, S - m, rr);
    if (!inside) { px(x, y, 0, 0, 0, 0); continue; }

    const t = y / S;
    let r = Math.round(20 + 8 * t), g = Math.round(24 + 8 * t), bl = Math.round(34 + 10 * t);

    const d1 = Math.hypot(x - cx, y - cy);
    const d2 = Math.hypot(x - (cx + 150), y - (cy - 40));
    if (d1 < 300 && d2 > 250) {
      r = 90; g = 209; bl = 255;
    }
    px(x, y, r, g, bl, 255);
  }
}

function roundedRect(x, y, lo, hi, rad) {
  if (x < lo || x > hi || y < lo || y > hi) {
    return false;
  }

  const corners = [
    [lo + rad, lo + rad, x < lo + rad && y < lo + rad],
    [hi - rad, lo + rad, x > hi - rad && y < lo + rad],
    [lo + rad, hi - rad, x < lo + rad && y > hi - rad],
    [hi - rad, hi - rad, x > hi - rad && y > hi - rad],
  ];
  for (const [ccx, ccy, active] of corners) {
    if (active && Math.hypot(x - ccx, y - ccy) > rad) return false;
  }
  return true;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = deflateSync(raw);

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("wrote app-icon.png", png.length, "bytes");
