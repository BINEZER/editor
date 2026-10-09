# Build Specification: Watermark-Free PDF & Document Editor

Platform: web app (installable PWA). Build method: AI app builder driving a git repo. Processing: local-first in the browser, with an optional online worker for heavy jobs. Target cost: $0 fixed, with every paid upgrade optional.

Status of the repo: Stage 1 (core editor), Stage 3 (OCR: English and Amharic, searchable-PDF output, editing of scanned lines, text download, confidence view) and Stage 4 (local PDF-to-DOCX: paragraphs, headings, lists, tables, column layouts, pictures, OCR input, fidelity report, round-trip test) are built and covered by `npm test`. Not yet built: deskew (O3), per-page retry, online OCR worker (O6), page backgrounds and vector shapes in Word export, DOCX-to-PDF (F3), and Stage 2 items (image conversion, print-ready options).

---

## 1. Product principles

1. **No watermark, ever.** No watermark, no "trial" stamp, no export gating, and no hidden branding in any output file. Free tier and paid tier produce identical output. The test suite enforces this (section 11).
2. **Local by default.** Files are processed in the browser. Nothing is uploaded unless the user explicitly picks an online job, and each such job states what it uploads.
3. **No account needed** for the core features.
4. **Honest about limits.** PDF is not a reflowable format, so some edits and conversions are best-effort. The UI says so instead of silently degrading.

## 2. Feature requirements

Priority: **P0** = launch, **P1** = soon after, **P2** = later.

### 2.1 PDF viewing and page management
| ID | Requirement | Pri |
|---|---|---|
| V1 | Open PDF via picker, drag-drop, or "Open with" (PWA file handler) | P0 |
| V2 | Continuous scroll, zoom 25–400%, fit-width, lazy page rendering | P0 |
| V3 | Thumbnails: reorder (drag), rotate, duplicate, delete, insert blank | P0 |
| V4 | Merge PDFs; split by range; extract pages | P0 |
| V5 | Password-protected PDFs: prompt for password, open, optionally save unlocked | P1 |
| V6 | Search text (pdf.js text layer) | P1 |

### 2.2 Editing existing and adding new content
| ID | Requirement | Pri |
|---|---|---|
| E1 | **Add text**: font family (standard 14 plus user-uploaded TTF/OTF), size, color, bold/italic, multi-line, move/resize | P0 |
| E2 | **Edit existing text, run-level**: click a text run, mask the original with a background-sampled box, and place editable text at the same position and size | P0 |
| E3 | Edit existing text with font matching: if the embedded font is a subset lacking glyphs, fall back to the closest standard or bundled font and warn | P1 |
| E4 | **Add images**: PNG/JPEG/WebP/GIF/SVG, move, resize, rotate, opacity, crop | P0 |
| E5 | **Replace or remove existing images** (select image XObject by hit-test, replace or cover) | P1 |
| E6 | Shapes: rectangle, ellipse, line, arrow, freehand; highlight (multiply blend) | P0 |
| E7 | Signature: draw, type, or upload; saved locally (IndexedDB) | P0 |
| E8 | Fill AcroForm fields; add form fields (text, checkbox) | P1 |
| E9 | **True redaction**: remove underlying content (rasterise the redacted region or strip the content stream), not just cover it | P1 |
| E10 | Links, bookmarks, page numbers, headers/footers, Bates stamping | P2 |
| E11 | Undo/redo (unlimited, snapshot-based), autosave of the working copy to IndexedDB | P0 |

Limit to document in the UI: E2 edits one text run at a time. Full paragraph reflow in an arbitrary PDF is not reliably possible. The PDF-to-DOCX path (F2) is the route for heavy text rewriting.

