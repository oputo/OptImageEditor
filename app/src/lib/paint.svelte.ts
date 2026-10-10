// Paint tools and settings (phase 3-b): brush / eraser / eyedropper, colours, brush size / hardness / opacity,
// pen pressure. Shared by all tabs; settings are remembered in localStorage ("oie.paint").

export type PaintTool = "brush" | "eraser" | "eyedropper";
export const PAINT_LABEL: Record<PaintTool, string> = { brush: "ブラシ", eraser: "消しゴム", eyedropper: "スポイト" };
export const PAINT_ICON: Record<PaintTool, string> = { brush: "🖌", eraser: "⌫", eyedropper: "💧" };
const KEY = "oie.paint";

type Saved = { fg: string; bg: string; size: number; hardness: number; opacity: number; pressureSize: boolean; pressureOpacity: boolean; eraserSize: number };

class PaintState {
  tool = $state<PaintTool | null>(null);
  fg = $state("#000000");
  bg = $state("#ffffff");
  /** diameter in image px */
  size = $state(30);
  eraserSize = $state(60);
  /** 0..1 (share of the radius that is fully opaque) */
  hardness = $state(0.8);
  /** 0..1 */
  opacity = $state(1);
  pressureSize = $state(true);
  pressureOpacity = $state(false);

  constructor() {
    try {
      const s: Partial<Saved> = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (s.fg) this.fg = s.fg;
      if (s.bg) this.bg = s.bg;
      if (s.size) this.size = s.size;
      if (s.eraserSize) this.eraserSize = s.eraserSize;
      if (typeof s.hardness === "number") this.hardness = s.hardness;
      if (typeof s.opacity === "number") this.opacity = s.opacity;
      if (typeof s.pressureSize === "boolean") this.pressureSize = s.pressureSize;
      if (typeof s.pressureOpacity === "boolean") this.pressureOpacity = s.pressureOpacity;
    } catch { /* storage unavailable */ }
  }

  save() {
    const s: Saved = { fg: this.fg, bg: this.bg, size: this.size, hardness: this.hardness, opacity: this.opacity, pressureSize: this.pressureSize, pressureOpacity: this.pressureOpacity, eraserSize: this.eraserSize };
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  }

  /** diameter of the current tool */
  get diameter() { return this.tool === "eraser" ? this.eraserSize : this.size; }
  set diameter(v: number) {
    const d = Math.max(1, Math.min(5000, Math.round(v)));
    if (this.tool === "eraser") this.eraserSize = d; else this.size = d;
    this.save();
  }

  swap() { [this.fg, this.bg] = [this.bg, this.fg]; this.save(); }
  reset() { this.fg = "#000000"; this.bg = "#ffffff"; this.save(); }
}
export const paint = new PaintState();

/** Photoshop's [ / ] steps */
export function stepSize(d: number, up: boolean) {
  const step = d < 10 ? 1 : d < 100 ? 10 : d < 200 ? 25 : d < 300 ? 50 : d < 500 ? 100 : 100;
  return Math.max(1, up ? d + step : d - step);
}

export const hexToRgb = (h: string): [number, number, number] => {
  const v = parseInt(h.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
export const rgbToHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, mx ? d / mx : 0, mx];
}
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
