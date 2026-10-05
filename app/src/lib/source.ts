// Random-access file sources.
// - TauriFileSource: reads byte ranges of a local path through Rust commands (desktop app)
// - BrowserFileSource: wraps a DOM File (browser / HTML5 drop fallback)
import { invoke } from "@tauri-apps/api/core";

export interface FileSource {
  /** display name (file name only) */
  readonly name: string;
  /** absolute path when known (Tauri), otherwise null */
  readonly path: string | null;
  readonly size: number;
  read(offset: number, length: number): Promise<ArrayBuffer>;
  readAll(): Promise<ArrayBuffer>;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export class BrowserFileSource implements FileSource {
  readonly path = null;
  constructor(private file: File) {}
  get name() { return this.file.name; }
  get size() { return this.file.size; }
  read(offset: number, length: number) {
    return this.file.slice(offset, Math.min(this.file.size, offset + length)).arrayBuffer();
  }
  readAll() { return this.file.arrayBuffer(); }
}

export type FileInfo = { size: number; modifiedMs: number };

/** Diagnostics: how large reads go through the Tauri IPC (switch with F3 in the app). */
export type ReadMode = "shared" | "single" | "parallel";
export const READ_MODES: ReadMode[] = ["shared", "single", "parallel"];
export const READ_MODE_LABEL: Record<ReadMode, string> = { shared: "共有メモリ", single: "IPC 一括", parallel: "IPC 分割並列" };
export const readTuning: { mode: ReadMode; chunkBytes: number; lastUsed: string } = { mode: "shared", chunkBytes: 8 << 20, lastUsed: "" };

// ---- WebView2 SharedBuffer (Windows): Rust reads the file straight into shared memory and posts it to the page
type SharedBufferEvent = Event & { additionalData: { oieId?: number }; getBuffer(): ArrayBuffer };
type ChromeWebview = {
  addEventListener(type: "sharedbufferreceived", cb: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buf: ArrayBuffer): void;
};
const chromeWebview = (): ChromeWebview | undefined =>
  (window as unknown as { chrome?: { webview?: ChromeWebview } }).chrome?.webview;

let sharedSeq = 0;
const sharedWaiters = new Map<number, (buf: ArrayBuffer) => void>();
let sharedListening = false;

function listenShared(wv: ChromeWebview) {
  if (sharedListening) return;
  sharedListening = true;
  wv.addEventListener("sharedbufferreceived", (e) => {
    const id = e.additionalData?.oieId;
    const buf = e.getBuffer();
    const resolve = id !== undefined ? sharedWaiters.get(id) : undefined;
    if (!resolve) { wv.releaseBuffer(buf); return; }
    sharedWaiters.delete(id!);
    // copy out of the shared memory and release it right away (the copy is a plain, transferable ArrayBuffer)
    const copy = buf.slice(0);
    wv.releaseBuffer(buf);
    resolve(copy);
  });
}

/** Returns null when shared buffers are not available (not Windows / old WebView2), so the caller can fall back. */
async function readShared(path: string, offset: number, length: number): Promise<ArrayBuffer | null> {
  const wv = chromeWebview();
  if (!wv) return null;
  listenShared(wv);
  const id = ++sharedSeq;
  const arrived = new Promise<ArrayBuffer>((resolve, reject) => {
    sharedWaiters.set(id, resolve);
    setTimeout(() => { if (sharedWaiters.delete(id)) reject(new Error("shared buffer timeout")); }, 30000);
  });
  let posted: boolean;
  try {
    posted = await invoke<boolean>("read_range_shared", { path, offset, length, id });
  } catch (e) {
    sharedWaiters.delete(id);
    throw e;
  }
  if (!posted) { sharedWaiters.delete(id); return null; }
  return arrived;
}

export class TauriFileSource implements FileSource {
  private constructor(readonly path: string, readonly size: number) {}
  get name() { return baseName(this.path); }

  static async open(path: string): Promise<TauriFileSource> {
    const info = await invoke<FileInfo>("file_info", { path });
    return new TauriFileSource(path, info.size);
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    const len = Math.max(0, Math.min(length, this.size - offset));
    if (len === 0) return new ArrayBuffer(0);
    if (readTuning.mode === "shared") {
      const buf = await readShared(this.path, offset, len);
      if (buf) { readTuning.lastUsed = "shared"; return buf; }
      // not available -> fall through to IPC
    }
    readTuning.lastUsed = readTuning.mode === "parallel" && len > readTuning.chunkBytes ? "parallel" : "single";
    const chunk = readTuning.chunkBytes;
    if (readTuning.mode !== "parallel" || len <= chunk) {
      // Rust returns raw bytes (tauri::ipc::Response) -> ArrayBuffer, no JSON/base64 overhead
      return invoke<ArrayBuffer>("read_range", { path: this.path, offset, length: len });
    }
    // parallel: split into chunks, request them concurrently, then join
    const parts: Promise<ArrayBuffer>[] = [];
    for (let o = 0; o < len; o += chunk) {
      parts.push(invoke<ArrayBuffer>("read_range", { path: this.path, offset: offset + o, length: Math.min(chunk, len - o) }));
    }
    const bufs = await Promise.all(parts);
    const out = new Uint8Array(len);
    let p = 0;
    for (const b of bufs) { out.set(new Uint8Array(b), p); p += b.byteLength; }
    return out.buffer;
  }

  readAll() { return this.read(0, this.size); }
}