### 2.3 OCR
| ID | Requirement | Pri |
|---|---|---|
| O1 | OCR scanned pages and images locally with Tesseract.js (WASM). Output: invisible text layer on the PDF (searchable PDF) | P0 |
| O2 | Language packs downloaded on demand, cached in IndexedDB. English first. Add `amh`, `ara`, `fra`, `deu`, `spa` etc. as selectable | P0 |
| O3 | Preprocessing: deskew, grayscale, binarise, DPI normalisation (target 300 DPI) before OCR | P1 |
| O4 | Output also as plain text, DOCX (with layout, see F2), and hOCR/JSON | P1 |
| O5 | Progress, cancel, and per-page retry; run in a Web Worker so the UI stays responsive | P0 |
| O6 | Optional online OCR worker (OCRmyPDF/Tesseract on the server) for large batches | P2 |

Amharic (`amh`) is a Tesseract-supported language. Accuracy on Ge'ez script is lower than on Latin script, so test it with real samples and show a confidence score per page.

### 2.4 Conversion
| ID | Requirement | Pri |
|---|---|---|
| F1 | PDF → images (PNG/JPEG/WebP), per page or ZIP, selectable DPI 72–600, JPEG quality | P0 |
| F2 | **PDF → DOCX**. Local mode: extract text runs, positions, fonts, and images with pdf.js, group them into lines and paragraphs (clustering by baseline and gap), detect columns and simple tables, and emit DOCX with the `docx` library. Scanned input goes through OCR first | P0 (basic), P1 (tables/columns) |
| F3 | DOCX → PDF. Local: `mammoth` → HTML → print (fast, fidelity moderate). Online worker: LibreOffice headless (high fidelity) | P1 |
| F4 | Images → PDF (one or many, page size/margins/orientation options) | P0 |
| F5 | Image ↔ image conversion (PNG/JPEG/WebP/BMP/GIF/SVG→raster) via Canvas, with quality, resize, and EXIF-orientation handling | P0 |
| F6 | HEIC → JPEG/PNG (`heic2any`) | P2 |

Fidelity target for F2 (stated honestly): text-based, single-column documents reproduce closely. Multi-column, forms, and complex tables are best-effort. Scanned documents depend on OCR quality. The converter shows a "fidelity report" (pages with detected tables, unsupported elements, and OCR confidence).

### 2.5 Export, all watermark-free
| ID | Requirement | Pri |
|---|---|---|
| X1 | Export PDF with annotations flattened into page content | P0 |
| X2 | Export as DOCX (via F2), JPEG, PNG (per page or ZIP) | P0 |
| X3 | **Print-ready**: page size presets (A4, Letter, A3, Legal, custom), margins, scale-to-fit or actual size, bleed (3 mm) and crop marks option, grayscale/color, N-up, booklet, and a browser print dialog with correct `@page` CSS | P0 (size/scale/print), P1 (bleed/marks/N-up) |
| X4 | Print-ready raster output at selectable DPI (150/300/600) with embedded DPI metadata (PNG `pHYs`, JPEG JFIF) | P0 |
| X5 | Compress PDF (downsample images, strip metadata, object streams) with preset levels and a preview of the resulting size | P1 |
| X6 | PDF/A-1b export. Embed fonts, add XMP metadata and an output intent. Use the online worker if it cannot be done reliably locally | P2 |
| X7 | Metadata: strip or edit title, author, and producer. Default producer string is the app name, with no promotional text | P0 |

## 3. Architecture

```
Browser (PWA)
├─ UI layer           vanilla JS + Web Components (or Preact); no build step required for Stage 1
├─ Document model     pages[] { source, rotation, annotations[] }, snapshot undo
├─ Render             pdf.js (canvas + text layer) in a worker
├─ Write              pdf-lib (merge, draw, embed, save)
├─ OCR worker         Tesseract.js (WASM), language data cached
├─ Convert workers    docx (MIT) builder, canvas image codecs, JSZip
├─ Storage            IndexedDB (autosave, signatures, fonts, OCR language packs)
└─ Service worker     offline cache of app shell + WASM + vendor files

Optional online worker (opt-in, per job)
└─ Stateless container: LibreOffice headless (DOCX→PDF), OCRmyPDF, Ghostscript-free
   PDF/A path. Files deleted when the job completes; no logs of content.
```

