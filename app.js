import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = PDFLib;

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let uid = 0;
const nid = () => 'x' + ++uid;

const FONT_CSS = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};
const STD_FONT = {
  Helvetica: ['Helvetica', 'HelveticaBold'],
  Times: ['TimesRoman', 'TimesRomanBold'],
  Courier: ['Courier', 'CourierBold'],
};
const BASELINE = 0.95; // first baseline offset, as a fraction of font size
const LEADING = 1.2; // line height, as a fraction of font size
const A4 = { w: 595.28, h: 841.89 };

/* ---------------------------------------------------------------- state */

const S = {
  sources: [], // { bytes, doc }
  pages: [], // { id, src, idx, blank, w, h, rot, annots[] }
  images: new Map(), // id -> { dataUrl, mime }
  tool: 'select',
  sel: null, // { pid, aid }
  zoom: 1,
  cur: 0,
  fileName: 'document',
  undo: [],
  redo: [],
  dirty: false,
  pendingImage: null,
  liveOpen: false,
  colors: {
    text: '#111111', highlight: '#ffe14d', ink: '#1d4ed8', rect: '#d92d20',
    ellipse: '#d92d20', line: '#d92d20', whiteout: '#ffffff',
  },
  fontSize: 18,
  stroke: 2,
  font: 'Helvetica',
  bold: false,
};

const refs = new Map(); // pid -> { w, inner, canvas, svg, rendered, visible, zoom, task, token }
const textCache = new Map(); // "src:idx" -> items[]
let editing = null; // { p, a, ta, isNew }
let drag = null;

const pageById = (id) => S.pages.find((p) => p.id === id);
const selAnnot = () => {
  if (!S.sel) return null;
  const p = pageById(S.sel.pid);
  return p?.annots.find((a) => a.id === S.sel.aid) || null;
};

/* ---------------------------------------------------------------- ui helpers */

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 6000 : 3000);
}
function busy(msg) {
  $('#busy').hidden = !msg;
  if (msg) $('#busyMsg').textContent = msg;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/* ---------------------------------------------------------------- history */

function pushUndo() {
  S.undo.push(structuredClone(S.pages));
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  S.dirty = true;
  updateHistoryButtons();
}
function restore(pages) {
  finishEdit(true);
  S.pages = pages;
  S.sel = null;
  S.dirty = true;
  S.cur = clamp(S.cur, 0, Math.max(0, pages.length - 1));
  buildPages();
  updateHistoryButtons();
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(structuredClone(S.pages));
  restore(S.undo.pop());
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(structuredClone(S.pages));
  restore(S.redo.pop());
}
function updateHistoryButtons() {
  $('#btnUndo').disabled = !S.undo.length;
  $('#btnRedo').disabled = !S.redo.length;
}

/* ---------------------------------------------------------------- loading */

async function loadSource(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') toast('Password-protected PDFs are not supported yet.', true);
    else toast(`Could not open "${file.name}": ${err?.message || err}`, true);
    return null;
  }
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return { bytes, doc, sizes };
}
const entriesFor = (srcIndex, sizes) =>
  sizes.map((s, i) => ({ id: nid(), src: srcIndex, idx: i, w: s.w, h: s.h, rot: 0, annots: [] }));

function isPdf(f) {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

async function openPdf(file) {
  if (!isPdf(file)) return toast('Please choose a PDF file.', true);
  if (S.dirty && !confirm('Discard your unsaved changes?')) return;
  busy('Opening…');
  try {
    const src = await loadSource(file);
    if (!src) return;
    finishEdit(true);
    S.sources.forEach((s) => s.doc.destroy());
    textCache.clear();
    S.sources = [{ bytes: src.bytes, doc: src.doc }];
    S.pages = entriesFor(0, src.sizes);
    S.undo = [];
    S.redo = [];
    S.sel = null;
    S.cur = 0;
    S.dirty = false;
    S.fileName = file.name.replace(/\.pdf$/i, '') || 'document';
    document.title = `${S.fileName} – PDF Editor`;
    document.body.classList.remove('empty');
    buildPages();
    fitWidth();
    updateHistoryButtons();
    setTool('select');
  } finally {
    busy('');
  }
}

async function addPdfs(files) {
  const list = [...files].filter(isPdf);
  if (!list.length) return toast('Please choose PDF files.', true);
  busy('Adding pages…');
  try {
    for (const f of list) {
      const src = await loadSource(f);
      if (!src) continue;
      pushUndo();
      S.sources.push({ bytes: src.bytes, doc: src.doc });
      S.pages.push(...entriesFor(S.sources.length - 1, src.sizes));
    }
    buildPages();
  } finally {
    busy('');
  }
}

function newBlankDocument() {
  if (S.dirty && !confirm('Discard your unsaved changes?')) return;
  finishEdit(true);
  S.sources.forEach((s) => s.doc.destroy());
  S.sources = [];
  textCache.clear();
  S.pages = [{ id: nid(), blank: true, w: A4.w, h: A4.h, rot: 0, annots: [] }];
  S.undo = [];
  S.redo = [];
  S.sel = null;
  S.cur = 0;
  S.dirty = false;
  S.fileName = 'document';
  document.body.classList.remove('empty');
  buildPages();
  fitWidth();
  updateHistoryButtons();
  setTool('select');
}

/* ---------------------------------------------------------------- page DOM */

const pageIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const p = pageById(e.target.dataset.pid);
      const r = p && refs.get(p.id);
      if (!r) continue;
      r.visible = e.isIntersecting;
      if (e.isIntersecting) {
        if (!r.rendered || r.zoom !== S.zoom) renderPage(p);
      } else if (r.rendered) {
        r.task?.cancel();
        r.canvas.width = r.canvas.height = 0;
        r.rendered = false;
      }
    }
  },
  { root: $('#viewer'), rootMargin: '800px 0px' }
);

const thumbIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || e.target._done) continue;
      e.target._done = true;
      const p = pageById(e.target.dataset.pid);
      if (p) renderThumb(p, e.target);
    }
  },
  { root: $('#side'), rootMargin: '300px 0px' }
);

