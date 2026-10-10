<script lang="ts">
  // Pen-friendly slider: a wide bar that follows the pointer while pressed (pointer capture, no touch scrolling),
  // so it works the same with a mouse or a pen. `log`: logarithmic scale (brush diameter 1..5000).
  let { value, min, max, log = false, label, unit = "", digits = 0, scale = 1, onchange }: {
    value: number; min: number; max: number; log?: boolean; label: string; unit?: string; digits?: number;
    /** shown value = value * scale (e.g. 0..1 shown as %) */
    scale?: number;
    onchange: (v: number) => void;
  } = $props();

  const toT = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromT = (t: number) => (log ? min * Math.pow(max / min, t) : min + (max - min) * t);
  const t = $derived(Math.max(0, Math.min(1, toT(value))));

  let bar: HTMLDivElement;
  function set(e: PointerEvent) {
    const r = bar.getBoundingClientRect();
    onchange(fromT(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))));
  }
</script>

<div class="scrub" role="slider" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabindex="-1" bind:this={bar}
  onpointerdown={(e) => { if (e.button !== 0) return; bar.setPointerCapture(e.pointerId); set(e); e.preventDefault(); }}
  onpointermove={(e) => { if (bar.hasPointerCapture(e.pointerId)) set(e); }}
  onwheel={(e) => { e.preventDefault(); onchange(fromT(Math.max(0, Math.min(1, t + (e.deltaY < 0 ? 0.02 : -0.02))))); }}>
  <div class="fill" style:width="{t * 100}%"></div>
  <span class="txt">{label} <b>{(value * scale).toFixed(digits)}{unit}</b></span>
</div>

<style>
  .scrub { position: relative; width: 150px; height: 26px; background: #1e1e1e; border: 1px solid #4a4a4a; border-radius: 4px;
    overflow: hidden; cursor: ew-resize; touch-action: none; user-select: none; flex: none; }
  .fill { position: absolute; left: 0; top: 0; bottom: 0; background: #2f4f73; pointer-events: none; }
  .txt { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 8px;
    color: var(--muted); font-size: 12px; pointer-events: none; }
  .txt b { color: #fff; font-weight: 500; font-variant-numeric: tabular-nums; }
</style>