**Hybrid routing rule.** Each job has a local implementation and an optional online implementation. The app picks local unless (a) the file exceeds the local budget (about 150 MB or 300 pages on low-RAM devices) or (b) the user selects "high fidelity (online)". A confirmation dialog lists exactly what will be uploaded and how long it is retained. The default retention is zero: results are streamed back and deleted.

**Why this split.** Everything that is cheap and private runs locally (edit, merge, OCR, image conversion, basic PDF→DOCX). Only the heavy, fidelity-sensitive jobs (DOCX→PDF via LibreOffice, large-batch OCR, PDF/A) go to a server, and that server is optional.

### 3.1 Technology choices
| Concern | Choice | Licence |
|---|---|---|
| PDF render | pdf.js | Apache-2.0 |
| PDF write | pdf-lib | MIT |
| OCR | Tesseract.js + tessdata (`tessdata_fast`) | Apache-2.0 |
| DOCX output | `docx` | MIT |
| DOCX input (local) | mammoth | BSD-2 |
| ZIP | JSZip or fflate | MIT |
| Fonts | Standard 14, plus bundled Noto Sans / Noto Serif Ethiopic subsets | OFL |
| Online worker | LibreOffice (MPL-2.0) and OCRmyPDF (MPL-2.0) run as separate processes | MPL |

### 3.2 Libraries to avoid
- **MuPDF / PyMuPDF and Ghostscript are AGPL.** Using them in a hosted service forces you to release your source under AGPL, or buy a commercial licence. Do not use them unless you decide on AGPL on purpose.
- Anything with a "free trial watermark" SDK (Apryse/PDFTron, Foxit, Syncfusion community with restrictions). They contradict the product goal.
- Any library with a usage cap or telemetry that cannot be turned off.

## 4. Licensing

**Dependency policy.** Allowed: MIT, BSD, Apache-2.0, MPL-2.0 (if unmodified or if modifications are published), OFL (fonts), ISC. Forbidden by default: GPL/AGPL/SSPL, and commercial or "source-available" licences. CI runs a licence scanner (`license-checker` / `licensee`) and fails the build on a forbidden licence. Ship a `THIRD_PARTY_NOTICES.md` and an in-app "About → Licences" page. Apache-2.0 requires keeping the notices (already done in `vendor/PDFJS-LICENSE`).

**Product licence (your choice, decide before launch).**
- *Option A, recommended for $0:* open source (MIT or Apache-2.0), free forever, optional donations. Strongest "watermark-free" trust signal, and anyone can self-host.
- *Option B, freemium:* free local tools, paid hosted tier (online worker, cloud sync, higher limits). Licence keys are verified offline (signed JWT, public key embedded), with no phone-home required and no feature that damages output when unlicensed. Paid tiers add capacity and convenience, never remove a watermark, because there is none.

## 5. Security and privacy

