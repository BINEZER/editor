// Unit tests for layout analysis (pure logic, no browser). Run: node test/layout.test.mjs
import { analyze } from '../layout.js';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };

const item = (str, x, y, size = 11, extra = {}) => ({ str, x, y, size, w: str.length * 0.5 * size, font: 'Arial', bold: false, italic: false, ...extra });
const page = (items, extra = {}) => ({ w: 612, h: 792, items, images: [], ...extra });
const text = (b) => b.runs.map((r) => r.text).join('');
const flatText = (blocks) => blocks.map((b) => (b.type === 'p' ? text(b) : b.type)).join(' | ');

// ---------------------------------------------------------------- paragraphs, headings, alignment, dehyphenation
{
  const items = [
    item('Annual Report', (612 - 13 * 0.5 * 22) / 2, 80, 22, { bold: true }),
    item('This is the first paragraph of the report and it keeps going across the page', 72, 130),
    item('so that the second line belongs to the same paragraph as the first one does', 72, 144),
    item('and a third line finishes it off with the inter-', 72, 158),
    item('national flavour of the text.', 72, 172),
    item('A new paragraph begins here after a visible gap between the two blocks of text', 72, 200),
    item('and continues on a second line for good measure and length.', 72, 214),
    item('Filler to make the body size dominate the document statistics properly here.', 72, 228),
  ];
  const { pages, stats } = analyze([page(items)]);
  const b = pages[0].blocks;
  check('title is a level-1 heading', b[0].type === 'p' && b[0].heading === 1, JSON.stringify(b[0]).slice(0, 200));
  check('title is centred', b[0].align === 'center');
  check('wrapped lines merge into one paragraph', b[1].type === 'p' && /first paragraph.*second line.*third line/.test(text(b[1])), flatText(b));
  check('hyphenated word is rejoined', /international flavour/.test(text(b[1])), text(b[1]));
  check('a gap starts a new paragraph', /^A new paragraph/.test(text(b[2])), flatText(b));
  check('paragraph spacing is recorded', b[2].before > 3, String(b[2].before));
  check('body text is not a heading', b[1].heading === 0);
  check('page margins follow the text', Math.abs(pages[0].margins.left - 72) < 1, JSON.stringify(pages[0].margins));
}

// ---------------------------------------------------------------- bullets, wrapped bullet
{
  const items = [
    item('Plain intro line before the list starts here.', 72, 100),
    item('•', 72, 130), item('First bullet item', 90, 130),
    item('•', 72, 144), item('Second bullet item that is long and wraps', 90, 144),
    item('onto a continuation line', 90, 158),
    item('•', 72, 172), item('Third item', 90, 172),
  ];
  const b = analyze([page(items)]).pages[0].blocks;
  const bullets = b.filter((x) => x.type === 'p' && x.bullet);
  check('three bullet paragraphs', bullets.length === 3, flatText(b));
  check('bullet marker removed from text', !/^•/.test(text(bullets[0])) && /First bullet item/.test(text(bullets[0])), text(bullets[0]));
  check('wrapped bullet keeps its continuation', /wraps onto a continuation/.test(text(bullets[1])), text(bullets[1]));
}

// ---------------------------------------------------------------- two-column prose keeps reading order
{
  const left = [], right = [];
  const L = 'left column sentence number', R = 'right column sentence number';
  for (let i = 0; i < 9; i++) {
    left.push(item(`${L} ${i} flows on and on`, 72, 120 + i * 14));
    right.push(item(`${R} ${i} flows on and on`, 330, 120 + i * 14));
  }
  const items = [item('Two Column Page', 230, 70, 22), ...left, ...right];
  const b = analyze([page(items)]).pages[0].blocks;
  const cols = b.find((x) => x.type === 'columns');
  check('two-column text becomes a columns block', !!cols, flatText(b));
  if (cols) {
    check('columns block has two columns', cols.cols.length === 2);
    const l = cols.cols[0].blocks.map(text).join(' ');
    const r = cols.cols[1].blocks.map(text).join(' ');
    check('left column holds only left text', /left column/.test(l) && !/right column/.test(l), l.slice(0, 80));
    check('right column holds only right text', /right column/.test(r) && !/left column/.test(r), r.slice(0, 80));
    check('column lines flow into one paragraph', cols.cols[0].blocks.length <= 2, String(cols.cols[0].blocks.length));
  }
  check('heading above the columns stays outside them', b[0].type === 'p' && b[0].heading >= 1, JSON.stringify(b[0]).slice(0, 120));
}