function buildPages() {
  const host = $('#pages');
  pageIO.disconnect();
  refs.forEach((r) => r.task?.cancel());
  refs.clear();
  host.textContent = '';
  for (const p of S.pages) {
    const w = document.createElement('div');
    w.className = 'pg';
    w.dataset.pid = p.id;
    const inner = document.createElement('div');
    inner.className = 'pgi';
    const canvas = document.createElement('canvas');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
    inner.append(canvas, svg);
    w.append(inner);
    host.append(w);
    refs.set(p.id, { w, inner, canvas, svg, rendered: false, visible: false, zoom: 0, token: 0, task: null });
  }
  layoutPages();
  S.pages.forEach((p) => renderAnnots(p));
  S.pages.forEach((p) => pageIO.observe(refs.get(p.id).w));
  buildThumbs();
  updateTool();
  updatePageInfo();
}

function layoutPages() {
  const z = S.zoom;
  for (const p of S.pages) {
    const r = refs.get(p.id);
    if (!r) continue;
    const rot = p.rot % 360;
    const swap = rot % 180 !== 0;
    r.w.style.width = (swap ? p.h : p.w) * z + 'px';
    r.w.style.height = (swap ? p.w : p.h) * z + 'px';
    r.inner.style.width = p.w * z + 'px';
    r.inner.style.height = p.h * z + 'px';
    r.inner.style.transform =
      rot === 90 ? `translate(${p.h * z}px,0) rotate(90deg)`
      : rot === 180 ? `translate(${p.w * z}px,${p.h * z}px) rotate(180deg)`
      : rot === 270 ? `translate(0,${p.w * z}px) rotate(270deg)`
      : 'none';
  }
}

async function renderPage(p) {
  const r = refs.get(p.id);
  if (!r || p.blank) {
    if (r) { r.rendered = true; r.zoom = S.zoom; }
    return;
  }
  const token = ++r.token;
  r.task?.cancel();
  const zoom = S.zoom;
  try {
    const page = await S.sources[p.src].doc.getPage(p.idx + 1);
    if (token !== r.token) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: zoom * dpr });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const task = page.render({ canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp });
    r.task = task;
    await task.promise;
    if (token !== r.token) return;
    r.canvas.replaceWith(c);
    r.canvas = c;
    r.rendered = true;
    r.zoom = zoom;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
  }
}

/* ---------------------------------------------------------------- thumbnails */

function buildThumbs() {
  const ul = $('#thumbs');
  thumbIO.disconnect();
  ul.textContent = '';
  S.pages.forEach((p, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.pid = p.id;
    const swap = p.rot % 180 !== 0;
    li.innerHTML =
      `<div class="tw" style="aspect-ratio:${swap ? p.h : p.w} / ${swap ? p.w : p.h}"><canvas></canvas></div>` +
      `<div class="tbar"><span>${i + 1}</span><span class="acts">` +
      `<button data-act="rot" title="Rotate">↻</button><button data-act="dup" title="Duplicate">⧉</button>` +
      `<button data-act="del" title="Delete">✕</button></span></div>`;
    ul.append(li);
    thumbIO.observe(li);
  });
  markCurrent();
}

async function renderThumb(p, li) {
  if (p.blank) return;
  const canvas = li.querySelector('canvas');
  try {
    const page = await S.sources[p.src].doc.getPage(p.idx + 1);
    const rotation = (page.rotate + p.rot) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (140 * dpr) / base.width, rotation });
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
  }
}

function markCurrent() {
  document.querySelectorAll('#thumbs li').forEach((li, i) => li.classList.toggle('cur', i === S.cur));
}

function updatePageInfo() {
  $('#pageInfo').textContent = S.pages.length ? `Page ${S.cur + 1} / ${S.pages.length}` : '';
}

function scrollToPage(i) {
  const p = S.pages[i];
  const r = p && refs.get(p.id);
  if (!r) return;
  const v = $('#viewer');
  v.scrollTop += r.w.getBoundingClientRect().top - v.getBoundingClientRect().top - 12;
}

function onViewerScroll() {
  const v = $('#viewer');
  const mid = v.getBoundingClientRect().top + v.clientHeight / 3;
  let cur = 0;
  S.pages.forEach((p, i) => {
    const r = refs.get(p.id);
    if (r && r.w.getBoundingClientRect().top <= mid) cur = i;
  });
  if (cur !== S.cur) {
    S.cur = cur;
    markCurrent();
    updatePageInfo();
    document.querySelectorAll('#thumbs li')[cur]?.scrollIntoView({ block: 'nearest' });
  }
}

/* ---------------------------------------------------------------- page operations */

function rotatePage(i) {
  pushUndo();
  const p = S.pages[i];
  p.rot = (p.rot + 90) % 360;
  layoutPages();
  buildThumbs();
}
function deletePage(i) {
  if (S.pages.length <= 1) return toast('A document needs at least one page.', true);
  pushUndo();
  S.pages.splice(i, 1);
  S.sel = null;
  S.cur = clamp(S.cur, 0, S.pages.length - 1);
  buildPages();
}
function duplicatePage(i) {
  pushUndo();
  const copy = structuredClone(S.pages[i]);
  copy.id = nid();
  S.pages.splice(i + 1, 0, copy);
  buildPages();
}
function insertBlank() {
  const ref = S.pages[S.cur];
  const swap = ref && ref.rot % 180 !== 0;
  const w = ref ? (swap ? ref.h : ref.w) : A4.w;
  const h = ref ? (swap ? ref.w : ref.h) : A4.h;
  pushUndo();
  S.pages.splice(S.cur + 1, 0, { id: nid(), blank: true, w, h, rot: 0, annots: [] });
  buildPages();
  scrollToPage(S.cur + 1);
}
function movePage(from, to) {
  if (from === to) return;
  pushUndo();
  const [p] = S.pages.splice(from, 1);
  S.pages.splice(to, 0, p);
  S.cur = to;
  buildPages();
}

