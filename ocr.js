// OCR engine wrapper around Tesseract.js (all files are vendored; nothing is fetched from a CDN).

const abs = (p) => new URL(p, import.meta.url).href;

const scripts = new Map();
export function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = abs(src);
        s.onload = () => (window[globalName] ? res(window[globalName]) : rej(new Error(`${globalName} did not load`)));
        s.onerror = () => { scripts.delete(src); rej(new Error(`Could not load ${src}`)); };
        document.head.append(s);
      })
    );
  }
  return scripts.get(src);
}

export const loadTesseract = () => loadScript('./vendor/tesseract/tesseract.min.js', 'Tesseract');

/** Grayscale + contrast stretch (1st–99th percentile), in place. Helps faint or grey scans. */
export function preprocess(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
  }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
  if (hi - lo > 30) {
    const k = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * k) | 0));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const r1 = (n) => Math.round(n * 10) / 10;
/** Convert a Tesseract result (pixel coordinates) into page-space boxes: [text, x, y, w, h, confidence]. */
export function parseResult(data, scale) {
  const box = (o) => [
    String(o.text || '').trim(),
    r1(o.bbox.x0 / scale), r1(o.bbox.y0 / scale),
    r1((o.bbox.x1 - o.bbox.x0) / scale), r1((o.bbox.y1 - o.bbox.y0) / scale),
    Math.round(o.confidence || 0),
  ];
  const words = (data.words || []).map(box).filter((w) => w[0]);
  const lines = (data.lines || []).map(box).filter((w) => w[0]);
  const confs = words.map((w) => w[5]);
  return {
    words,
    lines,
    text: String(data.text || '').trim(),
    conf: confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 0,
  };
}

/**
 * Recognise `items` with a small pool of workers.
 *  renderItem(item) -> { canvas, scale }   (scale = canvas pixels per page point)
 *  onPageDone(item, result)
 *  onProgress({ done, total, fraction, status })
 * Aborting `signal` terminates the workers and resolves quietly.
 */
export async function ocrPages({ items, renderItem, lang, workers = 2, signal, onPageDone, onProgress }) {
  const T = await loadTesseract();
  const n = Math.max(1, Math.min(workers, items.length));
  const inflight = new Array(n).fill(0);
  let done = 0;
  let next = 0;
  let status = 'Loading OCR engine…';
  const report = () =>
    onProgress?.({ done, total: items.length, fraction: Math.min(1, (done + inflight.reduce((a, b) => a + b, 0)) / items.length), status });
  report();

  const pool = [];
  const stop = () => pool.forEach((w) => w.terminate().catch(() => {}));
  signal?.addEventListener('abort', stop);
  try {
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) return;
      pool.push(
        await T.createWorker(lang, 1, {
          workerPath: abs('./vendor/tesseract/worker.min.js'),
          corePath: abs('./vendor/tesseract/'),
          langPath: abs('./vendor/tessdata/'),
          gzip: true,
          cacheMethod: 'none',
          logger: (m) => {
            if (m.status === 'recognizing text') {
              inflight[i] = m.progress || 0;
              status = 'Recognising text';
              report();
            }
          },
        })
      );
    }
    await Promise.all(
      pool.map(async (w, i) => {
        while (!signal?.aborted) {
          const k = next++;
          if (k >= items.length) break;
          status = `Rendering page ${k + 1}`;
          report();
          const { canvas, scale } = await renderItem(items[k]);
          preprocess(canvas);
          const { data } = await w.recognize(canvas);
          canvas.width = canvas.height = 0;
          inflight[i] = 0;
          done++;
          onPageDone(items[k], parseResult(data, scale));
          report();
        }
      })
    );
  } catch (err) {
    if (!signal?.aborted) throw err; // workers were terminated on purpose
  } finally {
    signal?.removeEventListener('abort', stop);
    await Promise.all(pool.map((w) => w.terminate().catch(() => {})));
  }
}
