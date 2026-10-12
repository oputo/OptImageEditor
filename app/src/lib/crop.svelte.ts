// Crop tool (C) and document transforms: the crop rectangle being edited (image px) and its options.
// "deletePixels" is remembered in localStorage ("oie.crop").

export type CropRect = { x: number; y: number; w: number; h: number };
/** document rotation / flip */
export type DocTransform = "cw" | "ccw" | "180" | "fh" | "fv";
export const TRANSFORM_LABEL: Record<DocTransform, string> = {
  cw: "90° 時計回り", ccw: "90° 反時計回り", "180": "180°", fh: "左右反転", fv: "上下反転",
};

const KEY = "oie.crop";

class CropTool {
  /** the rectangle being edited (null: the crop tool is off) */
  rect = $state<CropRect | null>(null);
  /** delete the pixels outside the crop (pixel layers and masks only); off: they are kept outside the canvas */
  deletePixels = $state(false);

  constructor() {
    try { this.deletePixels = JSON.parse(localStorage.getItem(KEY) ?? "{}").deletePixels === true; } catch { /* storage unavailable */ }
  }
  setDelete(on: boolean) {
    this.deletePixels = on;
    try { localStorage.setItem(KEY, JSON.stringify({ deletePixels: on })); } catch { /* storage unavailable */ }
  }
}
export const cropTool = new CropTool();

/** `r` with positive size, rounded, inside 0..W x 0..H */
export function normRect(x0: number, y0: number, x1: number, y1: number, W: number, H: number): CropRect {
  const ax = Math.max(0, Math.min(W, Math.round(Math.min(x0, x1)))), bx = Math.max(0, Math.min(W, Math.round(Math.max(x0, x1))));
  const ay = Math.max(0, Math.min(H, Math.round(Math.min(y0, y1)))), by = Math.max(0, Math.min(H, Math.round(Math.max(y0, y1))));
  return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

/** where point (x, y) of a W x H canvas goes */
export function mapPoint(t: DocTransform, x: number, y: number, W: number, H: number): [number, number] {
  switch (t) {
    case "cw": return [H - y, x];
    case "ccw": return [y, W - x];
    case "180": return [W - x, H - y];
    case "fh": return [W - x, y];
    case "fv": return [x, H - y];
  }
}

/** the transformed copy of a pixel rectangle (`ch` bytes per pixel) of a W x H canvas */
export function transformPixels<T extends { x: number; y: number; w: number; h: number; px: Uint8Array }>(
  t: DocTransform, p: T, W: number, H: number, ch: number,
): { x: number; y: number; w: number; h: number; px: Uint8Array } {
  const { w, h } = p;
  const swap = t === "cw" || t === "ccw";
  const nw = swap ? h : w, nh = swap ? w : h;
  const x = t === "cw" ? H - (p.y + h) : t === "ccw" ? p.y : t === "fv" ? p.x : W - (p.x + w);
  const y = t === "cw" ? p.x : t === "ccw" ? W - (p.x + w) : t === "fh" ? p.y : H - (p.y + h);
  const out = new Uint8Array(nw * nh * ch);
  const src = p.px;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let dx: number, dy: number;
      switch (t) {
        case "cw": dx = h - 1 - j; dy = i; break;
        case "ccw": dx = j; dy = w - 1 - i; break;
        case "180": dx = w - 1 - i; dy = h - 1 - j; break;
        case "fh": dx = w - 1 - i; dy = j; break;
        default: dx = i; dy = h - 1 - j;
      }
      const s = (j * w + i) * ch, d = (dy * nw + dx) * ch;
      for (let c = 0; c < ch; c++) out[d + c] = src[s + c];
    }
  }
  return { x, y, w: nw, h: nh, px: out };
}

/** the part of a 1-channel rectangle inside `r` (outside the source: `def`) */
export function cropGrey(p: { x: number; y: number; w: number; h: number; px: Uint8Array }, r: CropRect, def: number) {
  const px = new Uint8Array(r.w * r.h).fill(def);
  const x0 = Math.max(r.x, p.x), x1 = Math.min(r.x + r.w, p.x + p.w);
  const y0 = Math.max(r.y, p.y), y1 = Math.min(r.y + r.h, p.y + p.h);
  if (x1 > x0) for (let y = y0; y < y1; y++) {
    const s = (y - p.y) * p.w + (x0 - p.x);
    px.set(p.px.subarray(s, s + (x1 - x0)), (y - r.y) * r.w + (x0 - r.x));
  }
  return { ...r, px };
}
