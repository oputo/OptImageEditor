<script lang="ts">
  // Brush / eraser / eyedropper options (shown over the view while a paint tool is active). Every tool keeps its own
  // settings. The sliders are pen-friendly (Scrub); on the canvas, right-drag (pen side button) changes them too.
  import { PAINT_ICON, PAINT_LABEL, paint, type PaintTool } from "./paint.svelte";
  import Scrub from "./Scrub.svelte";

  let { target, onclose }: { target: string; onclose: () => void } = $props();
  const TOOLS: { t: PaintTool; key: string }[] = [{ t: "brush", key: "B" }, { t: "eraser", key: "E" }, { t: "eyedropper", key: "I" }];
</script>

<div class="bar" role="toolbar" aria-label="ペイント">
  {#each TOOLS as x (x.t)}
    <button class:on={paint.tool === x.t} onclick={() => (paint.tool = x.t)} title="{PAINT_LABEL[x.t]} ({x.key})">{PAINT_ICON[x.t]}</button>
  {/each}
  <span class="sep"></span>
  {#if paint.tool !== "eyedropper"}
    <span title="直径（[ / ]、キャンバスで右ドラッグの左右）"><Scrub label="直径" value={paint.diameter} min={1} max={5000} log unit="px" onchange={(v) => (paint.diameter = v)} /></span>
    <span title="硬さ（Shift+[ / ]、キャンバスで右ドラッグの上下）"><Scrub label="硬さ" value={paint.hardness} min={0} max={1} scale={100} unit="%" onchange={(v) => (paint.hardness = v)} /></span>
    <span title="不透明度（数字キー 1 = 10% … 0 = 100%、キャンバスで Shift+右ドラッグの上下）"><Scrub label="不透明度" value={paint.opacity} min={0.01} max={1} scale={100} unit="%" onchange={(v) => (paint.opacity = v)} /></span>
    <span class="sep"></span>
    <span class="lbl">筆圧</span>
    <button class:on={paint.pressureSize} onclick={() => { paint.pressureSize = !paint.pressureSize; paint.save(); }} title="筆圧で直径を変える（ペンのみ）">サイズ</button>
    <button class:on={paint.pressureOpacity} onclick={() => { paint.pressureOpacity = !paint.pressureOpacity; paint.save(); }} title="筆圧で不透明度を変える（ペンのみ）">不透明度</button>
  {:else}
    <span title="取得する範囲の平均（[ / ]、キャンバスで右ドラッグの左右）"><Scrub label="範囲" value={paint.diameter} min={1} max={101} log unit="px" onchange={(v) => (paint.diameter = v)} /></span>
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
    min-width: 28px; height: 28px; padding: 0 7px; background: #3a3a3a; color: var(--text);
    border: 1px solid #4a4a4a; border-radius: 4px; font: inherit; cursor: pointer; touch-action: none;
  }
  button.on { background: #2f4f73; border-color: var(--accent); }
  .lbl, .hint { color: var(--muted); }
  .tgt { color: #f0c040; }
  .sep { width: 1px; height: 20px; background: #555; margin: 0 3px; }
</style>