function initThumbEvents() {
  const ul = $('#thumbs');
  let dragIndex = -1;
  ul.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = [...ul.children].indexOf(li);
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'rot') rotatePage(i);
    else if (act === 'dup') duplicatePage(i);
    else if (act === 'del') deletePage(i);
    else scrollToPage(i);
  });
  ul.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    dragIndex = [...ul.children].indexOf(li);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragIndex));
  });
  ul.addEventListener('dragend', () => {
    dragIndex = -1;
    ul.querySelectorAll('li').forEach((l) => l.classList.remove('dragging', 'over-top', 'over-bot'));
  });
  ul.addEventListener('dragover', (e) => {
    if (dragIndex < 0) return;
    e.preventDefault();
    const li = e.target.closest('li');
    ul.querySelectorAll('li').forEach((l) => l.classList.remove('over-top', 'over-bot'));
    if (!li) return;
    const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    li.classList.add(after ? 'over-bot' : 'over-top');
  });
  ul.addEventListener('drop', (e) => {
    if (dragIndex < 0) return;
    e.preventDefault();
    const li = e.target.closest('li');
    if (!li) return;
    const idx = [...ul.children].indexOf(li);
    const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    let to = idx + (after ? 1 : 0);
    if (dragIndex < to) to--;
    movePage(dragIndex, to);
  });
}

/* ---------------------------------------------------------------- zoom */

function setZoom(z) {
  const v = $('#viewer');
  const ratio = v.scrollHeight ? v.scrollTop / v.scrollHeight : 0;
  S.zoom = clamp(z, 0.25, 4);
  layoutPages();
  v.scrollTop = ratio * v.scrollHeight;
  $('#zLabel').textContent = Math.round(S.zoom * 100) + '%';
  clearTimeout(setZoom.t);
  setZoom.t = setTimeout(() => {
    for (const p of S.pages) {
      const r = refs.get(p.id);
      if (!r) continue;
      if (r.visible) renderPage(p);
      else r.rendered = false;
    }
  }, 120);
  if (S.sel) renderAnnots(pageById(S.sel.pid));
}
function fitWidth() {
  if (!S.pages.length) return;
  const maxW = Math.max(...S.pages.map((p) => (p.rot % 180 ? p.h : p.w)));
  const avail = $('#viewer').clientWidth - 56;
  setZoom(clamp(avail / maxW, 0.25, 2));
}

/* ---------------------------------------------------------------- annotation rendering */

function lines(a) {
  return String(a.text ?? '').split('\n');
}
function estimateTextBox(a) {
  const ls = lines(a);
  const w = Math.max(...ls.map((l) => l.length), 1) * a.size * 0.55;
  return { w, h: ls.length * a.size * LEADING };
}

function shape(a, hit) {
  let el;
  const stroke = (e, width) => {
    e.setAttribute('fill', 'none');
    e.setAttribute('stroke', hit ? 'transparent' : a.color);
    e.setAttribute('stroke-width', hit ? Math.max(width, 12) : width);
    e.setAttribute('stroke-linecap', 'round');
    e.setAttribute('stroke-linejoin', 'round');
    e.style.pointerEvents = hit ? 'stroke' : 'none';
  };
  switch (a.type) {
    case 'text': {
      el = document.createElementNS(NS, 'text');
      el.setAttribute('font-size', a.size);
      el.setAttribute('fill', a.color);
      el.setAttribute('font-family', FONT_CSS[a.font] || FONT_CSS.Helvetica);
      if (a.bold) el.setAttribute('font-weight', 'bold');
      el.style.whiteSpace = 'pre';
      lines(a).forEach((ln, i) => {
        const t = document.createElementNS(NS, 'tspan');
        t.setAttribute('x', a.x);
        t.setAttribute('y', a.y + a.size * BASELINE + i * a.size * LEADING);
        t.textContent = ln || ' ';
        el.append(t);
      });
      break;
    }
    case 'highlight':
      el = document.createElementNS(NS, 'rect');
      setRect(el, a);
      el.setAttribute('fill', a.color);
      el.style.mixBlendMode = 'multiply';
      break;
    case 'whiteout':
      el = document.createElementNS(NS, 'rect');
      setRect(el, a);
      el.setAttribute('fill', a.color);
      break;
    case 'rect':
      el = document.createElementNS(NS, 'rect');
      setRect(el, a);
      stroke(el, a.width);
      break;
    case 'ellipse':
      el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', a.x + a.w / 2);
      el.setAttribute('cy', a.y + a.h / 2);
      el.setAttribute('rx', Math.max(a.w / 2, 0.1));
      el.setAttribute('ry', Math.max(a.h / 2, 0.1));
      stroke(el, a.width);
      break;
    case 'line':
      el = document.createElementNS(NS, 'line');
      el.setAttribute('x1', a.x1);
      el.setAttribute('y1', a.y1);
      el.setAttribute('x2', a.x2);
      el.setAttribute('y2', a.y2);
      stroke(el, a.width);
      break;
    case 'ink':
      el = document.createElementNS(NS, 'path');
      el.setAttribute('d', a.points.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join(''));
      stroke(el, a.width);
      break;
    case 'image':
      el = document.createElementNS(NS, 'image');
      setRect(el, a);
      el.setAttribute('href', S.images.get(a.img)?.dataUrl || '');
      el.setAttribute('preserveAspectRatio', 'none');
      break;
  }
  return el;
}
function setRect(el, a) {
  el.setAttribute('x', a.x);
  el.setAttribute('y', a.y);
  el.setAttribute('width', Math.max(a.w, 0.1));
  el.setAttribute('height', Math.max(a.h, 0.1));
}

