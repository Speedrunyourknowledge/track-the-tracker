/**
 * Generates the extension icon PNG files at 16, 32, 48, and 128px.
 *
 * Background: indigo #4f46e5
 * Foreground:  white "T" letter
 *
 * Run once after cloning or whenever you want to regenerate icons:
 *   node scripts/generate-icons.mjs
 */

import { deflate } from "zlib";
import { promisify } from "util";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const deflateAsync = promisify(deflate);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Colours ──────────────────────────────────────────────────────────────────
const [BG_R, BG_G, BG_B] = [79, 70, 229];     // indigo #4f46e5
const [FG_R, FG_G, FG_B] = [255, 255, 255];    // white

// ── CRC-32 (required for PNG chunks) ─────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0);
}

// ── PNG chunk builder ─────────────────────────────────────────────────────────
function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf  = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── IHDR ──────────────────────────────────────────────────────────────────────
function makeIHDR(size) {
  const buf = Buffer.alloc(13);
  buf.writeUInt32BE(size, 0);  // width
  buf.writeUInt32BE(size, 4);  // height
  buf[8]  = 8; // bit depth
  buf[9]  = 6; // colour type: RGBA
  buf[10] = 0; buf[11] = 0; buf[12] = 0;
  return buf;
}

// ── Pixel helpers ─────────────────────────────────────────────────────────────
function isInsideRoundedRect(x, y, size, r) {
  if (x < r   && y < r) {
    return Math.hypot(x - r, y - r) < r;
  }
  if (x > size-1-r && y < r) {
    return Math.hypot(x - (size-1-r), y - r) < r;
  }
  if (x < r   && y > size-1-r) {
    return Math.hypot(x - r, y - (size-1-r)) < r;
  }
  if (x > size-1-r && y > size-1-r) {
    return Math.hypot(x - (size-1-r), y - (size-1-r)) < r;
  }
  return true;
}

function isInsideT(x, y, size) {
  const pad      = Math.round(size * 0.17);
  const barH     = Math.round(size * 0.17);
  const stemW    = Math.round(size * 0.18);
  const stemX    = Math.floor((size - stemW) / 2);
  const bottomY  = size - pad;

  // Horizontal bar
  if (y >= pad && y < pad + barH && x >= pad && x < size - pad) {
    return true;
  }
  // Vertical stem
  if (x >= stemX && x < stemX + stemW && y >= pad && y < bottomY) {
    return true;
  }
  return false;
}

// ── Raw RGBA image data (uncompressed scanlines) ──────────────────────────────
function buildRawData(size) {
  const radius  = Math.max(2, Math.round(size * 0.15));
  const rowLen  = 1 + size * 4;           // 1 filter byte + RGBA pixels
  const raw     = Buffer.alloc(size * rowLen, 0);

  for (let y = 0; y < size; y++) {
    const base = y * rowLen;
    raw[base] = 0;                         // filter: None
    for (let x = 0; x < size; x++) {
      const off = base + 1 + x * 4;
      if (!isInsideRoundedRect(x, y, size, radius)) {
        // transparent outside rounded rect
        raw[off] = raw[off+1] = raw[off+2] = raw[off+3] = 0;
      }
      else if (isInsideT(x, y, size)) {
        raw[off] = FG_R; raw[off+1] = FG_G; raw[off+2] = FG_B; raw[off+3] = 255;
      }
      else {
        raw[off] = BG_R; raw[off+1] = BG_G; raw[off+2] = BG_B; raw[off+3] = 255;
      }
    }
  }
  return raw;
}

// ── Main: generate each icon size ─────────────────────────────────────────────
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function generateIcon(size, outPath) {
  const raw        = buildRawData(size);
  const compressed = await deflateAsync(raw, { level: 9 });
  const png        = Buffer.concat([
    PNG_SIG,
    makeChunk("IHDR", makeIHDR(size)),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(outPath, png);
  console.log(`✓ ${outPath} (${size}×${size})`);
}

const publicDir = resolve(__dirname, "../src/public");
mkdirSync(publicDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  await generateIcon(size, resolve(publicDir, `icon-${size}.png`));
}
console.log("Done.");
