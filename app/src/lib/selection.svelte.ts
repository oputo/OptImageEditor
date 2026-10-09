// Selection (phase 3-a): an 8-bit mask over the canvas (0 = not selected, 255 = selected, values between for
// anti-aliased / feathered edges), kept as its bounding rectangle + the mask inside it. A selection is an immutable
// value: every change makes a new one, so undo snapshots can share them.

export type Sel = { x: number; y: number; w: number; h: number; m: Uint8Array };
export type SelMode = "replace" | "add" | "subtract" | "intersect";
export type SelTool = "rect" | "ellipse" | "lasso" | "poly";

export const SEL_LABEL: Record<SelTool, string> = { rect: "長方形選択", ellipse: "楕円形選択", lasso: "なげなわ", poly: "多角形選択" };
export const SEL_ICON: Record<SelTool, string> = { rect: "⬚", ellipse: "◯", lasso: "ᘐ", poly: "⬠" };

/** Current selection tool (shared by all tabs). `tool === null`: no selection tool. */
class SelToolState {
  tool = $state<SelTool | null>(null);
  /** M cycles rect <-> ellipse, L cycles lasso <-> poly (Shift+M / Shift+L) */
  marquee = $state<"rect" | "ellipse">("rect");
  lasso = $state<"lasso" | "poly">("lasso");
}
export const selTool = new SelToolState();

/** mode from the modifier keys held when a selection starts (Photoshop) */
export function modeOf(e: { shiftKey: boolean; altKey: boolean }): SelMode {
  if (e.shiftKey && e.altKey) return "intersect";
  if (e.shiftKey) return "add";
  if (e.altKey) return "subtract";
  return "replace";
}

/** clips a rectangle to the canvas; null when empty */
export function clipRect(x0: number, y0: number, x1: number, y1: number, W: number, H: number) {
  const ax = Math.max(0, Math.floor(Math.min(x0, x1))), ay = Math.max(0, Math.floor(Math.min(y0, y1)));
  const bx = Math.min(W, Math.ceil(Math.max(x0, x1))), by = Math.min(H, Math.ceil(Math.max(y0, y1)));
  return bx > ax && by > ay ? { x: ax, y: ay, w: bx - ax, h: by - ay } : null;
}

/** rectangle (whole pixels: the corners are rounded to the pixel grid) */
export function rectSel(x0: number, y0: number, x1: number, y1: number, W: number, H: number): Sel | null {
  const r = clipRect(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), W, H);
  if (!r) return null;
  return { ...r, m: new Uint8Array(r.w * r.h).fill(255) };
}

/** a filled path (anti-aliased), drawn by `draw` in canvas px, inside the box (x0, y0)-(x1, y1) */
function pathSel(x0: number, y0: number, x1: number, y1: number, W: number, H: number, draw: (c: OffscreenCanvasRenderingContext2D) => void): Sel | null {
  const r = clipRect(x0 - 1, y0 - 1, x1 + 1, y1 + 1, W, H);
  if (!r) return null;
  const c = new OffscreenCanvas(r.w, r.h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.translate(-r.x, -r.y);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  draw(ctx);
  ctx.fill();
  const d = ctx.getImageData(0, 0, r.w, r.h).data;
  const m = new Uint8Array(r.w * r.h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
  return trimSel({ ...r, m });
}

export function ellipseSel(x0: number, y0: number, x1: number, y1: number, W: number, H: number): Sel | null {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (rx < 0.5 || ry < 0.5) return null;
  return pathSel(cx - rx, cy - ry, cx + rx, cy + ry, W, H, (c) => c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2));
}

/** polygon / lasso: points x, y, x, y, ... (closed) */
export function polySel(pts: number[], W: number, H: number): Sel | null {
  if (pts.length < 6) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
  return pathSel(x0, y0, x1, y1, W, H, (c) => { c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); });
}

export function allSel(W: number, H: number): Sel {
  return { x: 0, y: 0, w: W, h: H, m: new Uint8Array(W * H).fill(255) };
}

/** value of the selection at canvas pixel (x, y) */
export const selAt = (s: Sel, x: number, y: number) => (x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h ? s.m[(y - s.y) * s.w + x - s.x] : 0);

/** shrinks the rectangle to the selected pixels; null when nothing is selected */
export function trimSel(s: Sel): Sel | null {
  let x0 = s.w, y0 = s.h, x1 = -1, y1 = -1;
  for (let y = 0; y < s.h; y++) {
    const row = y * s.w;
    for (let x = 0; x < s.w; x++) {
      if (s.m[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    }
  }
  if (x1 < 0) return null;
  if (x0 === 0 && y0 === 0 && x1 === s.w - 1 && y1 === s.h - 1) return s;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) m.set(s.m.subarray((y + y0) * s.w + x0, (y + y0) * s.w + x0 + w), y * w);
  return { x: s.x + x0, y: s.y + y0, w, h, m };
}

/** combines the current selection `a` with a new shape `b` */
export function combine(a: Sel | null, b: Sel | null, mode: SelMode): Sel | null {
  if (mode === "replace") return b;
  if (mode === "add") {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.max(a.x + a.w, b.x + b.w) - x, h = Math.max(a.y + a.h, b.y + b.h) - y;
    const m = new Uint8Array(w * h);
    for (const s of [a, b]) {
      for (let yy = 0; yy < s.h; yy++) {
        const o = (yy + s.y - y) * w + s.x - x;
        for (let xx = 0; xx < s.w; xx++) { const v = s.m[yy * s.w + xx]; if (v > m[o + xx]) m[o + xx] = v; }
      }
    }
    return { x, y, w, h, m };
  }
  if (!a) return null;
  if (mode === "subtract") {
    if (!b) return a;
    const m = new Uint8Array(a.m);
    for (let yy = 0; yy < a.h; yy++) {
      for (let xx = 0; xx < a.w; xx++) {
        const v = selAt(b, xx + a.x, yy + a.y);
        if (v) { const i = yy * a.w + xx; m[i] = Math.round((m[i] * (255 - v)) / 255); }
      }
    }
    return trimSel({ ...a, m });
  }
  // intersect
  if (!b) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  if (w <= 0 || h <= 0) return null;
  const m = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) m[yy * w + xx] = Math.min(selAt(a, x + xx, y + yy), selAt(b, x + xx, y + yy));
  return trimSel({ x, y, w, h, m });
}

