// Desktop (Tauri) integration. Every function is a no-op / null outside Tauri so the UI also runs in a browser.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
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