- **Local-first:** a strict Content-Security-Policy (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' <worker origin>; img-src 'self' data: blob:`). No third-party scripts, no analytics by default, and all libraries are vendored and pinned (Subresource Integrity if CDN-hosted).
- **Untrusted input.** PDFs can be malicious. pdf.js runs in a worker with `isEvalSupported:false`, and JavaScript embedded in PDFs is never executed. Enforce size and page limits. Catch and surface parse failures without crashing.
- **Online worker (if built):** TLS only; files processed in a throwaway container (no shared disk, no network egress except back to the client); hard timeout and size cap; rate limiting; files deleted at job end; no content in logs; an unguessable one-time job ID. Provide a self-host Docker image so privacy-sensitive users can run their own.
- **Local data:** the autosave in IndexedDB is clearable from the UI ("Clear all local data"). Signatures are stored locally only.
- **Redaction honesty:** the "Whiteout" tool only covers content, so the UI labels it that way. Real redaction (E9) removes content and has its own test that extracts text from the output and asserts the redacted strings are absent.
- **Supply chain:** lockfile, `npm audit` in CI, Dependabot/Renovate, and no postinstall scripts.
- **Metadata hygiene:** offer one-click strip of author, producer, and XMP data on export.

## 6. Zero-budget deployment

| Need | Free option |
|---|---|
| Static hosting (the whole local app) | Cloudflare Pages, GitHub Pages, or Netlify free |
| Domain | Free subdomain (`*.pages.dev`); a custom domain is the only likely cost (about $10/yr, optional) |
| Source and CI | GitHub + GitHub Actions free minutes |
| Online worker (optional) | Self-hosted on a spare machine or free-tier VM (e.g. Oracle Cloud Always Free) using Docker. Cloudflare Workers free tier cannot run LibreOffice. If no free host is available, ship **without** the online worker. The local app is complete on its own |
| Error reporting | None by default; opt-in local error log the user can copy |

Big WASM and language files are cached by the service worker so they download once.

## 7. Performance targets (mid-range laptop, 2020+)

- First load under 3 s on broadband; app shell under 1 MB excluding vendor WASM. Lazy-load Tesseract, `docx`, and JSZip.
- Open a 100-page PDF and show page 1 in under 2 s; memory under 1 GB for a 500-page file (lazy render, release off-screen canvases).
- OCR about 2–6 s per A4 page at 300 DPI; run pages in parallel with a worker pool sized to `hardwareConcurrency - 1`.
- Export of 100 pages with annotations under 15 s.

## 8. Accessibility and UX

Keyboard shortcuts for all tools; focus-visible styles; labelled controls; high-contrast and dark mode; touch support (pointer events, pinch zoom); responsive layout down to tablet. An RTL-safe UI for Arabic and Hebrew documents. Clear progress and cancel on every long operation. Language: English first, with strings externalised so Amharic and others can be added.

## 9. Implementation stages

Each stage ends with something shippable and a green test suite.

**Stage 1: Core editor (done in prototype; harden).**
Open, view, thumbnails, page ops, add text/shapes/images/highlight/whiteout/draw, signature, edit-existing-text (run-level), undo/redo, flattened PDF export, JPEG/PNG page export, print.
*Exit:* P0 items in 2.1, 2.2 (except E4 crop), X1, X2 (JPEG/PNG), X7 pass tests.

**Stage 2: Images and print-ready.**
Image conversion (F4, F5), images→PDF, DPI-aware raster export (X4), page-size/scale/margin print options (X3), image crop/rotate/opacity, saved signatures, custom font upload, IndexedDB autosave, PWA/offline.
*Exit:* all P0 in 2.4 and 2.5 except F2/F3.

**Stage 3: OCR.**
Tesseract worker pool, language-pack manager, preprocessing, searchable-PDF output, plain-text output, confidence display. Test on English plus Amharic samples.
*Exit:* O1, O2, O5 pass the accuracy thresholds in section 10.

**Stage 4: PDF → DOCX.**
Text-run extraction → lines → paragraphs → DOCX, embedded images, headings via font-size heuristics, lists, then column and table detection, OCR path for scans, fidelity report.
*Exit:* F2 meets the fidelity benchmark in section 10.

**Stage 5: Advanced editing.**
Real redaction (E9), AcroForm fill (E8), font matching (E3), replace/remove existing images (E5), search, password handling, compress (X5), bleed/crop marks/N-up (X3).

**Stage 6: Optional online worker.**
Docker image with LibreOffice and OCRmyPDF, job API, confirmation UX, retention rules, self-host docs, DOCX→PDF high fidelity, PDF/A.

**Stage 7: Hardening and release.**
Licence audit, CSP, security review, accessibility audit, performance pass, docs, privacy page.

## 10. Testing

### 10.1 Automated
- **Unit tests** (Vitest): coordinate mapping for all four page rotations, text-line clustering, paragraph grouping, colour/hex helpers, history stack.
- **Golden PDF corpus** (about 40 files, kept in the repo and legally redistributable): scanned, multi-column, tables, forms, rotated pages (0/90/180/270), non-zero crop-box origin, encrypted, huge page counts, CJK/RTL/Ethiopic text, embedded subset fonts, transparency, broken xref.
- **E2E** (Playwright with the preinstalled Chromium): open → add text/image/signature → rotate/reorder → export → reopen the exported file with pdf-lib/pdf.js and assert the content is present at the right place. Run on Chromium, Firefox, WebKit.
- **Visual regression:** render exported pages and compare to stored references (pixel diff with tolerance).
- **No-watermark test (release-blocking):** for every export type, render and OCR the output, then assert no text other than the user's own appears. Extract all text from the PDF/DOCX and assert it is a subset of input plus user additions. Check metadata for no promotional strings. Run the same test with and without a licence key and assert byte-equivalent content.
- **Redaction test:** after E9, text extraction must not find the redacted strings, and neither must a binary search of the file.
- **Round-trip tests:** PDF→DOCX→PDF text similarity ≥ 95% (normalised Levenshtein) on text-based corpus files; image conversion preserves dimensions and DPI metadata.
- **Print-ready tests:** exported page boxes match the requested size within 0.1 mm; the bleed box is present when requested; DPI metadata is correct.
- **Fuzzing:** feed malformed and truncated PDFs and assert a clean error and no hang. Enforce timeouts.
- **Licence CI gate** and **CSP test** (page loads with no violations).

### 10.2 Quality thresholds
| Metric | Target |
|---|---|
| OCR character accuracy, clean English scan at 300 DPI | ≥ 97% |
| OCR accuracy, Amharic clean print | measure first, then set a floor; display confidence |
| PDF→DOCX text fidelity, single-column text PDFs | ≥ 95% text similarity, reading order correct |
| Edit-existing-text position error | ≤ 1 pt |
| Export success on corpus | 100% (no crashes), with graceful messages for the broken-file cases |

### 10.3 Manual checklist before each release
Open exported files in Acrobat Reader, Chrome, Firefox, macOS Preview, and Word/LibreOffice (for DOCX). Print to a real printer and to PDF. Test on a phone and a tablet. Test offline after the first load.

## 11. Definition of "watermark-free" (acceptance criteria)

1. No visible or hidden text, image, annotation, or overlay in any output that the user did not add.
2. No metadata or producer string that advertises the app beyond a plain name (and that can be stripped).
3. Identical output on the free and any paid tier.
4. Output is not rasterised unless the user chose an image format, so text stays selectable.
5. Enforced by the automated test in 10.1, which blocks release if it fails.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| PDF→DOCX fidelity disappointing on complex layouts | Fidelity report, honest labelling, optional LibreOffice-based path for DOCX→PDF, and iterate using the corpus |
| Editing existing text is limited to runs | Clear UI wording, with PDF→DOCX as the route for paragraph-level rewriting |
| Embedded subset fonts lack glyphs | Fall back to similar bundled fonts, warn, and let the user choose |
| Browser memory limits on huge files | Lazy render, page-wise processing, local budget, and the optional online path |
| AGPL contamination | Licence gate in CI; the forbidden list in 3.2 |
| No free hosting for the heavy worker | Ship local-only; the worker is a self-host Docker image |
| Amharic OCR accuracy | Use the best available model, preprocess, expose confidence, and allow manual correction before export |

## 13. Open decisions for you

1. Product licence: open source (Option A) or freemium (Option B)?
2. Which OCR languages besides English are launch-critical (Amharic?)
3. Is an online worker needed at launch, or is local-only acceptable for v1?
4. Primary users (personal and your companies' paperwork, or a public product)? This drives how much to invest in polish versus fidelity.

## 14. Brief for the AI app builder

Build in this order, one stage at a time, with tests passing before moving on. Keep the app a static, no-build-step web app unless a stage needs a bundler. Vendor and pin every dependency and respect section 3.2. Never add watermarks, telemetry, or upload files without an explicit user action. After each stage, update `README.md`, `THIRD_PARTY_NOTICES.md`, and the corpus tests.
