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
export const readTuning: { mode: "single" | "parallel"; chunkBytes: number } = { mode: "single", chunkBytes: 8 << 20 };

export class TauriFileSource implements FileSource {
  private constructor(readonly path: string, readonly size: number) {}
  get name() { return baseName(this.path); }

  static async open(path: string): Promise<TauriFileSource> {
    const info = await invoke<FileInfo>("file_info", { path });
    return new TauriFileSource(path, info.size);
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    const len = Math.max(0, Math.min(length, this.size - offset));
    const chunk = readTuning.chunkBytes;
    if (readTuning.mode === "single" || len <= chunk) {
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
