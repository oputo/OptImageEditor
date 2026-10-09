// Decodes image files off the UI thread.
// PSD/PSB: ag-psd reads only the stored composite image (layer pixels are skipped -> fast, low memory).
// PNG/JPG/WebP: decoded by the browser engine via createImageBitmap.
import { initializeCanvas, readPsd, writePsd, type Layer } from "ag-psd";
import { maskThumbOf, thumbOf, type DocLayer, type LayerBlendMode, type LayerKind, type PlanNode, type PsdDocData } from "./psdDoc";

// Workers have no `document`: give ag-psd OffscreenCanvas / ImageData factories.
initializeCanvas(
  (w, h) => new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement,
  (w, h) => new ImageData(w, h),
);

export type DecodeRequest = {
  id: number; name: string; buffer: ArrayBuffer;
  /** "layers": read the layer tree with pixels (PSD only); "save": rebuild the PSD from `save` */
  mode?: "composite" | "layers" | "save";
  save?: SaveParams;
  /** PSD composite from a rebuilt file without layer section: remove the white matte here */
  unmatte?: boolean;
};

/** Rebuild of the original file (`buffer`) with the edited layer tree and a new composite (straight RGBA). */
export type SaveParams = { plan: PlanNode[]; composite: Uint8ClampedArray; width: number; height: number; psb: boolean };
export type SaveResult = { id: number; ok: true; buffer: ArrayBuffer; ms: number } | { id: number; ok: false; error: string };

export type LayersResult = { id: number; ok: true; doc: PsdDocData } | { id: number; ok: false; error: string };

export type DecodeResult =
  | {
      id: number;
      ok: true;
      kind: "psd" | "raster";
      width: number;
      height: number;
      bitsPerChannel: number;
      layerCount: number | null;
      decodeMs: number;
      // exactly one of these is set
      rgba?: Uint8ClampedArray; // PSD composite, RGBA 8bit
      bitmap?: ImageBitmap; // raster formats
      note?: string;
    }
  | { id: number; ok: false; error: string };

const countLayers = (layers?: Layer[]): number =>
  (layers ?? []).reduce((n, l) => n + 1 + countLayers(l.children), 0);

// 16/32bit composite -> 8bit RGBA for display only
function toRgba8(data: Uint8ClampedArray | Uint16Array | Float32Array | Uint8Array, w: number, h: number): Uint8ClampedArray {
  const px = w * h;
  const ch = Math.round(data.length / px);
  if (data instanceof Uint8ClampedArray && ch === 4) return data;
  const out = new Uint8ClampedArray(px * 4);
  const scale = data instanceof Uint16Array ? 1 / 257 : data instanceof Float32Array ? 255 : 1;
  for (let i = 0; i < px; i++) {
    const s = i * ch, d = i * 4;
    const r = data[s] * scale;
    out[d] = r;
    out[d + 1] = ch >= 3 ? data[s + 1] * scale : r;
    out[d + 2] = ch >= 3 ? data[s + 2] * scale : r;
    out[d + 3] = ch === 4 ? data[s + 3] * scale : ch === 2 ? data[s + 1] * scale : 255;
  }
  return out;
}

// ---------------------------------------------------------------- layers (phase 2-a)


function kindOf(l: Layer): LayerKind {
  if (l.children) return "group";
  if (l.adjustment) return "adjustment";
  if (l.text) return "text";
  if (l.placedLayer) return "smart";
  if (l.vectorFill) return "fill";
  return "pixel";
}

function effectsEnabled(l: Layer): boolean {
  const fx = l.effects;
  if (!fx || fx.disabled) return false;
  return Object.entries(fx).some(([k, v]) => {
    if (k === "disabled" || k === "scale") return false;
    const list = Array.isArray(v) ? v : [v];
    return list.some((e) => e && (e as { enabled?: boolean }).enabled !== false);
  });
}

function lockFlags(l: Layer): number {
  const p = l.protected as (Layer["protected"] & { all?: boolean }) | undefined;
  if (!p) return 0;
  return ((p.transparency ? 0x01 : 0) | (p.composite ? 0x02 : 0) | (p.position ? 0x04 : 0) | (p.artboards ? 0x08 : 0) | (p.all ? 0x80000000 : 0)) >>> 0;
}

