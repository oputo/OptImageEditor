// Loads a file source into a renderer-ready image (decoding happens in a Web Worker).
import type { DecodeRequest, DecodeResult, LayersResult, SaveParams, SaveResult } from "./decoder.worker";
import type { PsdDocData } from "./psdDoc";
import type { ImageSource } from "./renderer";
import { readPsdCompositeOnly } from "./psdSlice";
import { loadCompositeShared, loadHdr, readTuning, type FileSource, type HdrInfo } from "./source";

export const SUPPORTED_EXT = ["psd", "psb", "png", "jpg", "jpeg", "webp", "exr", "hdr"];
export const isPsd = (name: string) => /\.(psd|psb)$/i.test(name);
export const isHdr = (name: string) => /\.(exr|hdr)$/i.test(name);

export type LoadStats = {
  fileSize: number;
  bytesRead: number;
  readMs: number;
  decodeMs: number;
  workerMs: number;
};

export type LoadedImage = {
  name: string;
  path: string | null;
  width: number;
  height: number;
  bitsPerChannel: number;
  layerInfo: string | null;
  note?: string;
  image: ImageSource;
  stats: LoadStats;
  /** set when `image` points into shared memory: call after uploading to the GPU */
  release?: () => void;
  /** how the bytes / pixels got here */
  via: string;
  /** set for EXR / HDR images (float data, shown with exposure) */
  hdr?: { info: HdrInfo; layer: number; float32: boolean };
};

export type LoadOptions = { /** EXR layer (channel group) index */ layer?: number };

const worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
let requestId = 0;

function decode(name: string, buffer: ArrayBuffer, unmatte = false): Promise<DecodeResult> {
  const id = ++requestId;
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent<DecodeResult>) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      resolve(ev.data);
    };
    worker.addEventListener("message", onMsg);
    const req: DecodeRequest = { id, name, buffer, unmatte };
    worker.postMessage(req, [buffer]);
  });
}

/** Reads the whole PSD and decodes its layer tree with pixels in the worker (phase 2-a). */
export async function loadLayers(src: FileSource): Promise<PsdDocData & { readMs: number }> {
  const t0 = performance.now();
  const buffer = await src.readAll();
  const readMs = performance.now() - t0;
  const id = ++requestId;
  const res = await new Promise<LayersResult>((resolve) => {
    const onMsg = (ev: MessageEvent<LayersResult>) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      resolve(ev.data);
    };
    worker.addEventListener("message", onMsg);
    const req: DecodeRequest = { id, name: src.name, buffer, mode: "layers" };
    worker.postMessage(req, [buffer]);
  });
  if (!res.ok) throw new Error(res.error);
  return { ...res.doc, readMs };
}

/** Rebuilds the PSD in the worker: the original file + the edited layer tree + a new composite. */
export async function buildPsd(original: ArrayBuffer, name: string, params: SaveParams): Promise<{ buffer: ArrayBuffer; ms: number }> {
  const id = ++requestId;
  const res = await new Promise<SaveResult>((resolve) => {
    const onMsg = (ev: MessageEvent<SaveResult>) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      resolve(ev.data);
    };
    worker.addEventListener("message", onMsg);
    const req: DecodeRequest = { id, name, buffer: original, mode: "save", save: params };
    worker.postMessage(req, [original, params.composite.buffer as ArrayBuffer]);
  });
  if (!res.ok) throw new Error(res.error);
  return { buffer: res.buffer, ms: res.ms };
}

export async function loadImage(src: FileSource, opts: LoadOptions = {}): Promise<LoadedImage> {
  const t0 = performance.now();
  let fallbackNote: string | undefined;

  // EXR / Radiance HDR: decoded by Rust to half floats (desktop only)
  if (isHdr(src.name)) {
    if (!src.path) throw new Error("EXR / HDR はデスクトップ版でのみ表示できます");
    const { load, buffer, release, via } = await loadHdr(src.path, opts.layer ?? 0);
    const l = load.info.layers[load.layer];
    const float32 = l.channels.some((c) => c.endsWith(":f32") || c.endsWith(":u32"));
    return {
      name: src.name,
      path: src.path,
      width: load.width,
      height: load.height,
      bitsPerChannel: float32 ? 32 : 16,
      layerInfo: `${load.info.format} ${load.info.compression}${load.info.layers.length > 1 ? ` / ${l.name}（${load.layer + 1}/${load.info.layers.length}）` : ""}`,
      note: float32 ? "表示用に 16bit float へ変換" : undefined,
      image: { kind: "half", width: load.width, height: load.height, data: new Uint16Array(buffer) },
      stats: { fileSize: src.size, bytesRead: src.size, readMs: 0, decodeMs: load.decodeMs, workerMs: performance.now() - t0 },
      release,
      via,
      hdr: { info: load.info, layer: load.layer, float32 },
    };
  }

  // Fast path (desktop, Windows): Rust decodes the PSD composite in parallel into shared memory
  if (src.path && isPsd(src.name) && readTuning.mode === "shared") {
    const { load, pixels } = await loadCompositeShared(src.path);
    if (pixels && load.info) {
      const info = load.info;
      return {
        name: src.name,
        path: src.path,
        width: info.width,
        height: info.height,
        bitsPerChannel: info.depth,
        layerInfo: `${Math.abs(info.layerCount)} layer records${info.hasAlpha ? " (transparent)" : ""}`,
        note: info.depth > 8 ? "表示用に 8bit へ変換" : undefined,
        image: { kind: "rgba", width: info.width, height: info.height, data: new Uint8ClampedArray(pixels.buffer), premultiplied: true },
        stats: { fileSize: src.size, bytesRead: info.imageDataLen, readMs: load.readMs, decodeMs: load.decodeMs, workerMs: performance.now() - t0 },
        release: pixels.release,
        via: "shared + Rust decode",
      };
    }
    if (load.unsupported) fallbackNote = `Rust デコード非対応: ${load.unsupported}`;
  }

  let buffer: ArrayBuffer;
  let bytesRead = src.size;
  let layerRecords: number | null = null;
  let unmatte = false;
  if (isPsd(src.name)) {
    try {
      const r = await readPsdCompositeOnly(src);
      buffer = r.buffer;
      bytesRead = r.bytesRead;
      layerRecords = r.layerRecords;
      unmatte = r.transparent;
    } catch (e) {
      console.warn("partial read failed, reading whole file", e);
      buffer = await src.readAll();
    }
  } else {
    buffer = await src.readAll();
  }
  const readMs = performance.now() - t0;

  const t1 = performance.now();
  const res = await decode(src.name, buffer, unmatte);
  const workerMs = performance.now() - t1;
  if (!res.ok) throw new Error(res.error);

  const image: ImageSource = res.rgba
    ? { kind: "rgba", width: res.width, height: res.height, data: res.rgba }
    : { kind: "bitmap", width: res.width, height: res.height, bitmap: res.bitmap! };

  return {
    name: src.name,
    path: src.path,
    width: res.width,
    height: res.height,
    bitsPerChannel: res.bitsPerChannel,
    layerInfo: layerRecords !== null ? `${layerRecords} layer records` : res.layerCount !== null ? `${res.layerCount} layers` : null,
    note: [res.note, fallbackNote].filter(Boolean).join(" / ") || undefined,
    image,
    stats: { fileSize: src.size, bytesRead, readMs, decodeMs: res.decodeMs, workerMs },
    via: src.path ? `${readTuning.lastUsed || readTuning.mode} + JS decode` : "browser + JS decode",
  };
}
