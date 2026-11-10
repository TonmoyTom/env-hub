'use strict';

// Makes every picture the app needs from the drawings in build/art/. No extra packages: it runs inside Electron,
// which can read, resize and write images. Run:  npm run art   (or: npx electron scripts/make-brand-assets.js)
//
//   build/art/crane-glyph-white.png     white crane + container, transparent      -> app icon, tray
//   build/art/logo-stack.png            stacked containers, transparent           -> logo in the sidebar
//   build/art/installer-sidebar-source  tall picture                              -> installer sidebar (BMP 164x314)
//   build/art/installer-header-source   wide picture, crane on the right          -> installer header (BMP 150x57)
//   build/art/empty-projects.png        "no projects" illustration                -> renderer/assets
//   build/art/empty-docker.png          "Docker is not running" illustration      -> renderer/assets
//
// Writes: build/icon.png (1024), build/icon.ico, build/icon.icns, build/tray.png (+ trayTemplate for macOS),
//         build/installerSidebar.bmp, build/installerHeader.bmp, renderer/assets/*.png

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'build', 'art');
const BUILD = path.join(ROOT, 'build');
const ASSETS = path.join(ROOT, 'renderer', 'assets');

// ---------- images as BGRA pixels ----------

function load(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`Cannot read ${file}`);
  const { width, height } = img.getSize();
  return { w: width, h: height, data: Buffer.from(img.toBitmap()) };
}

function toNative(img) {
  return nativeImage.createFromBitmap(img.data, { width: img.w, height: img.h });
}

function resize(img, w, h) {
  const out = toNative(img).resize({ width: w, height: h, quality: 'best' });
  const size = out.getSize();
  return { w: size.width, h: size.height, data: Buffer.from(out.toBitmap()) };
}

function png(img) {
  return toNative(img).toPNG();
}

// AI generated cut-outs have faint specks in the "empty" parts. Everything nearly clear becomes clear,
// everything nearly solid becomes solid, and the edge between keeps its softness.
function cleanAlpha(img, lo = 40, hi = 210) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    d[i] = a <= lo ? 0 : a >= hi ? 255 : Math.round(((a - lo) / (hi - lo)) * 255);
  }
  return img;
}