function annotNode(a, draft) {
  const g = document.createElementNS(NS, 'g');
  g.dataset.aid = a.id;
  g.setAttribute('class', 'ann' + (draft ? ' draft' : ''));
  g.append(shape(a, false));
  if (!draft && ['rect', 'ellipse', 'line', 'ink'].includes(a.type)) g.append(shape(a, true));
  if (!draft && a.type === 'text') {
    const b = estimateTextBox(a);
    const h = document.createElementNS(NS, 'rect');
    h.setAttribute('x', a.x);
    h.setAttribute('y', a.y);
    h.setAttribute('width', b.w);
    h.setAttribute('height', b.h);
    h.setAttribute('fill', 'transparent');
    g.append(h);
  }
  return g;
}

function renderAnnots(p, draft) {
  const r = p && refs.get(p.id);
  if (!r) return;
  const svg = r.svg;
  svg.textContent = '';
  for (const a of p.annots) {
    if (editing && editing.a === a) continue;
    svg.append(annotNode(a, false));
  }
  if (draft) svg.append(annotNode(draft, true));
  if (S.sel && S.sel.pid === p.id && !editing) drawSelection(p, svg);
}

function resizable(a) {
  return ['highlight', 'whiteout', 'rect', 'ellipse', 'image', 'text'].includes(a.type);
}
function drawSelection(p, svg) {
  const g = svg.querySelector(`[data-aid="${S.sel.aid}"]`);
  if (!g) { S.sel = null; syncProps(); return; }
  let bb;
  try { bb = g.firstElementChild.getBBox(); } catch { return; }
  const pad = 3;
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('class', 'sel');
  rect.setAttribute('x', bb.x - pad);
  rect.setAttribute('y', bb.y - pad);
  rect.setAttribute('width', bb.width + pad * 2);
  rect.setAttribute('height', bb.height + pad * 2);
  svg.append(rect);
  const a = p.annots.find((x) => x.id === S.sel.aid);
  if (a && resizable(a)) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', 'handle');
    c.setAttribute('cx', bb.x + bb.width + pad);
    c.setAttribute('cy', bb.y + bb.height + pad);
    c.setAttribute('r', 5 / S.zoom);
    svg.append(c);
  }
}

function select(pid, aid) {
  const prev = S.sel;
  S.sel = pid ? { pid, aid } : null;
  if (prev && (!S.sel || prev.pid !== S.sel.pid)) renderAnnots(pageById(prev.pid));
  if (S.sel) renderAnnots(pageById(S.sel.pid));
  else if (prev) renderAnnots(pageById(prev.pid));
  syncProps();
}

/* ---------------------------------------------------------------- tools & properties */

const TOOL_TYPE = {
  text: 'text', edit: 'text', highlight: 'highlight', draw: 'ink', rect: 'rect',
  ellipse: 'ellipse', line: 'line', whiteout: 'whiteout',
};

function setTool(t) {
  finishEdit();
  S.tool = t;
  if (t !== 'select') select(null);
  updateTool();
  syncProps();
}
function updateTool() {
  $('#pages').dataset.tool = S.tool;
  document.querySelectorAll('#tools [data-tool]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.tool === S.tool))
  );
  document.querySelectorAll('.pgi .hov').forEach((n) => n.remove());
}

function syncProps() {
  const a = selAnnot();
  const type = a ? a.type : TOOL_TYPE[S.tool];
  const show = (id, on) => ($(id).hidden = !on);
  show('#gColor', !!type && type !== 'image');
  show('#gSize', type === 'text');
  show('#gStroke', ['rect', 'ellipse', 'line', 'ink'].includes(type));
  show('#gFont', type === 'text');
  show('#gBold', type === 'text');
  if (!type || type === 'image') return;
  $('#pColor').value = a ? a.color : S.colors[type];
  if (type === 'text') {
    $('#pSize').value = Math.round((a ? a.size : S.fontSize) * 10) / 10;
    $('#pFont').value = a ? a.font : S.font;
    $('#pBold').checked = a ? !!a.bold : S.bold;
  }
  if (['rect', 'ellipse', 'line', 'ink'].includes(type)) $('#pStroke').value = a ? a.width : S.stroke;
}

function liveEdit(apply) {
  const a = selAnnot();
  if (a) {
    if (!S.liveOpen) { pushUndo(); S.liveOpen = true; }
    apply(a);
    renderAnnots(pageById(S.sel.pid));
  }
}
function initProps() {
  const typeNow = () => selAnnot()?.type || TOOL_TYPE[S.tool];
  $('#pColor').addEventListener('input', (e) => {
    const t = typeNow();
    if (t) S.colors[t] = e.target.value;
    liveEdit((a) => (a.color = e.target.value));
  });
  $('#pSize').addEventListener('input', (e) => {
    const v = clamp(parseFloat(e.target.value) || 0, 4, 300);
    if (!e.target.value) return;
    S.fontSize = v;
    liveEdit((a) => a.type === 'text' && (a.size = v));
  });
  $('#pStroke').addEventListener('input', (e) => {
    const v = clamp(parseFloat(e.target.value) || 0, 0.5, 60);
    if (!e.target.value) return;
    S.stroke = v;
    liveEdit((a) => 'width' in a && (a.width = v));
  });
  $('#pFont').addEventListener('input', (e) => {
    S.font = e.target.value;
    liveEdit((a) => a.type === 'text' && (a.font = e.target.value));
  });
  $('#pBold').addEventListener('input', (e) => {
    S.bold = e.target.checked;
    liveEdit((a) => a.type === 'text' && (a.bold = e.target.checked));
  });
  for (const id of ['#pColor', '#pSize', '#pStroke', '#pFont', '#pBold'])
    $(id).addEventListener('change', () => (S.liveOpen = false));
}

/* ---------------------------------------------------------------- pointer interaction */

function svgPoint(svg, e) {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const q = pt.matrixTransform(m.inverse());
  return { x: q.x, y: q.y };
}

function newAnnot(type, extra) {
  const base = { id: nid(), type };
  if (type === 'text')
    return { ...base, text: '', size: S.fontSize, color: S.colors.text, font: S.font, bold: S.bold, ...extra };
  if (['rect', 'ellipse', 'line', 'ink'].includes(type))
    return { ...base, color: S.colors[type], width: S.stroke, ...extra };
  return { ...base, color: S.colors[type], ...extra };
}

