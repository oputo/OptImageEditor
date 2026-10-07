<script lang="ts">
  // Navigator: thumbnail of the whole image with the visible area as a red frame.
  // Click / drag on it to move the view; the slider zooms around the centre of the view.
  import type { Renderer } from "./renderer";

  let { renderer, zoom }: { renderer?: Renderer; zoom: number } = $props();

  const BOX_W = 220, BOX_H = 150;
  const MIN = 0.01, MAX = 64;
  let canvas: HTMLCanvasElement;
  let dragging = false;
  // thumbnail placement inside the box
  let place = { x: 0, y: 0, k: 1 };

  $effect(() => {
    const r = renderer;
    if (!r) return;
    return r.onFrame(draw);
  });

  function draw() {
    const r = renderer;
    if (!r || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== BOX_W * dpr) { canvas.width = BOX_W * dpr; canvas.height = BOX_H * dpr; }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // opaque fill instead of clearRect (clearRect left stale frames behind in Chromium's accelerated 2D canvas here)
    ctx.fillStyle = "#1b1b1b";
    ctx.fillRect(0, 0, BOX_W, BOX_H);
    const set = r.activeSet;
    if (!set) return;
    const thumb = r.thumbnail(set);
    const k = Math.min((BOX_W - 8) / set.width, (BOX_H - 8) / set.height);
    place = { x: (BOX_W - set.width * k) / 2, y: (BOX_H - set.height * k) / 2, k };
    if (thumb) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(thumb, place.x, place.y, set.width * k, set.height * k);
    }
    // visible area (a rotated rectangle when the view is rotated)
    const vw = r.viewWidth, vh = r.viewHeight;
    const pts = [r.viewToImage(0, 0), r.viewToImage(vw, 0), r.viewToImage(vw, vh), r.viewToImage(0, vh)];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, BOX_W, BOX_H);
    ctx.clip();
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const px = place.x + x * k, py = place.y + y * k;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ff3b30";
    ctx.stroke();
    ctx.restore();
  }

  function moveTo(e: PointerEvent) {
    const r = renderer;
    if (!r?.hasImage) return;
    const rect = canvas.getBoundingClientRect();
    const ix = (e.clientX - rect.left - place.x) / place.k;
    const iy = (e.clientY - rect.top - place.y) / place.k;
    r.centerOn(Math.max(0, Math.min(r.imageWidth, ix)), Math.max(0, Math.min(r.imageHeight, iy)));
  }

  // slider: logarithmic 1% .. 6400%
  const toSlider = (s: number) => Math.round((1000 * Math.log(Math.max(MIN, s) / MIN)) / Math.log(MAX / MIN));
  const fromSlider = (v: number) => MIN * (MAX / MIN) ** (v / 1000);

  function onSlider(e: Event) {
    const r = renderer;
    if (!r?.hasImage) return;
    r.zoomAt(fromSlider(Number((e.currentTarget as HTMLInputElement).value)), r.viewWidth / 2, r.viewHeight / 2);
  }

  function step(f: number) {
    const r = renderer;
    if (r?.hasImage) r.zoomAt(r.scale * f, r.viewWidth / 2, r.viewHeight / 2);
  }
</script>

<div class="nav">
  <canvas
    bind:this={canvas}
    style:width="{BOX_W}px"
    style:height="{BOX_H}px"
    onpointerdown={(e) => { dragging = true; canvas.setPointerCapture(e.pointerId); moveTo(e); }}
    onpointermove={(e) => { if (dragging) moveTo(e); }}
    onpointerup={() => (dragging = false)}
    onpointercancel={() => (dragging = false)}
  ></canvas>
  <div class="zoom">
    <button title="縮小" onclick={() => step(1 / 1.25)}>−</button>
    <input type="range" min="0" max="1000" value={toSlider(zoom)} oninput={onSlider} title="表示倍率" />
    <button title="拡大" onclick={() => step(1.25)}>＋</button>
    <span class="pct">{(zoom * 100).toFixed(zoom < 0.1 ? 1 : 0)}%</span>
  </div>
</div>

<style>
  .nav {
    position: absolute; top: 40px; right: 10px; z-index: 5;
    background: rgba(32, 32, 32, 0.92); border: 1px solid var(--border); border-radius: 5px;
    padding: 6px; display: flex; flex-direction: column; gap: 4px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  }
  canvas { display: block; cursor: pointer; touch-action: none; }
  .zoom { display: flex; align-items: center; gap: 4px; }
  .zoom input { flex: 1; min-width: 0; accent-color: var(--accent); }
  .zoom button {
    background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px;
    width: 20px; height: 20px; padding: 0; line-height: 16px; cursor: pointer; font: inherit;
  }
  .pct { width: 48px; text-align: right; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
</style>
