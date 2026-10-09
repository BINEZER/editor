# PDF Editor

A watermark-free PDF editor that runs entirely in the browser. Files never leave your device.

## Run

```
npm start        # node server.js, then open http://localhost:8080
```

It is a static app with no build step. Any static file server works, but it must be served over
http(s), because pdf.js loads its worker as an ES module. Opening `index.html` from `file://` won't work.

## Features

- Open, view, zoom, and fit to width. Pages render lazily.
- Page thumbnails: drag to reorder, rotate, duplicate, delete. Insert blank pages and merge more PDFs.
- Add text (font, size, colour, bold, multi-line) and edit existing text (click a text run).
- Highlight, freehand draw, rectangle, ellipse, line, whiteout box.
- Insert images and a drawn signature (saved locally for reuse).
- Select, move, resize, and delete annotations. Nudge with arrow keys. Unlimited undo and redo.
- Download a flattened PDF. Page rotation, crop boxes and rotated source pages are handled.
- Keyboard: V T E H D R O L W for tools, I image, S signature, Ctrl+Z / Ctrl+Shift+Z, Ctrl+S, Delete.

## Known limits

- **Edit text covers the old text; it does not delete it.** The original text stays in the PDF
  underneath the cover box and can still be selected or extracted. Do not use Whiteout or Edit text to
  hide sensitive information. Real redaction is planned (see `SPEC.md`).
- Edit text works one text run at a time, on upright text only. Scanned pages have no text to edit (OCR is planned).
- Text uses the standard PDF fonts (Helvetica, Times, Courier). Characters outside their range, such as
  Ethiopic or CJK, are embedded as an image so they still appear, but they are not selectable.
- Password-protected PDFs are not supported yet.

## Tests

```
npm test         # node test/e2e.js
```

Drives the real UI in headless Chromium (Playwright), exports a PDF, then re-opens the export to verify
the content. It also checks the coordinate mapping for all 16 combinations of source and user page
rotation by rendering the export and testing pixels.

## Third-party code

pdf.js (Apache-2.0, `vendor/PDFJS-LICENSE`) and pdf-lib (MIT), vendored in `vendor/`.
See `SPEC.md` for the product roadmap.
