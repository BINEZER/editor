// Layout analysis for PDF -> DOCX. Pure functions (no DOM), so it can be unit-tested in Node.
//
// Input, per page (coordinates in points, y grows downwards, y = text BASELINE):
//   { w, h, items: [{ str, x, y, size, w, font, bold, italic, color }],
//     images: [{ x, y, w, h, data }], pageImage?: { data }, scanned?: bool }
// Output, per page: { w, h, margins, blocks }, where blocks are
//   { type:'p', runs, align, left, first, hanging, before, lineRatio, heading, bullet, tabs, y0, y1 }
//   { type:'table', cols:[widthPt], rows:[[{ runs, align }]], left, y0, y1 }
//   { type:'columns', cols:[{ width, blocks }], left, y0, y1 }
//   { type:'image', ... }

const ASC = 0.78; // glyph ascent / descent as a fraction of font size (for boxes)
const DESC = 0.22;
const LINE_HEIGHT = 1.15; // Word's single line spacing for typical fonts, in em
const FINE = 0.9; // gap (in em) that splits a line into segments when looking for gutters
const COARSE = 1.8; // gap (in em) that splits a line into separate columns of a text row

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const isEthiopic = (s) => /[ሀ-፿]/.test(s);

/** The most common font size by character count. */
export function bodySizeOf(pages) {
  const hist = new Map();
  for (const p of pages) for (const it of p.items) {
    const k = Math.round(it.size * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + it.str.length);
  }
  let best = 11, n = 0;
  for (const [k, v] of hist) if (v > n) { best = k; n = v; }
  return best;
}

function cleanItems(items) {
  const out = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    // faux-bold text is often drawn twice at (almost) the same spot
    if (out.some((o) => o.str === it.str && Math.abs(o.x - it.x) < 1.2 && Math.abs(o.y - it.y) < 1.2)) continue;
    out.push(it);
  }
  return out;
}

const styleKey = (it) => [it.font, it.bold ? 1 : 0, it.italic ? 1 : 0, Math.round(it.size * 2) / 2, it.color || ''].join('|');

function makeRuns(items) {
  const runs = [];
  let prev = null;
  for (const it of items) {
    let text = it.str;
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      const needSpace = gap > 0.12 * Math.max(it.size, prev.size) && !/\s$/.test(prev.str) && !/^\s/.test(text);
      if (needSpace) text = ' ' + text;
    }
    const key = styleKey(it);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.text += text;
    else runs.push({ key, text, font: it.font, bold: !!it.bold, italic: !!it.italic, size: it.size, color: it.color });
    prev = it;
  }
  return runs;
}

/** Group items into baseline-aligned lines, then split each line into segments at wide gaps. */
function buildSegments(items, gapMul = COARSE, minGap = 10) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    let L = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) {
      const l = lines[i];
      if (Math.abs(l.y - it.y) <= 0.4 * Math.max(it.size, l.size)) { L = l; break; }
    }
    if (!L) { L = { y: it.y, size: it.size, items: [] }; lines.push(L); }
    L.items.push(it);
    if (it.size > L.size) { L.size = it.size; L.y = it.y; }
  }
  const segs = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const chars = cur.items.reduce((n, i) => n + i.str.length, 0);
      const sizeByChars = new Map();
      cur.items.forEach((i) => sizeByChars.set(i.size, (sizeByChars.get(i.size) || 0) + i.str.length));
      let size = L.size, best = 0;
      for (const [s, c] of sizeByChars) if (c > best) { best = c; size = s; }
      cur.runs = makeRuns(cur.items);
      cur.text = cur.runs.map((r) => r.text).join('');
      cur.chars = chars;
      cur.size = size;
      cur.y = L.y;
      cur.top = L.y - ASC * size;
      cur.bottom = L.y + DESC * size;
      cur.bold = cur.items.every((i) => i.bold);
      segs.push(cur);
      cur = null;
    };
    for (const it of L.items) {
      const gap = cur ? it.x - cur.x1 : 0;
      // a list marker stays attached to the text that follows it, however far the indent is
      const markerOnly = cur && cur.items.length === 1 && MARKER.test(cur.items[0].str.trim()) && gap <= 4 * L.size;
      if (cur && gap > Math.max(gapMul * L.size, minGap) && !markerOnly) flush();
      if (!cur) cur = { items: [], x0: it.x, x1: it.x + it.w };
      cur.items.push(it);
      cur.x1 = Math.max(cur.x1, it.x + it.w);
    }
    flush();
  }
  return segs;
}

