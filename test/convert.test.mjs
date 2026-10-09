// Unit tests for the pure parts of convert.js (page ranges, DPI metadata, sheet layout, imposition).
// Run: node test/convert.test.mjs   (uses python3 + Pillow and pdftoppm as independent checkers when present)
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { parseRange, pngSetDpi, pngGetDpi, jpegSetDpi, jpegGetDpi, encodeBmp, layoutSheets, buildPrintPdf, imagesToPdf, mm, PAPER, crc32 } from '../convert.js';

const require = createRequire(import.meta.url);
const L = require('../vendor/pdf-lib.min.js');
const { PDFDocument, rgb, degrees } = L;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;
const have = (b) => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args]).toString().trim();
const hasPIL = (() => { try { py('import PIL'); return true; } catch { return false; } })();

// ---------------------------------------------------------------- page ranges
{
  check('empty range = all pages', parseRange('', 4).join() === '0,1,2,3');
  check('single pages and ranges', parseRange('1-3, 5', 6).join() === '0,1,2,4');
  check('open-ended ranges', parseRange('4-', 6).join() === '3,4,5' && parseRange('-2', 6).join() === '0,1');
  check('order is kept', parseRange('3,1', 5).join() === '2,0');
  for (const bad of ['0', '9', 'x', '3-1', '1-9']) {
    let msg = ''; try { parseRange(bad, 5); } catch (e) { msg = e.message; }
    check(`"${bad}" is rejected with a message`, msg.length > 5, msg);
  }
}

// ---------------------------------------------------------------- DPI metadata
{
  const mkPng = (w, h) => {
    const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
    for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0; // filter type 'none' for each row
    const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  };
  const png = mkPng(20, 10);
  const p300 = pngSetDpi(png, 300);
  check('PNG: dpi is written and read back', pngGetDpi(p300) === 300 && pngGetDpi(png) === null, String(pngGetDpi(p300)));
  check('PNG: setting dpi twice replaces the chunk', pngGetDpi(pngSetDpi(p300, 600)) === 600 && pngSetDpi(p300, 600).length === p300.length);
  if (hasPIL) {
    const f = path.join(tmp, 'a.png'); fs.writeFileSync(f, p300);
    const out = py('from PIL import Image;import sys;i=Image.open(sys.argv[1]);i.load();print(i.size,round(i.info["dpi"][0]))', f);
    check('PNG: an independent decoder (Pillow) reads size and 300 dpi', out === '(20, 10) 300', out);
  }
  const jf = path.join(tmp, 'a.jpg');
  if (hasPIL) {
    py('from PIL import Image;import sys;Image.new("RGB",(24,16),(200,30,30)).save(sys.argv[1],quality=90)', jf);
    const j = new Uint8Array(fs.readFileSync(jf));
    const j2 = jpegSetDpi(j, 300);
    check('JPEG: dpi is written and read back', jpegGetDpi(j2) === 300, String(jpegGetDpi(j2)));
    fs.writeFileSync(jf, j2);
    const out = py('from PIL import Image;import sys;i=Image.open(sys.argv[1]);i.load();print(i.size,round(i.info["dpi"][0]))', jf);
    check('JPEG: Pillow reads size and 300 dpi', out === '(24, 16) 300', out);
    const bare = j.slice(0, 2); // SOI only + rest without APP0: simulate an encoder without JFIF
    const noJfif = new Uint8Array([...j.slice(0, 2), ...j.slice(2 + 2 + (j[4] << 8 | j[5]))]);
    const fixed = jpegSetDpi(noJfif, 150);
    fs.writeFileSync(jf, fixed);
    check('JPEG without JFIF gets one and stays decodable', py('from PIL import Image;import sys;i=Image.open(sys.argv[1]);i.load();print(i.size)', jf) === '(24, 16)' && jpegGetDpi(fixed) === 150);
  }
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]); // 2x2: red green / blue transparent
  const bmp = encodeBmp(rgba, 2, 2, 300);
  if (hasPIL) {
    const f = path.join(tmp, 'a.bmp'); fs.writeFileSync(f, bmp);
    const out = py('from PIL import Image;import sys;i=Image.open(sys.argv[1]).convert("RGB");print(i.size,i.getpixel((0,0)),i.getpixel((0,1)),i.getpixel((1,1)),round(Image.open(sys.argv[1]).info["dpi"][0]))', f);
    check('BMP: pixels, orientation, transparency->white and dpi are right', out === '(2, 2) (255, 0, 0) (0, 0, 255) (255, 255, 255) 300', out);
  }
}

