// Decodes image files off the UI thread.
// PSD/PSB: ag-psd reads only the stored composite image (layer pixels are skipped -> fast, low memory).
// PNG/JPG/WebP: decoded by the browser engine via createImageBitmap.
import { initializeCanvas, readPsd, type Layer } from "ag-psd";

// Workers have no `document`: give ag-psd OffscreenCanvas / ImageData factories.
initializeCanvas(
  (w, h) => new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement,
  (w, h) => new ImageData(w, h),
);

export type DecodeRequest = { id: number; name: string; buffer: ArrayBuffer };

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

self.onmessage = async (ev: MessageEvent<DecodeRequest>) => {
  const { id, name, buffer } = ev.data;
  const t0 = performance.now();
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
