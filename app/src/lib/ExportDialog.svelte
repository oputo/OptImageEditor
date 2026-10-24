<script lang="ts">
  import { untrack } from "svelte";
  // Export (Ctrl+Alt+Shift+W): format, quality, size, annotations. (The document's image size is ImageSizeDialog.)
  // The written file goes next to the original (a free name) unless "保存先を選ぶ" is used; the original is never
  // overwritten. Settings are remembered in localStorage ("oie.export").
  export type ExportOptions = { format: "png" | "jpeg" | "webp"; quality: number; w: number; h: number; annotations: boolean; ask: boolean };

  let { w0, h0, name, hasAnnotations, onexport, onclose }: {
    w0: number; h0: number; name: string; hasAnnotations: boolean;
    onexport: (o: ExportOptions) => void;
    onclose: () => void;
  } = $props();

  const KEY = "oie.export";
  type Saved = { format: ExportOptions["format"]; quality: number; annotations: boolean };
  const saved: Saved = (() => {
    try { return { format: "png", quality: 0.9, annotations: true, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
    catch { return { format: "png", quality: 0.9, annotations: true }; }
  })();

  let format = $state<ExportOptions["format"]>(saved.format);
  let quality = $state(Math.round(saved.quality * 100));
  let annotations = $state(saved.annotations);
  // initial values only (the dialog is created per opening)
  let scale = $state<"100" | "50" | "25" | "custom">("100");
  let cw = $state(untrack(() => w0)), ch = $state(untrack(() => h0));
  let keepAspect = $state(true);
  let unit = $state<"px" | "%">("px");

  const size = $derived.by(() => {
    if (scale !== "custom") { const k = Number(scale) / 100; return { w: Math.max(1, Math.round(w0 * k)), h: Math.max(1, Math.round(h0 * k)) }; }
    return unit === "%" ? { w: Math.max(1, Math.round((w0 * cw) / 100)), h: Math.max(1, Math.round((h0 * ch) / 100)) } : { w: cw, h: ch };
  });
  const valid = $derived(size.w >= 1 && size.h >= 1 && size.w <= 30000 && size.h <= 30000);

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

  function go(ask: boolean) {
    if (!valid) return;
    try { localStorage.setItem(KEY, JSON.stringify({ format, quality: quality / 100, annotations })); } catch { /* storage unavailable */ }
    onexport({ format, quality: quality / 100, w: size.w, h: size.h, annotations: annotations && hasAnnotations, ask });
  }

  const ext = $derived(format === "jpeg" ? "jpg" : format);
  const stem = $derived(name.replace(/\.[^.]+$/, ""));
</script>

<div class="back" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="dlg" role="dialog" aria-modal="true" aria-label="書き出し"
    tabindex="-1" onkeydown={(e) => { e.stopPropagation(); if (e.key === "Escape") onclose(); else if (e.key === "Enter" && !e.isComposing) go(false); }}>
    <h2>書き出し</h2>

    <div class="row">
      <span class="lbl">形式</span>
      {#each [["png", "PNG"], ["jpeg", "JPG"], ["webp", "WebP"]] as [v, label] (v)}
        <button class:on={format === v} onclick={() => (format = v as ExportOptions["format"])}>{label}</button>
      {/each}
    </div>
    {#if format !== "png"}
      <div class="row">
        <span class="lbl">品質</span>
        <input type="range" min="10" max="100" bind:value={quality} />
        <span class="val">{quality}</span>
      </div>
    {/if}

    <div class="row">
      <span class="lbl">サイズ</span>
      {#each ["100", "50", "25"] as v (v)}
        <button class:on={scale === v} onclick={() => (scale = v as typeof scale)}>{v}%</button>
      {/each}
      <button class:on={scale === "custom"} onclick={() => (scale = "custom")}>指定</button>
    </div>
    {#if scale === "custom"}
      <div class="row">
        <span class="lbl"></span>
        <label>幅 <input type="number" min="1" value={cw} oninput={(e) => setW(Number((e.currentTarget as HTMLInputElement).value))} /></label>
        <label>高さ <input type="number" min="1" value={ch} oninput={(e) => setH(Number((e.currentTarget as HTMLInputElement).value))} /></label>
        <span class="units">
          <button class:on={unit === "px"} onclick={() => setUnit("px")}>px</button><button class:on={unit === "%"} onclick={() => setUnit("%")}>%</button>
        </span>
      </div>
      <div class="row"><span class="lbl"></span><label class="chk"><input type="checkbox" bind:checked={keepAspect} />縦横比を保持</label></div>
    {/if}
    <div class="row"><span class="lbl"></span><span class="dim">{w0} × {h0} → <b>{size.w} × {size.h}</b> px</span></div>

    {#if hasAnnotations}
      <div class="row"><span class="lbl">注釈</span><label class="chk"><input type="checkbox" bind:checked={annotations} />注釈を含める</label></div>
    {/if}

    <div class="row"><span class="lbl">ファイル名</span><span class="dim">{stem}{size.w !== w0 || size.h !== h0 ? `_${size.w}x${size.h}` : ""}.{ext}（元画像の横。同名があれば番号付き）</span></div>

    <div class="btns">
      <button onclick={onclose}>キャンセル</button>
      <span class="spacer"></span>
      <button onclick={() => go(true)} disabled={!valid}>保存先を選ぶ…</button>
      <button class="primary" onclick={() => go(false)} disabled={!valid}>書き出し</button>
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 50; display: flex; align-items: center; justify-content: center; }
  .dlg { background: #2b2b2b; border: 1px solid #555; border-radius: 8px; padding: 14px 16px; min-width: 460px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); font-size: 13px; outline: none; }
  h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .lbl { width: 72px; color: var(--muted); flex: none; }
  .val { width: 32px; text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: var(--muted); }
  .dim b { color: var(--text); }
  button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 4px; padding: 3px 10px; font: inherit; cursor: pointer; }
  button.on { background: #2f4f73; border-color: var(--accent); }
  button.primary { background: #2f4f73; border-color: var(--accent); color: #fff; }
  button:disabled { opacity: 0.4; cursor: default; }
  input[type="number"] { width: 80px; background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; padding: 2px 4px; }
  input[type="range"] { flex: 1; accent-color: var(--accent); }
  .units button { padding: 3px 6px; border-radius: 0; }
  .chk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .btns { display: flex; gap: 6px; margin-top: 14px; }
  .spacer { flex: 1; }
</style>
