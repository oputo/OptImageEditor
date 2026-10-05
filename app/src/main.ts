// OptImageEditor — phase 0 viewer spike.
// Opens PSD / PNG / JPG, shows the image with WebGL2 (zoom / pan) and reports timing and memory.
import { Renderer } from "./renderer";
import { readPsdCompositeOnly } from "./psdSlice";
import type { DecodeRequest, DecodeResult } from "./decoder.worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const stage = $<HTMLElement>("stage");
const statsEl = $<HTMLPreElement>("stats");
const busyEl = $<HTMLElement>("busy");
const hintEl = $<HTMLElement>("drop-hint");
const zoomLabel = $<HTMLElement>("zoom-label");
const fileLabel = $<HTMLElement>("file-label");
const fileInput = $<HTMLInputElement>("file-input");

const renderer = new Renderer(canvas);
const worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });

let requestId = 0;
let lastStats = "";

const mb = (n: number) => (n / 2 ** 20).toFixed(1) + " MB";
const ms = (n: number) => n.toFixed(0) + " ms";
const jsHeap = () => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? mb(m.usedJSHeapSize) : "n/a";
};

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

async function openFile(file: File) {
  busyEl.hidden = false;
  hintEl.hidden = true;
  fileLabel.textContent = file.name;
  await new Promise((r) => requestAnimationFrame(() => r(null))); // let the busy label paint
  const t0 = performance.now();
  try {
    // PSD/PSB: read only header + resources + composite (skip the layer section). Fallback: whole file.
    let buffer: ArrayBuffer;
    let layerRecords: number | null = null;
    let readNote = "whole file";
    if (/\.(psd|psb)$/i.test(file.name)) {
      try {
        const r = await readPsdCompositeOnly(file);
        buffer = r.buffer;
        layerRecords = r.layerRecords;
        readNote = `composite only: ${mb(r.bytesRead)} of ${mb(file.size)}`;
      } catch (e) {
        console.warn("partial read failed, reading whole file", e);
        buffer = await file.arrayBuffer();
      }
    } else {
      buffer = await file.arrayBuffer();
    }
    const tRead = performance.now() - t0;
    const t1 = performance.now();
    const res = await decode(file.name, buffer);
    const tWorker = performance.now() - t1;
    if (!res.ok) throw new Error(res.error);

    const tUpload = await renderer.setImage(
      res.rgba
        ? { kind: "rgba", width: res.width, height: res.height, data: res.rgba }
        : { kind: "bitmap", width: res.width, height: res.height, bitmap: res.bitmap! },
    );
    renderer.fit();
    const total = performance.now() - t0;

    const tiles = Math.ceil(res.width / Math.min(renderer.maxTextureSize, 8192)) * Math.ceil(res.height / Math.min(renderer.maxTextureSize, 8192));
    lastStats = [
      `file        ${file.name}`,
      `file size   ${mb(file.size)}`,
      `image       ${res.width} x ${res.height}  ${res.bitsPerChannel}bit${layerRecords !== null ? `  layer records ${layerRecords}` : res.layerCount !== null ? `  layers ${res.layerCount}` : ""}${res.note ? `  (${res.note})` : ""}`,
      `read file   ${ms(tRead)}  (${readNote})`,
      `decode      ${ms(res.decodeMs)}  (worker round-trip ${ms(tWorker)})`,
      `GPU upload  ${ms(tUpload)}  tiles ${tiles}  max tex ${renderer.maxTextureSize}`,
      `TOTAL       ${ms(total)}`,
      `texture mem ${mb(renderer.textureBytes)}`,
      `JS heap     ${jsHeap()}`,
      `UA          ${navigator.userAgent.match(/(Edg|Chrome)\/[\d.]+/g)?.join(" ") ?? navigator.userAgent}`,
    ].join("\n");
    statsEl.textContent = lastStats;
    statsEl.hidden = false;
    console.info("[OptImageEditor] load stats\n" + lastStats);
  } catch (e) {
    renderer.clear();
    renderer.requestDraw();
    statsEl.textContent = `エラー: ${e instanceof Error ? e.message : String(e)}`;
    statsEl.hidden = false;
    hintEl.hidden = false;
    console.error(e);
  } finally {
    busyEl.hidden = true;
    updateZoomLabel();
  }
}

function updateZoomLabel() {
  zoomLabel.textContent = renderer.hasImage ? `${(renderer.scale * 100).toFixed(renderer.scale < 0.1 ? 1 : 0)}%` : "-";
}

// ---- open: button / input / drag & drop (HTML5 DnD; Tauri's native drop is disabled in tauri.conf.json)
$("btn-open").onclick = () => fileInput.click();
fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) openFile(f); fileInput.value = ""; };
stage.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("drag-over"); });
stage.addEventListener("dragleave", () => stage.classList.remove("drag-over"));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("drag-over");
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---- zoom / pan
$("btn-fit").onclick = () => { renderer.fit(); updateZoomLabel(); };
$("btn-100").onclick = () => { renderer.zoomAt(1, renderer.viewWidth / 2, renderer.viewHeight / 2); updateZoomLabel(); };
$("btn-copy").onclick = async () => { if (lastStats) await navigator.clipboard.writeText(lastStats); };

canvas.addEventListener("wheel", (e) => {
  if (!renderer.hasImage) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
  renderer.zoomAt(renderer.scale * factor, e.clientX - r.left, e.clientY - r.top);
  updateZoomLabel();
}, { passive: false });

let panning = false;
let spaceDown = false;
let lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (!renderer.hasImage) return;
  if (e.button === 0 || e.button === 1 || spaceDown) {
    panning = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("panning");
    e.preventDefault();
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (!panning) return;
  renderer.panBy(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX; lastY = e.clientY;
});
const endPan = () => { panning = false; canvas.classList.remove("panning"); };
canvas.addEventListener("pointerup", endPan);
canvas.addEventListener("pointercancel", endPan);

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") spaceDown = true;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "o") { e.preventDefault(); fileInput.click(); }
  else if (ctrl && e.key === "0") { e.preventDefault(); renderer.fit(); }
  else if (ctrl && e.key === "1") { e.preventDefault(); renderer.zoomAt(1, renderer.viewWidth / 2, renderer.viewHeight / 2); }
  else if (ctrl && (e.key === "+" || e.key === "=" || e.key === ";")) { e.preventDefault(); renderer.zoomAt(renderer.scale * 1.25, renderer.viewWidth / 2, renderer.viewHeight / 2); }
  else if (ctrl && e.key === "-") { e.preventDefault(); renderer.zoomAt(renderer.scale / 1.25, renderer.viewWidth / 2, renderer.viewHeight / 2); }
  updateZoomLabel();
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });

new ResizeObserver(() => renderer.resize()).observe(canvas);
renderer.resize();

// test hook (used by automated checks; harmless in the app)
(window as unknown as { __oie: unknown }).__oie = { openFile, renderer, get stats() { return lastStats; } };
