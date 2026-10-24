// Desktop (Tauri) integration. Every function is a no-op / null outside Tauri so the UI also runs in a browser.
import { getName } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { SUPPORTED_EXT } from "./loader";
import { isTauri } from "./source";

/** Image files in the same folder as `path` (or inside `path` if it is a folder), natural-sorted. */
export async function listFolderImages(path: string): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("list_images", { path, extensions: SUPPORTED_EXT });
}

/** File paths passed on the command line ("Open with" / double click on an associated file). */
export async function startupPaths(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("startup_paths");
}

export async function pickFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const r = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "画像", extensions: SUPPORTED_EXT }, { name: "すべてのファイル", extensions: ["*"] }],
  });
  return typeof r === "string" ? r : null;
}

/** Native drag & drop (gives real paths). Returns an unlisten function. */
export async function onNativeDrop(handlers: { over: (on: boolean) => void; drop: (paths: string[]) => void }) {
  if (!isTauri()) return () => {};
  return getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload;
    if (p.type === "enter" || p.type === "over") handlers.over(true);
    else if (p.type === "leave") handlers.over(false);
    else if (p.type === "drop") { handlers.over(false); handlers.drop(p.paths); }
  });
}

let appNameP: Promise<string> | null = null;
/** productName of the running build ("OptImageEditor", or "OptImageEditor Dev" for `npm run app`). */
export function appName(): Promise<string> {
  return (appNameP ??= isTauri() ? getName().catch(() => "OptImageEditor") : Promise.resolve("OptImageEditor"));
}

/** Window title: "<doc> — <app name>", or just the app name when `doc` is empty. */
export async function setWindowTitle(doc: string) {
  const name = await appName();
  const title = doc ? `${doc} — ${name}` : name;
  if (isTauri()) await getCurrentWindow().setTitle(title);
  else document.title = title;
}

export async function toggleFullscreen() {
  if (isTauri()) {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}

/** Files sent by a second launch of the app (single instance): they are opened as new tabs here. */
export async function onOpenPaths(handler: (paths: string[]) => void) {
  if (!isTauri()) return () => {};
  return listen<string[]>("oie://open-paths", (e) => handler(e.payload));
}

/** Registers / unregisters the app in Explorer's "Open with" list (current user only, no admin rights). Returns the exe path. */
export async function setOpenWithRegistration(register: boolean): Promise<string> {
  return invoke<string>("register_open_with", { register, extensions: SUPPORTED_EXT });
}

export async function openDefaultAppsSettings() {
  if (isTauri()) await invoke("open_default_apps_settings");
}

export async function confirmDialog(text: string, title = "OptImageEditor"): Promise<boolean> {
  if (!isTauri()) return window.confirm(text);
  return ask(text, { title, kind: "info", okLabel: "はい", cancelLabel: "いいえ" });
}

export async function infoDialog(text: string, title = "OptImageEditor") {
  if (!isTauri()) { window.alert(text); return; }
  await message(text, { title, kind: "info" });
}

/** "Save as" dialog; null when cancelled (or not in the desktop app). */
export async function saveDialog(
  defaultPath: string,
  filters: { name: string; extensions: string[] }[] = [{ name: "Photoshop", extensions: ["psd", "psb"] }],
): Promise<string | null> {
  if (!isTauri()) return null;
  const r = await save({ defaultPath, filters });
  return r ?? null;
}

export type SavePsdResult = { bytes: number; ms: number; parseMs: number; compositeMs: number; writeMs: number };

/** Saves an edited PSD / PSB in Rust: layer records rebuilt from `plan`, channel data copied from `src`,
 *  `rgba` (premultiplied, width x height) as the new composite. */
export async function savePsd(
  req: { src: string; dst: string; backup: boolean; width: number; height: number; layerCount: number; plan: unknown },
  rgba: Uint8Array,
): Promise<SavePsdResult> {
  const json = new TextEncoder().encode(JSON.stringify(req));
  const body = new Uint8Array(4 + json.length + rgba.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(rgba, 4 + json.length);
  return invoke<SavePsdResult>("save_psd", body);
}

export type ResampleFilter = "nearest" | "bilinear" | "bicubic";
/** one axis of a resampling: output sample i comes from input position (i + 0.5) / k + c (sample j covers j..j+1) */
export type ResampleAxis = { n: number; k: number; c: number };

/** Resamples straight RGBA (`grey`: one byte per pixel; `outside`: its value outside the image, null: the edge
 *  repeats) in Rust, the same way the saved file's channels are (resample.rs). Null outside the desktop app. */
export async function resampleImage(px: Uint8Array, w: number, h: number, ax: ResampleAxis, ay: ResampleAxis,
  filter: ResampleFilter, grey: { outside: number | null } | null = null): Promise<Uint8Array | null> {
  if (!isTauri()) return null;
  const HEAD = 7 * 4 + 4 * 8;
  const body = new Uint8Array(HEAD + px.length);
  const dv = new DataView(body.buffer);
  const kind = grey ? (grey.outside === null ? 2 : 1) : 0;
  [kind, w, h, ax.n, ay.n, filter === "nearest" ? 0 : filter === "bilinear" ? 1 : 2, grey?.outside ?? 0].forEach((v, i) => dv.setUint32(i * 4, v, true));
  [ax.k, ax.c, ay.k, ay.c].forEach((v, i) => dv.setFloat64(28 + i * 8, v, true));
  body.set(px, HEAD);
  const out = await invoke<ArrayBuffer>("resample_image", body);
  return new Uint8Array(out);
}

/** Clipboard image through Rust (when navigator.clipboard.write is refused). False outside the desktop app. */
export async function copyImageFallback(w: number, h: number, rgba: Uint8ClampedArray): Promise<boolean> {
  if (!isTauri()) return false;
  const body = new Uint8Array(8 + rgba.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, w, true);
  dv.setUint32(4, h, true);
  body.set(rgba, 8);
  await invoke("copy_image", body);
  return true;
}

/** Writes `data` to `path` (via a temporary file). `backup`: keep the old file as `<path>.bak`. */
export async function writeFile(path: string, data: ArrayBuffer, backup: boolean) {
  await invoke("write_file", new Uint8Array(data), { headers: { "x-path": encodeURIComponent(path), "x-backup": backup ? "1" : "0" } });
}

/** Unsaved edits: closing the window asks `handler` first (true = close). The Rust side closes the window
 *  anyway if the page does not acknowledge within 3 s (hung / crashed WebView). */
export async function setCloseGuard(on: boolean) {
  if (isTauri()) await invoke("set_close_guard", { on });
}

export async function onCloseRequested(handler: () => Promise<boolean>) {
  if (!isTauri()) return () => {};
  return listen<number>("oie://close-requested", async (e) => {
    await invoke("close_ack", { seq: e.payload });
    if (await handler()) {
      await setCloseGuard(false);
      await getCurrentWindow().destroy();
    }
  });
}