function bounds(img, threshold = 128) {
  let x0 = img.w;
  let y0 = img.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.h; y += 1) {
    for (let x = 0; x < img.w; x += 1) {
      if (img.data[(y * img.w + x) * 4 + 3] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(img, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y += 1) {
    img.data.copy(out, y * box.w * 4, ((box.y + y) * img.w + box.x) * 4, ((box.y + y) * img.w + box.x + box.w) * 4);
  }
  return { w: box.w, h: box.h, data: out };
}

// The drawing cut to its content, scaled so its longest side is `longest`.
function fitContent(img, longest) {
  const box = bounds(img);
  const content = crop(img, box);
  const scale = longest / Math.max(content.w, content.h);
  return resize(content, Math.max(1, Math.round(content.w * scale)), Math.max(1, Math.round(content.h * scale)));
}

function recolor(img, bgr) {
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = bgr[0];
    img.data[i + 1] = bgr[1];
    img.data[i + 2] = bgr[2];
  }
  return img;
}

// ---------- drawing ----------

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function roundedRectDistance(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Blurs one plane of 0..1 numbers (three box blurs look like a gaussian).
function blurPlane(plane, w, h, radius) {
  const tmp = new Float32Array(plane.length);
  const pass = (src, dst, horizontal) => {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    for (let line = 0; line < lines; line += 1) {
      let sum = 0;
      const at = (i) => (horizontal ? line * w + i : i * w + line);
      for (let i = -radius; i <= radius; i += 1) sum += src[at(Math.min(len - 1, Math.max(0, i)))];
      for (let i = 0; i < len; i += 1) {
        dst[at(i)] = sum / (2 * radius + 1);
        sum += src[at(Math.min(len - 1, i + radius + 1))] - src[at(Math.max(0, i - radius))];
      }
    }
  };
  for (let n = 0; n < 3; n += 1) {
    pass(plane, tmp, true);
    pass(tmp, plane, false);
  }
  return plane;
}

const INDIGO = hex('#4F46E5');
const VIOLET = hex('#7C3AED');

// The app icon: a rounded square with a gradient, the white crane in the middle, and a soft shadow under it.
// `glyphScale` = how much of the square the crane fills (smaller icons use more, so the crane stays readable).
function composeIcon(size, glyph, glyphScale) {
  const out = Buffer.alloc(size * size * 4);
  const content = fitContent(glyph, Math.round(size * glyphScale));
  const gx = Math.round((size - content.w) / 2);
  const gy = Math.round((size - content.h) / 2);

  const shadow = new Float32Array(size * size);
  const offset = Math.round(size * 0.018);
  for (let y = 0; y < content.h; y += 1) {
    for (let x = 0; x < content.w; x += 1) {
      const a = content.data[(y * content.w + x) * 4 + 3] / 255;
      const sx = gx + x;
      const sy = gy + y + offset;
      if (a > 0 && sx >= 0 && sy >= 0 && sx < size && sy < size) shadow[sy * size + sx] = a;
    }
  }
  blurPlane(shadow, size, size, Math.max(1, Math.round(size * 0.014)));

  const half = size / 2;
  const radius = size * 0.225;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = roundedRectDistance(x + 0.5, y + 0.5, half, half, half, half, radius);
      const coverage = Math.max(0, Math.min(1, 0.5 - d));
      if (coverage === 0) continue;
      // gradient, with a faint light patch in the top left corner for depth
      let c = mix(INDIGO, VIOLET, (x + y) / (2 * size));
      const glow = Math.max(0, 1 - Math.hypot(x - size * 0.22, y - size * 0.18) / (size * 0.7)) * 0.16;
      c = mix(c, [255, 255, 255], glow);
      // shadow of the crane
      c = mix(c, [20, 10, 70], shadow[y * size + x] * 0.38);
      // the crane itself
      const gxp = x - gx;
      const gyp = y - gy;
      if (gxp >= 0 && gyp >= 0 && gxp < content.w && gyp < content.h) {
        const a = content.data[(gyp * content.w + gxp) * 4 + 3] / 255;
        c = mix(c, [255, 255, 255], a);
      }
      const i = (y * size + x) * 4;
      out[i] = Math.round(c[2]);
      out[i + 1] = Math.round(c[1]);
      out[i + 2] = Math.round(c[0]);
      out[i + 3] = Math.round(coverage * 255);
    }
  }
  return { w: size, h: size, data: out };
}

// ---------- file formats ----------

