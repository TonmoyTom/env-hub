'use strict';

// OLD, NOT USED ANY MORE: this drew a first icon in code. The real pictures now come from build/art/ with
// scripts/make-brand-assets.js (npm run art). Running this file would overwrite them with the old ones.
// Draws the installer pictures into build/ with no extra packages (only Node's zlib):
//   build/icon.png            256x256 app icon (used by electron-builder for the exe)
//   build/icon.ico            the same, as a Windows icon
//   build/installerSidebar.bmp  164x314 picture on the left of the installer (NSIS wants a 24 bit BMP)
// Run: node scripts/make-installer-art.js   (the files are committed, so this is only for changes)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');

// ---------- tiny canvas ----------

function createCanvas(w, h) {
  return { w, h, px: new Float32Array(w * h * 4) }; // r g b a, 0..1
}

const hex = (c) => [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Paints `color` over the pixel with coverage `cov` (0..1).
function blend(canvas, x, y, color, cov) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h || cov <= 0) return;
  const i = (y * canvas.w + x) * 4;
  const a = Math.min(1, cov) * (color[3] === undefined ? 1 : color[3]);
  const outA = a + canvas.px[i + 3] * (1 - a);
  for (let k = 0; k < 3; k += 1) {
    canvas.px[i + k] = outA === 0 ? 0 : (color[k] * a + canvas.px[i + k] * canvas.px[i + 3] * (1 - a)) / outA;
  }
  canvas.px[i + 3] = outA;
}

// Signed distance to a rounded rectangle centred at (cx, cy).
function roundedRectDistance(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Fills a rounded rectangle. `paint(x, y)` returns the colour of a pixel, so it can be a gradient.
function fillRoundedRect(canvas, cx, cy, hw, hh, r, paint) {
  const x0 = Math.floor(cx - hw - 1);
  const x1 = Math.ceil(cx + hw + 1);
  const y0 = Math.floor(cy - hh - 1);
  const y1 = Math.ceil(cy + hh + 1);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = roundedRectDistance(x + 0.5, y + 0.5, cx, cy, hw, hh, r);
      blend(canvas, x, y, paint(x, y), Math.max(0, Math.min(1, 0.5 - d)));
    }
  }
}

function fillCircle(canvas, cx, cy, radius, color) {
  fillRoundedRect(canvas, cx, cy, radius, radius, radius, () => color);
}

// ---------- the logo: three stacked layers (a stack of environments) on a gradient square ----------

const BLUE = hex('#2563eb');
const VIOLET = hex('#7c3aed');
const WHITE = [1, 1, 1];

function drawLogo(canvas, size, ox, oy) {
  const c = size / 2;
  fillRoundedRect(canvas, ox + c, oy + c, c, c, size * 0.22, (x, y) => mix(BLUE, VIOLET, ((x - ox) + (y - oy)) / (2 * size)));
  const barW = size * 0.5;
  const barH = size * 0.115;
  const gap = size * 0.07;
  const top = oy + c - barH * 1.5 - gap;
  for (let i = 0; i < 3; i += 1) {
    const shrink = i === 1 ? 0.0 : i === 0 ? 0.12 : 0.12;
    fillRoundedRect(canvas, ox + c, top + barH / 2 + i * (barH + gap), barW / 2 - size * shrink / 2, barH / 2, barH / 2, () => [...WHITE, i === 1 ? 1 : 0.8]);
    // a small dot at the left end of each layer, like a status light
    fillCircle(canvas, ox + c - barW / 2 + barH * 0.9, top + barH / 2 + i * (barH + gap), barH * 0.16, [...mix(BLUE, VIOLET, 0.5), 1]);
  }
}

// ---------- file writers ----------

function toRgba8(canvas, background) {
  const out = Buffer.alloc(canvas.w * canvas.h * 4);
  for (let i = 0; i < canvas.w * canvas.h; i += 1) {
    let [r, g, b] = canvas.px.slice(i * 4, i * 4 + 3);
    const a = canvas.px[i * 4 + 3];
    if (background) {
      r = r * a + background[0] * (1 - a);
      g = g * a + background[1] * (1 - a);
      b = b * a + background[2] * (1 - a);
      out.set([r * 255, g * 255, b * 255, 255].map((v) => Math.round(v)), i * 4);
    } else {
      out.set([r * 255, g * 255, b * 255, a * 255].map((v) => Math.round(v)), i * 4);
    }
  }
  return out;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(canvas) {
  const rgba = toRgba8(canvas);
  const rows = Buffer.alloc((canvas.w * 4 + 1) * canvas.h);
  for (let y = 0; y < canvas.h; y += 1) {
    rows[y * (canvas.w * 4 + 1)] = 0;
    rgba.copy(rows, y * (canvas.w * 4 + 1) + 1, y * canvas.w * 4, (y + 1) * canvas.w * 4);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(canvas.w, 0);
  head.writeUInt32BE(canvas.h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', head),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// A Windows icon that holds one PNG picture (allowed since Windows Vista).
function writeIco(png, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = size >= 256 ? 0 : size;
  head[7] = size >= 256 ? 0 : size;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

// 24 bit BMP, bottom-up rows padded to 4 bytes.
function writeBmp(canvas, background) {
  const rgba = toRgba8(canvas, background);
  const rowSize = Math.ceil((canvas.w * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * canvas.h);
  for (let y = 0; y < canvas.h; y += 1) {
    const dest = (canvas.h - 1 - y) * rowSize;
    for (let x = 0; x < canvas.w; x += 1) {
      const s = (y * canvas.w + x) * 4;
      data[dest + x * 3] = rgba[s + 2];
      data[dest + x * 3 + 1] = rgba[s + 1];
      data[dest + x * 3 + 2] = rgba[s];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0);
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(canvas.w, 18);
  head.writeInt32LE(canvas.h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  return Buffer.concat([head, data]);
}

// ---------- the pictures ----------

function makeIcon() {
  const canvas = createCanvas(256, 256);
  drawLogo(canvas, 256, 0, 0);
  const png = writePng(canvas);
  return { png, ico: writeIco(png, 256) };
}

function makeSidebar() {
  const w = 164;
  const h = 314;
  const canvas = createCanvas(w, h);
  const top = hex('#0b1220');
  const bottom = hex('#1e3a8a');
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) blend(canvas, x, y, mix(top, bottom, y / h), 1);
  }
  // soft circles for some depth
  fillCircle(canvas, 150, 270, 90, [...VIOLET, 0.22]);
  fillCircle(canvas, 20, 330, 70, [...BLUE, 0.28]);
  fillCircle(canvas, 130, 40, 50, [...BLUE, 0.12]);
  drawLogo(canvas, 84, 40, 64);
  // a thin line of dots under the logo
  for (let i = 0; i < 3; i += 1) fillCircle(canvas, 70 + i * 12, 176, 2.2, [1, 1, 1, i === 1 ? 0.9 : 0.45]);
  return writeBmp(canvas, top);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const icon = makeIcon();
  fs.writeFileSync(path.join(OUT, 'icon.png'), icon.png);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), icon.ico);
  fs.writeFileSync(path.join(OUT, 'installerSidebar.bmp'), makeSidebar());
  console.log('Wrote build/icon.png, build/icon.ico, build/installerSidebar.bmp');
}

main();