function initPointer() {
  const host = $('#pages');

  host.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    const svg = e.target.closest('svg');
    if (!svg) {
      if (!e.target.closest('textarea')) { finishEdit(); if (S.tool === 'select') select(null); }
      return;
    }
    if (editing) finishEdit();
    const p = pageById(svg.closest('.pg').dataset.pid);
    if (!p) return;
    const pt = svgPoint(svg, e);
    S.cur = S.pages.indexOf(p);
    markCurrent();
    updatePageInfo();
    e.preventDefault();

    switch (S.tool) {
      case 'select': {
        const handle = e.target.closest('.handle');
        const g = e.target.closest('[data-aid]');
        if (handle && S.sel) {
          const a = selAnnot();
          const node = svg.querySelector(`[data-aid="${a.id}"]`);
          startDrag(e, svg, p, a, 'resize', pt, node?.firstElementChild.getBBox());
        } else if (g) {
          select(p.id, g.dataset.aid);
          startDrag(e, svg, p, selAnnot(), 'move', pt);
        } else select(null);
        break;
      }
      case 'text': {
        const a = newAnnot('text', { x: pt.x, y: pt.y });
        editText(p, a, true);
        break;
      }
      case 'edit':
        await editExistingText(p, pt);
        break;
      case 'place':
        placePending(p, pt);
        break;
      case 'highlight':
      case 'rect':
      case 'ellipse':
      case 'whiteout':
        startDrag(e, svg, p, newAnnot(S.tool, { x: pt.x, y: pt.y, w: 0, h: 0 }), 'create', pt);
        break;
      case 'line':
        startDrag(e, svg, p, newAnnot('line', { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }), 'create', pt);
        break;
      case 'draw':
        startDrag(e, svg, p, newAnnot('ink', { points: [[pt.x, pt.y]] }), 'create', pt);
        break;
    }
  });

  host.addEventListener('pointermove', (e) => {
    if (drag) return onDragMove(e);
    if (S.tool === 'edit') hoverText(e);
  });
  host.addEventListener('pointerup', onDragEnd);
  host.addEventListener('pointercancel', onDragEnd);

  host.addEventListener('dblclick', (e) => {
    const g = e.target.closest('[data-aid]');
    if (!g || S.tool !== 'select') return;
    const p = pageById(g.closest('.pg').dataset.pid);
    const a = p?.annots.find((x) => x.id === g.dataset.aid);
    if (a?.type === 'text') editText(p, a, false);
  });
}

function startDrag(e, svg, p, a, kind, start, bbox) {
  svg.setPointerCapture(e.pointerId);
  drag = { kind, svg, p, a, start, orig: structuredClone(a), bbox, moved: false };
}

function onDragMove(e) {
  const { kind, svg, p, a, start, orig } = drag;
  const pt = svgPoint(svg, e);
  const dx = pt.x - start.x;
  const dy = pt.y - start.y;
  if (kind === 'create') {
    switch (a.type) {
      case 'line': a.x2 = pt.x; a.y2 = pt.y; break;
      case 'ink': {
        const last = a.points[a.points.length - 1];
        if (Math.hypot(pt.x - last[0], pt.y - last[1]) >= 0.5) a.points.push([pt.x, pt.y]);
        break;
      }
      default:
        a.x = Math.min(start.x, pt.x);
        a.y = Math.min(start.y, pt.y);
        a.w = Math.abs(pt.x - start.x);
        a.h = Math.abs(pt.y - start.y);
    }
    drag.moved = true;
    renderAnnots(p, a);
    return;
  }
  if (!drag.moved && Math.hypot(dx, dy) * S.zoom < 3) return;
  if (!drag.moved) { pushUndo(); drag.moved = true; }
  if (kind === 'move') {
    if (a.type === 'line') {
      a.x1 = orig.x1 + dx; a.y1 = orig.y1 + dy; a.x2 = orig.x2 + dx; a.y2 = orig.y2 + dy;
    } else if (a.type === 'ink') {
      a.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
    } else {
      a.x = orig.x + dx;
      a.y = orig.y + dy;
    }
  } else if (kind === 'resize') {
    if (a.type === 'text') {
      const ratio = (pt.y - a.y) / Math.max(drag.bbox.height, 1);
      a.size = clamp(Math.round(orig.size * ratio * 10) / 10, 4, 300);
      $('#pSize').value = a.size;
    } else if (a.type === 'image') {
      a.w = Math.max(8, pt.x - a.x);
      a.h = a.w * (orig.h / orig.w);
    } else {
      a.w = Math.max(5, pt.x - a.x);
      a.h = Math.max(5, pt.y - a.y);
    }
  }
  renderAnnots(p);
}

function onDragEnd() {
  if (!drag) return;
  const { kind, p, a } = drag;
  drag = null;
  if (kind !== 'create') { renderAnnots(p); return; }
  let ok;
  if (a.type === 'line') ok = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) >= 3;
  else if (a.type === 'ink') ok = a.points.length >= 2;
  else ok = a.w >= 3 && a.h >= 3;
  if (ok) {
    pushUndo();
    p.annots.push(a);
  }
  renderAnnots(p);
}

/* ---------------------------------------------------------------- text editing overlay */

function editText(p, a, isNew) {
  finishEdit();
  const r = refs.get(p.id);
  const z = S.zoom;
  const ta = document.createElement('textarea');
  ta.className = 'tedit';
  ta.wrap = 'off';
  ta.spellcheck = false;
  ta.value = a.text;
  ta.style.left = a.x * z + 'px';
  ta.style.top = a.y * z + 'px';
  ta.style.fontSize = a.size * z + 'px';
  ta.style.color = a.color;
  ta.style.fontFamily = FONT_CSS[a.font] || FONT_CSS.Helvetica;
  ta.style.fontWeight = a.bold ? 'bold' : 'normal';
  const fit = () => {
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.width = Math.max(a.size * z * 3, ta.scrollWidth + 6) + 'px';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('blur', () => { if (editing?.ta === ta) finishEdit(); });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); finishEdit(true); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finishEdit(); }
    ev.stopPropagation();
  });
  r.inner.append(ta);
  editing = { p, a, ta, isNew };
  renderAnnots(p);
  fit();
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
}

