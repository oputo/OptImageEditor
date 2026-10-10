<script lang="ts">
  // Brush / eraser / eyedropper options (shown over the view while a paint tool is active).
  import { PAINT_ICON, PAINT_LABEL, paint, type PaintTool } from "./paint.svelte";

  let { target, onclose }: { target: string; onclose: () => void } = $props();
  const TOOLS: { t: PaintTool; key: string }[] = [{ t: "brush", key: "B" }, { t: "eraser", key: "E" }, { t: "eyedropper", key: "I" }];
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
</script>

<div class="bar" role="toolbar" aria-label="ペイント">
  {#each TOOLS as x (x.t)}
    <button class:on={paint.tool === x.t} onclick={() => (paint.tool = x.t)} title="{PAINT_LABEL[x.t]} ({x.key})">{PAINT_ICON[x.t]}</button>
  {/each}
  {#if paint.tool !== "eyedropper"}
    <span class="sep"></span>
    <label title="直径（[ / ]）">直径 <input type="number" min="1" max="5000" value={paint.diameter} onchange={(e) => (paint.diameter = num(e))} /> px</label>
    <input class="range" type="range" min="1" max="500" value={Math.min(500, paint.diameter)} oninput={(e) => (paint.diameter = num(e))} />
    <label title="硬さ（Shift+[ / ]）">硬さ <input class="range sm" type="range" min="0" max="100" value={Math.round(paint.hardness * 100)} oninput={(e) => { paint.hardness = num(e) / 100; paint.save(); }} /><span class="v">{Math.round(paint.hardness * 100)}%</span></label>
    <label title="不透明度（数字キー: 1 = 10% … 0 = 100%）">不透明度 <input class="range sm" type="range" min="1" max="100" value={Math.round(paint.opacity * 100)} oninput={(e) => { paint.opacity = num(e) / 100; paint.save(); }} /><span class="v">{Math.round(paint.opacity * 100)}%</span></label>
    <span class="sep"></span>
    <span class="lbl">筆圧</span>
    <button class:on={paint.pressureSize} onclick={() => { paint.pressureSize = !paint.pressureSize; paint.save(); }} title="筆圧で直径を変える（ペンのみ）">サイズ</button>
    <button class:on={paint.pressureOpacity} onclick={() => { paint.pressureOpacity = !paint.pressureOpacity; paint.save(); }} title="筆圧で不透明度を変える（ペンのみ）">不透明度</button>
  {:else}
    <span class="hint">クリックで描画色を取得（ブラシ中は Alt+クリック）</span>
  {/if}
  <span class="sep"></span>
  <span class="tgt" title="描画先（マスクのサムネイルをクリックでマスクに切り替え）">{target}</span>
  <button onclick={onclose} title="ペイントを終了 (Esc)">×</button>
</div>

<style>
  .bar {
    position: absolute; left: 50%; top: 8px; transform: translateX(-50%); z-index: 6;
    display: flex; align-items: center; gap: 4px; padding: 4px 6px; white-space: nowrap;
    background: rgba(40, 40, 40, 0.95); border: 1px solid #555; border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5); font-size: 12px;
  }
  button {
    min-width: 26px; height: 26px; padding: 0 6px; background: #3a3a3a; color: var(--text);
    border: 1px solid #4a4a4a; border-radius: 4px; font: inherit; cursor: pointer;
  }
  button.on { background: #2f4f73; border-color: var(--accent); }
  label { display: flex; align-items: center; gap: 4px; color: var(--muted); }
  input[type="number"] { width: 52px; background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; padding: 1px 4px; }
  .range { width: 110px; accent-color: var(--accent); }
  .range.sm { width: 70px; }
  .v { width: 32px; color: var(--text); font-variant-numeric: tabular-nums; }
  .lbl, .hint { color: var(--muted); }
  .tgt { color: #f0c040; }
  .sep { width: 1px; height: 20px; background: #555; margin: 0 3px; }
</style>