// ---------------------------------------------------------------- sheet layout
{
  const A4 = { w: PAPER.A4[0], h: PAPER.A4[1] };
  let [s] = layoutSheets([A4], {});
  check('auto size keeps the page size', near(s.media[0], A4.w) && near(s.media[1], A4.h));
  check('shrink never enlarges and centres the page', s.placements[0].scale <= 1 && near(s.placements[0].x + s.placements[0].w / 2, A4.w / 2));
  check('margin shrinks the page to fit', s.placements[0].w < A4.w && near(s.placements[0].x, mm(10), 0.6) || s.placements[0].scale < 1);

  [s] = layoutSheets([{ w: 300, h: 200 }], { paper: 'A4', margin: 0, scale: 'fit' });
  check('fit scales a small landscape page up to the sheet and picks landscape', near(s.media[0], PAPER.A4[1]) && near(s.placements[0].w, PAPER.A4[1]), JSON.stringify(s.media));
  [s] = layoutSheets([{ w: 300, h: 200 }], { paper: 'A4', margin: 0, scale: 'actual' });
  check('actual size keeps 100% and centres', s.placements[0].scale === 1 && near(s.placements[0].x, (PAPER.A4[1] - 300) / 2));
  [s] = layoutSheets([A4], { paper: 'Letter', orientation: 'landscape' });
  check('explicit orientation wins', s.media[0] > s.media[1]);

  const four = layoutSheets(Array(5).fill(A4), { nup: 4, paper: 'A4' });
  check('4-up: 5 pages -> 2 sheets, 4 then 1', four.length === 2 && four[0].placements.length === 4 && four[1].placements.length === 1);
  const pl = four[0].placements;
  const overlap = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
  check('4-up placements are in a 2x2 grid without overlap', !pl.some((a, i) => pl.some((b, j) => i < j && overlap(a, b))) && pl[0].x < pl[1].x && pl[0].y > pl[2].y);
  const two = layoutSheets([A4, A4, A4], { nup: 2, paper: 'A4' });
  check('2-up on portrait pages uses a landscape sheet, side by side', two[0].media[0] > two[0].media[1] && two[0].placements[0].x < two[0].placements[1].x && near(two[0].placements[0].y, two[0].placements[1].y));
  check('9-up and 6-up are supported', layoutSheets(Array(9).fill(A4), { nup: 9 })[0].placements.length === 9 && layoutSheets(Array(6).fill(A4), { nup: 6 })[0].placements.length === 6);
  let bad = ''; try { layoutSheets([A4], { nup: 3 }); } catch (e) { bad = e.message; }
  check('unsupported pages-per-sheet is rejected', /1, 2, 4, 6 or 9/.test(bad));

  [s] = layoutSheets([A4], { paper: 'A4', bleed: 3, marks: true, margin: 0, scale: 'fit' });
  check('bleed + marks enlarge the media box around the trim box', near(s.trim.w, PAPER.A4[0]) && near(s.media[0], PAPER.A4[0] + 2 * (mm(3) + mm(8))) && near(s.bleed.w, PAPER.A4[0] + 2 * mm(3)));
  check('8 crop-mark segments, all outside the bleed box', s.marks.length === 8 && s.marks.every(([x1, y1, x2, y2]) => [[x1, y1], [x2, y2]].every(([x, y]) => x <= s.bleed.x + 0.01 || x >= s.bleed.x + s.bleed.w - 0.01 || y <= s.bleed.y + 0.01 || y >= s.bleed.y + s.bleed.h - 0.01)));
  [s] = layoutSheets([A4], { paper: 'A4', bleed: 3, bleedMode: 'enlarge', margin: 0 });
  const e = s.placements[0];
  check('enlarge mode covers the whole bleed box and clips to it', e.x <= s.bleed.x + 0.01 && e.y <= s.bleed.y + 0.01 && e.x + e.w >= s.bleed.x + s.bleed.w - 0.01 && e.clip === s.bleed);
}