function convertLayers(layers: Layer[] | undefined, seq: { n: number }, transfer: ArrayBuffer[]): DocLayer[] {
  return (layers ?? []).map((l) => {
    const kind = kindOf(l);
    const x = l.left ?? 0, y = l.top ?? 0;
    const w = Math.max(0, (l.right ?? 0) - x), h = Math.max(0, (l.bottom ?? 0) - y);
    const img = l.imageData;
    let pixels: Uint8ClampedArray | null = null;
    if (img && img.width === w && img.height === h && w > 0 && h > 0) {
      pixels = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data as ArrayLike<number>);
    }
    const warnings: string[] = [];
    if (kind === "adjustment") warnings.push(`調整レイヤー（${l.adjustment!.type}）は未対応`);
    if (effectsEnabled(l)) warnings.push("レイヤー効果は描画しない（PS の統合画像との差が出る）");
    if (l.vectorMask) warnings.push("ベクトルマスクは未対応");
    if (l.blendMode === "linear height" || l.blendMode === "height" || l.blendMode === "subtraction") warnings.push(`描画モード ${l.blendMode} は未対応`);

    let mask: DocLayer["mask"] = null;
    if (l.mask) {
      const m = l.mask;
      const mx = m.left ?? 0, my = m.top ?? 0;
      const mw = Math.max(0, (m.right ?? 0) - mx), mh = Math.max(0, (m.bottom ?? 0) - my);
      let mp: Uint8Array | null = null;
      if (m.imageData && m.imageData.width === mw && m.imageData.height === mh && mw > 0 && mh > 0) {
        const src = m.imageData.data;
        mp = new Uint8Array(mw * mh);
        for (let i = 0; i < mp.length; i++) mp[i] = src[i * 4] as number;
        transfer.push(mp.buffer as ArrayBuffer);
      }
      const thumb = maskThumbOf(mp, mw, mh, m.defaultColor ?? 255);
      transfer.push(thumb.data.buffer as ArrayBuffer);
      mask = { x: mx, y: my, w: mp ? mw : 0, h: mp ? mh : 0, defaultColor: m.defaultColor ?? 255, disabled: !!m.disabled, pixels: mp, thumb, withVector: !!l.vectorMask };
    }
    const thumb = pixels ? thumbOf(pixels, w, h) : null;
    if (pixels) transfer.push(pixels.buffer as ArrayBuffer);
    if (thumb) transfer.push(thumb.data.buffer);
    const children = l.children ? convertLayers(l.children, seq, transfer) : null;
    const id = ++seq.n; // post-order (children first): saveDoc() walks the file the same way
    return {
      id,
      origId: id,
      dup: false,
      raster: false,
      background: false,
      locks: lockFlags(l),
      name: l.name ?? "",
      kind,
      hidden: !!l.hidden,
      opacity: l.opacity ?? 1,
      fill: l.fillOpacity ?? 1,
      blendMode: (l.blendMode ?? (children ? "pass through" : "normal")) as LayerBlendMode,
      clipping: !!l.clipping,
      x, y, w: pixels ? w : 0, h: pixels ? h : 0,
      pixels,
      mask,
      maskEdited: false,
      thumb,
      children,
      open: !!l.opened,
      warnings,
    };
  });
}

// ---------------------------------------------------------------- save (phase 2-b)

