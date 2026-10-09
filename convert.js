// Image conversion and print-ready output. The pure parts (page ranges, DPI metadata, sheet layout) have no
// DOM dependency so they can be unit-tested in Node; decode/encode helpers use canvas in the browser.

export const mm = (v) => (v * 72) / 25.4;
export const PAPER = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.84],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

/** "1-3, 5, 8-" -> [0,1,2,4,7,...]. Empty means every page. Throws a readable Error on bad input. */
export function parseRange(text, n) {
  const t = String(text || '').trim();
  if (!t) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)(?:-(\d*))?$/.exec(part);
    if (!m || (m[1] === '' && !part.includes('-')) || part === '-') throw new Error(`"${part}" is not a page number or range`);
    let a, b;
    if (part.includes('-')) { a = m[1] === '' ? 1 : Number(m[1]); b = m[2] === '' || m[2] === undefined ? n : Number(m[2]); }
    else a = b = Number(m[1]);
    if (a < 1 || b < 1 || a > n || b > n) throw new Error(`Page ${a > n || b > n ? Math.max(a, b) : 0} is outside 1–${n}`);
    if (a > b) throw new Error(`"${part}" runs backwards`);
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out;
}

/* ------------------------------------------------------------------ DPI metadata */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** Write (or replace) the pHYs chunk so viewers and printers know the intended resolution. */
export function pngSetDpi(bytes, dpi) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) return bytes;
  const ppm = Math.round(dpi / 0.0254);
  const body = [112, 72, 89, 115, ...u32(ppm), ...u32(ppm), 1]; // 'pHYs' + x + y + unit(metre)
  const chunk = new Uint8Array([...u32(9), ...body, ...u32(crc32(new Uint8Array(body)))]);
  const parts = [bytes.subarray(0, 8)];
  let pos = 8;
  let inserted = false;
  while (pos + 12 <= bytes.length) {
    const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const end = pos + 12 + len;
    if (type === 'pHYs') { pos = end; continue; }
    parts.push(bytes.subarray(pos, end));
    if (type === 'IHDR' && !inserted) { parts.push(chunk); inserted = true; }
    pos = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function pngGetDpi(bytes) {
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    if (String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]) === 'pHYs') {
      const x = ((bytes[pos + 8] << 24) | (bytes[pos + 9] << 16) | (bytes[pos + 10] << 8) | bytes[pos + 11]) >>> 0;
      return bytes[pos + 16] === 1 ? Math.round(x * 0.0254) : null;
    }
    pos += 12 + len;
  }
  return null;
}

/** Set the JFIF density (dots per inch) in the APP0 segment, adding one if the encoder left it out. */
export function jpegSetDpi(bytes, dpi) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const d = Math.min(65535, Math.round(dpi));
  const isJfif = bytes[2] === 0xff && bytes[3] === 0xe0 && bytes[6] === 0x4a && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46;
  if (isJfif) {
    const out = bytes.slice();
    out[13] = 1; out[14] = d >> 8; out[15] = d & 255; out[16] = d >> 8; out[17] = d & 255;
    return out;
  }
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0];
  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(bytes.subarray(2), 2 + app0.length);
  return out;
}
export function jpegGetDpi(bytes) {
  if (bytes[2] === 0xff && bytes[3] === 0xe0 && bytes[13] === 1) return (bytes[14] << 8) | bytes[15];
  return null;
}

