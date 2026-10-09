<script lang="ts">
  // AI panel (F8, phase D minimal): background removal and edit by instruction through a local ComfyUI.
  // Floating (not modal) so the layer / rectangle annotation can still be chosen while it is open.
  import { onMount } from "svelte";
  import { AbortedError, KIND_LABEL, comfy, overridePath, type Progress, type ServerInfo, type WorkflowKind } from "./comfy";
  import { randomSeed } from "./ai";
  import type { Tab, ViewerState } from "./viewerState.svelte";

  let { vs, tab, onclose, onmsg }: { vs: ViewerState; tab: Tab | null; onclose: () => void; onmsg: (text: string) => void } = $props();

  const KEY = "oie.ai";
  type Saved = { kind: WorkflowKind; prompts: string[]; fixedSeed: boolean };
  const saved: Saved = (() => {
    try { return { kind: "bg_remove", prompts: [], fixedSeed: false, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
    catch { return { kind: "bg_remove", prompts: [], fixedSeed: false }; }
  })();
  let kind = $state<WorkflowKind>(saved.kind);
  let prompts = $state<string[]>(saved.prompts);
  let prompt = $state(saved.prompts[0] ?? "");
  let fixedSeed = $state(saved.fixedSeed);
  let seed = $state(randomSeed());
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ kind, prompts, fixedSeed })); } catch { /* storage unavailable */ }
  }

  let url = $state(comfy.url);
  let server = $state<ServerInfo | null>(null);
  let serverError = $state<string | null>(null);
  let checking = $state(false);
  async function check() {
    checking = true;
    comfy.setUrl(url);
    url = comfy.url;
    try { server = await comfy.info(); serverError = null; }
    catch (e) { server = null; serverError = e instanceof Error ? e.message : String(e); }
    finally { checking = false; }
  }

  let override = $state<string | null>(null);
  $effect(() => { const k = kind; overridePath(k).then((p) => { if (k === kind) override = p; }); });

  const target = $derived(tab?.meta ? vs.aiTarget(tab, kind) : null);
  const rect = $derived.by(() => { void tab?.annot.version; void tab?.sel; return tab?.meta ? vs.aiRect(tab) : null; });

  let running = $state(false);
  let progress = $state<Progress | null>(null);
  let elapsed = $state(0);
  let error = $state<string | null>(null);
  let ctl: AbortController | null = null;

  async function run() {
    if (!tab || running) return;
    error = null;
    if (kind === "edit" && !prompt.trim()) { error = "指示（プロンプト）を入力してください"; return; }
    if (!fixedSeed) seed = randomSeed();
    running = true;
    progress = null;
    ctl = new AbortController();
    const t0 = performance.now();
    const timer = setInterval(() => (elapsed = performance.now() - t0), 200);
    try {
      const m = await vs.runAi(tab, kind, { prompt, seed }, (p) => (progress = p), ctl.signal);
      if (kind === "edit") { prompts = [prompt.trim(), ...prompts.filter((x) => x !== prompt.trim())].slice(0, 20); persist(); }
      onmsg(`${m}（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
      server ??= await comfy.info().catch(() => null);
      serverError = null;
    } catch (e) {
      if (e instanceof AbortedError) onmsg("中止しました");
      else { error = e instanceof Error ? e.message : String(e); console.error(e); }
    } finally {
      clearInterval(timer);
      running = false;
      progress = null;
      ctl = null;
    }
  }

  async function free() {
    try { await comfy.free(); onmsg("ComfyUI のモデルをメモリから解放しました"); server = await comfy.info(); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  onMount(() => { check(); return () => ctl?.abort(); });

  const fmtS = (ms: number) => (ms / 1000).toFixed(1) + " 秒";
</script>

<!-- keys typed here must not reach the app's shortcuts (P, L, Delete ...) -->
<div class="ai" role="dialog" aria-label="AI（ComfyUI）" tabindex="-1"
  onkeydown={(e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape") { if (running) ctl?.abort(); else onclose(); e.stopPropagation(); e.preventDefault(); return; }
    if ((t.tagName === "TEXTAREA" || t.tagName === "INPUT") ) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); run(); }
      e.stopPropagation();
    }
  }}>
  <header>
    <span class="title">AI（ComfyUI）</span>
    <span class="dot" class:ok={!!server} class:ng={!!serverError} title={server ? `ComfyUI ${server.version} / ${server.device}` : serverError ?? "確認中"}></span>
    <span class="spacer"></span>
    <button class="x" onclick={onclose} title="閉じる (F8 / Esc)">×</button>
  </header>

  <div class="row">
    <input class="url" bind:value={url} onkeydown={(e) => { if (e.key === "Enter") check(); }} title="ComfyUI の URL" />
    <button onclick={check} disabled={checking}>{checking ? "…" : "接続"}</button>
  </div>
  {#if server}
    <div class="sub">ComfyUI {server.version} / {server.device} / VRAM 空き {(server.vramFreeMb / 1024).toFixed(1)} / {(server.vramTotalMb / 1024).toFixed(1)} GB
      <button class="link" onclick={free} disabled={running} title="ComfyUI が読み込んだモデルを VRAM / RAM から解放する">解放</button></div>
  {:else if serverError}
    <div class="err">{serverError}</div>
  {/if}

  <div class="seg">
    {#each Object.keys(KIND_LABEL) as k (k)}
      <button class:on={kind === k} disabled={running} onclick={() => { kind = k as WorkflowKind; persist(); }}>{KIND_LABEL[k as WorkflowKind]}</button>
    {/each}
  </div>

  <div class="kv"><span>対象</span><b>{target?.label ?? "（画像を開いてください）"}</b></div>
  {#if kind === "edit"}
    <div class="kv"><span>範囲</span>
      {#if rect}<b>{tab?.sel ? "選択範囲" : "四角の注釈"} {rect.w} × {rect.h}</b>{:else}<b>全体</b><span class="hint">選択範囲 (M / L) か注釈の四角 (U) で指定</span>{/if}
    </div>
    <textarea bind:value={prompt} rows="3" placeholder="例: 看板の文字を消す / 空を夕焼けにする（英語の方が安定）" disabled={running}></textarea>
    {#if prompts.length}
      <select value="" onchange={(e) => { prompt = (e.currentTarget as HTMLSelectElement).value; (e.currentTarget as HTMLSelectElement).value = ""; }} disabled={running}>
        <option value="" disabled>履歴から選ぶ…</option>
        {#each prompts as p (p)}<option value={p}>{p.length > 60 ? p.slice(0, 60) + "…" : p}</option>{/each}
      </select>
    {/if}
    <div class="row seedrow">
      <span class="lbl">seed</span>
      <input class="seed" type="number" bind:value={seed} disabled={running || !fixedSeed} />
      <label class="chk"><input type="checkbox" bind:checked={fixedSeed} onchange={persist} disabled={running} />固定</label>
    </div>
  {/if}

  <div class="row run">
    {#if running}
      <button class="stop" onclick={() => ctl?.abort()}>中止 <kbd>Esc</kbd></button>
      <span class="prog">
        {progress?.phase ?? "準備"}{progress?.max ? ` ${progress.value}/${progress.max}` : ""}　{fmtS(elapsed)}
      </span>
    {:else}
      <button class="primary" onclick={run} disabled={!tab?.meta}>実行 <kbd>Ctrl+Enter</kbd></button>
    {/if}
  </div>
  {#if running && progress?.max}<div class="bar"><div style="width: {(progress.value / progress.max) * 100}%"></div></div>{/if}
  {#if error}<div class="err">{error}</div>{/if}
  <div class="note">
    {#if kind === "bg_remove"}
      BiRefNet で前景を切り抜き、新しいレイヤーにします（元のレイヤーは非表示）。
    {:else}
      Qwen-Image-Edit-2511（4 ステップ）。表示中の画像の四角の周りを少し含めて約 1MP に縮小して送り、四角の部分だけを縁をぼかして一番上の新しいレイヤーに貼り戻します。初回はモデルの読み込みに 1〜2 分かかります。
    {/if}
    {#if override}<span class="ov" title={override}>差し替え用: {override}（置くと内蔵の代わりに使う）</span>{/if}
  </div>
</div>

<style>
  .ai { position: absolute; top: 10px; right: 10px; z-index: 30; width: 340px; background: rgba(38, 38, 38, 0.97); border: 1px solid #555; border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; outline: none; }
  header { display: flex; align-items: center; gap: 6px; }
  .title { font-weight: 600; font-size: 13px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
  .dot.ok { background: #22c55e; }
  .dot.ng { background: #ef4444; }
  .spacer { flex: 1; }
  .x { background: transparent; border: none; color: var(--muted); font-size: 16px; padding: 0 4px; cursor: pointer; }
  .row { display: flex; align-items: center; gap: 6px; }
  .url { flex: 1; min-width: 0; }
  input, textarea, select { background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; padding: 3px 5px; }
  textarea { resize: vertical; min-height: 48px; }
  .sub { color: var(--muted); font-size: 11px; }
  .err { color: #ffb4a8; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 4px; padding: 3px 10px; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.primary { background: #2f4f73; border-color: var(--accent); color: #fff; }
  button.stop { background: #6b2b2b; border-color: #a44; color: #fff; }
  button.link { background: transparent; border: none; color: #8ab4f8; padding: 0 4px; font-size: 11px; }
  .seg { display: flex; }
  .seg button { border-radius: 0; flex: 1; margin-left: -1px; }
  .seg button:first-child { border-radius: 4px 0 0 4px; }
  .seg button:last-child { border-radius: 0 4px 4px 0; }
  .seg button.on { background: #2f4f73; border-color: var(--accent); color: #fff; }
  .kv { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .kv > span:first-child { color: var(--muted); width: 32px; flex: none; }
  .kv b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 270px; }
  .hint { color: var(--muted); font-size: 11px; }
  .lbl { color: var(--muted); }
  .seed { width: 150px; }
  .chk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .run { min-height: 26px; }
  .prog { font-variant-numeric: tabular-nums; }
  kbd { color: inherit; opacity: 0.7; font: 10px Consolas, monospace; margin-left: 4px; }
  .bar { height: 4px; background: #1e1e1e; border-radius: 2px; overflow: hidden; }
  .bar div { height: 100%; background: var(--accent); transition: width 0.2s; }
  .note { color: var(--muted); font-size: 11px; line-height: 1.5; }
  .ov { display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
