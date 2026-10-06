// Desktop (Tauri) integration. Every function is a no-op / null outside Tauri so the UI also runs in a browser.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
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

export async function setWindowTitle(title: string) {
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
