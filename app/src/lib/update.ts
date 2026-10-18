// In-app update (src-tauri/src/update.rs), the app's version and its page on the web site.
import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./source";

export const WEB_PAGE = "https://oputo.com/apps/#optimageeditor";

export type UpdateInfo = { version: string; currentVersion: string; notes: string | null };
/** `latest`: the endpoints have this version; `notFound`: no endpoint had release information */
export type CheckResult = ({ status: "available" } & UpdateInfo) | { status: "latest" } | { status: "notFound" };

export function appVersion(): Promise<string> {
  return isTauri() ? getVersion() : Promise.resolve("browser");
}

export function checkUpdate(): Promise<CheckResult> {
  return invoke<CheckResult>("update_check");
}

/** downloads and installs the update found by `checkUpdate`; `installing`: the download is done and the installer
 *  starts in a moment. On Windows the app exits when the installer starts (and the installer restarts it). */
export async function installUpdate(onProgress: (done: number, total: number | null, installing: boolean) => void): Promise<void> {
  const ch = new Channel<{ done: number; total: number | null; installing: boolean }>();
  ch.onmessage = (p) => onProgress(p.done, p.total, p.installing);
  await invoke("update_install", { onProgress: ch });
}

export function openWebPage() {
  if (isTauri()) invoke("open_web_page").catch((e) => console.error(e));
  else window.open(WEB_PAGE, "_blank", "noopener");
}
