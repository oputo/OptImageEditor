<script lang="ts">
  // Annotation tool palette (shown over the view while annotating).
  import { COLORS, FONT_SIZES, TOOL_KEY, TOOL_LABEL, WIDTHS, annotTool, type Annotations, type Tool } from "./annotations.svelte";

  let { annot, oncopy, onsave, onlayer }: { annot: Annotations | null; oncopy: () => void; onsave: () => void; onlayer: () => void } = $props();

  /** picks the colour; a selected shape takes it too */
  function setColor(c: string) {
    annotTool.color = c;
    const s = annot?.shapes.find((x) => x.id === annot?.selected);
    if (s && s.color !== c) annot!.replace({ ...s, color: c });
  }

  const TOOLS: { t: Tool; icon: string }[] = [
    { t: "select", icon: "⬉" }, { t: "pen", icon: "✎" }, { t: "line", icon: "╱" },
    { t: "arrow", icon: "↗" }, { t: "rect", icon: "▭" }, { t: "text", icon: "T" },
  ];
</script>

<div class="bar" role="toolbar" aria-label="注釈">
  {#each TOOLS as x (x.t)}
    <button class:on={annotTool.tool === x.t} onclick={() => (annotTool.tool = x.t)}
      title="{TOOL_LABEL[x.t]} ({TOOL_KEY[x.t] ? TOOL_KEY[x.t].toUpperCase() : "Shift+U で切り替え"}){x.t === 'line' || x.t === 'arrow' ? '。Shift で 45° 刻み' : x.t === 'rect' ? '。Shift で正方形' : x.t === 'select' ? '。ドラッグで移動、Delete で削除、テキストはダブルクリックで編集' : ''}">{x.icon}</button>
  {/each}
  <span class="sep"></span>
  {#each COLORS as c (c.c)}
    <button class="color" class:on={annotTool.color === c.c} style:--c={c.c} title={c.label} aria-label={c.label}
      onclick={() => setColor(c.c)}></button>
  {/each}
  <span class="sep"></span>
  {#each WIDTHS as w, i (w)}
    <button class:on={annotTool.widthIndex === i} onclick={() => (annotTool.widthIndex = i)}
      title="太さ {w}px / 文字 {FONT_SIZES[i]}px（画面上）"><span class="dot" style:width="{w + 2}px" style:height="{w + 2}px"></span></button>
  {/each}
  <span class="sep"></span>
  <button disabled={!annot?.undoCount} onclick={() => annot?.undo()} title="取り消し (Ctrl+Z)">↶</button>
  <button disabled={!annot?.redoCount} onclick={() => annot?.redo()} title="やり直し (Ctrl+Shift+Z)">↷</button>
  <button disabled={!annot?.shapes.length} onclick={() => annot?.clear()} title="注釈をすべて消す">全消去</button>
  <span class="sep"></span>
  <button class="act" onclick={oncopy} title="注釈込みの画像をクリップボードへ (Ctrl+Shift+C)">コピー</button>
  <button class="act" onclick={onsave} title="注釈込みの画像を別の PNG で保存（元画像の横に 名前_注釈.png）">PNG 保存</button>
  <button class="act" disabled={!annot?.shapes.length} onclick={onlayer} title="注釈を一番上の「注釈」レイヤーにする（Ctrl+S で画像と一緒に保存できる）">レイヤーに</button>
  <button onclick={() => (annotTool.tool = null)} title="注釈を終了 (Esc)">×</button>
</div>

<style>
  .bar {
    position: absolute; left: 50%; top: 8px; transform: translateX(-50%); z-index: 6;
    display: flex; align-items: center; gap: 3px; padding: 4px 6px;
    background: rgba(40, 40, 40, 0.95); border: 1px solid #555; border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5); font-size: 12px;
  }
  button {
    min-width: 26px; height: 26px; padding: 0 6px; background: #3a3a3a; color: var(--text);
    border: 1px solid #4a4a4a; border-radius: 4px; font: inherit; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; white-space: nowrap;
  }
  button:disabled { opacity: 0.4; cursor: default; }
  button.on { background: #2f4f73; border-color: var(--accent); }
  button.act { background: #2f4f73; border-color: var(--accent); color: #fff; }
  .color { background: var(--c); width: 22px; min-width: 22px; height: 22px; padding: 0; border: 2px solid #666; border-radius: 50%; }
  .color.on { border-color: #fff; box-shadow: 0 0 0 2px var(--accent); background: var(--c); }
  .dot { display: inline-block; border-radius: 50%; background: var(--text); }
  .sep { width: 1px; height: 20px; background: #555; margin: 0 3px; }
</style>
