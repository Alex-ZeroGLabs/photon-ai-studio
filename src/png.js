'use strict';
// Dependency-free PNG decode/encode (8-bit gray/RGB/RGBA, non-interlaced) + seam color matching.
const fs = require('node:fs');
const zlib = require('node:zlib');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Returns { w, h, data: Uint8Array RGBA }. */
function decode(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, depth = 8, ct = 6, interlace = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; interlace = d[12]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error('Unsupported PNG');
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!bpp) throw new Error('Unsupported PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], o = y * (stride + 1) + 1, r = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[o + x], a = x >= bpp ? px[r + x - bpp] : 0, u = y ? px[r - stride + x] : 0, c = x >= bpp && y ? px[r - stride + x - bpp] : 0;
      let out;
      if (f === 0) out = v; else if (f === 1) out = v + a; else if (f === 2) out = v + u; else if (f === 3) out = v + ((a + u) >> 1);
      else { const pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c); out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      px[r + x] = out & 255;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += bpp) {
    if (bpp >= 3) { data[i * 4] = px[j]; data[i * 4 + 1] = px[j + 1]; data[i * 4 + 2] = px[j + 2]; data[i * 4 + 3] = bpp === 4 ? px[j + 3] : 255; }
    else { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[j]; data[i * 4 + 3] = bpp === 2 ? px[j + 1] : 255; }
  }
  return { w, h, data };
}

function encode(file, { w, h, data }) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  const chunk = (type, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}

/** Box blur of a Float32 mask via integral image. */
function boxBlur(m, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += m[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * Seam color match: the generated image keeps the original pixels outside `mask` (0..1, 1 = generated),
 * so compare a thin ring just outside the mask with a ring just inside it and shift the generated
 * area by the difference (fading towards the center). Fixes tone drift of inpaint models.
 */
function seamMatch(img, hardMask, { strength = 0.9, ringFrac = 0.06, dilate = 0, inner = 0.55 } = {}) {
  const { w, h, data } = img;
  let area = 0; for (let i = 0; i < hardMask.length; i++) area += hardMask[i] > 0.5 ? 1 : 0;
  if (area < 64 || area > w * h - 64) return false;
  const r = Math.max(3, Math.round(Math.sqrt(area) * ringFrac));
  // `dilate` = how far generated pixels reach outside the selection (mask grow + blur in the graph).
  let mask = hardMask;
  if (dilate > 0) { const d = boxBlur(hardMask, w, h, dilate); mask = new Float32Array(d.length); for (let i = 0; i < d.length; i++) mask[i] = Math.min(1, d[i] * 2.2); }
  const blurIn = boxBlur(hardMask, w, h, r);
  const blurOut = boxBlur(mask, w, h, r);
  const sIn = [0, 0, 0], sOut = [0, 0, 0]; let nIn = 0, nOut = 0;
  for (let i = 0; i < w * h; i++) {
    if (hardMask[i] > 0.5 && blurIn[i] < 0.97) { for (let c = 0; c < 3; c++) sIn[c] += data[i * 4 + c]; nIn++; }
    else if (mask[i] < 0.01 && blurOut[i] > 0.02) { for (let c = 0; c < 3; c++) sOut[c] += data[i * 4 + c]; nOut++; }
  }
  if (nIn < 32 || nOut < 32) return false;
  const off = sOut.map((s, c) => s / nOut - sIn[c] / nIn);
  if (Math.max(...off.map(Math.abs)) < 2) return false;
  // Full shift near the seam, softer in the middle (keeps the new object's own colors more intact).
  const far = inner < 1 ? boxBlur(mask, w, h, r * 4) : null;
  for (let i = 0; i < w * h; i++) {
    const m = mask[i]; if (m <= 0.001) continue;
    const edge = far ? 1 - Math.max(0, Math.min(1, (far[i] - 0.5) * 2)) * (1 - inner) : 1; // 1 at seam .. `inner` deep inside
    const k = m * edge * strength;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(data[i * 4 + c] + off[c] * k)));
  }
  return off;
}

/** Load a white-on-black mask PNG as Float32 (red channel). */
function maskFromPng(file) { const m = decode(file); const out = new Float32Array(m.w * m.h); for (let i = 0; i < out.length; i++) out[i] = m.data[i * 4] / 255; return { w: m.w, h: m.h, mask: out }; }

module.exports = { decode, encode, seamMatch, maskFromPng };
