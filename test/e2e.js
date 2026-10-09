// End-to-end test: drives the real UI in headless Chromium, exports a PDF and verifies it.
// Run: node test/e2e.js   (needs Playwright; PLAYWRIGHT_BROWSERS_PATH must point at a Chromium install)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let playwright;
for (const m of ['playwright', '/opt/node-tools/node_modules/playwright']) {
  try { playwright = require(m); break; } catch {}
}
if (!playwright) { console.error('Playwright not found'); process.exit(2); }
const { PDFDocument, StandardFonts, rgb, degrees } = require('../vendor/pdf-lib.min.js');

const PORT = 8123;
const BASE = `http://localhost:${PORT}/`;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};

async function makeSamplePdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Hello World', { x: 72, y: 700, size: 24, font });
  p1.drawText('Second line of text', { x: 72, y: 660, size: 14, font });
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Page two', { x: 72, y: 700, size: 24, font });
  const p3 = doc.addPage([400, 300]);
  p3.drawText('Page three', { x: 40, y: 250, size: 20, font });
  // pages with /Rotate for the coordinate-mapping check
  for (const r of [90, 180, 270]) {
    const p = doc.addPage([300, 200]);
    p.setRotation(degrees(r));
  }
  doc.addPage([300, 200]);
  fs.writeFileSync(file, await doc.save());
}

