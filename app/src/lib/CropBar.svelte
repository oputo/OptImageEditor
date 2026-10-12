<script lang="ts">
  // Crop tool options (shown over the view while cropping): size, "delete cropped pixels", apply / cancel.
  import { cropTool } from "./crop.svelte";

  let { onapply, oncancel }: { onapply: () => void; oncancel: () => void } = $props();
</script>

<div class="bar" role="toolbar" aria-label="切り抜き">
  <span class="lbl">切り抜き</span>
  <span class="size">{cropTool.rect?.w ?? 0} × {cropTool.rect?.h ?? 0} px</span>
  <span class="sep"></span>
  <label title="オン: 枠の外のピクセルを削除（ピクセルレイヤーとマスクのみ。スマートオブジェクト・テキストはそのまま）。オフ: 枠の外も残す（カンバスの外に隠れるだけ）">
    <input type="checkbox" checked={cropTool.deletePixels} onchange={(e) => cropTool.setDelete((e.currentTarget as HTMLInputElement).checked)} />
    切り抜いたピクセルを削除
  </label>
  <span class="sep"></span>
  <span class="hint">ハンドルで調整（Shift: 縦横比を保つ）・枠の外をドラッグで引き直し</span>
  <button class="ok" onclick={onapply} title="確定 (Enter)">✓</button>
  <button onclick={oncancel} title="中止 (Esc)">×</button>
</div>

<style>
  .bar {
    position: absolute; left: 50%; top: 8px; transform: translateX(-50%); z-index: 6;
    display: flex; align-items: center; gap: 6px; padding: 4px 8px; white-space: nowrap;
    background: rgba(40, 40, 40, 0.95); border: 1px solid #555; border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5); font-size: 12px;
  }
  .lbl { color: #f0c040; }
  .size { font-variant-numeric: tabular-nums; min-width: 110px; }
  .hint { color: var(--muted); }
  label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  button {
    min-width: 28px; height: 26px; padding: 0 8px; background: #3a3a3a; color: var(--text);
    border: 1px solid #4a4a4a; border-radius: 4px; font: inherit; cursor: pointer;
  }
  button.ok { background: #2f4f73; border-color: var(--accent); color: #fff; }
  .sep { width: 1px; height: 20px; background: #555; margin: 0 2px; }
</style>
