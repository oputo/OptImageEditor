// Annotations ("赤入れ"): pen / line / arrow / rectangle / text drawn over an image, kept as shapes (editable,
// undo per shape) in image px, and burnt into the image only when copied to the clipboard or saved as PNG.
// Line widths and text sizes are chosen in screen px and converted to image px with the zoom at drawing time,
// so a stroke looks the way it was drawn whatever the zoom was.

export type Tool = "select" | "pen" | "line" | "arrow" | "rect" | "text";
export type ShapeKind = Exclude<Tool, "select">;

export type Shape = {
  id: number;
  kind: ShapeKind;
  color: string;
  /** line width in image px */
  width: number;
  /** pen: x, y, x, y, ...; line / arrow / rect: x1, y1, x2, y2; text: x, y (top left) */
  pts: number[];
  text?: string;
  /** text: font size in image px */
  size?: number;
};

export const COLORS = [
  { c: "#ff3030", label: "赤" }, { c: "#ffd400", label: "黄" }, { c: "#2f7bff", label: "青" },
  { c: "#22c55e", label: "緑" }, { c: "#ffffff", label: "白" }, { c: "#000000", label: "黒" },
];
/** line widths (screen px) and text sizes (screen px) for the 3 steps */
export const WIDTHS = [2, 4, 8];
export const FONT_SIZES = [16, 24, 36];
export const TOOL_LABEL: Record<Tool, string> = { select: "選択", pen: "ペン", line: "直線", arrow: "矢印", rect: "四角", text: "テキスト" };
/** single-letter keys (physical key, see App.svelte) */
export const TOOL_KEY: Record<Tool, string> = { select: "v", pen: "p", line: "l", arrow: "a", rect: "u", text: "t" };

const FONT_FAMILY = `"Segoe UI", "Yu Gothic UI", "Hiragino Sans", sans-serif`;
const HISTORY_MAX = 100;

/** Current tool settings (shared by all tabs). `tool === null`: annotation mode off. */
class AnnotTool {
  tool = $state<Tool | null>(null);
  color = $state(COLORS[0].c);
  widthIndex = $state(1);
}
export const annotTool = new AnnotTool();

/** The annotations of one tab, with their undo history. */
export class Annotations {
  shapes = $state.raw<Shape[]>([]);
  selected = $state<number | null>(null);
  /** bumps on every change (redraw trigger) */
  version = $state(0);
  undoCount = $state(0);
  redoCount = $state(0);
  private undoStack: Shape[][] = [];
  private redoStack: Shape[][] = [];
  private seq = 0;

  nextId() { return ++this.seq; }

  /** replaces the shapes as one undoable step */
  commit(next: Shape[]) {
    this.undoStack.push(this.shapes);
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.set(next);
  }

  undo() { this.travel(this.undoStack, this.redoStack); }
  redo() { this.travel(this.redoStack, this.undoStack); }
  private travel(from: Shape[][], to: Shape[][]) {
    const s = from.pop();
    if (!s) return;
    to.push(this.shapes);
    this.set(s);
  }

  private set(next: Shape[]) {
    this.shapes = next;
    if (this.selected !== null && !next.some((s) => s.id === this.selected)) this.selected = null;
    this.undoCount = this.undoStack.length;
    this.redoCount = this.redoStack.length;
    this.version++;
  }

  add(s: Shape) { this.commit([...this.shapes, s]); }
  remove(id: number) { this.commit(this.shapes.filter((s) => s.id !== id)); }
  replace(s: Shape) { this.commit(this.shapes.map((x) => (x.id === s.id ? s : x))); }
  clear() { if (this.shapes.length) this.commit([]); }
  /** removes every shape and the history (the shapes became a layer: undoing them back would draw them twice) */
  reset() { this.undoStack = []; this.redoStack = []; this.set([]); }
}

// ---------------------------------------------------------------- geometry

export function translate(s: Shape, dx: number, dy: number): Shape {
  return { ...s, pts: s.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
}

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function textBox(s: Shape): { w: number; h: number } {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext("2d")!;
  measureCtx.font = font(s.size ?? 24);
  const lines = (s.text ?? "").split("\n");
  const w = Math.max(...lines.map((l) => measureCtx!.measureText(l).width));
  return { w, h: lines.length * (s.size ?? 24) * 1.25 };
}

export function bounds(s: Shape): { x: number; y: number; w: number; h: number } {
  if (s.kind === "text") {
    const b = textBox(s);
    return { x: s.pts[0], y: s.pts[1], w: b.w, h: b.h };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 2) {
    x0 = Math.min(x0, s.pts[i]); x1 = Math.max(x1, s.pts[i]);
    y0 = Math.min(y0, s.pts[i + 1]); y1 = Math.max(y1, s.pts[i + 1]);
  }
  const m = s.kind === "arrow" ? s.width * 3 : s.width / 2;
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Is image point (x, y) on shape `s`? `tol`: tolerance in image px. */
export function hit(s: Shape, x: number, y: number, tol: number): boolean {
  const p = s.pts;
  const t = tol + s.width / 2;
  switch (s.kind) {
    case "text": {
      const b = bounds(s);
      return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    }
    case "rect": {
      const [x0, x1] = [Math.min(p[0], p[2]), Math.max(p[0], p[2])], [y0, y1] = [Math.min(p[1], p[3]), Math.max(p[1], p[3])];
      return (
        segDist(x, y, x0, y0, x1, y0) < t || segDist(x, y, x1, y0, x1, y1) < t ||
        segDist(x, y, x1, y1, x0, y1) < t || segDist(x, y, x0, y1, x0, y0) < t
      );
    }
    case "arrow":
    case "line":
      return segDist(x, y, p[0], p[1], p[2], p[3]) < (s.kind === "arrow" ? t + s.width : t);
    case "pen":
      if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) < t;
      for (let i = 0; i + 3 < p.length; i += 2) if (segDist(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) < t) return true;
      return false;
  }
}

/** topmost shape at (x, y) */
export function shapeAt(shapes: Shape[], x: number, y: number, tol: number): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) if (hit(shapes[i], x, y, tol)) return shapes[i];
  return null;
}

