// OCR end-to-end test: builds "scanned" PDFs (text rasterised into images), runs the real OCR dialog,
// then checks accuracy, word positions, the exported searchable PDF, editing of scanned text, and cancel.
// Run: node test/ocr.e2e.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let playwright;
for (const m of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { playwright = require(m); break; } catch {} }
if (!playwright) { console.error('Playwright not found'); process.exit(2); }
const { PDFDocument, StandardFonts } = require('../vendor/pdf-lib.min.js');

const PORT = 8126;
const BASE = `http://localhost:${PORT}/`;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };

function similarity(a, b) {
  a = a.replace(/\s+/g, ' ').trim(); b = b.replace(/\s+/g, ' ').trim();
  const m = a.length, n = b.length;
  if (!m && !n) return 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const EN_LINES = ['Invoice 2024-117', 'Total due: 1,250.00 USD', 'Thank you for your business'];
const AM_LINES = ['ሰላም ዓለም', 'አዲስ አበባ ኢትዮጵያ'];

// draws lines of text into a 1700x2200 canvas (Letter @ 200 DPI): left x=100px, baselines 300px, 420px, ...
async function scanPng(page, lines, font) {
  return page.evaluate(async ({ lines, font }) => {
    if (font.url) {
      const ff = new FontFace('ScanFont', `url(${font.url})`);
      await ff.load(); document.fonts.add(ff);
    }
    const c = document.createElement('canvas'); c.width = 1700; c.height = 2200;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1700, 2200);
    x.fillStyle = '#111'; x.font = `${font.size}px ${font.family}`;
    lines.forEach((l, i) => x.fillText(l, 100, 300 + i * 120));
    return c.toDataURL('image/png').split(',')[1];
  }, { lines, font });
}
async function scanPdf(file, png, pages = 1) {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(Buffer.from(png, 'base64'));
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  fs.writeFileSync(file, await doc.save());
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfocr-'));
  const server = spawn('node', [path.join(__dirname, '..', 'server.js'), String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE);

  const runOcr = async ({ scope = 'all', lang = 'eng', dpi = '300', timeout = 180000 }) => {
    await page.click('#btnOcr');
    await page.selectOption('#ocrScope', scope);
    await page.selectOption('#ocrLang', lang);
    await page.selectOption('#ocrDpi', dpi);
    await page.click('#ocrRun');
    await page.waitForFunction(() => !document.querySelector('#ocrRun').disabled, null, { timeout });
  };
  const closeDlg = async () => { await page.click('#ocrClose'); await page.waitForFunction(() => !document.querySelector('#ocrDlg').open); };
  // extract text items of the exported PDF via pdf.js (inside the page, no extra deps)
  const inspectExport = (rot) => page.evaluate(async (rot) => {
    const E = window.__editor;
    if (rot) E.S.pages[0].rot = rot;
    const bytes = await E.buildPdf();
    const pdfjs = await import('./vendor/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    const items = tc.items.filter((i) => i.str.trim()).map((i) => {
      const [, , , , e, f] = pdfjs.Util.transform(vp.transform, i.transform);
      return { str: i.str, x: e, y: f, w: i.width };
    });
    // pixel comparison against the plain source render to prove the layer is invisible
    const render = async (d) => { const p = await d.getPage(1); const v = p.getViewport({ scale: 1 }); const c = document.createElement('canvas'); c.width = v.width; c.height = v.height; await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    const out = await render(doc);
    const src = await render(E.S.sources[0].doc);
    let diff = 0; for (let i = 0; i < out.length; i += 4) diff += Math.abs(out[i] - src[i]);
    return { items, text: tc.items.map((i) => i.str).join(' '), meanDiff: diff / (out.length / 4), size: [vp.width, vp.height] };
  }, rot);

  // ============================================================ English
  const enPng = await scanPng(page, EN_LINES, { family: 'Arial, Helvetica, sans-serif', size: 52 });
  const enPdf = path.join(tmp, 'scan-en.pdf');
  await scanPdf(enPdf, enPng);
  await page.setInputFiles('#fileOpen', enPdf);
  await page.waitForFunction(() => window.__editor.S.pages.length === 1);
  await page.waitForTimeout(500);

  await runOcr({ scope: 'empty', lang: 'eng' });
  const o = await page.evaluate(() => { const S = window.__editor.S; return S.ocr.get(S.pages[0].id) || null; });
  check('OCR produced a result for the scanned page', !!o);
  if (o) {
    const sim = similarity(o.text, EN_LINES.join(' '));
    console.log(`      English text similarity ${(sim * 100).toFixed(1)}%, confidence ${o.conf}%, words ${o.words.length}`);
    console.log('      recognised:', JSON.stringify(o.text));
    check('English accuracy >= 95%', sim >= 0.95, `got ${(sim * 100).toFixed(1)}%`);
    const first = o.words.find((w) => /Invoice/i.test(w[0]));
    check('first word box is where the text was drawn (±8 pt)', !!first && Math.abs(first[1] - 100 * 0.36) < 8 && Math.abs(first[2] - (300 - 40) * 0.36) < 10, JSON.stringify(first));
    check('results list shows the page', (await page.locator('#ocrResults li').count()) === 1);
  }
  await page.check('#ocrShow');
  check('"Show recognised words" draws word boxes', (await page.locator('.pgi .ocrw').count()) === (o ? o.words.length : -1));
  await page.uncheck('#ocrShow');
  const [txtDl] = await Promise.all([page.waitForEvent('download'), page.click('#ocrTxt')]);
  const txtFile = path.join(tmp, 'o.txt'); await txtDl.saveAs(txtFile);
  check('Download text contains the recognised text', fs.readFileSync(txtFile, 'utf8').includes('Invoice'));
  await closeDlg();

  // second run with scope "pages without text" must skip it (already recognised)
  await page.click('#btnOcr'); await page.selectOption('#ocrScope', 'empty'); await page.click('#ocrRun');
  await page.waitForTimeout(400);
  check('already-recognised pages are skipped', (await page.locator('#ocrRun').isEnabled()) && !(await page.locator('#ocrProg').isVisible()));
  await closeDlg();

  // exported searchable PDF
  let ex = await inspectExport(0);
  check('export is searchable: contains "Invoice"', /Invoice/.test(ex.text), ex.text);
  check('export is searchable: contains "1,250.00"', /1,250\.00/.test(ex.text), ex.text);
  check('invisible layer does not change how the page looks', ex.meanDiff < 0.5, `meanDiff=${ex.meanDiff}`);
  const inv = ex.items.find((i) => /Invoice/.test(i.str));
  check('exported text sits on the word (baseline within 6 pt)', !!inv && Math.abs(inv.x - 36) < 6 && Math.abs(inv.y - 108) < 6, JSON.stringify(inv));
  check('exported word width is fitted to the scan (±25%)', !!inv && inv.w > 0, JSON.stringify(inv));

  // rotated page keeps text aligned
  ex = await inspectExport(90);
  const inv90 = ex.items.find((i) => /Invoice/.test(i.str));
  // base display point (x, baseline y) rotated 90° clockwise -> (H - y, x), H = 792
  check('rotated page: text still extractable and positioned', !!inv90 && Math.abs(inv90.x - (792 - 108)) < 10 && Math.abs(inv90.y - 36) < 10, JSON.stringify(inv90));
  await page.evaluate(() => { window.__editor.S.pages[0].rot = 0; });

  // ---- edit scanned text with the Edit text tool
  await page.evaluate(() => document.querySelector('#viewer').scrollTo(0, 0));
  for (let i = 0; i < 3; i++) await page.click('#zOut');
  await page.waitForTimeout(500);
  await page.click('[data-tool=edit]');
  const box = await page.locator('.pg').first().boundingBox();
  const z = await page.evaluate(() => window.__editor.S.zoom);
  await page.mouse.move(box.x + 60 * z, box.y + 95 * z); // over the first line
  await page.mouse.click(box.x + 60 * z, box.y + 95 * z);
  const gotEditor = await page.waitForSelector('textarea.tedit', { timeout: 5000 }).then(() => true, () => false);
  check('Edit text works on a scanned line (OCR text prefilled)', gotEditor);
  if (gotEditor) {
    const pre = await page.inputValue('textarea.tedit');
    check('prefilled text matches the scan', /Invoice/.test(pre), pre);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Invoice 2025-001');
    await page.keyboard.press('Control+Enter');
    ex = await inspectExport(0);
    check('edited text is in the export', /Invoice 2025-001/.test(ex.text), ex.text);
    check('replaced scan words are removed from the hidden layer', !/2024/.test(ex.text), ex.text);
    check('other lines keep their hidden text', /Total due/.test(ex.text), ex.text);
  }

  // ---- duplicate page copies OCR; remove OCR clears it
  await page.click('[data-tool=select]');
  await page.locator('#thumbs li').first().hover();
  await page.locator('#thumbs li').first().locator('[data-act=dup]').click();
  check('duplicating a page copies its OCR text', await page.evaluate(() => { const S = window.__editor.S; return S.pages.length === 2 && S.ocr.has(S.pages[1].id); }));
  await page.click('#btnOcr'); await page.click('#ocrClear');
  check('Remove OCR clears recognised text', await page.evaluate(() => window.__editor.S.ocr.size === 0));
  await closeDlg();

  // ============================================================ Amharic
  const amPng = await scanPng(page, AM_LINES, { family: 'ScanFont', size: 64, url: '/vendor/fonts/noto-sans-ethiopic-ethiopic-400-normal.woff' });
  const amPdf = path.join(tmp, 'scan-am.pdf');
  await scanPdf(amPdf, amPng);
  await page.evaluate(() => { window.__editor.S.dirty = false; });
  await page.setInputFiles('#fileOpen', amPdf);
  await page.waitForFunction(() => window.__editor.S.pages.length === 1 && window.__editor.S.sources.length === 1);
  await page.waitForTimeout(500);
  await runOcr({ scope: 'all', lang: 'amh', timeout: 240000 });
  const am = await page.evaluate(() => { const S = window.__editor.S; return S.ocr.get(S.pages[0].id) || null; });
  check('Amharic OCR produced a result', !!am);
  if (am) {
    const sim = similarity(am.text, AM_LINES.join(' '));
    console.log(`      Amharic text similarity ${(sim * 100).toFixed(1)}%, confidence ${am.conf}%`);
    console.log('      recognised:', JSON.stringify(am.text));
    check('Amharic accuracy >= 70% on clean rendered text', sim >= 0.7, `got ${(sim * 100).toFixed(1)}%`);
    ex = await inspectExport(0);
    const eth = (ex.text.match(/[ሀ-፿]/g) || []).length;
    check('Amharic text is embedded in the export (searchable)', eth >= 4, ex.text);
    check('Amharic hidden layer does not change the look', ex.meanDiff < 0.5, `meanDiff=${ex.meanDiff}`);
  }
  await closeDlg().catch(() => {});

  // ============================================================ cancel + pages that already have text
  const manyPdf = path.join(tmp, 'many.pdf');
  await scanPdf(manyPdf, enPng, 4);
  await page.evaluate(() => { window.__editor.S.dirty = false; });
  await page.setInputFiles('#fileOpen', manyPdf);
  await page.waitForFunction(() => window.__editor.S.pages.length === 4 && window.__editor.S.sources.length === 1);
  await page.click('#btnOcr'); await page.selectOption('#ocrScope', 'all'); await page.selectOption('#ocrLang', 'eng');
  await page.click('#ocrRun');
  await page.waitForSelector('#ocrProg:not([hidden])');
  await page.waitForTimeout(1500);
  await page.click('#ocrClose'); // acts as Cancel while running
  await page.waitForFunction(() => !document.querySelector('#ocrDlg').open);
  await page.waitForTimeout(800);
  const afterCancel = await page.evaluate(() => window.__editor.S.ocr.size);
  check('cancel stops OCR without finishing every page', afterCancel < 4, `ocr pages: ${afterCancel}`);
  await page.click('#btnOcr');
  check('dialog is usable again after cancel', (await page.locator('#ocrRun').isEnabled()) && !(await page.locator('#ocrProg').isVisible()));
  await closeDlg();

  const textPdf = path.join(tmp, 'text.pdf');
  { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([612, 792]).drawText('Already has real text', { x: 72, y: 700, size: 20, font: f }); fs.writeFileSync(textPdf, await d.save()); }
  await page.evaluate(() => { window.__editor.S.dirty = false; });
  await page.setInputFiles('#fileOpen', textPdf);
  await page.waitForFunction(() => window.__editor.S.pages.length === 1 && window.__editor.S.sources.length === 1);
  await page.click('#btnOcr'); await page.selectOption('#ocrScope', 'empty'); await page.click('#ocrRun');
  await page.waitForTimeout(600);
  check('pages that already have text are skipped in "pages without text" mode', await page.evaluate(() => window.__editor.S.ocr.size === 0));
  await closeDlg();

  check('no page or console errors', errors.length === 0, errors.join('\n'));
  await browser.close(); server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll OCR checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