function saveDoc(id: number, buffer: ArrayBuffer, p: SaveParams) {
  const t0 = performance.now();
  // full read: layer pixels and embedded smart object files are written back unchanged
  const psd = readPsd(buffer, { useImageData: true, useRawThumbnail: true, skipCompositeImageData: true });
  const byId = new Map<number, Layer>();
  let n = 0;
  const walk = (ls: Layer[] | undefined) => { for (const l of ls ?? []) { walk(l.children); byId.set(++n, l); } };
  walk(psd.children);

  const clone = (l: Layer): Layer => {
    const c = structuredClone(l) as Layer;
    const strip = (x: Layer) => { delete x.id; x.children?.forEach(strip); }; // new layer ids are assigned on write
    strip(c);
    return c;
  };
  const build = (nodes: PlanNode[]): Layer[] => nodes.map((q) => {
    let l: Layer;
    if (q.raster) throw new Error("ブラウザ版では、結合・統合したレイヤーを含む PSD の保存に未対応です");
    if (q.origId !== null) {
      const src = byId.get(q.origId);
      if (!src) throw new Error(`layer ${q.origId} not found in the file`);
      l = q.dup ? clone(src) : src;
    } else {
      l = q.group ? { children: [] } : { left: 0, top: 0, right: 0, bottom: 0 };
    }
    l.name = q.name;
    l.hidden = q.hidden;
    l.opacity = q.opacity;
    if (q.fill !== 1 || l.fillOpacity !== undefined) l.fillOpacity = q.fill;
    l.blendMode = q.blendMode;
    l.clipping = q.clipping;
    if (l.mask && q.maskDisabled !== null) l.mask.disabled = q.maskDisabled;
    if (q.group) {
      l.children = build(q.children ?? []);
      l.opened = q.open;
    }
    return l;
  });
  psd.children = build(p.plan);
  // resources that list the layers by index would no longer match: Photoshop rebuilds them
  if (psd.imageResources) {
    const r = psd.imageResources as Record<string, unknown>; // some of these are not in ag-psd's typings
    for (const k of ["layerState", "layersGroup", "layerGroupsEnabledId", "layerSelectionIds"]) delete r[k];
  }
  psd.imageData = { width: p.width, height: p.height, data: p.composite };
  const out = writePsd(psd, { generateThumbnail: false, trimImageData: false, psb: p.psb });
  const res: SaveResult = { id, ok: true, buffer: out, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(res, [out]);
}

function readLayers(id: number, buffer: ArrayBuffer) {
  const t0 = performance.now();
  const psd = readPsd(buffer, {
    skipCompositeImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true, // embedded smart object files: large and not needed for display
    useImageData: true,
  });
  const bits = psd.bitsPerChannel ?? 8;
  if (bits !== 8) throw new Error(`${bits}bit の PSD はレイヤー表示に未対応です（8bit のみ）`);
  if (psd.colorMode !== undefined && psd.colorMode !== 3) throw new Error("RGB 以外のカラーモードはレイヤー表示に未対応です");
  const transfer: ArrayBuffer[] = [];
  const seq = { n: 0 };
  const layers = convertLayers(psd.children, seq, transfer);
  if (!layers.length) {
    // a document without layers (flattened): its composite is the background layer. It is not a layer of the
    // file (count stays 0), so it is saved from its pixels ("raster")
    const full = readPsd(buffer, { skipLayerImageData: true, skipThumbnail: true, skipLinkedFilesData: true, useImageData: true });
    const img = full.imageData;
    if (img) {
      const px = toRgba8(img.data as Uint8ClampedArray, psd.width, psd.height);
      for (let i = 3; i < px.length; i += 4) px[i] = 255; // a background is opaque
      const thumb = thumbOf(px, psd.width, psd.height);
      transfer.push(px.buffer as ArrayBuffer);
      if (thumb) transfer.push(thumb.data.buffer as ArrayBuffer);
      layers.push({
        id: 1, origId: null, dup: false, raster: true, background: true, locks: 0, name: "背景", kind: "pixel",
        hidden: false, opacity: 1, fill: 1, blendMode: "normal", clipping: false, x: 0, y: 0, w: psd.width, h: psd.height,
        pixels: px, mask: null, maskEdited: false, thumb, children: null, open: true, warnings: [],
      });
    }
  }
  const doc: PsdDocData = { width: psd.width, height: psd.height, bitsPerChannel: bits, layers, count: seq.n, decodeMs: performance.now() - t0 };
  const res: LayersResult = { id, ok: true, doc };
  (self as unknown as Worker).postMessage(res, transfer);
}

/** Same as ag-psd does when the layer count is negative: C = (C' - 255) / a + 255. */
function removeWhiteMatte(p: Uint8ClampedArray) {
  for (let i = 0; i < p.length; i += 4) {
    const pa = p[i + 3];
    if (pa === 0 || pa === 255) continue;
    const ra = 255 / pa, invA = 255 * (1 - ra);
    p[i] = p[i] * ra + invA;
    p[i + 1] = p[i + 1] * ra + invA;
    p[i + 2] = p[i + 2] * ra + invA;
  }
}

self.onmessage = async (ev: MessageEvent<DecodeRequest>) => {
  const { id, name, buffer } = ev.data;
  const t0 = performance.now();
  if (ev.data.mode === "save") {
    try {
      saveDoc(id, buffer, ev.data.save!);
    } catch (e) {
      const res: SaveResult = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
      (self as unknown as Worker).postMessage(res);
    }
    return;
  }
  if (ev.data.mode === "layers") {
    try {
      readLayers(id, buffer);
    } catch (e) {
      const res: LayersResult = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
      (self as unknown as Worker).postMessage(res);
    }
    return;
  }
  try {
    if (/\.(psd|psb)$/i.test(name)) {
      const psd = readPsd(buffer, {
        skipLayerImageData: true,
        skipThumbnail: true,
        skipLinkedFilesData: true,
        useImageData: true,
      });
      const layerCount = countLayers(psd.children);
      const img = psd.imageData;
      if (!img) {
        const res: DecodeResult = {
          id, ok: false,
          error: "統合画像がありません（PS の「互換性を優先」がオフで保存された可能性）。レイヤー合成は未実装です。",
        };
        (self as unknown as Worker).postMessage(res);
        return;
      }
      const rgba = toRgba8(img.data as Uint8ClampedArray, psd.width, psd.height);
      if (ev.data.unmatte) removeWhiteMatte(rgba);
      const res: DecodeResult = {
        id, ok: true, kind: "psd",
        width: psd.width, height: psd.height,
        bitsPerChannel: psd.bitsPerChannel ?? 8,
        layerCount,
        decodeMs: performance.now() - t0,
        rgba,
        note: (psd.bitsPerChannel ?? 8) > 8 ? "表示用に 8bit へ変換" : undefined,
      };
      (self as unknown as Worker).postMessage(res, [rgba.buffer]);
    } else {
      const bitmap = await createImageBitmap(new Blob([buffer]), {
        premultiplyAlpha: "premultiply",
        colorSpaceConversion: "default",
      });
      const res: DecodeResult = {
        id, ok: true, kind: "raster",
        width: bitmap.width, height: bitmap.height,
        bitsPerChannel: 8, layerCount: null,
        decodeMs: performance.now() - t0,
        bitmap,
      };
      (self as unknown as Worker).postMessage(res, [bitmap]);
    }
  } catch (e) {
    const res: DecodeResult = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    (self as unknown as Worker).postMessage(res);
  }
};
