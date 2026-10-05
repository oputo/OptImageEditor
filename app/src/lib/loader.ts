// Loads a file source into a renderer-ready image (decoding happens in a Web Worker).
import type { DecodeRequest, DecodeResult } from "./decoder.worker";
import type { ImageSource } from "./renderer";
import { readPsdCompositeOnly } from "./psdSlice";
import { loadCompositeShared, readTuning, type FileSource } from "./source";

export const SUPPORTED_EXT = ["psd", "psb", "png", "jpg", "jpeg", "webp"];
export const isPsd = (name: string) => /\.(psd|psb)$/i.test(name);

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
};

const worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
let requestId = 0;

function decode(name: string, buffer: ArrayBuffer): Promise<DecodeResult> {
  const id = ++requestId;
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent<DecodeResult>) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      resolve(ev.data);
    };
    worker.addEventListener("message", onMsg);
    const req: DecodeRequest = { id, name, buffer };
    worker.postMessage(req, [buffer]);
  });
}

export async function loadImage(src: FileSource): Promise<LoadedImage> {
  const t0 = performance.now();
  let fallbackNote: string | undefined;

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
  if (isPsd(src.name)) {
    try {
      const r = await readPsdCompositeOnly(src);
      buffer = r.buffer;
      bytesRead = r.bytesRead;
      layerRecords = r.layerRecords;
    } catch (e) {
      console.warn("partial read failed, reading whole file", e);
      buffer = await src.readAll();
    }
  } else {
    buffer = await src.readAll();
  }
  const readMs = performance.now() - t0;

  const t1 = performance.now();
  const res = await decode(src.name, buffer);
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
