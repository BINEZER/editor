// Export + image-conversion end-to-end tests, driving the real dialogs in headless Chromium.
// Independent checkers: Pillow (image files), pdf-lib (PDF structure), Chromium's own print-to-PDF (print CSS).
// Run: node test/export.e2e.js
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let playwright;
for (const m of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { playwright = require(m); break; } catch {} }
if (!playwright) { console.error('Playwright not found'); process.exit(2); }
const { PDFDocument, StandardFonts, rgb } = require('../vendor/pdf-lib.min.js');

const PORT = 8133;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args]).toString().trim();
const info = (file) => JSON.parse(py('from PIL import Image;import sys,json;i=Image.open(sys.argv[1]);i.load();d=i.info.get("dpi");print(json.dumps({"size":list(i.size),"mode":i.mode,"fmt":i.format,"dpi":round(d[0]) if d else None}))', file));
const px = (file, x, y) => JSON.parse(py('from PIL import Image;import sys,json;i=Image.open(sys.argv[1]).convert("RGBA");print(json.dumps(list(i.getpixel((int(sys.argv[2]),int(sys.argv[3]))))))', file, String(x), String(y)));
const unzip = (zip, dir) => { fs.mkdirSync(dir, { recursive: true }); py('import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir); return fs.readdirSync(dir).sort(); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexp-'));
  const server = spawn('node', [path.join(__dirname, '..', 'server.js'), String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${PORT}/`);

  // ---- a 3-page source: Letter portrait (red marker top-left), A4 landscape (green), small page (blue)
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const sizes = [[612, 792], [841.89, 595.28], [300, 400]];
  const marker = [rgb(1, 0, 0), rgb(0, 0.7, 0), rgb(0, 0, 1)];
  sizes.forEach(([w, h], i) => {
    const p = doc.addPage([w, h]);
    p.drawRectangle({ x: 20, y: h - 70, width: 50, height: 50, color: marker[i] });
    p.drawText(`Page ${i + 1}`, { x: 100, y: h - 60, size: 24, font: f });
  });
  const src = path.join(tmp, 'report.pdf'); fs.writeFileSync(src, await doc.save());
  await page.setInputFiles('#fileOpen', src);
  await page.waitForFunction(() => window.__editor.S.pages.length === 3);
  await page.waitForTimeout(400);

  const dl = async (trigger) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), trigger()]);
    const file = path.join(tmp, d.suggestedFilename());
    await d.saveAs(file);
    return file;
  };
  const toastText = () => page.textContent('#toast');

  // ============================================================ page images
  await page.click('#btnExport');
  await page.click('[data-tab=images]');
  await page.selectOption('#iFormat', 'png'); await page.selectOption('#iDpi', '150'); await page.fill('#xRangeI', '1');
  let file = await dl(() => page.click('#iExport'));
  let im = info(file);
  check('single page -> a plain PNG named after the page', path.basename(file) === 'report-p1.png', path.basename(file));
  check('PNG size = page size x dpi (612x792pt @150dpi = 1275x1650)', im.size[0] === 1275 && im.size[1] === 1650, JSON.stringify(im));
  check('PNG carries 150 dpi', im.dpi === 150, JSON.stringify(im));
  const red = px(file, 100, 120); // marker at pt (20..70, 20..70 from top) -> px ~ (42..146)
  check('rendered page shows its content (red marker)', red[0] > 200 && red[1] < 60, JSON.stringify(red));

  await page.selectOption('#iFormat', 'jpeg'); await page.selectOption('#iDpi', '96'); await page.fill('#xRangeI', '2');
  file = await dl(() => page.click('#iExport'));
  im = info(file);
  check('JPEG of the landscape page: 1123x794 @96 dpi', path.basename(file) === 'report-p2.jpg' && im.fmt === 'JPEG' && Math.abs(im.size[0] - 1123) <= 1 && Math.abs(im.size[1] - 794) <= 1 && im.dpi === 96, JSON.stringify(im) + path.basename(file));

  await page.selectOption('#iFormat', 'png'); await page.selectOption('#iDpi', '72'); await page.fill('#xRangeI', '1-3'); await page.check('#iGray');
  const zip = await dl(() => page.click('#iExport'));
  const names = unzip(zip, path.join(tmp, 'zip1'));
  check('several pages -> a ZIP with one numbered file per page', path.basename(zip) === 'report-images.zip' && names.join() === 'report-p1.png,report-p2.png,report-p3.png', names.join());
  const g = px(path.join(tmp, 'zip1', 'report-p1.png'), 45, 45);
  check('grayscale option removes colour', g[0] === g[1] && g[1] === g[2] && g[0] < 200, JSON.stringify(g));
  await page.uncheck('#iGray');
  await page.selectOption('#iFormat', 'webp'); await page.fill('#xRangeI', '3');
  file = await dl(() => page.click('#iExport'));
  check('WebP export works', info(file).fmt === 'WEBP', JSON.stringify(info(file)));
  await page.selectOption('#iFormat', 'bmp');
  file = await dl(() => page.click('#iExport'));
  im = info(file);
  check('BMP export works and keeps dpi', im.fmt === 'BMP' && im.size[0] === 300 && im.dpi === 72, JSON.stringify(im));
  await page.fill('#xRangeI', '9');
  await page.click('#iExport');
  await page.waitForFunction(() => /outside/.test(document.querySelector('#toast').textContent));
  check('bad page range gives a clear message', /Page 9 is outside 1–3/.test(await toastText()), await toastText());
  await page.fill('#xRangeI', '');
  // annotations are baked into exported images
  await page.evaluate(() => { window.__editor.S.pages[0].annots.push({ id: 'q', type: 'whiteout', x: 200, y: 300, w: 100, h: 100, color: '#0000ff' }); });
  await page.selectOption('#iFormat', 'png'); await page.selectOption('#iDpi', '72'); await page.fill('#xRangeI', '1');
  file = await dl(() => page.click('#iExport'));
  const blue = px(file, 250, 350);
  check('annotations appear in exported images', blue[2] > 200 && blue[0] < 60, JSON.stringify(blue));
  await page.evaluate(() => { window.__editor.S.pages[0].annots = []; });

  // ============================================================ print-ready PDF
  await page.click('[data-tab=print]');
  await page.selectOption('#xPaper', 'A4'); await page.selectOption('#xNup', '1'); await page.fill('#xMargin', '0');
  await page.selectOption('#xScale', 'fit'); await page.fill('#xBleed', '3'); await page.check('#xMarks'); await page.fill('#xRangeP', '1');
  file = await dl(() => page.click('#xDownload'));
  let out = await PDFDocument.load(fs.readFileSync(file));
  const pg = out.getPage(0), tb = pg.getTrimBox(), bb = pg.getBleedBox();
  const mm = (v) => (v * 72) / 25.4;
  check('print-ready file is named -print.pdf', path.basename(file) === 'report-print.pdf');
  check('TrimBox is A4', Math.abs(tb.width - 595.28) < 0.1 && Math.abs(tb.height - 841.89) < 0.1, JSON.stringify(tb));
  check('BleedBox is 3 mm bigger on every side', Math.abs(bb.width - tb.width - 2 * mm(3)) < 0.1 && Math.abs(tb.x - bb.x - mm(3)) < 0.1);
  check('MediaBox leaves room for crop marks', pg.getWidth() > bb.width + 2 * mm(3));
  check('only the requested page is exported', out.getPageCount() === 1);
  await page.fill('#xRangeP', ''); await page.check('#xMarks'); await page.uncheck('#xMarks'); await page.fill('#xBleed', '0'); await page.selectOption('#xNup', '2'); await page.selectOption('#xScale', 'shrink'); await page.fill('#xMargin', '8');
  file = await dl(() => page.click('#xDownload'));
  out = await PDFDocument.load(fs.readFileSync(file));
  check('2-up: 3 pages -> 2 landscape A4 sheets', out.getPageCount() === 2 && out.getPage(0).getWidth() > out.getPage(0).getHeight() && Math.abs(out.getPage(0).getWidth() - 841.89) < 0.1, `${out.getPageCount()} ${out.getPage(0).getWidth()}`);

  // ============================================================ browser print (print CSS)
  const r = await page.evaluate(async () => {
    await window.__editor.preparePrint({ paper: 'auto', orientation: 'auto', scale: 'shrink', margin: 0, nup: 1, bleed: 0, bleedMode: 'blank', marks: false }, '');
    return document.querySelectorAll('#printRoot canvas').length;
  });
  check('print view contains one canvas per page', r === 3, String(r));
  await page.emulateMedia({ media: 'print' });
  const printed = await page.pdf({ preferCSSPageSize: true });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.__editor.clearPrint());
  const pd = await PDFDocument.load(printed);
  const dims = pd.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  check('mixed page sizes are fitted onto one paper size for browser printing', pd.getPageCount() === 3 && dims.every((d) => d.join() === '612,792'), JSON.stringify(dims));
  // uniform documents keep their @page size (here 2-up landscape A4)
  await page.evaluate(async () => { await window.__editor.preparePrint({ paper: 'A4', orientation: 'auto', scale: 'shrink', margin: 0, nup: 1, bleed: 0, bleedMode: 'blank', marks: false }, '1'); });
  await page.emulateMedia({ media: 'print' });
  const printed2 = await page.pdf({ preferCSSPageSize: true });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.__editor.clearPrint());
  const pd2 = await PDFDocument.load(printed2);
  check('a single-size print job uses that paper size exactly (A4 = 595x842 pt)', pd2.getPageCount() === 1 && Math.round(pd2.getPage(0).getWidth()) === 595 && Math.round(pd2.getPage(0).getHeight()) === 842, `${pd2.getPage(0).getWidth()}x${pd2.getPage(0).getHeight()}`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const d = document.querySelector('#expDlg'); if (d.open) d.close(); });

  // ============================================================ image tool
  // fixtures made in the browser: transparent PNG, JPEG, SVG; plus an EXIF-rotated JPEG made by Pillow
  const fx = await page.evaluate(async () => {
    const mk = (w, h, fn) => { const c = document.createElement('canvas'); c.width = w; c.height = h; fn(c.getContext('2d')); return c; };
    const b64 = (c, t) => c.toDataURL(t).split(',')[1];
    return {
      alpha: b64(mk(80, 40, (x) => { x.fillStyle = 'rgba(255,0,0,0.5)'; x.fillRect(0, 0, 40, 40); }), 'image/png'),
      photo: b64(mk(600, 300, (x) => { const g = x.createLinearGradient(0, 0, 600, 0); g.addColorStop(0, '#ff0000'); g.addColorStop(1, '#0000ff'); x.fillStyle = g; x.fillRect(0, 0, 600, 300); }), 'image/jpeg'),
    };
  });
  const files = {
    'alpha.png': Buffer.from(fx.alpha, 'base64'),
    'photo.jpg': Buffer.from(fx.photo, 'base64'),
    'vector.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#00aa00"/></svg>'),
    'bad.png': Buffer.from('this is not an image'),
  };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(tmp, n), b);
  py('from PIL import Image;import sys;im=Image.new("RGB",(40,20),(255,0,0));e=Image.Exif();e[274]=6;im.save(sys.argv[1],exif=e)', path.join(tmp, 'rotated.jpg'));

  const pick = async (names) => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#imgPick')]);
    await fc.setFiles(names.map((n) => path.join(tmp, n)));
  };
  await page.click('#btnImgTool');
  await pick(['alpha.png', 'photo.jpg', 'vector.svg', 'rotated.jpg']);
  check('chosen images are listed', (await page.locator('#imgList li').count()) === 4);
  await page.selectOption('#cFormat', 'png'); await page.selectOption('#cResize', 'none'); await page.fill('#cDpi', '300');
  const zip2 = await dl(() => page.click('#imgRun'));
  const n2 = unzip(zip2, path.join(tmp, 'zip2'));
  check('batch conversion gives a ZIP with one PNG per image', n2.join() === 'alpha.png,photo.png,rotated.png,vector.png', n2.join());
  check('converted PNGs carry the chosen dpi', info(path.join(tmp, 'zip2', 'photo.png')).dpi === 300);
  check('EXIF orientation is applied (40x20 tagged "rotate 90" becomes 20x40)', info(path.join(tmp, 'zip2', 'rotated.png')).size.join() === '20,40', JSON.stringify(info(path.join(tmp, 'zip2', 'rotated.png'))));
  check('SVG is rasterised at a useful size', info(path.join(tmp, 'zip2', 'vector.png')).size[0] >= 1000, JSON.stringify(info(path.join(tmp, 'zip2', 'vector.png'))));
  check('PNG keeps transparency', px(path.join(tmp, 'zip2', 'alpha.png'), 70, 20)[3] === 0);

  await page.selectOption('#cFormat', 'jpeg'); await page.selectOption('#cResize', 'max'); await page.fill('#cResizeVal', '100');
  const zip3 = await dl(() => page.click('#imgRun'));
  unzip(zip3, path.join(tmp, 'zip3'));
  const ja = path.join(tmp, 'zip3', 'alpha.jpg');
  check('JPEG output: transparency becomes white, not black', px(ja, 70, 20).slice(0, 3).every((v) => v > 240), JSON.stringify(px(ja, 70, 20)));
  const jp = info(path.join(tmp, 'zip3', 'photo.jpg'));
  check('"longest side up to 100 px" resizes proportionally (600x300 -> 100x50)', jp.size.join() === '100,50' && jp.fmt === 'JPEG' && jp.dpi === 300, JSON.stringify(jp));
  await page.selectOption('#cResize', 'percent'); await page.fill('#cResizeVal', '50');
  const zip4 = await dl(() => page.click('#imgRun'));
  unzip(zip4, path.join(tmp, 'zip4'));
  check('percentage resize (600x300 @50% -> 300x150)', info(path.join(tmp, 'zip4', 'photo.jpg')).size.join() === '300,150');

  // PDF from images
  await page.selectOption('#cFormat', 'pdf'); await page.selectOption('#cResize', 'none'); await page.selectOption('#cPaper', 'A4'); await page.fill('#cMargin', '10'); await page.uncheck('#cOpen');
  file = await dl(() => page.click('#imgRun'));
  out = await PDFDocument.load(fs.readFileSync(file));
  check('images -> PDF: one A4 page per image', out.getPageCount() === 4 && out.getPages().every((p) => Math.abs(Math.min(p.getWidth(), p.getHeight()) - 595.28) < 0.1), String(out.getPageCount()));
  check('landscape image gets a landscape page', out.getPages().some((p) => p.getWidth() > p.getHeight()));
  await page.selectOption('#cPaper', 'fit'); await page.fill('#cDpi', '72');
  file = await dl(() => page.click('#imgRun'));
  out = await PDFDocument.load(fs.readFileSync(file));
  const pgs = out.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())].join('x'));
  check('"fit to image" at 72 dpi makes pages the image size in points', pgs.includes('600x300') && pgs.includes('80x40'), pgs.join());

  // bad file is skipped with a message, the rest still converts
  await page.evaluate(() => document.querySelector('#imgClose').click());
  await page.click('#btnImgTool');
  await pick(['bad.png', 'alpha.png']);
  await page.selectOption('#cFormat', 'png');
  file = await dl(() => page.click('#imgRun'));
  check('a corrupt image is skipped and the rest still converts', path.basename(file) === 'alpha.png');
  await page.waitForFunction(() => /skipped/.test(document.querySelector('#toast').textContent));
  check('the skipped file is reported', /bad\.png/.test(await toastText()), await toastText());

  // open in editor: adds pages to the current document
  await page.evaluate(() => document.querySelector('#imgClose').click());
  await page.click('#btnImgTool');
  await pick(['photo.jpg', 'vector.svg']);
  await page.selectOption('#cFormat', 'pdf'); await page.selectOption('#cPaper', 'A4'); await page.check('#cOpen');
  await page.click('#imgRun');
  await page.waitForFunction(() => window.__editor.S.pages.length === 5, null, { timeout: 30000 });
  check('"add to the current document" appends the image pages', await page.evaluate(() => window.__editor.S.pages.length === 5));

  // empty state shows the image tool, too
  await page.evaluate(() => { window.__editor.S.dirty = false; });
  await page.reload();
  check('the empty start screen offers Images → PDF', await page.locator('#btnImages2').isVisible());
  await page.click('#btnImages2');
  check('and it opens the image dialog without a document', await page.evaluate(() => document.querySelector('#imgDlg').open));

  check('no page or console errors', errors.length === 0, errors.join('\n'));
  await browser.close(); server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll export checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
