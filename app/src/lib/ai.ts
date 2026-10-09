// Image preparation for the AI tools (ComfyUI): what is sent (crop, scale, PNG) and how a result comes back
// (mask applied as alpha, edited region pasted back with a feathered edge). Pixels are straight RGBA, 8 bit.

export type Pixels = { x: number; y: number; w: number; h: number; px: Uint8Array };
export type Rect = { x: number; y: number; w: number; h: number };

/** PNG of `p` (straight RGBA), optionally scaled to `size`, optionally over white (no alpha) */
export async function toPng(p: { w: number; h: number; px: Uint8Array }, opt: { size?: { w: number; h: number }; white?: boolean } = {}): Promise<Blob> {
  const src = new OffscreenCanvas(p.w, p.h);
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.px.buffer as ArrayBuffer, p.px.byteOffset, p.px.byteLength), p.w, p.h), 0, 0);
  const w = opt.size?.w ?? p.w, h = opt.size?.h ?? p.h;
  if (!opt.white && w === p.w && h === p.h) return src.convertToBlob({ type: "image/png" });
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d")!;
  if (opt.white) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return out.convertToBlob({ type: "image/png" });
}

/** decodes an image (optionally scaled to w x h) to straight RGBA */
export async function decode(blob: Blob, size?: { w: number; h: number }): Promise<{ w: number; h: number; px: Uint8ClampedArray }> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const w = size?.w ?? bmp.width, h = size?.h ?? bmp.height;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { w, h, px: ctx.getImageData(0, 0, w, h).data };
}

/** size scaled so that the longer side is at most `max` */
export function fitMax(w: number, h: number, max: number) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** size with about `pixels` pixels (same aspect), sides multiples of `step` */
export function fitPixels(w: number, h: number, pixels: number, step = 16) {
  const s = Math.sqrt(pixels / (w * h));
  const r = (v: number) => Math.max(step * 16, Math.round((v * s) / step) * step);
  return { w: r(w), h: r(h) };
}

/** a copy of the region `r` (canvas coordinates) of `src`; outside `src` transparent */
export function crop(src: Pixels, r: Rect): Pixels {
  const px = new Uint8Array(r.w * r.h * 4);
  const x0 = Math.max(r.x, src.x), x1 = Math.min(r.x + r.w, src.x + src.w);
  const y0 = Math.max(r.y, src.y), y1 = Math.min(r.y + r.h, src.y + src.h);
  if (x1 > x0) {
    for (let y = y0; y < y1; y++) {
      const s = ((y - src.y) * src.w + (x0 - src.x)) * 4;
      px.set(src.px.subarray(s, s + (x1 - x0) * 4), ((y - r.y) * r.w + (x0 - r.x)) * 4);
    }
  }
  return { ...r, px };
}

/** `src` with its alpha multiplied by `mask` (same size; the mask's alpha when it has any, else its red channel) */
export function applyMask(src: Pixels, mask: Uint8ClampedArray): Pixels {
  let hasAlpha = false;
  for (let i = 3; i < mask.length; i += 4) if (mask[i] < 255) { hasAlpha = true; break; }
  const px = new Uint8Array(src.px);
  for (let i = 0; i < px.length; i += 4) {
    const m = hasAlpha ? mask[i + 3] : mask[i];
    px[i + 3] = Math.round((px[i + 3] * m) / 255);
  }
  return { ...src, px };
}

/** trims fully transparent borders (an empty result keeps 0 x 0) */
export function trim(p: Pixels): Pixels {
  let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      if (p.px[(y * p.w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    }
  }
  if (x1 < 0) return { x: p.x, y: p.y, w: 0, h: 0, px: new Uint8Array(0) };
  if (x0 === 0 && y0 === 0 && x1 === p.w - 1 && y1 === p.h - 1) return p;
  return crop(p, { x: p.x + x0, y: p.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

/** The edit region: `rect` (canvas coordinates) with a margin of context around it, inside the canvas. */
export function editRegion(rect: Rect, canvas: { w: number; h: number }): { crop: Rect; margin: number } {
  const margin = Math.round(Math.max(rect.w, rect.h) * 0.25);
  const x0 = Math.max(0, rect.x - margin), y0 = Math.max(0, rect.y - margin);
  const x1 = Math.min(canvas.w, rect.x + rect.w + margin), y1 = Math.min(canvas.h, rect.y + rect.h + margin);
  return { crop: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, margin };
}

/** The part `rect` of `result` (covering `area`), opaque, with its edges faded out over a few px, except edges that
 *  lie on the canvas border. */
export function featheredPatch(result: Uint8ClampedArray, area: Rect, rect: Rect, canvas: { w: number; h: number }): Pixels {
  const f = Math.max(2, Math.min(24, Math.round(Math.min(rect.w, rect.h) * 0.04)));
  const fl = rect.x > 0, ft = rect.y > 0, fr = rect.x + rect.w < canvas.w, fb = rect.y + rect.h < canvas.h;
  const px = new Uint8Array(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const ay = (y + rect.y - area.y) * area.w;
    for (let x = 0; x < rect.w; x++) {
      const s = (ay + x + rect.x - area.x) * 4, d = (y * rect.w + x) * 4;
      let k = 1;
      if (fl) k = Math.min(k, (x + 0.5) / f);
      if (fr) k = Math.min(k, (rect.w - x - 0.5) / f);
      if (ft) k = Math.min(k, (y + 0.5) / f);
      if (fb) k = Math.min(k, (rect.h - y - 0.5) / f);
      px[d] = result[s]; px[d + 1] = result[s + 1]; px[d + 2] = result[s + 2];
      px[d + 3] = Math.round(Math.min(1, k) * 255);
    }
  }
  return { ...rect, px };
}

/** `top` drawn over `base` (both straight RGBA; `top` inside `base`'s area) */
export function over(base: Pixels, top: Pixels): Pixels {
  const px = new Uint8Array(base.px);
  for (let y = 0; y < top.h; y++) {
    const by = y + top.y - base.y;
    if (by < 0 || by >= base.h) continue;
    for (let x = 0; x < top.w; x++) {
      const bx = x + top.x - base.x;
      if (bx < 0 || bx >= base.w) continue;
      const s = (y * top.w + x) * 4, d = (by * base.w + bx) * 4;
      const ta = top.px[s + 3] / 255;
      if (!ta) continue;
      const ba = px[d + 3] / 255, oa = ta + ba * (1 - ta);
      for (let c = 0; c < 3; c++) px[d + c] = Math.round((top.px[s + c] * ta + px[d + c] * ba * (1 - ta)) / oa);
      px[d + 3] = Math.round(oa * 255);
    }
  }
  return { ...base, px };
}

/** a random seed for the sampler */
export const randomSeed = () => Math.floor(Math.random() * 2 ** 48);