/** 24-bit BMP from RGBA pixels (alpha is flattened onto white). */
export function encodeBmp(rgba, w, h, dpi = 96) {
  const row = (w * 3 + 3) & ~3;
  const size = 54 + row * h;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, size, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  dv.setUint32(34, row * h, true);
  const ppm = Math.round(dpi / 0.0254);
  dv.setInt32(38, ppm, true); dv.setInt32(42, ppm, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      out[o++] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
      out[o++] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
      out[o++] = Math.round(rgba[i] * a + 255 * (1 - a));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ print layout */

/**
 * Work out every output sheet. `pages` are display sizes in points ({w,h}). All coordinates are PDF
 * coordinates (origin bottom-left) on the full media box, which includes bleed and the slug for crop marks.
 */
export function layoutSheets(pages, opts = {}) {
  const o = { paper: 'auto', orientation: 'auto', margin: 10, scale: 'shrink', nup: 1, bleed: 0, bleedMode: 'blank', marks: false, gutter: 4, borders: false, ...opts };
  const M = mm(o.margin), B = mm(o.bleed), G = mm(o.gutter);
  const n = o.nup;
  const grids = (portrait) => ({ 1: [1, 1], 2: portrait ? [2, 1] : [1, 2], 4: [2, 2], 6: portrait ? [3, 2] : [2, 3], 9: [3, 3] })[n];
  if (!grids(true)) throw new Error('Pages per sheet must be 1, 2, 4, 6 or 9');
  const off = B + (o.marks ? mm(8) : 0);
  const sheets = [];
  for (let i = 0; i < pages.length; i += n) {
    const group = pages.slice(i, i + n);
    const lead = n === 1 ? group[0] : pages[0];
    const portraitSrc = lead.h >= lead.w;
    const [cols, rows] = grids(portraitSrc);
    let [W, H] = o.paper === 'auto' ? (n === 1 ? [group[0].w, group[0].h] : PAPER.A4) : PAPER[o.paper];
    if (!PAPER[o.paper] && o.paper !== 'auto') throw new Error(`Unknown paper size ${o.paper}`);
    const [lo, hi] = [Math.min(W, H), Math.max(W, H)];
    if (o.orientation === 'portrait') [W, H] = [lo, hi];
    else if (o.orientation === 'landscape') [W, H] = [hi, lo];
    else if (n === 1) { if (o.paper !== 'auto') [W, H] = group[0].w > group[0].h ? [hi, lo] : [lo, hi]; }
    else [W, H] = cols > rows ? [hi, lo] : [lo, hi];
    const media = [W + 2 * off, H + 2 * off];
    const trim = { x: off, y: off, w: W, h: H };
    const bleed = { x: off - B, y: off - B, w: W + 2 * B, h: H + 2 * B };
    const cw = (W - 2 * M - (cols - 1) * G) / cols, ch = (H - 2 * M - (rows - 1) * G) / rows;
    const placements = group.map((pg, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      const cell = { x: off + M + col * (cw + G), y: off + M + (rows - 1 - row) * (ch + G), w: cw, h: ch };
      let s, clip = cell;
      if (n === 1 && o.bleedMode === 'enlarge' && B > 0) {
        s = Math.max((W + 2 * B) / pg.w, (H + 2 * B) / pg.h);
        clip = bleed;
        const w = pg.w * s, h = pg.h * s;
        return { src: i + k, x: trim.x + (W - w) / 2, y: trim.y + (H - h) / 2, w, h, scale: s, clip };
      }
      const fit = Math.min(cell.w / pg.w, cell.h / pg.h);
      s = o.scale === 'actual' ? 1 : o.scale === 'fit' ? fit : Math.min(1, fit);
      const w = pg.w * s, h = pg.h * s;
      return { src: i + k, x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h, scale: s, clip };
    });
    const marks = [];
    if (o.marks) {
      const gap = B + mm(1), len = mm(5);
      const { x, y, w, h } = trim;
      for (const [cx, cy, sx, sy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]) {
        marks.push([cx + sx * gap, cy, cx + sx * (gap + len), cy]); // horizontal tick, level with the trim edge
        marks.push([cx, cy + sy * gap, cx, cy + sy * (gap + len)]); // vertical tick
      }
    }
    sheets.push({ media, trim, bleed, placements, marks, borders: o.borders && n > 1 });
  }
  return sheets;
}

/** Imposition of an existing PDF (bytes) into print-ready sheets with pdf-lib. */
export async function buildPrintPdf(L, bytes, opts = {}) {
  const { PDFDocument, rgb, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = L;
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const srcPages = src.getPages();
  const info = srcPages.map((pg) => {
    const cb = pg.getCropBox();
    const R = ((pg.getRotation().angle % 360) + 360) % 360;
    return { R, cw: cb.width, ch: cb.height, w: R % 180 ? cb.height : cb.width, h: R % 180 ? cb.width : cb.height };
  });
  const order = opts.pages || srcPages.map((_, i) => i);
  const sheets = layoutSheets(order.map((i) => info[i]), opts);
  const out = await PDFDocument.create();
  const embedded = await out.embedPages(
    order.map((i) => srcPages[i]),
    order.map((i) => { const c = srcPages[i].getCropBox(); return { left: c.x, bottom: c.y, right: c.x + c.width, top: c.y + c.height }; })
  );
  for (const sh of sheets) {
    const page = out.addPage(sh.media);
    page.setTrimBox(sh.trim.x, sh.trim.y, sh.trim.w, sh.trim.h);
    page.setBleedBox(sh.bleed.x, sh.bleed.y, sh.bleed.w, sh.bleed.h);
    for (const pl of sh.placements) {
      const k = pl.src; // index into `order`
      const { R, cw, ch } = info[order[k]];
      // place the unrotated embedded page so that, after rotating R degrees clockwise, it fills pl's box
      const s = pl.scale;
      const origin = R === 90 ? [pl.x, pl.y + cw * s] : R === 180 ? [pl.x + cw * s, pl.y + ch * s] : R === 270 ? [pl.x + ch * s, pl.y] : [pl.x, pl.y];
      page.pushOperators(pushGraphicsState(), rectangle(pl.clip.x, pl.clip.y, pl.clip.w, pl.clip.h), clip(), endPath());
      page.drawPage(embedded[k], { x: origin[0], y: origin[1], xScale: s, yScale: s, rotate: degrees(-R) });
      page.pushOperators(popGraphicsState());
      if (sh.borders) page.drawRectangle({ x: pl.x, y: pl.y, width: pl.w, height: pl.h, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.4 });
    }
    for (const [x1, y1, x2, y2] of sh.marks) page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.35, color: rgb(0, 0, 0) });
  }
  return { bytes: await out.save(), sheets };
}

/** One page per image. items: [{ bytes, kind: 'png'|'jpg', w, h }] (pixels). */
export async function imagesToPdf(L, items, o = {}) {
  const { PDFDocument } = L;
  const opts = { paper: 'fit', orientation: 'auto', margin: 10, dpi: 150, ...o };
  const out = await PDFDocument.create();
  for (const it of items) {
    const img = it.kind === 'jpg' ? await out.embedJpg(it.bytes) : await out.embedPng(it.bytes);
    const iw = (it.w * 72) / opts.dpi, ih = (it.h * 72) / opts.dpi;
    if (opts.paper === 'fit') {
      const page = out.addPage([iw, ih]);
      page.drawImage(img, { x: 0, y: 0, width: iw, height: ih });
      continue;
    }
    let [W, H] = PAPER[opts.paper];
    const [lo, hi] = [Math.min(W, H), Math.max(W, H)];
    if (opts.orientation === 'landscape' || (opts.orientation === 'auto' && it.w > it.h)) [W, H] = [hi, lo];
    else [W, H] = [lo, hi];
    const M = mm(opts.margin);
    const s = Math.min((W - 2 * M) / iw, (H - 2 * M) / ih);
    const page = out.addPage([W, H]);
    page.drawImage(img, { x: (W - iw * s) / 2, y: (H - ih * s) / 2, width: iw * s, height: ih * s });
  }
  return out.save();
}

/* ------------------------------------------------------------------ browser helpers */

const canvasBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));