/* ------------------------------------------------------------------ XY-cut: columns and tables */

function verticalGaps(segs, minGap) {
  const iv = segs.map((s) => [s.x0, s.x1]).sort((a, b) => a[0] - b[0]);
  const cuts = [];
  let reach = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] - reach >= minGap) cuts.push((iv[i][0] + reach) / 2);
    reach = Math.max(reach, iv[i][1]);
  }
  return cuts;
}

const MARKER = /^(?:[•◦▪▫●○■□‣⁃·*\-–—]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])$/;

/**
 * Split a set of (fine) segments into an ordered list of nodes:
 *   { kind:'flow', segs } | { kind:'split', columns:[segs[]] }
 * Lines are first grouped by vertical gaps; then runs of consecutive groups that share a vertical
 * gutter (empty strip of page running through all of their lines) become columns or a table.
 */
function xyCut(segs, ctx) {
  if (!segs.length) return [];
  const sorted = [...segs].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const groups = [];
  let cur = [sorted[0]];
  let maxBottom = sorted[0].bottom;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].top - maxBottom >= ctx.hGap) { groups.push(cur); cur = []; }
    cur.push(sorted[i]);
    maxBottom = Math.max(maxBottom, sorted[i].bottom);
  }
  groups.push(cur);

  const nodes = [];
  const pushFlow = (s) => {
    const last = nodes[nodes.length - 1];
    if (last && last.kind === 'flow') last.segs.push(...s);
    else nodes.push({ kind: 'flow', segs: [...s] });
  };
  const split = (all, cuts) => {
    const cols = Array.from({ length: cuts.length + 1 }, () => []);
    for (const s of all) {
      let c = 0;
      while (c < cuts.length && (s.x0 + s.x1) / 2 > cuts[c]) c++;
      cols[c].push(s);
    }
    return cols.filter((c) => c.length);
  };
  // Walk forward from group `i` while the same vertical gutters keep running through every line.
  const scanRun = (i, build, gutter, accept) => {
    let acc = [];
    let best = null;
    let k = 0;
    for (let j = i; j < groups.length; j++) {
      acc = acc.concat(groups[j]);
      const segs = build(acc);
      const cuts = verticalGaps(segs, gutter);
      if (!cuts.length || (best && cuts.length < k)) break; // columns changed: the run is over
      const cols = split(segs, cuts);
      if (accept(segs, cols)) { best = { j, cols }; k = cuts.length; }
    }
    return best;
  };
  const rowCount = (segs) => new Set(segs.map((s) => Math.round(s.y / 3))).size;
  const strictOk = (segs, cols) =>
    rowCount(segs) >= 2 && cols.length >= 2 && cols.every((c) => c.length >= 2) &&
    // a column that only holds list markers is a hanging indent, not a real column
    !cols.some((c) => c.every((s) => MARKER.test(s.text.trim())));
  // Tables often have narrow gutters (cell padding). Accept those only for table-looking runs:
  // 3+ rows, short cells, and most rows spread over several columns.
  const tightBuild = (acc) => buildSegments(acc.flatMap((s) => s.items), 0.45, 3.5);
  const tightOk = (segs, cols) => {
    if (rowCount(segs) < 3 || cols.length < 2 || !cols.every((c) => c.length >= 3)) return false;
    if (cols.some((c) => c.every((s) => MARKER.test(s.text.trim())))) return false;
    if (median(segs.map((s) => s.chars)) > 28) return false;
    const rows = clusterRows(cols);
    return rows.filter((r) => new Set(r.cells.map((c) => c.ci)).size > 1).length / rows.length >= 0.7;
  };
  let i = 0;
  while (i < groups.length) {
    let best = scanRun(i, (a) => a, ctx.gutter, strictOk);
    if (tightBuild(groups[i]).length >= 2) {
      // keep whichever reading covers more lines (a loose reading can stop one row short), then more columns
      const tight = scanRun(i, tightBuild, 3.5, tightOk);
      if (tight && (!best || tight.j > best.j || (tight.j === best.j && tight.cols.length > best.cols.length))) best = tight;
    }
    if (best) { nodes.push({ kind: 'split', columns: best.cols }); i = best.j + 1; }
    else { pushFlow(groups[i]); i++; }
  }
  return nodes;
}