// ---------------------------------------------------------------- imposition, checked by rendering with poppler
async function sample(n = 4) {
  const doc = await PDFDocument.create();
  const cols = [rgb(1, 0, 0), rgb(0, 0.7, 0), rgb(0, 0, 1), rgb(1, 0.8, 0)];
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([300, 400]);
    p.drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: rgb(0.95, 0.95, 0.95) });
    p.drawRectangle({ x: 10, y: 340, width: 50, height: 50, color: cols[i % 4] }); // marker square in the top-left corner
  }
  return doc;
}
const render = (pdf, page, dpi = 36) => {
  const base = path.join(tmp, 'r');
  execFileSync('pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), '-png', pdf, base]);
  const f = fs.readdirSync(tmp).filter((x) => x.startsWith('r-') && x.endsWith('.png')).sort().pop();
  const out = path.join(tmp, f);
  return out;
};
const pixel = (png, x, y) => JSON.parse(py('from PIL import Image;import sys,json;i=Image.open(sys.argv[1]).convert("RGB");print(json.dumps(list(i.getpixel((int(sys.argv[2]),int(sys.argv[3]))))))', png, String(x), String(y)));
const size = (png) => JSON.parse(py('from PIL import Image;import sys,json;print(json.dumps(list(Image.open(sys.argv[1]).size)))', png));
const isRed = ([r, g, b]) => r > 200 && g < 80 && b < 80;
// centre of the red marker, as a fraction of the image size
const redCentroid = (png) => JSON.parse(py('from PIL import Image;import sys,json;i=Image.open(sys.argv[1]).convert("RGB");w,h=i.size;px=i.load();pts=[(x,y) for y in range(h) for x in range(w) if px[x,y][0]>200 and px[x,y][1]<80 and px[x,y][2]<80];print(json.dumps([sum(p[0] for p in pts)/len(pts)/w,sum(p[1] for p in pts)/len(pts)/h,len(pts)]) if pts else "null")', png));

if (have('pdftoppm') && hasPIL) {
  // rotation: a page with /Rotate 90 has its top-left marker at the top-RIGHT of the displayed page
  const doc = await sample(1);
  doc.getPage(0).setRotation(degrees(90));
  const srcFile = path.join(tmp, 'rot.pdf'); fs.writeFileSync(srcFile, await doc.save());
  const base = render(srcFile, 1);
  const [bw, bh] = size(base);
  check('(reference) rotated source shows the marker top-right', isRed(pixel(base, bw - 8, 8)) || isRed(pixel(base, bw - 12, 12)), JSON.stringify(pixel(base, bw - 10, 10)));
  for (const R of [0, 90, 180, 270]) {
    const d = await sample(1); d.getPage(0).setRotation(degrees(R));
    const f = path.join(tmp, `src${R}.pdf`); fs.writeFileSync(f, await d.save());
    const ref = render(f, 1); const [rw, rh] = size(ref);
    const res = await buildPrintPdf(L, new Uint8Array(fs.readFileSync(f)), { paper: 'auto', margin: 0, scale: 'fit' });
    const o = path.join(tmp, `out${R}.pdf`); fs.writeFileSync(o, res.bytes);
    const img = render(o, 1); const [ow, oh] = size(img);
    // compare 5 sample points between the direct render of the source and the imposed page
    const pts = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5]];
    const same = pts.every(([fx, fy]) => { const a = pixel(ref, Math.floor(fx * rw), Math.floor(fy * rh)), b = pixel(img, Math.floor(fx * ow), Math.floor(fy * oh)); return a.every((v, i) => Math.abs(v - b[i]) < 40); });
    const ca = redCentroid(ref), cb = redCentroid(img);
    check(`print layout keeps page rotation ${R}° exactly as the source renders`, same && Math.abs(rw - ow) <= 1 && Math.abs(rh - oh) <= 1 && ca && cb && Math.abs(ca[0] - cb[0]) < 0.03 && Math.abs(ca[1] - cb[1]) < 0.03, `${rw}x${rh} vs ${ow}x${oh}, marker ${JSON.stringify(ca)} vs ${JSON.stringify(cb)}`);
  }
  // n-up: 4 coloured pages on one A4 sheet, markers appear in the matching cells in reading order
  const four = await sample(4); const f4 = path.join(tmp, 'four.pdf'); fs.writeFileSync(f4, await four.save());
  const r4 = await buildPrintPdf(L, new Uint8Array(fs.readFileSync(f4)), { nup: 4, paper: 'A4', margin: 5, scale: 'shrink' });
  const o4 = path.join(tmp, 'four-up.pdf'); fs.writeFileSync(o4, r4.bytes);
  const pdfDoc = await PDFDocument.load(r4.bytes);
  check('4 pages on 1 sheet of A4', pdfDoc.getPageCount() === 1 && near(pdfDoc.getPage(0).getWidth(), PAPER.A4[0], 0.1));
  const im4 = render(o4, 1); const [w4, h4] = size(im4);
  const sheet = r4.sheets[0];
  const markerAt = (k) => { const pl = sheet.placements[k]; const x = pl.x + (30 / 300) * pl.w, yTop = pl.y + pl.h - (35 / 400) * pl.h; return pixel(im4, Math.round((x / sheet.media[0]) * w4), Math.round(((sheet.media[1] - yTop) / sheet.media[1]) * h4)); };
  const [c0, c1, c2] = [markerAt(0), markerAt(1), markerAt(2)];
  check('4-up: cell 1 shows page 1 (red), cell 2 page 2 (green), cell 3 page 3 (blue)', isRed(c0) && c1[1] > 140 && c1[0] < 80 && c2[2] > 200 && c2[0] < 80, JSON.stringify([c0, c1, c2]));
  // bleed + marks: box dictionary and visible marks
  const rb = await buildPrintPdf(L, new Uint8Array(fs.readFileSync(f4)), { paper: 'A4', bleed: 3, marks: true, margin: 0, scale: 'fit', pages: [0] });
  const dbl = await PDFDocument.load(rb.bytes);
  const pg = dbl.getPage(0);
  const tb = pg.getTrimBox(), bb = pg.getBleedBox();
  check('TrimBox is the trim size and BleedBox is 3 mm larger on every side', near(tb.width, PAPER.A4[0], 0.1) && near(bb.width - tb.width, 2 * mm(3), 0.1) && near(tb.x - bb.x, mm(3), 0.1));
  const ob = path.join(tmp, 'bleed.pdf'); fs.writeFileSync(ob, rb.bytes);
  const imb = render(ob, 1, 72); const [wb, hb] = size(imb);
  const dark = (px) => px[0] < 90 && px[1] < 90 && px[2] < 90;
  const sheetb = rb.sheets[0];
  const mk = sheetb.marks[0]; // horizontal tick at the trim's lower-left corner
  const mx = (mk[0] + mk[2]) / 2, my = mk[1];
  const hit = [-1, 0, 1].some((dy) => dark(pixel(imb, Math.round(mx), Math.round(hb - my + dy))));
  check('crop marks are really drawn in the slug area', hit);
  check('slug area outside the marks stays blank', pixel(imb, 2, 2).every((v) => v > 240));
} else console.log('SKIP  pdftoppm / Pillow not available: imposition rendering checks skipped');

