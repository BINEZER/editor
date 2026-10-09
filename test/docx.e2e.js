// PDF -> DOCX end-to-end test: real PDF in, real .docx out, then LibreOffice converts the .docx back to PDF
// so we can compare the text and page count with what we started with.
// Run: node test/docx.e2e.js   (needs Playwright, plus LibreOffice (soffice) and pdftotext for the round trip)
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let playwright;
for (const m of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { playwright = require(m); break; } catch {} }
if (!playwright) { console.error('Playwright not found'); process.exit(2); }
const { PDFDocument, StandardFonts, rgb } = require('../vendor/pdf-lib.min.js');

const PORT = 8128;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const have = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };

const TITLE = 'Annual Report 2024';
const PARA1 = 'The company grew steadily throughout the year, opening three new offices and hiring forty people across engineering, sales and support. Revenue rose by eighteen percent compared with the previous year.';
const PARA2 = 'Looking ahead, the board expects continued expansion into neighbouring markets, supported by a stronger balance sheet and a growing base of repeat customers who value reliability above all else.';
const BULLETS = ['Opened offices in three cities', 'Launched the new customer portal', 'Reduced average response time by half'];
const TABLE = [['Region', 'Units', 'Revenue'], ['North', '120', '4,500.00'], ['South', '95', '3,980.50'], ['West', '210', '9,120.75']];
const COL_L = 'Left column text begins with a short introduction to the topic and then continues at length so that the column fills many lines and wraps naturally onto the following lines of the page, which exercises reading order. It keeps going with more sentences to be sure there are enough lines to detect a column layout reliably.';
const COL_R = 'Right column text is entirely separate from the left one and talks about something different, which means a converter that reads straight across the page would interleave the two and produce nonsense. A correct conversion keeps this paragraph whole and after the left column. More words follow here as well.';
const SCAN_LINES = ['Scanned page heading', 'This page was only a picture'];

function wrap(font, text, size, width) {
  const words = text.split(' '); const lines = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) > width && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function norm(s) { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean); }