/** Cluster the baselines of several columns into shared rows. */
function clusterRows(columns) {
  const all = columns.flatMap((c, ci) => c.map((s) => ({ s, ci })));
  all.sort((a, b) => a.s.y - b.s.y);
  const rows = [];
  for (const e of all) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(e.s.y - row.y) <= 0.45 * Math.max(e.s.size, row.size)) {
      row.cells.push(e);
      row.size = Math.max(row.size, e.s.size);
    } else rows.push({ y: e.s.y, size: e.s.size, cells: [e] });
  }
  return rows;
}

function classifySplit(columns) {
  const rows = clusterRows(columns);
  const total = columns.reduce((n, c) => n + c.length, 0);
  // fraction of segments that share their row with a segment of another column
  const shared = rows.filter((r) => new Set(r.cells.map((c) => c.ci)).size > 1).reduce((n, r) => n + r.cells.length, 0);
  const align = shared / total;
  const avgChars = columns.flat().reduce((n, s) => n + s.chars, 0) / total;
  const pitches = [];
  for (const c of columns) {
    const ys = c.map((s) => s.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) pitches.push(ys[i] - ys[i - 1]);
  }
  const mp = median(pitches);
  const uniform = pitches.length > 3 && pitches.filter((p) => Math.abs(p - mp) < 0.12 * mp).length / pitches.length > 0.8;
  const prose = avgChars >= 40 || (avgChars >= 28 && uniform && rows.length >= 6);
  if (prose) return 'columns';
  // ragged columns (little row alignment) read best as separate flowing columns
  return align >= 0.6 ? 'table' : 'columns';
}

/* ------------------------------------------------------------------ paragraphs */

const BULLET = /^([•◦▪▫●○■□‣⁃·*]|[-–—](?=\s))\s*/;
const NUMBERED = /^(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]{1,5}[.)])\s+/;

function listKind(text) {
  if (BULLET.test(text)) return 'bullet';
  if (NUMBERED.test(text)) return 'number';
  return null;
}
function stripBullet(runs) {
  const out = runs.map((r) => ({ ...r }));
  const m = BULLET.exec(out[0].text);
  if (m) out[0].text = out[0].text.slice(m[0].length);
  if (!out[0].text && out.length > 1) out.shift();
  return out;
}

function groupLines(segs) {
  const sorted = [...segs].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  for (const s of sorted) {
    const l = lines[lines.length - 1];
    if (l && Math.abs(l.y - s.y) <= 0.4 * Math.max(l.size, s.size)) {
      l.segs.push(s);
      if (s.size > l.size) { l.size = s.size; l.y = s.y; }
    } else lines.push({ y: s.y, size: s.size, segs: [s] });
  }
  for (const l of lines) {
    l.segs.sort((a, b) => a.x0 - b.x0);
    l.x0 = l.segs[0].x0;
    l.x1 = Math.max(...l.segs.map((s) => s.x1));
    l.top = Math.min(...l.segs.map((s) => s.top));
    l.bottom = Math.max(...l.segs.map((s) => s.bottom));
    l.bold = l.segs.every((s) => s.bold);
  }
  return lines;
}

function headingLevel(size, body) {
  const r = size / body;
  return r >= 1.8 ? 1 : r >= 1.4 ? 2 : r >= 1.15 ? 3 : 0;
}