// ---------------------------------------------------------------- images -> PDF
{
  const png = (() => { const raw = Buffer.alloc((4 * 3 + 1) * 2, 0x40); raw[0] = 0; raw[13] = 0; const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); }; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2; return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])); })();
  const items = [{ bytes: png, kind: 'png', w: 300, h: 150 }, { bytes: png, kind: 'png', w: 150, h: 300 }];
  let d = await PDFDocument.load(await imagesToPdf(L, items, { paper: 'fit', dpi: 150 }));
  check('fit mode: page size follows the image at the chosen dpi', d.getPageCount() === 2 && near(d.getPage(0).getWidth(), 144, 0.1) && near(d.getPage(0).getHeight(), 72, 0.1));
  d = await PDFDocument.load(await imagesToPdf(L, items, { paper: 'A4', margin: 10 }));
  check('A4 mode: landscape image -> landscape page, portrait -> portrait', d.getPage(0).getWidth() > d.getPage(0).getHeight() && d.getPage(1).getWidth() < d.getPage(1).getHeight());
  d = await PDFDocument.load(await imagesToPdf(L, items, { paper: 'Letter', orientation: 'portrait' }));
  check('forced orientation applies to every page', d.getPage(0).getWidth() < d.getPage(0).getHeight());
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll conversion checks passed');
process.exit(failures ? 1 : 0);
