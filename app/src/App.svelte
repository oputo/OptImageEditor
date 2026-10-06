<script lang="ts">
  // OptImageEditor — phase 1-b: viewer with tabs, prefetch, recent files, single instance, "Open with" registration.
  import { onMount } from "svelte";
  import Viewer from "./lib/Viewer.svelte";
  import TabBar from "./lib/TabBar.svelte";
  import type { Renderer } from "./lib/renderer";
  import { SUPPORTED_EXT } from "./lib/loader";
  import { baseName, isTauri, readTuning, READ_MODES, READ_MODE_LABEL } from "./lib/source";
  import {
    confirmDialog, infoDialog, onNativeDrop, onOpenPaths, openDefaultAppsSettings, pickFile,
    setOpenWithRegistration, startupPaths, toggleFullscreen,
  } from "./lib/desktop";
  import { ViewerState } from "./lib/viewer.svelte";
  import { recent } from "./lib/recent.svelte";

  const vs = new ViewerState();
  let renderer = $state<Renderer | undefined>();
  $effect(() => { vs.renderer = renderer; });

  let dragOver = $state(false);
  let showStats = $state(false);
  let readMode = $state(readTuning.mode);
  let menuOpen = $state(false);
  let toast = $state<string | null>(null);
  let fileInput: HTMLInputElement;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const active = $derived(vs.active);
  const meta = $derived(active?.meta ?? null);
  const mb = (n: number) => (n / 2 ** 20).toFixed(1) + " MB";
  const ms = (n: number) => n.toFixed(0) + " ms";
  const shortPath = (p: string) => (p.length > 70 ? "…" + p.slice(-69) : p);

  function showToast(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 4000);
  }

  async function openPaths(paths: string[]) {
    if (!paths.length) return;
    const ok = await vs.openPaths(paths);
    if (!ok) showToast(`対応していない形式です（${SUPPORTED_EXT.join(" / ")}）`);
  }

  async function openDialog() {
    if (isTauri()) {
      const p = await pickFile();
      if (p) openPaths([p]);
    } else {
      fileInput.click();
    }
  }

  function fit() { renderer?.fit(); vs.zoom = renderer?.scale ?? 0; }
  function zoomTo(scale: number) {
    if (!renderer?.hasImage) return;
    renderer.zoomAt(scale, renderer.viewWidth / 2, renderer.viewHeight / 2);
    vs.zoom = renderer.scale;
  }

  async function registerOpenWith(register: boolean) {
    menuOpen = false;
    try {
      const exe = await setOpenWithRegistration(register);
      if (register) {
        const go = await confirmDialog(
          "「プログラムから開く」に登録しました（現在のユーザーのみ）。\n\n" +
          `対象: ${SUPPORTED_EXT.map((e) => "." + e).join(" ")}\n登録した exe: ${exe}\n\n` +
          "既定のアプリにするには、画像を右クリック →［プログラムから開く］→［別のプログラムを選択］→ OptImageEditor を選び、「常にこのアプリを使う」をオンにしてください。\n\n" +
          "今すぐ Windows の「既定のアプリ」設定を開きますか？",
        );
        if (go) await openDefaultAppsSettings();
      } else {
        await infoDialog("登録を解除しました。");
      }
    } catch (e) {
      await infoDialog(`失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function onKey(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    let handled = true;
    if (k === "Escape" && menuOpen) menuOpen = false;
    else if (ctrl && k === "Tab") vs.cycle(e.shiftKey ? -1 : 1);
    else if (ctrl && e.shiftKey && k.toLowerCase() === "t") vs.reopenClosed();
    else if (ctrl && k.toLowerCase() === "o") openDialog();
    else if (ctrl && k.toLowerCase() === "w") vs.closeActive();
    else if (ctrl && k === "0") fit();
    else if (ctrl && k === "1") zoomTo(1);
    else if (ctrl && (k === "+" || k === "=" || k === ";")) zoomTo((renderer?.scale ?? 1) * 1.25);
    else if (ctrl && k === "-") zoomTo((renderer?.scale ?? 1) / 1.25);
    else if (!ctrl && (k === "ArrowRight" || k === "PageDown")) vs.step(1);
    else if (!ctrl && (k === "ArrowLeft" || k === "PageUp")) vs.step(-1);
    else if (!ctrl && k === "Home") vs.goTo(0);
    else if (!ctrl && k === "End") vs.goTo((active?.folder.length ?? 1) - 1);
    else if (k === "F11") toggleFullscreen();
    else if (k === "F2") showStats = !showStats;
    else if (k === "F3") { readTuning.mode = READ_MODES[(READ_MODES.indexOf(readTuning.mode) + 1) % READ_MODES.length]; readMode = readTuning.mode; showStats = true; }
    else if (k === "F5") vs.reload();
    else handled = false;
    if (handled) e.preventDefault();
  }

  // HTML5 drop (browser build only; the desktop app uses native drop to get real paths)
  function onHtmlDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (isTauri()) return;
    for (const f of Array.from(e.dataTransfer?.files ?? [])) vs.openFile(f);
  }

  const statsText = $derived.by(() => {
    if (!meta || !active) return "";
    const cache = vs.cacheInfo;
    return [
      `file        ${meta.name}`,
      `path        ${meta.path ?? "(browser)"}`,
      `file size   ${mb(meta.stats.fileSize)}  (read ${mb(meta.stats.bytesRead)})`,
      `image       ${meta.width} x ${meta.height}  ${meta.bitsPerChannel}bit${meta.layerInfo ? "  " + meta.layerInfo : ""}${meta.note ? `  (${meta.note})` : ""}`,
      `via         ${meta.fromCache ? "GPU cache (prefetched / kept)" : meta.via}`,
      `read file   ${ms(meta.stats.readMs)}`,
      `decode      ${ms(meta.stats.decodeMs)}  (read+decode round-trip ${ms(meta.stats.workerMs)})`,
      `GPU upload  ${ms(meta.uploadMs)}  max tex ${renderer?.maxTextureSize ?? "?"}`,
      `TOTAL       ${meta.fromCache ? "0 ms (from GPU cache)" : ms(meta.totalMs)}`,
      `GPU cache   ${cache.count} images, ${mb(cache.bytes)}`,
      `JS heap     ${(performance as unknown as { memory?: { usedJSHeapSize: number } }).memory ? mb((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) : "n/a"}`,
    ].join("\n");
  });

  async function copyStats() {
    if (statsText) await navigator.clipboard.writeText(statsText);
  }

  onMount(() => {
    const unlisten: (() => void)[] = [];
    onNativeDrop({ over: (on) => (dragOver = on), drop: (paths) => openPaths(paths) }).then((u) => unlisten.push(u));
    onOpenPaths((paths) => openPaths(paths)).then((u) => unlisten.push(u));
    startupPaths().then((paths) => openPaths(paths));
    const closeMenu = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".menu-wrap")) menuOpen = false; };
    window.addEventListener("mousedown", closeMenu);
    // test hook for automated checks (browser build)
    (window as unknown as { __oie: unknown }).__oie = {
      vs,
      openFile: (f: File) => {
        vs.openFile(f);
        return new Promise<void>((r) => { const t = setInterval(() => { if (!vs.active?.loading) { clearInterval(t); r(); } }, 20); });
      },
      get stats() { return statsText; },
      get error() { return vs.active?.error ?? null; },
    };
    return () => { unlisten.forEach((u) => u()); window.removeEventListener("mousedown", closeMenu); };
  });
</script>

<svelte:window onkeydown={onKey} ondragover={(e) => e.preventDefault()} ondrop={(e) => e.preventDefault()} />

<header class="toolbar">
  <div class="menu-wrap">
    <button class="menu-btn" class:active={menuOpen} onclick={() => (menuOpen = !menuOpen)} title="メニュー">≡</button>
    {#if menuOpen}
      <div class="menu" role="menu">
        <div class="menu-head">最近使ったファイル</div>
        {#each recent.list as p (p)}
          <button class="item" role="menuitem" title={p} onclick={() => { menuOpen = false; openPaths([p]); }}>
            <span class="fname">{baseName(p)}</span><span class="fdir">{shortPath(p)}</span>
          </button>
        {:else}
          <div class="empty">（まだありません）</div>
        {/each}
        {#if recent.list.length}
          <button class="item small" role="menuitem" onclick={() => { recent.clear(); }}>履歴を消去</button>
        {/if}
        {#if isTauri()}
          <div class="menu-sep"></div>
          <button class="item" role="menuitem" onclick={() => registerOpenWith(true)}>「プログラムから開く」に登録</button>
          <button class="item" role="menuitem" onclick={() => registerOpenWith(false)}>登録を解除</button>
        {/if}
      </div>
    {/if}
  </div>
  <button onclick={openDialog} title="開く (Ctrl+O)">開く</button>
  <input bind:this={fileInput} type="file" multiple accept={SUPPORTED_EXT.map((e) => "." + e).join(",")} hidden
    onchange={() => { for (const f of Array.from(fileInput.files ?? [])) vs.openFile(f); fileInput.value = ""; }} />
  <span class="sep"></span>
  <button onclick={() => vs.step(-1)} disabled={(active?.folder.length ?? 0) < 2} title="前の画像 (← / PageUp)">◀</button>
  <button onclick={() => vs.step(1)} disabled={(active?.folder.length ?? 0) < 2} title="次の画像 (→ / PageDown)">▶</button>
  <span class="sep"></span>
  <button onclick={fit} title="全体表示 (Ctrl+0)">全体</button>
  <button onclick={() => zoomTo(1)} title="100% (Ctrl+1)">100%</button>
  <span class="spacer"></span>
  <button class:active={showStats} onclick={() => (showStats = !showStats)} title="計測を表示 (F2)">計測</button>
</header>

{#if vs.tabs.length}
  <TabBar tabs={vs.tabs} activeId={vs.activeId} onactivate={(id) => vs.activate(id)} onclose={(id) => vs.close(id)} onopen={openDialog} />
{/if}

<main
  class="stage"
  class:drag-over={dragOver}
  ondragover={(e) => { e.preventDefault(); if (!isTauri()) dragOver = true; }}
  ondragleave={() => { if (!isTauri()) dragOver = false; }}
  ondrop={onHtmlDrop}
>
  <Viewer bind:renderer onzoom={(s) => (vs.zoom = s)} />
  {#if !active}
    <div class="start">
      <div class="hint">PSD / PSB / PNG / JPG / WebP をドロップ、または「開く」（Ctrl+O）</div>
      {#if recent.list.length}
        <div class="recent">
          <div class="recent-head">最近使ったファイル</div>
          {#each recent.list.slice(0, 10) as p (p)}
            <button class="recent-item" title={p} onclick={() => openPaths([p])}>
              <span class="fname">{baseName(p)}</span><span class="fdir">{shortPath(p)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if active.error}
    <div class="hint error">{active.error}</div>
  {/if}
  {#if active?.loading}<div class="busy">読み込み中…</div>{/if}
  {#if toast}<div class="toast">{toast}</div>{/if}
  {#if showStats && meta}
    <div class="stats">
      <pre>{statsText}</pre>
      <span class="hint-keys">F3: 読み込み方式 [{READ_MODE_LABEL[readMode]}] を切替 ／ F5: 再読み込み</span>
      <button onclick={copyStats}>コピー</button>
    </div>
  {/if}
</main>

<footer class="statusbar">
  {#if active && meta}
    <span class="name" title={meta.path ?? meta.name}>{meta.name}</span>
    <span>{meta.width} × {meta.height}</span>
    <span>{meta.bitsPerChannel}bit</span>
    {#if meta.layerInfo}<span>{meta.layerInfo}</span>{/if}
    {#if active.folder.length && active.folderIndex >= 0}<span>{active.folderIndex + 1} / {active.folder.length}</span>{/if}
    <span class="spacer"></span>
    <span>{(vs.zoom * 100).toFixed(vs.zoom < 0.1 ? 1 : 0)}%</span>
    <span>{meta.fromCache ? "cache" : `${meta.totalMs.toFixed(0)} ms`}</span>
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

  .menu-wrap { position: relative; }
  .menu-btn { font-size: 16px; line-height: 1; padding: 2px 9px 4px; }
  .menu {
    position: absolute; top: 32px; left: 0; z-index: 20;
    min-width: 320px; max-width: 520px; max-height: 70vh; overflow-y: auto;
    background: #2b2b2b; border: 1px solid #4a4a4a; border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); padding: 6px;
    display: flex; flex-direction: column;
  }
  .menu-head { color: var(--muted); font-size: 11px; padding: 4px 8px; }
  .menu-sep { height: 1px; background: var(--border); margin: 6px 2px; }
  .menu .empty { color: var(--muted); padding: 4px 8px 8px; }
  .item {
    display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
    background: transparent; border: none; border-radius: 4px; padding: 5px 8px; text-align: left;
  }
  .item:hover:not(:disabled) { background: #3a3a3a; }
  .item.small { color: var(--muted); font-size: 12px; }
  .fname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .fdir { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  .stage { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .stage.drag-over { outline: 2px dashed var(--accent); outline-offset: -6px; }
  .start {
    position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
    pointer-events: none;
  }
  .hint { color: var(--muted); font-size: 15px; padding: 20px; text-align: center; pointer-events: none; }
  .stage > .hint { position: absolute; inset: 0; display: grid; place-items: center; }
  .hint.error { color: #ffb4a8; }
  .recent { display: flex; flex-direction: column; min-width: 360px; max-width: 640px; pointer-events: auto; }
  .recent-head { color: var(--muted); font-size: 12px; padding: 0 8px 4px; }
  .recent-item {
    display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
    background: transparent; border: none; padding: 5px 8px; text-align: left; border-radius: 4px;
  }
  .recent-item:hover { background: #2e2e2e !important; }
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
  .hint-keys { color: var(--muted); font-size: 11px; }
  .stats pre { margin: 0; font: 12px/1.5 Consolas, "Cascadia Mono", monospace; color: #cfe3ff; white-space: pre; user-select: text; }
</style>