/** Turn a flow of segments (one column of reading order) into paragraph blocks. */
function buildParagraphs(segs, ctx, bounds) {
  const lines = groupLines(segs);
  const rl = bounds?.left ?? Math.min(...lines.map((l) => l.x0));
  const rr = bounds?.right ?? Math.max(...lines.map((l) => l.x1));
  const paras = [];
  let cur = null;

  const finish = () => { if (cur) { paras.push(cur); cur = null; } };
  for (const line of lines) {
    if (line.segs.length >= 2) {
      // a row with several columns of text: keep positions with tab stops
      finish();
      const runs = [];
      line.segs.forEach((s, i) => {
        if (i) runs.push({ ...s.runs[0], text: '\t', key: 'tab' });
        runs.push(...s.runs);
      });
      paras.push({
        type: 'p', runs, tabs: line.segs.slice(1).map((s) => s.x0), left: line.x0,
        lines: [line], size: line.size, y0: line.top, y1: line.bottom, firstBase: line.y, lastBase: line.y, x0: line.x0, x1: line.x1,
      });
      continue;
    }
    const seg = line.segs[0];
    const kind = listKind(seg.text);
    const heading = headingLevel(line.size, ctx.body);
    let join = false;
    if (cur && !cur.tabs && !kind) {
      const pitch = line.y - cur.lastBase;
      const maxSize = Math.max(cur.size, line.size);
      const sizeOk = line.size / cur.size > 0.85 && line.size / cur.size < 1.18;
      const pitchOk = pitch > 0.8 * maxSize && pitch < 1.75 * maxSize && (cur.lines.length < 2 || pitch < 1.35 * cur.pitch);
      const leftOk = Math.abs(line.x0 - cur.bodyX) <= 0.6 * line.size ||
        (cur.lines.length === 1 && cur.x0 - line.x0 > 0 && cur.x0 - line.x0 <= 3 * line.size) || // first-line indent
        (cur.list && line.x0 >= cur.x0 - 2 && line.x0 <= cur.x0 + 3 * line.size) ||
        (Math.abs((line.x0 + line.x1) / 2 - cur.center) <= 0.5 * line.size && cur.centered);
      const headingOk = !!heading === !!cur.heading;
      join = sizeOk && pitchOk && leftOk && headingOk;
    }
    if (join) {
      const prevLast = cur.runs[cur.runs.length - 1];
      const dehyph = /[A-Za-zÀ-ɏ]-$/.test(prevLast.text) && /^[a-zß-ÿ]/.test(seg.runs[0].text);
      if (dehyph) prevLast.text = prevLast.text.slice(0, -1);
      else if (!/\s$/.test(prevLast.text)) prevLast.text += ' ';
      cur.runs.push(...seg.runs);
      cur.lines.push(line);
      cur.pitch = line.y - cur.lastBase;
      cur.lastBase = line.y;
      cur.y1 = line.bottom;
      cur.x1 = Math.max(cur.x1, line.x1);
      if (cur.lines.length === 2) cur.bodyX = line.x0;
    } else {
      finish();
      cur = {
        type: 'p', runs: kind === 'bullet' && !heading ? stripBullet(seg.runs) : seg.runs.map((r) => ({ ...r })),
        lines: [line], size: line.size, y0: line.top, y1: line.bottom, firstBase: line.y, lastBase: line.y,
        x0: line.x0, x1: line.x1, bodyX: line.x0, heading, list: heading ? null : kind,
        centered: false, center: (line.x0 + line.x1) / 2,
      };
    }
  }
  finish();

  // alignment, indents, spacing
  const width = rr - rl;
  let prev = null;
  for (const p of paras) {
    if (p.tabs) { p.left = p.left - rl; p.tabs = p.tabs.map((x) => x - rl); p.align = 'left'; p.heading = 0; }
    else {
      const mid = (p.x0 + p.x1) / 2;
      const single = p.lines.length === 1;
      const midOk = Math.abs(mid - (rl + rr) / 2) < 0.03 * width + 2 || (bounds?.pageMid != null && Math.abs(mid - bounds.pageMid) < 0.03 * width + 2);
      let align = 'left';
      if (midOk && p.x0 - rl > 0.08 * width && rr - p.x1 > 0.08 * width) align = 'center';
      else if (single && rr - p.x1 < 3 && p.x0 - rl > 0.25 * width) align = 'right';
      else if (p.lines.length >= 3) {
        const body = p.lines.slice(0, -1);
        const maxR = Math.max(...body.map((l) => l.x1));
        if (body.every((l) => maxR - l.x1 < 2.5) && body.every((l) => Math.abs(l.x0 - p.lines[1].x0) < 2.5)) align = 'both';
      }
      p.align = align;
      p.left = Math.max(0, p.bodyX - rl);
      p.first = p.lines.length > 1 ? p.x0 - p.bodyX : 0;
      if (p.list) { p.hanging = 18; p.left = Math.max(0, p.x0 - rl) + 18; p.first = -18; }
      if (align === 'center' || align === 'right') { p.left = 0; p.first = 0; }
      p.lineRatio = p.lines.length > 1 ? Math.min(2, Math.max(0.8, (p.pitch / (LINE_HEIGHT * p.size)))) : 1;
      p.bullet = p.list === 'bullet';
    }
    const lh = LINE_HEIGHT * p.size;
    p.before = prev ? Math.max(0, Math.min(72, p.firstBase - prev.lastBase - (prev.lines.length > 1 && prev.pitch ? prev.pitch : lh))) : 0;
    p.lineRatio = p.lineRatio ?? 1;
    p.type = 'p';
    prev = p;
  }
  return paras.map(({ lines, ...rest }) => rest);
}

