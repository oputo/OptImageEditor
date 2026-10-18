// Paint tools and settings (phase 3-b): brush / eraser / eyedropper, colours, brush size / hardness / opacity,
// pen pressure. Shared by all tabs; settings are remembered in localStorage ("oie.paint").

export type PaintTool = "brush" | "eraser" | "eyedropper";
export const PAINT_LABEL: Record<PaintTool, string> = { brush: "ブラシ", eraser: "消しゴム", eyedropper: "スポイト" };
export const PAINT_ICON: Record<PaintTool, string> = { brush: "🖌", eraser: "⌫", eyedropper: "💧" };
const KEY = "oie.paint";

/** settings of one tool (the eyedropper's diameter is its sample size; it has no hardness / opacity) */
export type ToolParams = { size: number; hardness: number; opacity: number };
const DEFAULTS: Record<PaintTool, ToolParams> = {
  brush: { size: 30, hardness: 0.8, opacity: 1 },
  eraser: { size: 60, hardness: 0.8, opacity: 1 },
  eyedropper: { size: 1, hardness: 1, opacity: 1 },
};
type Saved = { fg: string; bg: string; params: Partial<Record<PaintTool, Partial<ToolParams>>>; pressureSize: boolean; pressureOpacity: boolean };

class PaintState {
  tool = $state<PaintTool | null>(null);
  fg = $state("#000000");
  bg = $state("#ffffff");
  /** per tool: diameter (image px), hardness 0..1 (share of the radius that is fully opaque), opacity 0..1 */
  params = $state<Record<PaintTool, ToolParams>>(structuredClone(DEFAULTS));
  pressureSize = $state(true);
  pressureOpacity = $state(false);

  constructor() {
    try {
      const s: Partial<Saved> & { size?: number; eraserSize?: number; hardness?: number; opacity?: number } = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (s.fg) this.fg = s.fg;
      if (s.bg) this.bg = s.bg;
      for (const t of Object.keys(DEFAULTS) as PaintTool[]) Object.assign(this.params[t], s.params?.[t] ?? {});
      // settings saved before the tools had their own (3-b, daa6fab)
      if (!s.params) {
        if (s.size) this.params.brush.size = s.size;
        if (s.eraserSize) this.params.eraser.size = s.eraserSize;
        if (typeof s.hardness === "number") this.params.brush.hardness = this.params.eraser.hardness = s.hardness;
        if (typeof s.opacity === "number") this.params.brush.opacity = this.params.eraser.opacity = s.opacity;
      }
      if (typeof s.pressureSize === "boolean") this.pressureSize = s.pressureSize;
      if (typeof s.pressureOpacity === "boolean") this.pressureOpacity = s.pressureOpacity;
    } catch { /* storage unavailable */ }
  }

  save() {
    const s: Saved = { fg: this.fg, bg: this.bg, params: $state.snapshot(this.params), pressureSize: this.pressureSize, pressureOpacity: this.pressureOpacity };
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  }

  /** the settings of the current tool (the brush's when no tool is active) */
  get cur(): ToolParams { return this.params[this.tool ?? "brush"]; }
  get diameter() { return this.cur.size; }
  set diameter(v: number) {
    const max = this.tool === "eyedropper" ? 101 : 5000;
    this.cur.size = Math.max(1, Math.min(max, Math.round(v)));
    this.save();
  }
  get hardness() { return this.cur.hardness; }
  set hardness(v: number) { this.cur.hardness = Math.max(0, Math.min(1, v)); this.save(); }
  get opacity() { return this.cur.opacity; }
  set opacity(v: number) { this.cur.opacity = Math.max(0.01, Math.min(1, v)); this.save(); }

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