function finishEdit(cancel = false) {
  if (!editing) return;
  const { p, a, ta, isNew } = editing;
  editing = null;
  const text = ta.value.replace(/\r/g, '').replace(/\s+$/, '');
  ta.remove();
  if (!cancel) {
    if (isNew) {
      if (text) { a.text = text; pushUndo(); p.annots.push(a); }
    } else if (!text) {
      pushUndo();
      p.annots = p.annots.filter((x) => x !== a);
      if (S.sel?.aid === a.id) S.sel = null;
    } else if (text !== a.text) {
      pushUndo();
      a.text = text;
    }
  }
  renderAnnots(p);
  syncProps();
}

/* ---------------------------------------------------------------- editing existing text */

async function textItemsFor(p) {
  if (p.blank) return [];
  const key = `${p.src}:${p.idx}`;
  if (textCache.has(key)) return textCache.get(key);
  const promise = (async () => {
    const page = await S.sources[p.src].doc.getPage(p.idx + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, , , e, f] = pdfjsLib.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(a, b);
      if (!size || Math.abs(b) > 0.05 * size || a < 0) continue; // only upright, unmirrored text
      const fam = tc.styles[it.fontName]?.fontFamily || '';
      items.push({
        str: it.str, x: e, y: f, size, w: it.width * vp.scale,
        font: /mono|courier/i.test(fam) ? 'Courier' : /serif/i.test(fam) && !/sans/i.test(fam) ? 'Times' : 'Helvetica',
      });
    }
    return items;
  })();
  textCache.set(key, promise);
  return promise;
}
const hitItem = (items, pt) =>
  items.find(
    (it) => pt.x >= it.x - 2 && pt.x <= it.x + it.w + 2 && pt.y >= it.y - it.size * 0.95 && pt.y <= it.y + it.size * 0.3
  );

async function hoverText(e) {
  const svg = e.target.closest('svg');
  document.querySelectorAll('.pgi .hov').forEach((n) => n.remove());
  if (!svg) return;
  const p = pageById(svg.closest('.pg').dataset.pid);
  if (!p) return;
  const items = await textItemsFor(p);
  const it = hitItem(items, svgPoint(svg, e));
  if (!it || S.tool !== 'edit') return;
  document.querySelectorAll('.pgi .hov').forEach((n) => n.remove());
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('class', 'hov');
  r.setAttribute('x', it.x - 1);
  r.setAttribute('y', it.y - it.size * 0.9);
  r.setAttribute('width', it.w + 2);
  r.setAttribute('height', it.size * 1.15);
  svg.append(r);
}