/* ------------------------------------------------------------------ tables / columns */

function buildTable(columns, ctx) {
  const rows = clusterRows(columns);
  const xs = columns.map((c) => ({ x0: Math.min(...c.map((s) => s.x0)), x1: Math.max(...c.map((s) => s.x1)) }));
  const left = xs[0].x0;
  const widths = xs.map((x, i) => (i + 1 < xs.length ? xs[i + 1].x0 - x.x0 : x.x1 - x.x0 + 6));
  const aligns = columns.map((c) => {
    if (c.length < 2) return 'left';
    const rightFlush = c.every((s) => Math.abs(s.x1 - c[0].x1) < 2);
    const leftFlush = c.every((s) => Math.abs(s.x0 - c[0].x0) < 2);
    return rightFlush && !leftFlush ? 'right' : 'left';
  });
  const out = [];
  rows.forEach((r, ri) => {
    const next = rows[ri + 1];
    const pitch = next ? next.y - r.y : 0;
    const after = next ? Math.max(0, Math.min(36, pitch - LINE_HEIGHT * r.size)) : 0;
    const cells = columns.map((_, ci) => {
      const here = r.cells.filter((c) => c.ci === ci).map((c) => c.s).sort((a, b) => a.x0 - b.x0);
      const runs = here.flatMap((s, i) => (i ? [{ ...s.runs[0], text: ' ', key: 'sp' }, ...s.runs] : s.runs));
      return { runs, align: aligns[ci], after };
    });
    out.push(cells);
  });
  const all = columns.flat();
  const table = {
    type: 'table', cols: widths, rows: out, left,
    y0: Math.min(...all.map((s) => s.top)), y1: Math.max(...all.map((s) => s.bottom)),
  };
  decorateTable(table, rows, columns, ctx);
  return table;
}

const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
const distinct = (vals, tol = 2) => {
  const out = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
};

