// Icon Generator for Classroom Downloader — Pure Node.js (no dependencies)
// Run: node generate-icons.js

const fs = require('fs');
const path = require('path');

const sizes = [16, 32, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

for (const size of sizes) {
  const png = createPNG(size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`Generated icon${size}.png (${png.length} bytes)`);
}
console.log('Done!');

function createPNG(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData.writeUInt8(8, 8);   // 8-bit
  ihdrData.writeUInt8(6, 9);   // RGBA
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);
  const ihdr = createChunk('IHDR', ihdrData);

  // Image data
  const rawData = [];
  const r0 = size * 0.18; // corner radius

  for (let y = 0; y < size; y++) {
    rawData.push(0); // filter: None
    for (let x = 0; x < size; x++) {
      // Rounded rectangle check
      if (!inRoundedRect(x, y, size, size, r0)) {
        rawData.push(0, 0, 0, 0); // transparent
        continue;
      }

      const cx = size / 2;
      const lw = Math.max(size * 0.09, 1.2); // line width

      // Arrow shaft (vertical line)
      const shaftTop = size * 0.2;
      const shaftBottom = size * 0.55;
      const isShaft = Math.abs(x - cx) <= lw && y >= shaftTop && y <= shaftBottom;

      // Arrow head (V shape)
      const headTop = size * 0.42;
      const headBottom = size * 0.62;
      const headWidth = size * 0.25;
      let isHead = false;
      if (y >= headTop && y <= headBottom) {
        const dy = y - headTop;
        const targetX1 = cx - headWidth + dy * (headWidth / (headBottom - headTop));
        const targetX2 = cx + headWidth - dy * (headWidth / (headBottom - headTop));
        isHead = (Math.abs(x - targetX1) <= lw || Math.abs(x - targetX2) <= lw);
      }

      // Bottom tray (U shape)
      const trayTop = size * 0.65;
      const trayBottom = size * 0.78;
      const trayLeft = size * 0.22;
      const trayRight = size * 0.78;
      const trayR = size * 0.06;
      const isHorizontalBottom = (Math.abs(y - trayBottom) <= lw && x >= trayLeft + trayR && x <= trayRight - trayR);
      const isLeftWall = (Math.abs(x - trayLeft) <= lw && y >= trayTop && y <= trayBottom - trayR);
      const isRightWall = (Math.abs(x - trayRight) <= lw && y >= trayTop && y <= trayBottom - trayR);
      // Rounded corners for tray
      const isBLCorner = dist(x, y, trayLeft + trayR, trayBottom - trayR) <= trayR + lw &&
                         dist(x, y, trayLeft + trayR, trayBottom - trayR) >= trayR - lw &&
                         x <= trayLeft + trayR && y >= trayBottom - trayR;
      const isBRCorner = dist(x, y, trayRight - trayR, trayBottom - trayR) <= trayR + lw &&
                         dist(x, y, trayRight - trayR, trayBottom - trayR) >= trayR - lw &&
                         x >= trayRight - trayR && y >= trayBottom - trayR;
      const isTray = isHorizontalBottom || isLeftWall || isRightWall || isBLCorner || isBRCorner;

      if (isShaft || isHead || isTray) {
        rawData.push(255, 255, 255, 255); // white
      } else {
        rawData.push(26, 115, 232, 255);  // blue
      }
    }
  }

  const rawBuf = Buffer.from(rawData);
  const deflated = deflateStore(rawBuf);
  const idat = createChunk('IDAT', deflated);
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function inRoundedRect(x, y, w, h, r) {
  if (x < r && y < r) return dist(x, y, r, r) <= r;
  if (x > w - r - 1 && y < r) return dist(x, y, w - r - 1, r) <= r;
  if (x < r && y > h - r - 1) return dist(x, y, r, h - r - 1) <= r;
  if (x > w - r - 1 && y > h - r - 1) return dist(x, y, w - r - 1, h - r - 1) <= r;
  return true;
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcVal = crc32(Buffer.concat([typeB, data]));
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function deflateStore(data) {
  const blocks = [];
  blocks.push(Buffer.from([0x78, 0x01]));
  const BS = 65535;
  for (let i = 0; i < data.length; i += BS) {
    const chunk = data.slice(i, Math.min(i + BS, data.length));
    const last = (i + BS >= data.length) ? 1 : 0;
    const hdr = Buffer.alloc(5);
    hdr.writeUInt8(last, 0);
    hdr.writeUInt16LE(chunk.length, 1);
    hdr.writeUInt16LE(chunk.length ^ 0xFFFF, 3);
    blocks.push(hdr);
    blocks.push(chunk);
  }
  const a = adler32(data);
  const ab = Buffer.alloc(4);
  ab.writeUInt32BE(a, 0);
  blocks.push(ab);
  return Buffer.concat(blocks);
}

function crc32(buf) {
  const table = makeCRCTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xFF];
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeCRCTable() {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
