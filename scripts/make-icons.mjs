import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y, size);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function iconPaint(x, y, size) {
  const n = (v) => (v / size) * 2 - 1;
  const px = n(x + 0.5);
  const py = n(y + 0.5);
  const r2 = px * px + py * py;
  if (r2 > 0.92) return [0, 0, 0, 0];
  const bg = [24, 28, 36, 255];
  const fg = [236, 244, 255, 255];
  const inBody =
    px > -0.42 &&
    px < 0.02 &&
    py > -0.28 &&
    py < 0.28;
  const inCone =
    px >= 0.0 &&
    px < 0.38 &&
    Math.abs(py) < 0.18 + (px - 0.0) * 0.7;
  const wave1 = Math.abs(Math.hypot(px - 0.12, py) - 0.42) < 0.07 && px > 0.18;
  const wave2 = Math.abs(Math.hypot(px - 0.12, py) - 0.62) < 0.07 && px > 0.28;
  if (inBody || inCone || wave1 || wave2) return fg;
  return bg;
}

mkdirSync("icons", { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`icons/icon${size}.png`, png(size, iconPaint));
}