/** Borders from ruling lines drawn around/inside the table, and cell shading from filled boxes behind cells. */
function decorateTable(table, rows, columns, ctx) {
  const pad = 8;
  const width = table.cols.reduce((a, b) => a + b, 0);
  const bx0 = table.left - pad, bx1 = table.left + width + pad, by0 = table.y0 - pad, by1 = table.y1 + pad;
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const hs = [], vs = [];
  for (const r of ctx.rules || []) {
    const horizontal = r.y1 - r.y0 < 1.6 && r.x1 - r.x0 > 8;
    const vertical = r.x1 - r.x0 < 1.6 && r.y1 - r.y0 > 8;
    if (horizontal && r.y0 >= by0 && r.y0 <= by1 && overlap(r.x0, r.x1, bx0, bx1) >= 0.4 * (bx1 - bx0)) hs.push(r);
    else if (vertical && r.x0 >= bx0 && r.x0 <= bx1 && overlap(r.y0, r.y1, by0, by1) >= 0.4 * (by1 - by0)) vs.push(r);
  }
  const nH = distinct(hs.map((r) => r.y0)).length, nV = distinct(vs.map((r) => r.x0)).length;
  if (nH >= 2 || nV >= 2) {
    const used = [...hs, ...vs];
    const colors = used.map((r) => r.color);
    const mode = colors.sort((a, b) => colors.filter((c) => c === a).length - colors.filter((c) => c === b).length).pop();
    table.borders = {
      horizontal: nH >= 2, vertical: nV >= 2,
      color: (mode || '#000000').replace('#', ''),
      size: Math.max(2, Math.min(24, Math.round(median(used.map((r) => r.w)) * 8))),
    };
  }
  // cell shading: the smallest non-white box that contains the cell's text
  const boxes = (ctx.fills || []).filter((f) => lum(f.color) < 0.97);
  rows.forEach((r, ri) => {
    r.cells.forEach((c) => {
      const cx = (c.s.x0 + c.s.x1) / 2, cy = c.s.y - c.s.size * 0.3;
      let best = null;
      for (const f of boxes) {
        if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h && (!best || f.w * f.h < best.w * best.h)) best = f;
      }
      if (best) {
        const cell = table.rows[ri][c.ci];
        if (cell) cell.fill = best.color.replace('#', '');
      }
    });
  });
}

/** Light text only makes sense on a background we reproduce (table cell shading); elsewhere fall back to black. */
function fixContrast(blocks) {
  const light = (c) => c && lum('#' + c.replace('#', '')) > 0.72;
  const fixRuns = (runs, bg) => {
    for (const r of runs) {
      if (!light(r.color)) continue;
      if (bg && Math.abs(lum('#' + r.color.replace('#', '')) - lum('#' + bg)) > 0.35) continue; // readable on this shading
      r.color = undefined;
    }
  };
  for (const b of blocks) {
    if (b.type === 'p') fixRuns(b.runs, null);
    else if (b.type === 'table') b.rows.forEach((row) => row.forEach((c) => fixRuns(c.runs, c.fill)));
    else if (b.type === 'columns') b.cols.forEach((c) => fixContrast(c.blocks));
  }
}