/** Ctrl+Shift+I */
export function invertSel(s: Sel | null, W: number, H: number): Sel | null {
  if (!s) return allSel(W, H);
  const m = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < s.h; y++) {
    const cy = y + s.y;
    if (cy < 0 || cy >= H) continue;
    for (let x = 0; x < s.w; x++) {
      const cx = x + s.x;
      if (cx >= 0 && cx < W) m[cy * W + cx] = 255 - s.m[y * s.w + x];
    }
  }
  return trimSel({ x: 0, y: 0, w: W, h: H, m });
}

/** selection from the alpha of straight RGBA pixels at (x, y) (Ctrl+click on a layer thumbnail), clipped to the canvas */
export function selFromAlpha(p: { x: number; y: number; w: number; h: number; px: Uint8Array }, W: number, H: number): Sel | null {
  const r = clipRect(p.x, p.y, p.x + p.w, p.y + p.h, W, H);
  if (!r) return null;
  const m = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) m[y * r.w + x] = p.px[((y + r.y - p.y) * p.w + x + r.x - p.x) * 4 + 3];
  return trimSel({ ...r, m });
}

/** moves a selection (canvas size change) */
export const shiftSel = (s: Sel | null, dx: number, dy: number): Sel | null => (s && (dx || dy) ? { ...s, x: s.x + dx, y: s.y + dy } : s);

/** Outline of the selection at 50 %: segments x0, y0, x1, y1 (canvas px, on pixel edges), adjacent runs merged.
 *  null when there are too many to draw every frame (the bounding box is drawn instead). */
export function outline(s: Sel, max = 400000): Float32Array | null {
  const out: number[] = [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < s.w && y < s.h && s.m[y * s.w + x] >= 128;
  // horizontal edges: between row y - 1 and row y
  for (let y = 0; y <= s.h; y++) {
    let start = -1;
    for (let x = 0; x <= s.w; x++) {
      const edge = x < s.w && inside(x, y - 1) !== inside(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) { out.push(s.x + start, s.y + y, s.x + x, s.y + y); start = -1; }
    }
    if (out.length > max * 4) return null;
  }
  // vertical edges: between column x - 1 and column x
  for (let x = 0; x <= s.w; x++) {
    let start = -1;
    for (let y = 0; y <= s.h; y++) {
      const edge = y < s.h && inside(x - 1, y) !== inside(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) { out.push(s.x + x, s.y + start, s.x + x, s.y + y); start = -1; }
    }
    if (out.length > max * 4) return null;
  }
  return new Float32Array(out);
}

/** straight RGBA pixels `p` with their alpha multiplied by the selection (cropped to the selection) */
export function maskPixels(p: { x: number; y: number; w: number; h: number; px: Uint8Array }, s: Sel): { x: number; y: number; w: number; h: number; px: Uint8Array } {
  const x = Math.max(p.x, s.x), y = Math.max(p.y, s.y);
  const w = Math.max(0, Math.min(p.x + p.w, s.x + s.w) - x), h = Math.max(0, Math.min(p.y + p.h, s.y + s.h) - y);
  const px = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const si = ((yy + y - p.y) * p.w + xx + x - p.x) * 4, di = (yy * w + xx) * 4;
      const v = s.m[(yy + y - s.y) * s.w + xx + x - s.x];
      if (!v) continue;
      px[di] = p.px[si]; px[di + 1] = p.px[si + 1]; px[di + 2] = p.px[si + 2];
      px[di + 3] = Math.round((p.px[si + 3] * v) / 255);
    }
  }
  return { x, y, w, h, px };
}

/** `p` with the selected part removed (alpha * (1 - sel)); `fillWhite`: a background layer gets white instead */
export function clearPixels(p: { x: number; y: number; w: number; h: number; px: Uint8Array }, s: Sel, fillWhite: boolean): Uint8Array {
  const px = new Uint8Array(p.px);
  const x0 = Math.max(p.x, s.x), y0 = Math.max(p.y, s.y), x1 = Math.min(p.x + p.w, s.x + s.w), y1 = Math.min(p.y + p.h, s.y + s.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = s.m[(y - s.y) * s.w + x - s.x];
      if (!v) continue;
      const i = ((y - p.y) * p.w + x - p.x) * 4;
      if (fillWhite) {
        for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] + ((255 - px[i + c]) * v) / 255);
      } else {
        px[i + 3] = Math.round((px[i + 3] * (255 - v)) / 255);
      }
    }
  }
  return px;
}