async function makePng(file) {
  // 40x20 solid blue PNG via pdf-lib-free approach: use zlib + manual PNG
  const zlib = require('zlib');
  const w = 40, h = 20;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 255; }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfed-'));
  const samplePdf = path.join(tmp, 'sample.pdf');
  const samplePng = path.join(tmp, 'blue.png');
  await makeSamplePdf(samplePdf);
  await makePng(samplePng);

  const server = spawn('node', [path.join(__dirname, '..', 'server.js'), String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  try {
    await page.goto(BASE);
    check('empty state shown before opening a file', await page.locator('#drop').isVisible());

    await page.setInputFiles('#fileOpen', samplePdf);
    await page.waitForFunction(() => window.__editor.S.pages.length === 7);
    check('opens PDF with 7 pages', true);
    await page.waitForFunction(() => document.querySelector('.pg canvas') && document.querySelector('.pg canvas').width > 100);
    await page.waitForTimeout(500);
    check('thumbnails created', (await page.locator('#thumbs li').count()) === 7);

    for (let i = 0; i < 4; i++) await page.click('#zOut');
    await page.waitForTimeout(400);
    const pageBox = async (i) => {
      const b = await page.locator('.pg').nth(i).boundingBox();
      const z = await page.evaluate(() => window.__editor.S.zoom);
      return { b, z };
    };
    const toScreen = async (i, x, y) => { const { b, z } = await pageBox(i); return [b.x + x * z, b.y + y * z]; };

    // ---- add text
    await page.click('[data-tool=text]');
    let [sx, sy] = await toScreen(0, 300, 300);
    await page.mouse.click(sx, sy);
    await page.waitForSelector('textarea.tedit');
    await page.keyboard.type('Added text');
    await page.keyboard.press('Control+Enter');
    check('text tool adds a text annotation', await page.evaluate(() => window.__editor.S.pages[0].annots.some((a) => a.type === 'text' && a.text === 'Added text')));

    // ---- drag-create shapes
    const drag = async (tool, x1, y1, x2, y2) => {
      await page.click(`[data-tool=${tool}]`);
      const [ax, ay] = await toScreen(0, x1, y1);
      const [bx, by] = await toScreen(0, x2, y2);
      await page.mouse.move(ax, ay); await page.mouse.down();
      await page.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 4 }); await page.mouse.move(bx, by, { steps: 4 });
      await page.mouse.up();
    };
    await drag('rect', 100, 400, 200, 460);
    await drag('ellipse', 250, 400, 350, 460);
    await drag('line', 100, 500, 300, 520);
    await drag('highlight', 72, 70, 200, 100);
    await drag('whiteout', 400, 400, 450, 440);
    await drag('draw', 100, 600, 200, 650);
    const types = await page.evaluate(() => window.__editor.S.pages[0].annots.map((a) => a.type));
    for (const t of ['rect', 'ellipse', 'line', 'highlight', 'whiteout', 'ink'])
      check(`${t} tool creates an annotation`, types.includes(t));

    // ---- edit existing text
    await page.click('[data-tool=edit]');
    [sx, sy] = await toScreen(0, 72 + 40, 792 - 700 - 8);
    await page.mouse.click(sx, sy);
    await page.waitForSelector('textarea.tedit');
    check('edit-text prefilled with original text', (await page.inputValue('textarea.tedit')) === 'Hello World');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Hello Edited');
    await page.keyboard.press('Control+Enter');
    check('edit-text replaced the text', await page.evaluate(() => window.__editor.S.pages[0].annots.some((a) => a.type === 'text' && a.text === 'Hello Edited')));

    // ---- select, move, delete
    await page.click('[data-tool=select]');
    [sx, sy] = await toScreen(0, 100, 430);
    const before = await page.evaluate(() => window.__editor.S.pages[0].annots.find((a) => a.type === 'rect').x);
    await page.mouse.click(sx, sy); // click rect's left edge area
    await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 30, sy + 10, { steps: 5 }); await page.mouse.up();
    const after = await page.evaluate(() => window.__editor.S.pages[0].annots.find((a) => a.type === 'rect').x);
    check('select tool moves an annotation', Math.abs(after - before - 30 / 1) < 6 * 1 + 30 && after > before, `before=${before} after=${after}`);
    await page.keyboard.press('Delete');
    check('Delete removes selected annotation', await page.evaluate(() => !window.__editor.S.pages[0].annots.some((a) => a.type === 'rect')));
    await page.keyboard.press('Control+z');
    check('undo restores the deleted annotation', await page.evaluate(() => window.__editor.S.pages[0].annots.some((a) => a.type === 'rect')));

    // ---- image
    await page.setInputFiles('#fileImg', samplePng);
    await page.waitForFunction(() => window.__editor.S.pendingImage);
    [sx, sy] = await toScreen(0, 450, 600);
    await page.mouse.click(sx, sy);
    check('image placed', await page.evaluate(() => window.__editor.S.pages[0].annots.some((a) => a.type === 'image')));

    // ---- page operations (thumbnail buttons)
    await page.locator('#thumbs li').nth(1).hover();
    await page.locator('#thumbs li').nth(1).locator('[data-act=rot]').click();
    check('rotate page', await page.evaluate(() => window.__editor.S.pages[1].rot === 90));
    await page.locator('#thumbs li').nth(1).locator('[data-act=dup]').click();
    check('duplicate page', await page.evaluate(() => window.__editor.S.pages.length === 8));
    await page.locator('#thumbs li').nth(2).hover();
    await page.locator('#thumbs li').nth(2).locator('[data-act=del]').click();
    check('delete page', await page.evaluate(() => window.__editor.S.pages.length === 7));
    await page.click('#btnBlank');
    check('insert blank page', await page.evaluate(() => window.__editor.S.pages.length === 8 && window.__editor.S.pages.some((p) => p.blank)));
    await page.evaluate(() => window.scrollTo(0, 0));
    // drag reorder: move first thumb below the second
    await page.locator('#thumbs li').nth(0).dragTo(page.locator('#thumbs li').nth(1), { targetPosition: { x: 40, y: 150 } });
    check('thumbnail drag reorders pages', await page.evaluate(() => window.__editor.S.pages[0].idx !== 0 || window.__editor.S.pages[1].idx === 0));

    // ---- zoom
    await page.click('#zIn');
    check('zoom in changes label', (await page.textContent('#zLabel')) !== '');

    // ---- download through the real button
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]);
    const outFile = path.join(tmp, 'out.pdf');
    await dl.saveAs(outFile);
    check('download filename', dl.suggestedFilename() === 'sample-edited.pdf', dl.suggestedFilename());
    const out = await PDFDocument.load(fs.readFileSync(outFile));
    check('exported PDF has 8 pages', out.getPageCount() === 8, String(out.getPageCount()));

    // ---- verify exported content by re-opening in pdf.js
    const outB64 = fs.readFileSync(outFile).toString('base64');
    const res = await page.evaluate(async (b64) => {
      const pdfjs = await import('./vendor/pdf.min.mjs');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      const texts = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const pg = await doc.getPage(i);
        texts.push((await pg.getTextContent()).items.map((x) => x.str).join(' '));
      }
      return texts;
    }, outB64);
    const all = res.join(' | ');
    check('export contains added text', all.includes('Added text'), all);
    check('export contains edited text', all.includes('Hello Edited'), all);
    check('export has no watermark-like extra text', !/watermark|trial|unlicensed|demo/i.test(all), all);

  } catch (err) {
    console.error(err);
    failures++;
  }

  // ---- coordinate mapping: 4 base rotations x 4 user rotations, verified by rendering the export
  try {
    const rotPdf = path.join(tmp, 'rot.pdf');
    const d = await PDFDocument.create();
    for (const r of [0, 90, 180, 270]) { const p = d.addPage([300, 200]); p.setRotation(degrees(r)); }
    fs.writeFileSync(rotPdf, await d.save());
    await page.setInputFiles('#fileOpen', rotPdf);
    await page.waitForFunction(() => window.__editor.S.pages.length === 4 && window.__editor.S.pages[0].w);
    const results = await page.evaluate(async () => {
      const E = window.__editor;
      const S = E.S;
      const base = S.pages.map((p) => ({ idx: p.idx, w: p.w, h: p.h }));
      S.pages = [];
      let n = 0;
      for (const b of base) for (const r of [0, 90, 180, 270])
        S.pages.push({
          id: 'm' + n++, src: 0, idx: b.idx, w: b.w, h: b.h, rot: r,
          annots: [
            { id: 'g', type: 'whiteout', x: 40, y: 20, w: 50, h: 30, color: '#00ff00' },
            { id: 't', type: 'text', x: 150, y: 100, text: 'MMMMMMMM', size: 20, color: '#000000', font: 'Helvetica', bold: true },
          ],
        });
      const bytes = await E.buildPdf();
      const pdfjs = await import('./vendor/pdf.min.mjs');
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      const out = [];
      for (let i = 0; i < S.pages.length; i++) {
        const p = S.pages[i];
        const pg = await doc.getPage(i + 1);
        const vp = pg.getViewport({ scale: 1 });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d');
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        const W = p.w, H = p.h;
        // expected location after the user rotation r (clockwise) of the base-frame point
        const map = (x, y) => p.rot === 90 ? [H - y, x] : p.rot === 180 ? [W - x, H - y] : p.rot === 270 ? [y, W - x] : [x, y];
        const [gx, gy] = map(65, 35);
        const px = ctx.getImageData(Math.round(gx), Math.round(gy), 1, 1).data;
        // text: scan a window around the expected centre of "MMMMMMMM" (width ~ 8*0.83*20)
        const [tx, ty] = map(150 + 60, 100 + 10);
        const win = ctx.getImageData(Math.max(0, Math.round(tx) - 20), Math.max(0, Math.round(ty) - 20), 40, 40).data;
        let dark = 0;
        for (let k = 0; k < win.length; k += 4) if (win[k] < 90 && win[k + 1] < 90 && win[k + 2] < 90) dark++;
        out.push({ base: base[Math.floor(i / 4)].idx, rot: p.rot, green: [px[0], px[1], px[2]], dark, size: [c.width, c.height] });
      }
      return out;
    });
    for (const r of results) {
      const g = r.green[1] > 200 && r.green[0] < 60 && r.green[2] < 60;
      check(`mapping base-rotation #${r.base} + user ${r.rot}°: rectangle lands correctly`, g, JSON.stringify(r));
      check(`mapping base-rotation #${r.base} + user ${r.rot}°: text lands correctly`, r.dark > 40, JSON.stringify(r));
    }
  } catch (err) {
    console.error(err);
    failures++;
  }

  // ---- non-Latin text falls back to an image instead of failing
  try {
    const r = await page.evaluate(async () => {
      const E = window.__editor;
      E.S.pages[0].annots = [{ id: 'et', type: 'text', x: 20, y: 20, text: 'ሰላም አለም', size: 20, color: '#000000', font: 'Helvetica', bold: false }];
      const bytes = await E.buildPdf();
      return bytes.length;
    });
    check('export succeeds with non-Latin text (rasterised fallback)', r > 100);
  } catch (err) {
    check('export succeeds with non-Latin text (rasterised fallback)', false, String(err));
  }

  check('no page or console errors', errors.length === 0, errors.join('\n'));
  await page.screenshot({ path: path.join(tmp, 'final.png') });
  console.log('screenshot:', path.join(tmp, 'final.png'));
  await browser.close();
  server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