/** Decode any browser-readable image (EXIF orientation applied; SVG rasterised) onto a canvas. */
export async function decodeImage(file) {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  let source, w, h;
  if (!isSvg) {
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      w = source.width; h = source.height;
    } catch { source = null; }
  }
  if (!source) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
      w = img.naturalWidth || 1024;
      h = img.naturalHeight || 768;
      if (isSvg) { const k = Math.max(1, 1600 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k); }
    } catch {
      throw new Error(`"${file.name}" could not be read as an image${/\.(heic|heif|tiff?)$/i.test(file.name) ? ' (this browser cannot open that format)' : ''}.`);
    } finally { URL.revokeObjectURL(url); }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
  source.close?.();
  return { canvas, w, h, type: isSvg ? 'image/svg+xml' : file.type };
}

export function hasAlpha(canvas) {
  const w = Math.min(canvas.width, 256), h = Math.min(canvas.height, 256);
  const stepX = Math.max(1, Math.floor(canvas.width / w)), stepY = Math.max(1, Math.floor(canvas.height / h));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (let y = 0; y < canvas.height; y += stepY) {
    const d = ctx.getImageData(0, y, canvas.width, 1).data;
    for (let x = 3; x < d.length; x += 4 * stepX) if (d[x] < 250) return true;
  }
  return false;
}

export function resizeCanvas(canvas, { mode = 'none', max = 2000, percent = 100 } = {}) {
  let k = 1;
  if (mode === 'max') k = Math.min(1, max / Math.max(canvas.width, canvas.height));
  else if (mode === 'percent') k = percent / 100;
  if (Math.abs(k - 1) < 0.001) return canvas;
  let cur = canvas;
  const tw = Math.max(1, Math.round(canvas.width * k)), th = Math.max(1, Math.round(canvas.height * k));
  // halve repeatedly when shrinking a lot: much better quality than one big drawImage
  while (cur.width / 2 > tw && cur.height / 2 > th) {
    const c = document.createElement('canvas');
    c.width = Math.round(cur.width / 2); c.height = Math.round(cur.height / 2);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  const out = document.createElement('canvas');
  out.width = tw; out.height = th;
  const x = out.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, tw, th);
  return out;
}

export function flatten(canvas, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(canvas, 0, 0);
  return c;
}

export function toGrayscale(canvas) {
  const x = canvas.getContext('2d', { willReadFrequently: true });
  const img = x.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  x.putImageData(img, 0, 0);
  return canvas;
}

export const FORMATS = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
  bmp: { mime: 'image/bmp', ext: 'bmp' },
};

/** Encode a canvas, embedding the resolution where the format supports it (PNG, JPEG, BMP). */
export async function encodeCanvas(canvas, format, { quality = 0.92, dpi = 96, background = '#ffffff' } = {}) {
  const f = FORMATS[format];
  if (!f) throw new Error(`Unknown format ${format}`);
  if (format === 'bmp') {
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    return { bytes: encodeBmp(d, canvas.width, canvas.height, dpi), ...f };
  }
  const src = format === 'jpeg' ? flatten(canvas, background) : canvas;
  const blob = await canvasBlob(src, f.mime, quality);
  if (!blob || blob.type !== f.mime) throw new Error(`This browser cannot create ${format.toUpperCase()} files`);
  let bytes = new Uint8Array(await blob.arrayBuffer());
  if (format === 'png') bytes = pngSetDpi(bytes, dpi);
  else if (format === 'jpeg') bytes = jpegSetDpi(bytes, dpi);
  return { bytes, ...f };
}