function sampleBackground(p, x, y) {
  const r = refs.get(p.id);
  const c = r?.canvas;
  if (!c || !c.width || !r.rendered) return '#ffffff';
  try {
    const px = clamp(Math.round((x / p.w) * c.width), 0, c.width - 1);
    const py = clamp(Math.round((y / p.h) * c.height), 0, c.height - 1);
    const [R, G, B] = c.getContext('2d').getImageData(px, py, 1, 1).data;
    return '#' + [R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch {
    return '#ffffff';
  }
}

async function editExistingText(p, pt) {
  const items = await textItemsFor(p);
  const it = hitItem(items, pt);
  if (!it) return toast('No editable text here. Scanned pages need OCR first.');
  const sx = it.x > 3 ? it.x - 2 : it.x + it.w + 2;
  const bg = sampleBackground(p, sx, it.y - it.size * 0.3);
  pushUndo();
  p.annots.push(
    newAnnot('whiteout', { x: it.x - 1, y: it.y - it.size * 0.9, w: it.w + 2, h: it.size * 1.15, color: bg })
  );
  const t = newAnnot('text', { x: it.x, y: it.y - it.size * BASELINE, text: it.str, size: Math.round(it.size * 10) / 10, font: it.font });
  p.annots.push(t);
  editText(p, t, false);
}

/* ---------------------------------------------------------------- images & signature */

function readAsDataUrl(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
async function prepareImageFromUrl(url, mimeHint) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const nw = img.naturalWidth || 300;
  const nh = img.naturalHeight || 150;
  const scale = Math.min(1, 2400 / Math.max(nw, nh));
  const c = document.createElement('canvas');
  c.width = Math.round(nw * scale);
  c.height = Math.round(nh * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const jpeg = mimeHint === 'image/jpeg';
  const dataUrl = c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92);
  const id = nid();
  S.images.set(id, { dataUrl, mime: jpeg ? 'image/jpeg' : 'image/png' });
  return { id, w: c.width, h: c.height };
}
async function chooseImage(file) {
  try {
    const img = await prepareImageFromUrl(await readAsDataUrl(file), file.type);
    S.pendingImage = img;
    setTool('place');
    toast('Click on a page to place the image.');
  } catch {
    toast('That image could not be read.', true);
  }
}
function placePending(p, pt) {
  const im = S.pendingImage;
  if (!im) return setTool('select');
  const w = Math.min(im.w, p.w * 0.4, 260);
  const h = w * (im.h / im.w);
  const a = { id: nid(), type: 'image', img: im.id, x: clamp(pt.x - w / 2, 0, Math.max(0, p.w - w)), y: clamp(pt.y - h / 2, 0, Math.max(0, p.h - h)), w, h };
  pushUndo();
  p.annots.push(a);
  S.pendingImage = null;
  setTool('select');
  select(p.id, a.id);
}

const sig = { drawing: false, last: null, drawn: false };
function initSignature() {
  const dlg = $('#sigDlg');
  const cv = $('#sigCanvas');
  const ctx = cv.getContext('2d');
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height };
  };
  const clear = () => { ctx.clearRect(0, 0, cv.width, cv.height); sig.drawn = false; };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    sig.drawing = true;
    sig.last = pos(e);
    ctx.strokeStyle = $('#sigColor').value;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 3.5;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(sig.last.x, sig.last.y, 1.75, 0, Math.PI * 2);
    ctx.fill();
    sig.drawn = true;
  });
  cv.addEventListener('pointermove', (e) => {
    if (!sig.drawing) return;
    const q = pos(e);
    ctx.beginPath();
    ctx.moveTo(sig.last.x, sig.last.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
    sig.last = q;
  });
  const stop = () => (sig.drawing = false);
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);
  $('#sigClear').onclick = clear;
  $('#sigCancel').onclick = () => dlg.close();
  $('#sigSaved').onclick = async () => {
    const url = safeStorage('get', 'sig');
    if (url) { dlg.close(); await useSignature(url); }
  };
  $('#sigUse').onclick = async () => {
    if (!sig.drawn) return toast('Draw your signature first.', true);
    const { width: W, height: H } = cv;
    const data = ctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (data[(y * W + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    const url = out.toDataURL('image/png');
    safeStorage('set', 'sig', url);
    dlg.close();
    await useSignature(url);
  };
  return {
    open() {
      clear();
      $('#sigSaved').hidden = !safeStorage('get', 'sig');
      dlg.showModal();
    },
  };
}
async function useSignature(url) {
  S.pendingImage = await prepareImageFromUrl(url, 'image/png');
  setTool('place');
  toast('Click on a page to place your signature.');
}
function safeStorage(op, key, val) {
  try {
    if (op === 'get') return localStorage.getItem('pdfeditor.' + key);
    localStorage.setItem('pdfeditor.' + key, val);
  } catch { return null; }
}

/* ---------------------------------------------------------------- export */

const hexRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const dataUrlBytes = (u) => Uint8Array.from(atob(u.slice(u.indexOf(',') + 1)), (c) => c.charCodeAt(0));

function makeMap(pg) {
  const { x: x0, y: y0, width: w, height: h } = pg.getCropBox();
  const R = (((pg.getRotation().angle % 360) + 360) % 360);
  const pt = (dx, dy) => {
    switch (R) {
      case 90: return [x0 + dy, y0 + dx];
      case 180: return [x0 + w - dx, y0 + dy];
      case 270: return [x0 + w - dy, y0 + h - dx];
      default: return [x0 + dx, y0 + h - dy];
    }
  };
  return { R, pt };
}

async function rasterText(a) {
  const k = 3;
  const ls = lines(a).map((l) => l.replace(/\t/g, '    '));
  const font = `${a.bold ? 'bold ' : ''}${a.size * k}px ${FONT_CSS[a.font] || FONT_CSS.Helvetica}`;
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const w = Math.max(1, Math.ceil(Math.max(...ls.map((l) => m.measureText(l).width)) + 4));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = Math.ceil(ls.length * a.size * LEADING * k);
  const ctx = c.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = a.color;
  ctx.textBaseline = 'alphabetic';
  ls.forEach((l, i) => ctx.fillText(l, 0, (BASELINE + i * LEADING) * a.size * k));
  return { bytes: dataUrlBytes(c.toDataURL('image/png')), w: c.width / k, h: c.height / k };
}

async function buildPdf() {
  const out = await PDFDocument.create();
  const fontCache = new Map();
  const getFont = async (family, bold) => {
    const key = family + bold;
    if (!fontCache.has(key)) fontCache.set(key, await out.embedFont(StandardFonts[STD_FONT[family || 'Helvetica'][bold ? 1 : 0]]));
    return fontCache.get(key);
  };
  const imgCache = new Map();
  const getImage = async (id) => {
    if (!imgCache.has(id)) {
      const im = S.images.get(id);
      const bytes = dataUrlBytes(im.dataUrl);
      imgCache.set(id, im.mime === 'image/jpeg' ? await out.embedJpg(bytes) : await out.embedPng(bytes));
    }
    return imgCache.get(id);
  };

  // copy each needed source page in one batch per source to preserve shared resources
  const srcDocs = new Map();
  const pool = new Map(); // "src:idx" -> copied pages not yet used
  for (let si = 0; si < S.sources.length; si++) {
    const idxs = [...new Set(S.pages.filter((p) => p.src === si && !p.blank).map((p) => p.idx))];
    if (!idxs.length) continue;
    const sd = await PDFDocument.load(S.sources[si].bytes, { updateMetadata: false });
    srcDocs.set(si, sd);
    const copies = await out.copyPages(sd, idxs);
    idxs.forEach((idx, k) => pool.set(`${si}:${idx}`, [copies[k]]));
  }

  for (const p of S.pages) {
    let page;
    if (p.blank) page = out.addPage([p.w, p.h]);
    else {
      const slot = pool.get(`${p.src}:${p.idx}`);
      const copy = slot.length ? slot.pop() : (await out.copyPages(srcDocs.get(p.src), [p.idx]))[0];
      page = out.addPage(copy);
    }
    const m = makeMap(page);
    for (const a of p.annots) await drawAnnot(page, m, a, getFont, getImage);
    page.setRotation(degrees((m.R + p.rot) % 360));
  }
  return out.save();
}

async function drawAnnot(page, m, a, getFont, getImage) {
  const rot = degrees(m.R);
  const rectBL = (x, y, h) => m.pt(x, y + h); // user-space origin for a display-space rect
  switch (a.type) {
    case 'text': {
      const text = String(a.text).replace(/\r/g, '').replace(/\t/g, '    ');
      const font = await getFont(a.font, a.bold);
      let encodable = true;
      try { font.encodeText(text.replace(/\n/g, '')); } catch { encodable = false; }
      if (encodable) {
        text.split('\n').forEach((ln, i) => {
          if (!ln) return;
          const [x, y] = m.pt(a.x, a.y + a.size * BASELINE + i * a.size * LEADING);
          page.drawText(ln, { x, y, size: a.size, font, color: hexRgb(a.color), rotate: rot });
        });
      } else {
        // characters outside the standard fonts' range (e.g. Ethiopic, CJK): embed as an image
        const r = await rasterText({ ...a, text });
        const img = await page.doc.embedPng(r.bytes);
        const [x, y] = rectBL(a.x, a.y, r.h);
        page.drawImage(img, { x, y, width: r.w, height: r.h, rotate: rot });
      }
      break;
    }
    case 'highlight': {
      const [x, y] = rectBL(a.x, a.y, a.h);
      page.drawRectangle({ x, y, width: a.w, height: a.h, color: hexRgb(a.color), rotate: rot, blendMode: BlendMode.Multiply });
      break;
    }
    case 'whiteout': {
      const [x, y] = rectBL(a.x, a.y, a.h);
      page.drawRectangle({ x, y, width: a.w, height: a.h, color: hexRgb(a.color), rotate: rot });
      break;
    }
    case 'rect': {
      const [x, y] = rectBL(a.x, a.y, a.h);
      page.drawRectangle({ x, y, width: a.w, height: a.h, borderColor: hexRgb(a.color), borderWidth: a.width, rotate: rot });
      break;
    }
    case 'ellipse': {
      const [x, y] = m.pt(a.x + a.w / 2, a.y + a.h / 2);
      page.drawEllipse({ x, y, xScale: a.w / 2, yScale: a.h / 2, borderColor: hexRgb(a.color), borderWidth: a.width, rotate: rot });
      break;
    }
    case 'line': {
      const [x1, y1] = m.pt(a.x1, a.y1);
      const [x2, y2] = m.pt(a.x2, a.y2);
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.width, color: hexRgb(a.color), lineCap: LineCapStyle.Round });
      break;
    }
    case 'ink': {
      const pts = a.points.map(([x, y]) => m.pt(x, y));
      for (let i = 1; i < pts.length; i++)
        page.drawLine({
          start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] },
          thickness: a.width, color: hexRgb(a.color), lineCap: LineCapStyle.Round,
        });
      break;
    }
    case 'image': {
      const img = await getImage(a.img);
      const [x, y] = rectBL(a.x, a.y, a.h);
      page.drawImage(img, { x, y, width: a.w, height: a.h, rotate: rot });
      break;
    }
  }
}

