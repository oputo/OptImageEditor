<script lang="ts">
  import { untrack } from "svelte";
  import type { ResampleFilter } from "./resize";
  // Image size (Ctrl+Alt+I): scales the whole document (layers kept; smart objects / text not rasterized).
  // The method and "scale styles" are remembered in localStorage ("oie.imageSize").
  export type ImageSizeOptions = { w: number; h: number; filter: ResampleFilter; scaleStyles: boolean };

  let { w0, h0, isPsd, onapply, onclose }: {
    w0: number; h0: number;
    /** the document has PSD layers (styles / smart objects can be in it) */
    isPsd: boolean;
    onapply: (o: ImageSizeOptions) => void;
    onclose: () => void;
  } = $props();

  const KEY = "oie.imageSize";
  type Saved = { filter: ResampleFilter; scaleStyles: boolean };
  const saved: Saved = (() => {
    try { return { filter: "bicubic", scaleStyles: true, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
    catch { return { filter: "bicubic", scaleStyles: true }; }
  })();

  let filter = $state<ResampleFilter>(saved.filter);
  let scaleStyles = $state(saved.scaleStyles);
  let cw = $state(untrack(() => w0)), ch = $state(untrack(() => h0)); // initial values (created per opening)
  let keepAspect = $state(true);
  let unit = $state<"px" | "%">("px");

  const size = $derived(unit === "%"
    ? { w: Math.max(1, Math.round((w0 * cw) / 100)), h: Math.max(1, Math.round((h0 * ch) / 100)) }
    : { w: Math.round(cw), h: Math.round(ch) });
  const valid = $derived(size.w >= 1 && size.h >= 1 && size.w <= 30000 && size.h <= 30000);
  const changed = $derived(size.w !== w0 || size.h !== h0);

  function setW(v: number) {
    cw = v;
    if (keepAspect) ch = unit === "%" ? v : Math.max(1, Math.round((v * h0) / w0));
  }
  function setH(v: number) {
    ch = v;
    if (keepAspect) cw = unit === "%" ? v : Math.max(1, Math.round((v * w0) / h0));
  }
  function setUnit(u: "px" | "%") {
    if (u === unit) return;
    if (u === "%") { cw = Math.round((cw / w0) * 1000) / 10; ch = Math.round((ch / h0) * 1000) / 10; }
    else { cw = Math.round((w0 * cw) / 100); ch = Math.round((h0 * ch) / 100); }
    unit = u;
  }
  function preset(p: number) { unit = "%"; cw = p; ch = p; }

  function apply() {
    if (!valid) return;
    if (!changed) { onclose(); return; }
    try { localStorage.setItem(KEY, JSON.stringify({ filter, scaleStyles })); } catch { /* storage unavailable */ }
    onapply({ w: size.w, h: size.h, filter, scaleStyles });
  }

  const FILTERS: [ResampleFilter, string, string][] = [
    ["bicubic", "バイキュービック", "写真・絵（既定）"],
    ["bilinear", "バイリニア", "やわらかめ"],
    ["nearest", "ニアレストネイバー", "ドット絵・ハードエッジ"],
  ];
</script>

<div class="back" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="dlg" role="dialog" aria-modal="true" aria-label="画像解像度" tabindex="-1"
    onkeydown={(e) => { e.stopPropagation(); if (e.key === "Escape") onclose(); else if (e.key === "Enter" && !e.isComposing) apply(); }}>
    <h2>画像解像度</h2>
    <div class="row"><span class="lbl">現在</span><span class="dim">{w0} × {h0} px</span></div>
    <div class="row">
      <span class="lbl">幅</span><input type="number" min="1" value={cw} oninput={(e) => setW(Number((e.currentTarget as HTMLInputElement).value))} />
      <span class="lbl short">高さ</span><input type="number" min="1" value={ch} oninput={(e) => setH(Number((e.currentTarget as HTMLInputElement).value))} />
      <span class="units">
        <button class:on={unit === "px"} onclick={() => setUnit("px")}>px</button><button class:on={unit === "%"} onclick={() => setUnit("%")}>%</button>
      </span>
    </div>
    <div class="row">
      <span class="lbl"></span>
      {#each [25, 50, 200] as p (p)}<button onclick={() => preset(p)}>{p}%</button>{/each}
      <label class="chk"><input type="checkbox" bind:checked={keepAspect} />縦横比を保持</label>
    </div>
    <div class="row top">
      <span class="lbl">再サンプル</span>
      <div class="col">
        {#each FILTERS as [v, label, hint] (v)}
          <label class="chk"><input type="radio" name="filter" checked={filter === v} onchange={() => (filter = v)} />{label}<span class="dim">（{hint}）</span></label>
        {/each}
      </div>
    </div>
    {#if isPsd}
      <div class="row"><span class="lbl">スタイル</span><label class="chk"><input type="checkbox" bind:checked={scaleStyles} />レイヤースタイルを拡大・縮小（影の距離・境界線の太さなど）</label></div>
    {/if}
    <div class="row"><span class="lbl">新しいサイズ</span><b>{size.w} × {size.h}</b>&nbsp;px</div>
    <p class="note">レイヤーを保ったまま文書全体を拡大・縮小します（Ctrl+Z で戻せます）。スマートオブジェクトとテキストはラスタライズせず、配置を拡大・縮小します。解像度（ppi）は変えません。</p>
    <div class="btns">
      <button onclick={onclose}>キャンセル</button>
      <span class="spacer"></span>
      <button class="primary" onclick={apply} disabled={!valid}>OK</button>
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 50; display: flex; align-items: center; justify-content: center; }
  .dlg { background: #2b2b2b; border: 1px solid #555; border-radius: 8px; padding: 14px 16px; min-width: 440px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); font-size: 13px; outline: none; }
  h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .row.top { align-items: flex-start; }
  .col { display: flex; flex-direction: column; gap: 3px; }
  .lbl { width: 80px; color: var(--muted); flex: none; }
  .lbl.short { width: auto; margin-left: 8px; }
  .dim { color: var(--muted); }
  input[type="number"] { width: 80px; background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; padding: 2px 4px; }
  .chk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .units button { padding: 3px 6px; border-radius: 0; }
  .note { color: var(--muted); font-size: 11px; margin: 8px 0 0; max-width: 420px; }
  .btns { display: flex; gap: 6px; margin-top: 12px; }
  .spacer { flex: 1; }
  button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 4px; padding: 3px 10px; font: inherit; cursor: pointer; }
  button.on { background: #2f4f73; border-color: var(--accent); }
  button.primary { background: #2f4f73; border-color: var(--accent); color: #fff; }
  button:disabled { opacity: 0.4; }
</style>
