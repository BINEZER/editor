# Third-party software

All of these are vendored in `vendor/` (no CDN, no network access at runtime).

| Component | Version | License | Use |
|---|---|---|---|
| pdf.js (`pdfjs-dist`) | 4.10.38 | Apache-2.0 (`vendor/PDFJS-LICENSE`) | Rendering, text extraction |
| pdf-lib | 1.17.1 | MIT | Writing the exported PDF |
| @pdf-lib/fontkit | 1.1.1 | MIT | Embedding the Ethiopic font for searchable Amharic text |
| Tesseract.js | 5.1.1 | Apache-2.0 | OCR engine wrapper and worker |
| tesseract.js-core | 5.1.1 | Apache-2.0 | Tesseract compiled to WebAssembly |
| tessdata_best (`eng`, `amh`) | via @tesseract.js-data 1.0.0 | Apache-2.0 | OCR language models |
| Noto Sans Ethiopic | via @fontsource 5.3.0 | SIL OFL 1.1 | Font for the hidden Amharic text layer, and for test fixtures |

Forbidden by project policy (see `SPEC.md`): GPL/AGPL libraries such as MuPDF and Ghostscript.