async function savePdf() {
  if (!S.pages.length) return;
  finishEdit();
  busy('Building your PDF…');
  await nextFrame();
  try {
    const bytes = await buildPdf();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${S.fileName}-edited.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    S.dirty = false;
    toast('PDF downloaded.');
  } catch (err) {
    console.error(err);
    toast('Could not build the PDF: ' + (err?.message || err), true);
  } finally {
    busy('');
  }
}

/* ---------------------------------------------------------------- wiring */

function deleteSelected() {
  const a = selAnnot();
  if (!a) return false;
  const p = pageById(S.sel.pid);
  pushUndo();
  p.annots = p.annots.filter((x) => x !== a);
  S.sel = null;
  renderAnnots(p);
  syncProps();
  return true;
}
function nudgeSelected(dx, dy) {
  const a = selAnnot();
  if (!a) return;
  pushUndo();
  if (a.type === 'line') { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; }
  else if (a.type === 'ink') a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
  else { a.x += dx; a.y += dy; }
  renderAnnots(pageById(S.sel.pid));
}

function initKeys(signature) {
  const HOTKEYS = { v: 'select', t: 'text', e: 'edit', h: 'highlight', d: 'draw', r: 'rect', o: 'ellipse', l: 'line', w: 'whiteout' };
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target.matches?.('input[type=number],input[type=text],textarea,select');
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); savePdf(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileOpen').click(); return; }
    if (typing || !S.pages.length) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (deleteSelected()) e.preventDefault(); return; }
    if (e.key === 'Escape') { S.pendingImage = null; if (S.tool !== 'select') setTool('select'); else select(null); return; }
    if (e.key.startsWith('Arrow') && selAnnot()) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      nudgeSelected(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
      return;
    }
    const k = e.key.toLowerCase();
    if (HOTKEYS[k]) setTool(HOTKEYS[k]);
    else if (k === 'i') $('#fileImg').click();
    else if (k === 's') signature.open();
  });
}

function init() {
  const signature = initSignature();
  initThumbEvents();
  initPointer();
  initProps();
  initKeys(signature);

  $('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileOpen').click();
  $('#btnNew').onclick = newBlankDocument;
  $('#btnAdd').onclick = () => $('#fileAdd').click();
  $('#btnBlank').onclick = insertBlank;
  $('#btnSave').onclick = savePdf;
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#zIn').onclick = () => setZoom(S.zoom * 1.2);
  $('#zOut').onclick = () => setZoom(S.zoom / 1.2);
  $('#zFit').onclick = fitWidth;
  $('#fileOpen').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openPdf(f); };
  $('#fileAdd').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addPdfs(f); };
  $('#fileImg').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) chooseImage(f); };
  $('#tools').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]')?.dataset.tool;
    if (!t) return;
    if (t === 'image') $('#fileImg').click();
    else if (t === 'signature') signature.open();
    else setTool(t);
  });
  $('#viewer').addEventListener('scroll', () => {
    cancelAnimationFrame(init.raf);
    init.raf = requestAnimationFrame(onViewerScroll);
  });
  $('#viewer').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // drag & drop a PDF anywhere
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; document.body.classList.add('dragover'); } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragover'); } });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    depth = 0;
    document.body.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const pdfs = files.filter(isPdf);
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (pdfs.length) (S.pages.length && pdfs.length === 1 && !confirm('Open this PDF as a new document?\n(Cancel adds its pages to the current one.)') ? addPdfs(pdfs) : openPdf(pdfs[0]));
    else if (imgs.length && S.pages.length) chooseImage(imgs[0]);
  });

  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('resize', () => { if (S.sel) renderAnnots(pageById(S.sel.pid)); });

  syncProps();
  updateHistoryButtons();
  // test/automation hook: lets tests inspect state without touching the UI
  window.__editor = { S, buildPdf, openPdf };
}

init();
