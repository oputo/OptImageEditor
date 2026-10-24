// Image size of the document (B-2b): how rectangles and pixels are scaled. The pixels are resampled in Rust
// (resample.rs, the same code the saver uses for the file's channels); in a browser build with a canvas instead.
import { resampleImage, type ResampleAxis, type ResampleFilter } from "./desktop";

export type { ResampleFilter };

/** rounds half away from zero (as Rust's f64::round, so the app and the saver place rectangles alike) */
export const rnd = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

/** a span [x, x + w) scaled by `s` about 0: where it starts and the axis mapping its samples */
export function scaleSpan(x: number, w: number, s: number): { at: number; axis: ResampleAxis } {
  const a = rnd(s * x), b = rnd(s * (x + w));
  return { at: a, axis: { n: Math.max(0, b - a), k: s, c: a / s - x } };
}

/** Straight RGBA (or, with `grey`, one byte per pixel) resampled to ax.n x ay.n. */
export async function resamplePixels(px: Uint8Array, w: number, h: number, ax: ResampleAxis, ay: ResampleAxis,
  filter: ResampleFilter, grey: { outside: number | null } | null = null): Promise<Uint8Array> {
  if (!ax.n || !ay.n) return new Uint8Array(0);
  const r = await resampleImage(px, w, h, ax, ay, filter, grey);
  if (r) return r;
  // browser build: a canvas (premultiplied inside; good enough for a preview there)
  const src = new OffscreenCanvas(w, h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (grey) for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]; rgba[i * 4 + 3] = 255; }
  else rgba.set(px);
  src.getContext("2d")!.putImageData(new ImageData(rgba, w, h), 0, 0);
  const out = new OffscreenCanvas(ax.n, ay.n);
  const ctx = out.getContext("2d")!;
  if (grey?.outside != null) { const v = grey.outside; ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(0, 0, ax.n, ay.n); }
  ctx.imageSmoothingEnabled = filter !== "nearest";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, -ax.c * ax.k, -ay.c * ay.k, w * ax.k, h * ay.k);
  const d = ctx.getImageData(0, 0, ax.n, ay.n).data;
  if (!grey) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  const g = new Uint8Array(ax.n * ay.n);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4];
  return g;
}
