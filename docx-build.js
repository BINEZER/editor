// Builds a .docx from the layout produced by layout.js, using the `docx` library (MIT).
// The library is injected so this module works both in the browser (window.docx) and in Node tests.

const tw = (pt) => Math.round(pt * 20); // points -> twips
const emu = (pt) => Math.round(pt * 12700);
const px = (pt) => Math.max(1, Math.round(pt * (96 / 72)));

const FONT_MAP = [
  [/arial|helvetica|liberation ?sans|nimbus ?sans/i, 'Arial'],
  [/times|liberation ?serif|nimbus ?roman/i, 'Times New Roman'],
  [/courier|liberation ?mono|consolas|mono/i, 'Courier New'],
];
export function wordFont(name, text = '') {
  if (/[ሀ-፿]/.test(text)) return 'Nyala';
  const n = String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/[-,].*$/, '').replace(/(PS|MT)$/g, '');
  for (const [re, out] of FONT_MAP) if (re.test(n)) return out;
  const spaced = n.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced && !/^g_d\d/.test(n) && !/^(sans-serif|serif|monospace)$/i.test(spaced) ? spaced : 'Arial';
}

export function buildDocx(D, analysis) {
  const {
    Document, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, Tab, HeadingLevel, AlignmentType, TabStopType,
    WidthType, BorderStyle, ShadingType, TableLayoutType, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
    TextWrappingType, TextWrappingSide, LineRuleType, LevelFormat,
  } = D;
  const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders = { top: NONE, bottom: NONE, left: NONE, right: NONE };
  const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, both: AlignmentType.JUSTIFIED };
  const HEAD = [null, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

  const runsOf = (runs) =>
    runs.flatMap((r) => {
      if (r.key === 'tab') return [new TextRun({ children: [new Tab()] })];
      return [
        new TextRun({
          text: r.text,
          bold: r.bold || undefined,
          italics: r.italic || undefined,
          size: Math.max(2, Math.round(r.size * 2)),
          font: wordFont(r.font, r.text),
          color: (r.color || '000000').replace('#', ''),
        }),
      ];
    });

  const paragraph = (b, opts = {}) => {
    const spacing = { before: tw(opts.noBefore ? 0 : b.before || 0), after: tw(b.after || 0) };
    if (b.lineRatio && Math.abs(b.lineRatio - 1) > 0.05) { spacing.line = Math.round(b.lineRatio * 240); spacing.lineRule = LineRuleType.AUTO; }
    const p = {
      children: runsOf(b.runs),
      alignment: ALIGN[b.align] || AlignmentType.LEFT,
      spacing,
    };
    if (b.heading) p.heading = HEAD[b.heading];
    const indent = {};
    if (b.left > 1) indent.left = tw(b.left);
    if (b.hanging) indent.hanging = tw(b.hanging);
    else if (b.first > 1) indent.firstLine = tw(b.first);
    else if (b.first < -1) indent.hanging = tw(-b.first);
    if (Object.keys(indent).length) p.indent = indent;
    if (b.tabs) p.tabStops = b.tabs.map((x) => ({ type: TabStopType.LEFT, position: tw(x) }));
    if (b.bullet) p.numbering = { reference: 'bullets', level: 0 };
    return new Paragraph(p);
  };

  const imageRun = (b, floating) => {
    const o = { data: b.data, transformation: { width: px(b.w), height: px(b.h) } };
    if (floating) {
      o.floating = {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(b.x) },
        verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(b.y) },
        wrap: { type: TextWrappingType.SQUARE, side: TextWrappingSide.BOTH_SIDES },
        allowOverlap: true,
      };
    }
    return new ImageRun(o);
  };

  const blocksToDocx = (blocks, page, inCell = false) => {
    const out = [];
    blocks.forEach((b, i) => {
      if (b.type === 'p') out.push(paragraph(b, { noBefore: inCell && i === 0 }));
      else if (b.type === 'spacer') out.push(new Paragraph({ children: [], spacing: { before: 0, after: 0, line: Math.max(20, tw(b.height)), lineRule: LineRuleType.EXACT } }));
      else if (b.type === 'image') {
        const contentW = page.w - page.margins.left - page.margins.right;
        if (b.floating) {
          out.push(new Paragraph({ children: [imageRun(b, true)], spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT } }));
        } else {
          const k = Math.min(1, contentW / b.w, (page.h - page.margins.top - page.margins.bottom - 4) / b.h);
          const bb = { ...b, w: b.w * k, h: b.h * k };
          const centered = Math.abs(b.x + b.w / 2 - page.w / 2) < 0.05 * page.w;
          out.push(
            new Paragraph({
              children: [imageRun(bb, false)],
              alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
              indent: !centered && b.x - page.margins.left > 1 ? { left: tw(b.x - page.margins.left) } : undefined,
              spacing: { before: 0, after: 0 },
            })
          );
        }
      } else if (b.type === 'table') {
        out.push(table(b, page));
      } else if (b.type === 'columns') {
        out.push(columns(b, page));
      }
    });
    return out;
  };

  const cell = (children, widthPt, o = {}) =>
    new TableCell({
      children: children.length ? children : [new Paragraph({ children: [] })],
      width: { size: tw(widthPt), type: WidthType.DXA },
      borders: o.bordered ? undefined : noBorders,
      margins: o.bordered ? { top: 30, bottom: 30, left: 70, right: 70 } : { top: 0, bottom: 0, left: 40, right: 40 },
      shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    });

  const lineOf = (b, on) => (on ? { style: BorderStyle.SINGLE, size: b.size, color: b.color } : NONE);
  const tableOpts = (b, page, widths) => ({
    width: { size: tw(widths.reduce((a, c) => a + c, 0)), type: WidthType.DXA },
    columnWidths: widths.map(tw),
    layout: TableLayoutType.FIXED,
    borders: b.borders
      ? {
          top: lineOf(b.borders, b.borders.horizontal), bottom: lineOf(b.borders, b.borders.horizontal),
          left: lineOf(b.borders, b.borders.vertical), right: lineOf(b.borders, b.borders.vertical),
          insideHorizontal: lineOf(b.borders, b.borders.horizontal), insideVertical: lineOf(b.borders, b.borders.vertical),
        }
      : { ...noBorders, insideHorizontal: NONE, insideVertical: NONE },
    indent: b.left - page.margins.left > 1 ? { size: tw(b.left - page.margins.left), type: WidthType.DXA } : undefined,
  });

  const table = (b, page) =>
    new Table({
      ...tableOpts(b, page, b.cols),
      rows: b.rows.map(
        (r) =>
          new TableRow({
            cantSplit: true,
            children: r.map((c, ci) =>
              cell(
                c.runs.length
                  ? [new Paragraph({ children: runsOf(c.runs), alignment: ALIGN[c.align] || AlignmentType.LEFT, spacing: { before: 0, after: tw(c.after || 0) } })]
                  : [],
                b.cols[ci],
                { bordered: !!b.borders, fill: c.fill }
              )
            ),
          })
      ),
    });

  const columns = (b, page) =>
    new Table({
      ...tableOpts(b, page, b.cols.map((c) => c.width)),
      rows: [
        new TableRow({
          children: b.cols.map((c) => cell(blocksToDocx(c.blocks, page, true), c.width)),
        }),
      ],
    });

  const sections = analysis.pages.map((pg) => {
    const children = blocksToDocx(pg.blocks, pg);
    if (!children.length) children.push(new Paragraph({ children: [] }));
    return {
      properties: {
        page: {
          size: { width: tw(pg.w), height: tw(pg.h) },
          margin: { top: tw(pg.margins.top), right: tw(pg.margins.right), bottom: tw(pg.margins.bottom), left: tw(pg.margins.left), header: 0, footer: 0 },
        },
      },
      children,
    };
  });

  return new D.Document({
    creator: 'PDF Editor',
    title: analysis.title || 'Converted document',
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
        },
      ],
    },
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections,
  });
}