// ---------------------------------------------------------------- table
{
  const rows = [['Item', 'Qty', 'Price'], ['Widget', '4', '12.50'], ['Gadget', '10', '99.00'], ['Gizmo', '1', '5.25'], ['Thing', '22', '1.10']];
  const items = [item('Order summary table follows below this sentence of text.', 72, 90)];
  rows.forEach((r, i) => {
    items.push(item(r[0], 72, 140 + i * 16));
    items.push(item(r[1], 260, 140 + i * 16));
    items.push(item(r[2], 400, 140 + i * 16));
  });
  const { pages, stats } = analyze([page(items)]);
  const t = pages[0].blocks.find((x) => x.type === 'table');
  check('aligned short cells become a table', !!t, flatText(pages[0].blocks));
  if (t) {
    check('table has 5 rows x 3 columns', t.rows.length === 5 && t.rows[0].length === 3, `${t.rows.length}x${t.rows[0]?.length}`);
    check('table cells hold the right text', t.rows[2].map((c) => c.runs.map((r) => r.text).join('')).join(',') === 'Gadget,10,99.00');
    check('table column widths follow the layout', Math.abs(t.cols[0] - 188) < 2, JSON.stringify(t.cols));
  }
  check('stats count the table', stats.tables === 1);
}

// ---------------------------------------------------------------- single row of columns -> tab stops
{
  const items = [
    item('Name: John Smith', 72, 100), item('Date: 2024-05-01', 400, 100),
    item('Some ordinary text underneath the header row for the body size.', 72, 130),
  ];
  const b = analyze([page(items)]).pages[0].blocks;
  check('one multi-column row becomes a tab-stop paragraph', b[0].type === 'p' && b[0].tabs?.length === 1 && /\t/.test(text(b[0])), JSON.stringify(b[0]).slice(0, 200));
}

// ---------------------------------------------------------------- images
{
  const items = [item('Text above the picture in the document body.', 72, 100), item('Text below the picture in the document body.', 72, 400)];
  const img = { x: 72, y: 150, w: 200, h: 150, data: new Uint8Array([1]) };
  const b = analyze([page(items, { images: [img] })]).pages[0].blocks.filter((x) => x.type !== 'spacer');
  const withSpacer = analyze([page(items, { images: [img] })]).pages[0].blocks;
  check('a gap above a picture becomes a spacer', withSpacer.some((x) => x.type === 'spacer' && x.height > 20));
  check('image is placed between the surrounding paragraphs', b.map((x) => x.type).join() === 'p,image,p', b.map((x) => x.type).join());
  check('image with free space around is inline', b[1].floating === false);
  const side = { x: 400, y: 90, w: 100, h: 60, data: new Uint8Array([1]) };
  const b2 = analyze([page(items, { images: [side] })]).pages[0].blocks;
  check('image beside text floats', b2.find((x) => x.type === 'image').floating === true);
}

// ---------------------------------------------------------------- scans and edge cases
{
  const full = { x: 0, y: 0, w: 612, h: 792, data: new Uint8Array([1]) };
  const r = analyze([page([], { images: [full] })]);
  check('scan without text keeps its page image and flags it', r.pages[0].blocks[0].type === 'image' && r.stats.scannedNoText === 1);
  const r2 = analyze([page([item('Searchable scan text lives here', 72, 100)], { images: [full] })]);
  check('searchable scan drops the background picture', r2.pages[0].blocks.every((b) => b.type !== 'image'));
  check('empty page does not throw', analyze([page([])]).pages[0].blocks.length === 0);
  const dup = analyze([page([item('Bold', 72, 100), item('Bold', 72.4, 100.3), item('Bold text follows on this line', 100, 100)])]);
  check('doubled (faux-bold) text is de-duplicated', (dup.pages[0].blocks[0].runs.map((x) => x.text).join('').match(/Bold/g) || []).length === 2, text(dup.pages[0].blocks[0]));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll layout checks passed');
process.exit(failures ? 1 : 0);