function buildBlocks(segs, ctx, bounds) {
  const blocks = [];
  for (const node of xyCut(segs, ctx)) {
    if (node.kind === 'flow') {
      const coarse = buildSegments(node.segs.flatMap((s) => s.items), COARSE);
      blocks.push(...buildParagraphs(coarse, ctx, bounds));
      continue;
    }
    const kind = classifySplit(node.columns);
    if (kind === 'table') {
      ctx.stats.tables++;
      blocks.push(buildTable(node.columns, ctx));
    } else {
      ctx.stats.columns++;
      const xs = node.columns.map((c) => ({ x0: Math.min(...c.map((s) => s.x0)), x1: Math.max(...c.map((s) => s.x1)) }));
      const cols = node.columns.map((c, i) => {
        const width = (i + 1 < xs.length ? xs[i + 1].x0 - xs[i].x0 : xs[i].x1 - xs[i].x0 + 6);
        const inner = buildBlocks(c, ctx, { left: xs[i].x0, right: xs[i].x1 });
        return { width, blocks: inner };
      });
      const all = node.columns.flat();
      blocks.push({
        type: 'columns', cols, left: xs[0].x0,
        y0: Math.min(...all.map((s) => s.top)), y1: Math.max(...all.map((s) => s.bottom)),
      });
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ images */

function placeImages(blocks, images, segs, content, stats) {
  const sorted = [...images].sort((a, b) => a.y - b.y);
  for (const im of sorted) {
    // text beside the picture -> let it float, otherwise it sits in the flow
    const beside = segs.some((s) => s.bottom > im.y + 2 && s.top < im.y + im.h - 2 && s.x1 > im.x - 1 && s.x0 < im.x + im.w + 1) ||
      segs.some((s) => s.bottom > im.y + 2 && s.top < im.y + im.h - 2);
    const block = { type: 'image', x: im.x, y: im.y, w: im.w, h: im.h, data: im.data, floating: beside, y0: im.y, y1: im.y + im.h };
    let at = blocks.findIndex((b) => b.y0 >= im.y - 2);
    if (at < 0) at = blocks.length;
    blocks.splice(at, 0, block);
    stats.images++;
  }
}

/* Tables, column layouts and pictures have no 'space before' of their own, so the gap above them
   (and above a paragraph that follows them) is reproduced explicitly. */
function addSpacing(blocks) {
  const out = [];
  let prev = null;
  for (const b of blocks) {
    if (prev) {
      const gap = b.y0 - prev.y1 - 2;
      if (b.type === 'p') { if (prev.type !== 'p') b.before = Math.max(0, Math.min(120, gap)); }
      else if (!(b.type === 'image' && b.floating) && gap > 4) out.push({ type: 'spacer', height: Math.min(gap, 400), y0: prev.y1, y1: b.y0 });
    }
    out.push(b);
    if (!(b.type === 'image' && b.floating)) prev = b;
  }
  blocks.splice(0, blocks.length, ...out);
}

/* ------------------------------------------------------------------ public API */

export function analyze(pages, opts = {}) {
  const prepared = pages.map((p) => ({ ...p, items: cleanItems(p.items) }));
  const body = opts.bodySize || bodySizeOf(prepared);
  const stats = { pages: pages.length, paragraphs: 0, headings: 0, lists: 0, tables: 0, columns: 0, images: 0, scannedNoText: 0, ocrPages: 0, skippedRotated: 0, textItems: 0 };
  const out = [];
  for (const p of prepared) {
    const before = { ...stats };
    const ctx = { body, hGap: Math.max(2, 0.4 * body), gutter: Math.max(10, 0.9 * body), stats, rules: p.rules, fills: p.fills };
    const segs = buildSegments(p.items, FINE);
    stats.textItems += p.items.length;
    if (p.ocr) stats.ocrPages++;
    let images = p.images || [];
    const area = p.w * p.h;
    const full = images.filter((i) => i.w * i.h >= 0.85 * area);
    if (segs.length) images = images.filter((i) => !full.includes(i)); // searchable scan: keep the text only
    else if (full.length && !p.ocr) stats.scannedNoText++;

    const margins = { top: 36, right: 36, bottom: 36, left: 36 };
    if (!segs.length && full.length) Object.assign(margins, { top: 0, right: 0, bottom: 0, left: 0 });
    if (segs.length) {
      const x0 = Math.min(...segs.map((s) => s.x0));
      const x1 = Math.max(...segs.map((s) => s.x1));
      const y0 = Math.min(...segs.map((s) => s.top));
      const y1 = Math.max(...segs.map((s) => s.bottom));
      const clampM = (v, max) => Math.max(18, Math.min(max, v));
      margins.left = clampM(x0, p.w * 0.3);
      margins.right = clampM(p.w - x1, p.w * 0.3);
      margins.top = clampM(y0, p.h * 0.3);
      margins.bottom = clampM(p.h - y1, p.h * 0.3);
    }
    const bounds = { left: margins.left, right: p.w - margins.right, pageMid: p.w / 2 };
    const blocks = segs.length ? buildBlocks(segs, ctx, bounds) : [];
    placeImages(blocks, images, segs, bounds, stats);
    addSpacing(blocks);
    fixContrast(blocks);
    const countP = (list) => list.forEach((b) => {
      if (b.type === 'p') { stats.paragraphs++; if (b.heading) stats.headings++; if (b.list) stats.lists++; }
      else if (b.type === 'columns') b.cols.forEach((c) => countP(c.blocks));
    });
    countP(blocks);
    // blocks inside the page flow are positioned relative to the left margin
    const info = {
      tables: stats.tables - before.tables,
      columns: stats.columns - before.columns,
      scannedNoText: stats.scannedNoText - before.scannedNoText > 0,
      ocr: !!p.ocr,
      empty: !segs.length && !images.length,
    };
    out.push({ w: p.w, h: p.h, margins, blocks, left: margins.left, info });
  }
  return { pages: out, stats, body };
}
