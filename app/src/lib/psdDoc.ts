// Layer tree of a PSD as used by the compositor and the layers panel (phase 2-a: read only).
// Order of `children` is bottom -> top (like the file and ag-psd); the panel shows it reversed.

export const BLEND_MODES = [
  "normal", "dissolve",
  "darken", "multiply", "color burn", "linear burn", "darker color",
  "lighten", "screen", "color dodge", "linear dodge", "lighter color",
  "overlay", "soft light", "hard light", "vivid light", "linear light", "pin light", "hard mix",
  "difference", "exclusion", "subtract", "divide",
  "hue", "saturation", "color", "luminosity",
] as const;
export type LayerBlendMode = (typeof BLEND_MODES)[number] | "pass through";

/** Photoshop (Japanese UI) names */
export const BLEND_LABEL: Record<LayerBlendMode, string> = {
  "pass through": "通過", normal: "通常", dissolve: "ディザ合成",
  darken: "比較（暗）", multiply: "乗算", "color burn": "焼き込みカラー", "linear burn": "焼き込み（リニア）", "darker color": "カラー比較（暗）",
  lighten: "比較（明）", screen: "スクリーン", "color dodge": "覆い焼きカラー", "linear dodge": "覆い焼き（リニア）- 加算", "lighter color": "カラー比較（明）",
  overlay: "オーバーレイ", "soft light": "ソフトライト", "hard light": "ハードライト", "vivid light": "ビビッドライト",
  "linear light": "リニアライト", "pin light": "ピンライト", "hard mix": "ハードミックス",
  difference: "差の絶対値", exclusion: "除外", subtract: "減算", divide: "除算",
  hue: "色相", saturation: "彩度", color: "カラー", luminosity: "輝度",
};

export type LayerKind = "pixel" | "group" | "text" | "smart" | "fill" | "adjustment";

export type MaskData = {
  x: number; y: number; w: number; h: number;
  /** value outside the mask rectangle (0 or 255) */
  defaultColor: number;
  disabled: boolean;
  /** w * h grey values; null when the rectangle is empty */
  pixels: Uint8Array | null;
};

export type DocLayer = {
  id: number;
  /** id of the layer in the file this one comes from (a duplicate keeps its source's); null = created here */
  origId: number | null;
  /** created by duplicating `origId` (the saved file gets a copy of that layer) */
  dup: boolean;
  name: string;
  kind: LayerKind;
  hidden: boolean;
  /** 0..1 */
  opacity: number;
  /** 0..1 ("塗り") */
  fill: number;
  blendMode: LayerBlendMode;
  /** clipped to the layer below */
  clipping: boolean;
  /** pixel rectangle in document px */
  x: number; y: number; w: number; h: number;
  /** straight (not premultiplied) RGBA, w * h * 4; dropped after the GPU upload */
  pixels: Uint8ClampedArray | null;
  mask: MaskData | null;
  /** small preview (RGBA, thumbW x thumbH) */
  thumb: { w: number; h: number; data: Uint8ClampedArray } | null;
  children: DocLayer[] | null;
  /** group expanded in the panel */
  open: boolean;
  /** what this compositor does not render (shown as a warning mark) */
  warnings: string[];
};

export type PsdDocData = {
  width: number;
  height: number;
  bitsPerChannel: number;
  layers: DocLayer[];
  /** layer count incl. groups */
  count: number;
  decodeMs: number;
};

/** Depth-first walk (bottom -> top), children before nothing — callers decide. */
export function* walkLayers(layers: DocLayer[]): Generator<DocLayer> {
  for (const l of layers) {
    yield l;
    if (l.children) yield* walkLayers(l.children);
  }
}

/** Serializable description of the layer tree for saving (no pixels; the worker takes them from the file). */
export type PlanNode = {
  origId: number | null;
  dup: boolean;
  group: boolean;
  name: string;
  hidden: boolean;
  opacity: number;
  fill: number;
  blendMode: LayerBlendMode;
  clipping: boolean;
  maskDisabled: boolean | null;
  open: boolean;
  children: PlanNode[] | null;
};

export function toPlan(layers: DocLayer[]): PlanNode[] {
  return layers.map((l) => ({
    origId: l.origId, dup: l.dup, group: !!l.children, name: l.name, hidden: l.hidden,
    opacity: l.opacity, fill: l.fill, blendMode: l.blendMode, clipping: l.clipping,
    maskDisabled: l.mask ? l.mask.disabled : null, open: l.open,
    children: l.children ? toPlan(l.children) : null,
  }));
}

/** Copy of a layer tree for the undo history. Pixel data (thumbnails, mask pixels) is never edited in place,
 *  so it is shared instead of copied ($state.snapshot would clone every typed array). */
export function cloneTree(layers: DocLayer[]): DocLayer[] {
  return layers.map((l) => ({
    ...l,
    warnings: [...l.warnings],
    mask: l.mask ? { ...l.mask } : null,
    thumb: l.thumb ? { ...l.thumb } : null,
    children: l.children ? cloneTree(l.children) : null,
  }));
}
