<script lang="ts">
  import { untrack } from "svelte";
  // Canvas size (Ctrl+Alt+C): new width / height (absolute or relative) and the anchor (where the image stays).
  let { w0, h0, onapply, onclose }: {
    w0: number; h0: number;
    onapply: (w: number, h: number, anchor: number) => void;
    onclose: () => void;
  } = $props();

  let relative = $state(false);
  let w = $state(untrack(() => w0)), h = $state(untrack(() => h0)); // initial values (created per opening)
  let anchor = $state(4);

  const nw = $derived(Math.round(relative ? w0 + w : w));
  const nh = $derived(Math.round(relative ? h0 + h : h));
  const valid = $derived(nw >= 1 && nh >= 1 && nw <= 30000 && nh <= 30000);

  function setRelative(r: boolean) {
    if (r === relative) return;
    if (r) { w = nw - w0; h = nh - h0; } else { w = nw; h = nh; }
    relative = r;
  }
  // arrows of the anchor grid: which way the canvas grows from the anchor
  const ARROW = ["↖", "↑", "↗", "←", "", "→", "↙", "↓", "↘"];
  function arrow(i: number) {
    const ac = anchor % 3, ar = Math.floor(anchor / 3), c = i % 3, r = Math.floor(i / 3);
    const dc = c - ac, dr = r - ar;
    if (Math.abs(dc) > 1 || Math.abs(dr) > 1 || (dc === 0 && dr === 0)) return "";
    return ARROW[(dr + 1) * 3 + (dc + 1)];
  }
  function apply() { if (valid) onapply(nw, nh, anchor); }
</script>

<div class="back" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="dlg" role="dialog" aria-modal="true" aria-label="カンバスサイズ" tabindex="-1"
    onkeydown={(e) => { e.stopPropagation(); if (e.key === "Escape") onclose(); else if (e.key === "Enter" && !e.isComposing) apply(); }}>
    <h2>カンバスサイズ</h2>
    <div class="row"><span class="lbl">現在</span><span class="dim">{w0} × {h0} px</span></div>
    <div class="row">
      <span class="lbl">幅</span><input type="number" bind:value={w} />
      <span class="lbl short">高さ</span><input type="number" bind:value={h} /> px
    </div>
    <div class="row"><span class="lbl"></span><label class="chk"><input type="checkbox" checked={relative} onchange={(e) => setRelative((e.currentTarget as HTMLInputElement).checked)} />相対（現在のサイズに足す）</label></div>
    <div class="row top">
      <span class="lbl">基準位置</span>
      <div class="grid" role="radiogroup" aria-label="基準位置">
        {#each Array(9) as _, i (i)}
          <button class="cell" class:on={anchor === i} role="radio" aria-checked={anchor === i} onclick={() => (anchor = i)}>{anchor === i ? "●" : arrow(i)}</button>
        {/each}
      </div>
    </div>
    <div class="row"><span class="lbl">新しいサイズ</span><b>{nw} × {nh}</b>&nbsp;px</div>
    <p class="note">レイヤーの画素は変更しません（カンバスの外に出た部分も保持されます）。スマートオブジェクト・テキスト・ベクトルマスクの位置も合わせて移動します。</p>
    <div class="btns">
      <button onclick={onclose}>キャンセル</button>
      <span class="spacer"></span>
      <button class="primary" onclick={apply} disabled={!valid}>OK</button>
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 50; display: flex; align-items: center; justify-content: center; }
  .dlg { background: #2b2b2b; border: 1px solid #555; border-radius: 8px; padding: 14px 16px; min-width: 400px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); font-size: 13px; outline: none; }
  h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .row.top { align-items: flex-start; }
  .lbl { width: 80px; color: var(--muted); flex: none; }
  .lbl.short { width: auto; margin-left: 8px; }
  .dim { color: var(--muted); }
  input[type="number"] { width: 80px; background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; padding: 2px 4px; }
  .chk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(3, 28px); gap: 2px; }
  .cell { width: 28px; height: 28px; padding: 0; background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; cursor: pointer; font: inherit; }
  .cell.on { background: #2f4f73; border-color: var(--accent); }
  .note { color: var(--muted); font-size: 11px; margin: 8px 0 0; max-width: 380px; }
  .btns { display: flex; gap: 6px; margin-top: 12px; }
  .spacer { flex: 1; }
  button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 4px; padding: 3px 12px; font: inherit; cursor: pointer; }
  button.primary { background: #2f4f73; border-color: var(--accent); color: #fff; }
  button:disabled { opacity: 0.4; }
</style>