function f1(expected, got) {
  const bag = new Map(); for (const w of got) bag.set(w, (bag.get(w) || 0) + 1);
  let hit = 0; for (const w of expected) if ((bag.get(w) || 0) > 0) { hit++; bag.set(w, bag.get(w) - 1); }
  const p = hit / Math.max(1, got.length), r = hit / Math.max(1, expected.length);
  return p + r ? (2 * p * r) / (p + r) : 0;
}
const zipText = (file, name) => execFileSync('python3', ['-c', 'import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf8"))', file, name], { maxBuffer: 1 << 26 }).toString();
const zipNames = (file) => execFileSync('python3', ['-c', 'import zipfile,sys;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file]).toString().split('\n');

async function buildSourcePdf(file, scanPng, photoPng) {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const H = 792;
  // ---- page 1: title, paragraphs, bullets, table, picture
  const p1 = doc.addPage([612, H]);
  p1.drawText(TITLE, { x: (612 - bold.widthOfTextAtSize(TITLE, 22)) / 2, y: H - 80, size: 22, font: bold });
  let y = H - 130;
  for (const para of [PARA1, PARA2]) {
    for (const ln of wrap(reg, para, 11, 468)) { p1.drawText(ln, { x: 72, y, size: 11, font: reg }); y -= 14; }
    y -= 12;
  }
  for (const b of BULLETS) { p1.drawText('•', { x: 72, y, size: 11, font: reg }); p1.drawText(b, { x: 90, y, size: 11, font: reg }); y -= 14; }
  y -= 18;
  for (const [i, row] of TABLE.entries()) {
    row.forEach((c, k) => p1.drawText(c, { x: [72, 240, 380][k], y, size: 11, font: i ? reg : bold }));
    y -= 16;
  }
  y -= 20;
  const img = await doc.embedPng(Buffer.from(photoPng, 'base64'));
  p1.drawImage(img, { x: 72, y: y - 100, width: 150, height: 100 });
  // ---- page 2: two columns of prose
  const p2 = doc.addPage([612, H]);
  p2.drawText('Two column page', { x: 72, y: H - 80, size: 18, font: bold });
  let yl = H - 120;
  for (const ln of wrap(reg, COL_L, 11, 215)) { p2.drawText(ln, { x: 72, y: yl, size: 11, font: reg }); yl -= 14; }
  let yr = H - 120;
  for (const ln of wrap(reg, COL_R, 11, 215)) { p2.drawText(ln, { x: 325, y: yr, size: 11, font: reg }); yr -= 14; }
  // ---- page 3: a scan
  const p3 = doc.addPage([612, H]);
  const scan = await doc.embedPng(Buffer.from(scanPng, 'base64'));
  p3.drawImage(scan, { x: 0, y: 0, width: 612, height: H });
  fs.writeFileSync(file, await doc.save());
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfdocx-'));
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

  const scanPng = await page.evaluate((lines) => {
    const c = document.createElement('canvas'); c.width = 1700; c.height = 2200;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1700, 2200); x.fillStyle = '#111'; x.font = '52px Arial';
    lines.forEach((l, i) => x.fillText(l, 100, 300 + i * 120));
    return c.toDataURL('image/png').split(',')[1];
  }, SCAN_LINES);
  const photoPng = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 200;
    const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 300, 200); g.addColorStop(0, '#d92d20'); g.addColorStop(1, '#1d4ed8');
    x.fillStyle = g; x.fillRect(0, 0, 300, 200); x.fillStyle = '#fff'; x.fillRect(100, 60, 100, 80);
    return c.toDataURL('image/png').split(',')[1];
  });
  const srcPdf = path.join(tmp, 'report.pdf');
  await buildSourcePdf(srcPdf, scanPng, photoPng);
  await page.setInputFiles('#fileOpen', srcPdf);
  await page.waitForFunction(() => window.__editor.S.pages.length === 3);
  await page.waitForTimeout(500);

  const convert = async () => {
    const b64 = await page.evaluate(async () => {
      const r = await window.__editor.convertToDocx();
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { b64: btoa(s), stats: r.analysis.stats, infos: r.analysis.pages.map((p) => p.info), notes: r.notes };
    });
    return b64;
  };

  // ============ 1) conversion of the page structure (scan has no OCR yet)
  let res = await convert();
  const docx1 = path.join(tmp, 'noocr.docx'); fs.writeFileSync(docx1, Buffer.from(res.b64, 'base64'));
  console.log('      stats:', JSON.stringify(res.stats));
  check('output is a valid DOCX zip with the expected parts', ['word/document.xml', '[Content_Types].xml', 'word/numbering.xml'].every((n) => zipNames(docx1).includes(n)));
  const xml = zipText(docx1, 'word/document.xml');
  check('one section per PDF page', (xml.match(/<w:sectPr/g) || []).length === 3, String((xml.match(/<w:sectPr/g) || []).length));
  check('title became a Heading 1', /<w:pStyle w:val="Heading1"\/>[\s\S]*?Annual Report 2024/.test(xml));
  check('title is centred', /<w:jc w:val="center"\/>[\s\S]{0,400}Annual Report 2024/.test(xml) || /Annual Report 2024/.test(xml) && /<w:jc w:val="center"\/>/.test(xml));
  const paras = xml.split('</w:p>').map((p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));
  check('paragraph 1 is a single paragraph', paras.some((p) => p.includes('opening three new offices') && p.includes('support. Revenue rose') ));
  check('paragraph 2 is a separate paragraph', paras.some((p) => p.startsWith('Looking ahead') && p.includes('above all else')));
  check('bullets use Word list numbering', (xml.match(/<w:numId /g) || []).length >= 3, String((xml.match(/<w:numId /g) || []).length));
  check('bullet glyph is not duplicated in the text', !paras.some((p) => /^•/.test(p)));
  check('table and column layout produced Word tables', (xml.match(/<w:tbl>/g) || []).length >= 2, String((xml.match(/<w:tbl>/g) || []).length));
  check('table cells hold the right values', /Region[\s\S]*Units[\s\S]*Revenue[\s\S]*North[\s\S]*120[\s\S]*4,500\.00/.test(xml));
  check('picture embedded', /<w:drawing>/.test(xml) && zipNames(docx1).some((n) => n.startsWith('word/media/')));
  check('left column text comes before right column text', xml.indexOf('Left column text begins') < xml.indexOf('Right column text is entirely') && xml.indexOf('Right column text') < xml.indexOf('after the left column') );
  check('left column is not interleaved with right column', !/Left column[^<]*Right column/.test(xml));
  check('page sizes written (Letter)', /<w:pgSz w:w="12240" w:h="15840"/.test(xml));
  check('scanned page without OCR is flagged', res.infos[2].scannedNoText === true && res.stats.scannedNoText === 1, JSON.stringify(res.infos));
  check('scanned page kept as an image', (xml.match(/<w:drawing>/g) || []).length >= 2);

  // ============ 2) after OCR the scan becomes real text
  await page.click('#btnOcr'); await page.selectOption('#ocrScope', 'empty'); await page.selectOption('#ocrDpi', '200'); await page.click('#ocrRun');
  await page.waitForFunction(() => !document.querySelector('#ocrRun').disabled, null, { timeout: 180000 });
  await page.click('#ocrClose'); await page.waitForFunction(() => !document.querySelector('#ocrDlg').open);
  res = await convert();
  const docx2 = path.join(tmp, 'ocr.docx'); fs.writeFileSync(docx2, Buffer.from(res.b64, 'base64'));
  const xml2 = zipText(docx2, 'word/document.xml');
  check('after OCR the scan page is editable text', /Scanned page heading/.test(xml2) && /only a picture/.test(xml2));
  check('OCR page is marked in the report info', res.infos[2].ocr === true && res.infos[2].scannedNoText === false);
  check('OCR page no longer contains the page picture', (xml2.match(/<w:drawing>/g) || []).length === 1, String((xml2.match(/<w:drawing>/g) || []).length));

  // ============ 3) user edits flow into the Word file
  await page.evaluate(() => {
    const S = window.__editor.S;
    const p = S.pages[0];
    // cover "Annual Report 2024" and put new text in its place
    p.annots.push({ id: 'w1', type: 'whiteout', x: 150, y: 40, w: 320, h: 45, color: '#ffffff' });
    p.annots.push({ id: 't1', type: 'text', x: 200, y: 50, text: 'Edited Title 2025', size: 22, color: '#d92d20', font: 'Helvetica', bold: true });
    p.annots.push({ id: 'h1', type: 'highlight', x: 72, y: 300, w: 100, h: 14, color: '#ffe14d' });
  });
  res = await convert();
  const docx3 = path.join(tmp, 'edited.docx'); fs.writeFileSync(docx3, Buffer.from(res.b64, 'base64'));
  const xml3 = zipText(docx3, 'word/document.xml');
  check('edited text replaces the covered original', /Edited Title 2025/.test(xml3) && !/Annual Report 2024/.test(xml3));
  check('added text keeps its colour', /<w:color w:val="d92d20"\/>/i.test(xml3));
  check('unsupported annotations are counted, not silently lost', res.notes.skippedAnnots === 1, JSON.stringify(res.notes));
  await page.evaluate(() => { const S = window.__editor.S; S.pages[0].annots = []; });

  // ============ 4) the real button: download + report dialog
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btnDocx')]);
  const dlFile = path.join(tmp, 'download.docx'); await dl.saveAs(dlFile);
  check('download is named after the PDF', dl.suggestedFilename() === 'report.docx', dl.suggestedFilename());
  await page.waitForSelector('#docxDlg[open]');
  const summary = await page.textContent('#docxSummary');
  check('report dialog summarises the conversion', /3 pages/.test(summary) && /table/.test(summary), summary);
  check('report dialog lists notes', (await page.locator('#docxNotes li').count()) >= 2);
  await page.screenshot({ path: path.join(tmp, 'report.png') });
  await page.click('#docxDlg button.primary');

  // ============ 4b) colours, borders and shading
  {
    const doc = await PDFDocument.create();
    const reg = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pg = doc.addPage([612, 792]);
    pg.drawText('A paragraph in plain black text that gives the page its body size.', { x: 72, y: 700, size: 11, font: reg });
    pg.drawText('Blue heading line of text', { x: 72, y: 660, size: 11, font: reg, color: rgb(0.1, 0.4, 0.8) });
    pg.drawText('Ghost white text on white', { x: 72, y: 630, size: 11, font: reg, color: rgb(1, 1, 1) });
    // table: dark header row with white text, thin black borders
    const cols = [72, 240, 380], right = 480;
    pg.drawRectangle({ x: 72, y: 540, width: right - 72, height: 20, color: rgb(0.1, 0.14, 0.2) });
    ['Region', 'Units', 'Revenue'].forEach((c, k) => pg.drawText(c, { x: cols[k] + 4, y: 546, size: 11, font: bold, color: rgb(1, 1, 1) }));
    const data = [['North', '120', '4,500'], ['South', '95', '3,980'], ['West', '210', '9,120']];
    data.forEach((r, i) => r.forEach((c, k) => pg.drawText(c, { x: cols[k] + 4, y: 520 - i * 20, size: 11, font: reg })));
    for (let i = 0; i <= 4; i++) pg.drawLine({ start: { x: 72, y: 560 - i * 20 }, end: { x: right, y: 560 - i * 20 }, thickness: 0.7, color: rgb(0, 0, 0) });
    for (const x of [...cols, right]) pg.drawLine({ start: { x, y: 560 }, end: { x, y: 480 }, thickness: 0.7, color: rgb(0, 0, 0) });
    const f2 = path.join(tmp, 'colour.pdf');
    fs.writeFileSync(f2, await doc.save());
    await page.evaluate(() => { window.__editor.S.dirty = false; });
    await page.setInputFiles('#fileOpen', f2);
    await page.waitForFunction(() => window.__editor.S.pages.length === 1 && window.__editor.S.sources.length === 1);
    await page.waitForTimeout(500);
    res = await convert();
    const f2docx = path.join(tmp, 'colour.docx'); fs.writeFileSync(f2docx, Buffer.from(res.b64, 'base64'));
    const x4 = zipText(f2docx, 'word/document.xml');
    const blue = /Blue heading line[\s\S]{0,0}/.test(x4) && (x4.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*?Blue heading line(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/) || [''])[0];
    const col = (blue.match(/<w:color w:val="(\w+)"/) || [])[1] || '';
    const rgbv = col ? [0, 2, 4].map((i) => parseInt(col.slice(i, i + 2), 16)) : [0, 0, 0];
    check('coloured text keeps its colour', rgbv[2] > 150 && rgbv[0] < 70, col);
    check('table gets borders from the ruling lines', /<w:tblBorders>[\s\S]*?<w:top w:val="single"/.test(x4) && /<w:insideV w:val="single"/.test(x4), (x4.match(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/) || ['none'])[0].slice(0, 300));
    check('header row shading is carried over', /<w:shd [^>]*w:fill="1a2433"|<w:shd [^>]*w:fill="1a2332"|<w:shd [^>]*w:fill="1[0-9a-f]2[0-9a-f]3[0-9a-f]"/i.test(x4), (x4.match(/<w:shd [^>]*>/g) || []).join(' '));
    check('light text on the shaded header stays light', /<w:color w:val="f[0-9a-f]f[0-9a-f]f[0-9a-f]"\/>/i.test(x4), (x4.match(/<w:color [^>]*>/g) || []).join(' '));
    const ghost = (x4.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*?Ghost white text(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/) || [''])[0];
    check('white text on a plain page is made readable', ghost.length > 0 && !/w:val="ffffff"/i.test(ghost), ghost.slice(0, 200));
  }

  // ============ 5) round trip through LibreOffice
  if (have('soffice') && have('pdftotext')) {
    const out = path.join(tmp, 'rt'); fs.mkdirSync(out);
    execFileSync('soffice', ['--headless', '--norestore', `-env:UserInstallation=file://${tmp}/lo-profile`, '--convert-to', 'pdf', '--outdir', out, docx2], { timeout: 180000, stdio: 'ignore' });
    const rtPdf = path.join(out, 'ocr.pdf');
    check('LibreOffice opened and re-exported the DOCX', fs.existsSync(rtPdf));
    if (fs.existsSync(rtPdf)) {
      const rtText = execFileSync('pdftotext', ['-raw', rtPdf, '-']).toString();
      const pages = (execFileSync('pdfinfo', [rtPdf]).toString().match(/Pages:\s+(\d+)/) || [])[1];
      const expected = norm([TITLE, PARA1, PARA2, ...BULLETS, ...TABLE.flat(), 'Two column page', COL_L, COL_R, ...SCAN_LINES].join(' '));
      const score = f1(expected, norm(rtText));
      console.log(`      round trip: ${pages} pages, word F1 ${(score * 100).toFixed(1)}%`);
      check('round trip keeps >= 97% of the words', score >= 0.97, `F1=${score}`);
      check('round trip page count stays close (3 +/- 1)', Math.abs(Number(pages) - 3) <= 1, String(pages));
      // reading order of the two columns survives
      const iL = rtText.indexOf('Left column text begins'), iR = rtText.indexOf('Right column text is entirely');
      const iEndL = rtText.indexOf('lines of the page');
      check('round trip: right column does not interrupt the left one', iL >= 0 && iR > iEndL && iEndL > iL, `${iL} ${iEndL} ${iR}`);
      fs.copyFileSync(rtPdf, path.join(tmp, 'roundtrip.pdf'));
      execFileSync('pdftoppm', ['-r', '60', '-png', rtPdf, path.join(tmp, 'rt')]);
      execFileSync('pdftoppm', ['-r', '60', '-png', srcPdf, path.join(tmp, 'src')]);
    }
  } else console.log('SKIP  LibreOffice / pdftotext not installed: round-trip checks skipped');

  check('no page or console errors', errors.length === 0, errors.join('\n'));
  console.log('artifacts in', tmp);
  await browser.close(); server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll DOCX checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