// A Windows icon with several sizes, each one a PNG.
function writeIco(pngs) {
  const head = Buffer.alloc(6 + pngs.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    head[at] = size >= 256 ? 0 : size;
    head[at + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

// A macOS icon: a list of PNG pictures, each with its four letter type.
const ICNS_TYPES = [
  ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

function writeIcns(pngBySize) {
  const parts = ICNS_TYPES.map(([type, size]) => {
    const data = pngBySize.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const total = 8 + parts.reduce((sum, p) => sum + p.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...parts]);
}

// 24 bit BMP (what the NSIS installer wants), rows bottom up, padded to 4 bytes. Transparent pixels turn into `backdrop`.
function writeBmp(img, backdrop = [255, 255, 255]) {
  const rowSize = Math.ceil((img.w * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * img.h);
  for (let y = 0; y < img.h; y += 1) {
    const dest = (img.h - 1 - y) * rowSize;
    for (let x = 0; x < img.w; x += 1) {
      const s = (y * img.w + x) * 4;
      const a = img.data[s + 3] / 255;
      data[dest + x * 3] = Math.round(img.data[s] * a + backdrop[2] * (1 - a));
      data[dest + x * 3 + 1] = Math.round(img.data[s + 1] * a + backdrop[1] * (1 - a));
      data[dest + x * 3 + 2] = Math.round(img.data[s + 2] * a + backdrop[0] * (1 - a));
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0);
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(img.w, 18);
  head.writeInt32LE(img.h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  return Buffer.concat([head, data]);
}

// Scales a picture to fill w x h, and cuts what sticks out (from the middle).
function cover(img, w, h) {
  const scale = Math.max(w / img.w, h / img.h);
  const sw = Math.max(w, Math.round(img.w * scale));
  const sh = Math.max(h, Math.round(img.h * scale));
  const scaled = resize(img, sw, sh);
  return crop(scaled, { x: Math.floor((sw - w) / 2), y: Math.floor((sh - h) / 2), w, h });
}

// ---------- the work ----------

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`wrote ${path.relative(ROOT, file)} (${Math.round(data.length / 1024)} KB)`);
}

function main() {
  // 1. app icon, from the white crane
  const glyph = cleanAlpha(load(path.join(ART, 'crane-glyph-white.png')));
  const icon1024 = composeIcon(1024, glyph, 0.6);
  write(path.join(BUILD, 'icon.png'), png(icon1024));

  const sizes = new Map();
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    // small sizes draw their own version, so the crane stays big enough to read
    const picture = size >= 256 ? resize(icon1024, size, size) : composeIcon(Math.max(size * 4, 128), glyph, size <= 32 ? 0.74 : 0.66);
    sizes.set(size, png(size >= 256 ? picture : resize(picture, size, size)));
  }
  write(path.join(BUILD, 'icon.ico'), writeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: sizes.get(size) }))));
  write(path.join(BUILD, 'icon.icns'), writeIcns(sizes));

  // 2. tray: the colored icon (Windows, Linux) and a one color shape for the macOS menu bar
  write(path.join(BUILD, 'tray.png'), sizes.get(16));
  write(path.join(BUILD, 'tray@2x.png'), sizes.get(32));
  const black = recolor(cleanAlpha(load(path.join(ART, 'crane-glyph-white.png'))), [0, 0, 0]);
  const flat = (size) => {
    const content = fitContent(black, Math.round(size * 0.9));
    const out = Buffer.alloc(size * size * 4);
    const ox = Math.floor((size - content.w) / 2);
    const oy = Math.floor((size - content.h) / 2);
    for (let y = 0; y < content.h; y += 1) {
      content.data.copy(out, ((oy + y) * size + ox) * 4, y * content.w * 4, (y + 1) * content.w * 4);
    }
    return png({ w: size, h: size, data: out });
  };
  write(path.join(BUILD, 'trayTemplate.png'), flat(16));
  write(path.join(BUILD, 'trayTemplate@2x.png'), flat(32));

  // 3. installer pictures (BMP, 24 bit)
  const side = load(path.join(ART, 'installer-sidebar-source.png'));
  write(path.join(BUILD, 'installerSidebar.bmp'), writeBmp(cover(side, 164, 314)));
  const header = load(path.join(ART, 'installer-header-source.png'));
  write(path.join(BUILD, 'installerHeader.bmp'), writeBmp(cover(header, 150, 57)));

  // 4. pictures inside the app
  const stack = cleanAlpha(load(path.join(ART, 'logo-stack.png')));
  write(path.join(ASSETS, 'logo-stack.png'), png(fitContent(stack, 220)));
  write(path.join(ASSETS, 'logo.png'), png(resize(icon1024, 128, 128)));
  const projects = load(path.join(ART, 'empty-projects.png'));
  write(path.join(ASSETS, 'empty-projects.png'), png(resize(projects, 720, 480)));
  const docker = cleanAlpha(load(path.join(ART, 'empty-docker.png')), 24, 160);
  const dockerContent = crop(docker, bounds(docker, 20));
  const dockerScale = 640 / dockerContent.w;
  write(path.join(ASSETS, 'empty-docker.png'), png(resize(dockerContent, 640, Math.round(dockerContent.h * dockerScale))));
}

app.whenReady().then(() => {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
  app.quit();
});