/** Shift: snap the end point of a line / arrow to 45 degrees, make a rectangle square. */
export function constrain(kind: ShapeKind, x0: number, y0: number, x: number, y: number): [number, number] {
  const dx = x - x0, dy = y - y0;
  if (kind === "rect") {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d];
  }
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len];
}

// ---------------------------------------------------------------- drawing

const font = (size: number) => `bold ${size}px ${FONT_FAMILY}`;
/** outline colour that keeps text readable on any background */
const contrast = (c: string) => (c === "#ffffff" || c === "#ffd400" || c === "#22c55e" ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)");

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draws `s` with the context's current transform mapping image px. */
export function drawShape(ctx: Ctx, s: Shape) {
  const p = s.pts;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  switch (s.kind) {
    case "pen": {
      ctx.beginPath();
      if (p.length === 2) {
        ctx.arc(p[0], p[1], s.width / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.moveTo(p[0], p[1]);
      // quadratic curves through the midpoints: smooth without overshooting
      for (let i = 2; i + 3 < p.length; i += 2) {
        ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
      }
      ctx.lineTo(p[p.length - 2], p[p.length - 1]);
      ctx.stroke();
      break;
    }
    case "line":
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[2], p[3]);
      ctx.stroke();
      break;
    case "arrow": {
      const ang = Math.atan2(p[3] - p[1], p[2] - p[0]);
      const len = Math.hypot(p[2] - p[0], p[3] - p[1]);
      const head = Math.min(len, s.width * 4 + 6 * Math.sqrt(s.width));
      const back = head * 0.8; // the shaft stops inside the head so its round cap does not show at the tip
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[2] - Math.cos(ang) * back, p[3] - Math.sin(ang) * back);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p[2], p[3]);
      ctx.lineTo(p[2] - Math.cos(ang - 0.45) * head, p[3] - Math.sin(ang - 0.45) * head);
      ctx.lineTo(p[2] - Math.cos(ang + 0.45) * head, p[3] - Math.sin(ang + 0.45) * head);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "rect":
      ctx.strokeRect(Math.min(p[0], p[2]), Math.min(p[1], p[3]), Math.abs(p[2] - p[0]), Math.abs(p[3] - p[1]));
      break;
    case "text": {
      const size = s.size ?? 24;
      ctx.font = font(size);
      ctx.textBaseline = "top";
      ctx.lineWidth = Math.max(1, size / 7);
      ctx.strokeStyle = contrast(s.color);
      const lines = (s.text ?? "").split("\n");
      lines.forEach((l, i) => {
        const y = p[1] + i * size * 1.25;
        ctx.strokeText(l, p[0], y);
        ctx.fillText(l, p[0], y);
      });
      break;
    }
  }
  ctx.restore();
}

/** Selection frame of `s`; `px` = image px per screen px (keeps the frame 1 screen px wide). */
export function drawSelection(ctx: Ctx, s: Shape, px: number) {
  const b = bounds(s);
  const m = 4 * px;
  ctx.save();
  ctx.lineWidth = px;
  ctx.setLineDash([4 * px, 3 * px]);
  ctx.strokeStyle = "#ffffff";
  ctx.strokeRect(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
  ctx.lineDashOffset = 3.5 * px;
  ctx.strokeStyle = "#000000";
  ctx.strokeRect(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
  ctx.restore();
}

/** Burns the shapes into the image. `premultiplied`: RGBA8 as read back from the GPU. Returns a PNG. */
export async function flattenToPng(premultiplied: Uint8Array, w: number, h: number, shapes: Shape[]): Promise<Blob> {
  return flattenToCanvas(premultiplied, w, h, shapes).convertToBlob({ type: "image/png" });
}

/** The image (straight alpha) with the shapes drawn on it. */
export function flattenToCanvas(premultiplied: Uint8Array, w: number, h: number, shapes: Shape[]): OffscreenCanvas {
  const data = new Uint8ClampedArray(premultiplied.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = premultiplied[i + 3];
    if (!a) continue;
    data[i] = (premultiplied[i] * 255) / a + 0.5;
    data[i + 1] = (premultiplied[i + 1] * 255) / a + 0.5;
    data[i + 2] = (premultiplied[i + 2] * 255) / a + 0.5;
    data[i + 3] = a;
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  for (const s of shapes) drawShape(ctx, s);
  return c;
}
