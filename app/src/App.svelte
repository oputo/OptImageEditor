<script lang="ts">
  // OptImageEditor — phase 1-a: image viewer shell.
  import { onMount } from "svelte";
  import Viewer from "./lib/Viewer.svelte";
  import type { Renderer } from "./lib/renderer";
  import { loadImage, SUPPORTED_EXT, type LoadedImage } from "./lib/loader";
  import { BrowserFileSource, TauriFileSource, baseName, isTauri, type FileSource } from "./lib/source";
  import { listFolderImages, onNativeDrop, pickFile, setWindowTitle, startupPaths, toggleFullscreen } from "./lib/desktop";

  type Meta = Omit<LoadedImage, "image"> & { uploadMs: number; totalMs: number };

  let renderer = $state<Renderer | undefined>();
  let current = $state<Meta | null>(null);
  let folder = $state<string[]>([]);
  let folderDir: string | null = null;
  let index = $state(-1);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let zoom = $state(0);
  let dragOver = $state(false);
  let showStats = $state(false);
  let fileInput: HTMLInputElement;
  let loadToken = 0;

  const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
  const mb = (n: number) => (n / 2 ** 20).toFixed(1) + " MB";
  const ms = (n: number) => n.toFixed(0) + " ms";

  async function show(src: FileSource) {
    const token = ++loadToken;
    loading = true;
    error = null;
    const t0 = performance.now();
    try {
      const img = await loadImage(src);
      if (token !== loadToken || !renderer) return; // a newer request superseded this one
      const uploadMs = await renderer.setImage(img.image);
      renderer.fit();
      zoom = renderer.scale;
      const { image: _img, ...meta } = img;
      current = { ...meta, uploadMs, totalMs: performance.now() - t0 };
      const pos = folder.length ? ` (${index + 1}/${folder.length})` : "";
      setWindowTitle(`${img.name}${pos} — OptImageEditor`);
    } catch (e) {
      if (token !== loadToken) return;
      renderer?.clear();
      renderer?.requestDraw();
      current = null;
      error = `${src.name}: ${e instanceof Error ? e.message : String(e)}`;
      console.error(e);
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  async function openPath(path: string) {
    const dir = dirOf(path);
    if (dir !== folderDir) {
      folderDir = dir;
      folder = await listFolderImages(path);
    }
    index = folder.findIndex((p) => p.toLowerCase() === path.toLowerCase());
    try {
      await show(await TauriFileSource.open(path));
    } catch (e) {
      error = `${baseName(path)}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function openBrowserFile(file: File) {
    folder = [];
    folderDir = null;
    index = -1;
    show(new BrowserFileSource(file));
  }

  async function openDialog() {
    if (isTauri()) {
      const p = await pickFile();
      if (p) openPath(p);
    } else {
      fileInput.click();
    }
  }

  function step(delta: number) {
    if (folder.length < 2) return;
    const i = (index + delta + folder.length) % folder.length;
    openPath(folder[i]);
  }

  function goTo(i: number) {
    if (folder.length) openPath(folder[Math.max(0, Math.min(folder.length - 1, i))]);
  }

  function fit() { renderer?.fit(); zoom = renderer?.scale ?? 0; }
  function zoomTo(scale: number) {
    if (!renderer?.hasImage) return;
    renderer.zoomAt(scale, renderer.viewWidth / 2, renderer.viewHeight / 2);
    zoom = renderer.scale;
  }

  function closeImage() {
    loadToken++;
    renderer?.clear();
    renderer?.requestDraw();
    current = null;
    folder = [];
    folderDir = null;
    index = -1;
    setWindowTitle("OptImageEditor");
  }

  function onKey(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    let handled = true;
    if (ctrl && k.toLowerCase() === "o") openDialog();
    else if (ctrl && k.toLowerCase() === "w") closeImage();
    else if (ctrl && k === "0") fit();
    else if (ctrl && k === "1") zoomTo(1);
    else if (ctrl && (k === "+" || k === "=" || k === ";")) zoomTo((renderer?.scale ?? 1) * 1.25);
    else if (ctrl && k === "-") zoomTo((renderer?.scale ?? 1) / 1.25);
    else if (!ctrl && (k === "ArrowRight" || k === "PageDown")) step(1);
    else if (!ctrl && (k === "ArrowLeft" || k === "PageUp")) step(-1);
    else if (!ctrl && k === "Home") goTo(0);
    else if (!ctrl && k === "End") goTo(folder.length - 1);
    else if (k === "F11") toggleFullscreen();
    else if (k === "F2") showStats = !showStats;
    else handled = false;
    if (handled) e.preventDefault();
  }

  // HTML5 drop (browser fallback; in the desktop app native drop is used to get real paths)
  function onHtmlDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (isTauri()) return;
    const f = e.dataTransfer?.files?.[0];
    if (f) openBrowserFile(f);
  }

  let statsText = $derived(
    current
      ? [
          `file        ${current.name}`,
          `path        ${current.path ?? "(browser)"}`,
          `file size   ${mb(current.stats.fileSize)}  (read ${mb(current.stats.bytesRead)})`,
          `image       ${current.width} x ${current.height}  ${current.bitsPerChannel}bit${current.layerInfo ? "  " + current.layerInfo : ""}${current.note ? `  (${current.note})` : ""}`,
          `read file   ${ms(current.stats.readMs)}`,
          `decode      ${ms(current.stats.decodeMs)}  (worker round-trip ${ms(current.stats.workerMs)})`,
          `GPU upload  ${ms(current.uploadMs)}  max tex ${renderer?.maxTextureSize ?? "?"}`,
          `TOTAL       ${ms(current.totalMs)}`,
          `texture mem ${mb(renderer?.textureBytes ?? 0)}`,
          `JS heap     ${(performance as unknown as { memory?: { usedJSHeapSize: number } }).memory ? mb((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) : "n/a"}`,
        ].join("\n")
      : "",
  );

  async function copyStats() {
    if (statsText) await navigator.clipboard.writeText(statsText);
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    onNativeDrop({ over: (on) => (dragOver = on), drop: (paths) => paths[0] && openPath(paths[0]) }).then((u) => (unlisten = u));
    startupPaths().then((paths) => { if (paths[0]) openPath(paths[0]); });
    // test hook for automated checks (browser)
    (window as unknown as { __oie: unknown }).__oie = {
      openFile: (f: File) => { openBrowserFile(f); return new Promise<void>((r) => { const t = setInterval(() => { if (!loading) { clearInterval(t); r(); } }, 20); }); },
      get stats() { return statsText; },
      get error() { return error; },
    };
    return () => unlisten?.();
  });
</script>

<svelte:window onkeydown={onKey} ondragover={(e) => e.preventDefault()} ondrop={(e) => e.preventDefault()} />

<header class="toolbar">
  <button onclick={openDialog} title="開く (Ctrl+O)">開く</button>
  <input bind:this={fileInput} type="file" accept={SUPPORTED_EXT.map((e) => "." + e).join(",")} hidden
    onchange={() => { const f = fileInput.files?.[0]; if (f) openBrowserFile(f); fileInput.value = ""; }} />
  <span class="sep"></span>
  <button onclick={() => step(-1)} disabled={folder.length < 2} title="前の画像 (← / PageUp)">◀</button>
  <button onclick={() => step(1)} disabled={folder.length < 2} title="次の画像 (→ / PageDown)">▶</button>
  <span class="sep"></span>
  <button onclick={fit} title="全体表示 (Ctrl+0)">全体</button>
  <button onclick={() => zoomTo(1)} title="100% (Ctrl+1)">100%</button>
  <span class="spacer"></span>
  <button class:active={showStats} onclick={() => (showStats = !showStats)} title="計測を表示 (F2)">計測</button>
</header>

<main
  class="stage"
  class:drag-over={dragOver}
  ondragover={(e) => { e.preventDefault(); if (!isTauri()) dragOver = true; }}
  ondragleave={() => { if (!isTauri()) dragOver = false; }}
  ondrop={onHtmlDrop}
>
  <Viewer bind:renderer onzoom={(s) => (zoom = s)} />
  {#if !current && !loading}
    <div class="hint">{error ?? "PSD / PSB / PNG / JPG / WebP をドロップ、または「開く」（Ctrl+O）"}</div>
  {/if}
  {#if loading}<div class="busy">読み込み中…</div>{/if}
  {#if error && current}<div class="toast">{error}</div>{/if}
  {#if showStats && current}
    <div class="stats">
      <pre>{statsText}</pre>
      <button onclick={copyStats}>コピー</button>
    </div>
  {/if}
</main>

<footer class="statusbar">
  {#if current}
    <span class="name" title={current.path ?? current.name}>{current.name}</span>
    <span>{current.width} × {current.height}</span>
    <span>{current.bitsPerChannel}bit</span>
    {#if current.layerInfo}<span>{current.layerInfo}</span>{/if}
    {#if folder.length}<span>{index + 1} / {folder.length}</span>{/if}
    <span class="spacer"></span>
    <span>{(zoom * 100).toFixed(zoom < 0.1 ? 1 : 0)}%</span>
    <span>{current.totalMs.toFixed(0)} ms</span>
  {:else}
    <span class="spacer"></span>
  {/if}
</footer>

<style>
  .toolbar, .statusbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    background: var(--panel);
    flex: none;
  }
  .toolbar { height: 36px; border-bottom: 1px solid var(--border); }
  .statusbar { height: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; gap: 14px; font-variant-numeric: tabular-nums; }
  .statusbar .name { color: var(--text); max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  .sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
  button {
    background: #3a3a3a;
    color: var(--text);
    border: 1px solid #4a4a4a;
    border-radius: 4px;
    padding: 3px 10px;
    font: inherit;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #454545; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.active { border-color: var(--accent); color: var(--accent); }

  .stage { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .stage.drag-over { outline: 2px dashed var(--accent); outline-offset: -6px; }
  .hint {
    position: absolute; inset: 0; display: grid; place-items: center;
    color: var(--muted); font-size: 15px; pointer-events: none; padding: 20px; text-align: center;
  }
  .busy, .toast {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75); padding: 6px 14px; border-radius: 4px; pointer-events: none;
  }
  .toast { color: #ffb4a8; top: auto; bottom: 12px; }
  .stats {
    position: absolute; right: 10px; bottom: 10px;
    background: rgba(0, 0, 0, 0.75); border: 1px solid var(--border); border-radius: 4px;
    padding: 8px 10px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  }
  .stats pre { margin: 0; font: 12px/1.5 Consolas, "Cascadia Mono", monospace; color: #cfe3ff; white-space: pre; user-select: text; }
</style>
