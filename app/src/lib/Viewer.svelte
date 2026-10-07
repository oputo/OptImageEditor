<script lang="ts">
  // Canvas view: owns the WebGL renderer and the view interaction
  // (zoom / pan / rotate with R + drag), plus the 2D overlay (grid, pixel grid, guides) and the rulers.
  import { onMount, untrack } from "svelte";
  import { Renderer } from "./renderer";
  import { viewOptions as opt } from "./viewOptions.svelte";
  import type { Guides } from "./viewerState.svelte";

  let { renderer = $bindable(), guides = null, oncursor }: {
    renderer?: Renderer;
    guides?: Guides | null;
    /** image px under the mouse (null when outside the canvas) */
    oncursor?: (p: [number, number] | null) => void;
  } = $props();

  const RULER = 18; // css px
  const HIT = 5; // css px: distance at which a guide can be grabbed

  let canvas: HTMLCanvasElement;
  let overlay: HTMLCanvasElement;
  let rulerTop = $state<HTMLCanvasElement>();
  let rulerLeft = $state<HTMLCanvasElement>();
  let cursorClass = $state("");
  let spaceDown = false;
  let rDown = $state(false);
  let hasImage = $state(false);
  let rotated = $state(false);
  let mouse: [number, number] | null = null; // css px in the canvas

  type Drag =
    | { kind: "pan"; x: number; y: number }
    | { kind: "rotate"; start: number; startRot: number }
    | { kind: "guide"; axis: "v" | "h"; index: number };
  let drag: Drag | null = null;
  let hot: { axis: "v" | "h"; index: number } | null = $state(null); // guide under the mouse / being dragged

  const showRulers = $derived(opt.rulers && hasImage && !rotated);
  const guidesOn = () => opt.extras && opt.guides && !!guides;

  onMount(() => {
    const r = new Renderer(canvas);
    renderer = r;
    const off = r.onFrame(() => {
      hasImage = r.hasImage;
      rotated = r.rotation !== 0;
      drawOverlay();
    });
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(canvas);
    r.resize();
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown = true;
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) rDown = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown = false;
      if (e.key === "r" || e.key === "R") rDown = false;
    };
    const blur = () => { spaceDown = false; rDown = false; };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    return () => {
      off();
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
      r.clear();
    };
  });

  // redraw the overlay when options / guides change
  $effect(() => {
    void [opt.extras, opt.guides, opt.grid, opt.gridPx, opt.pixelGrid, opt.rulers, showRulers, hot];
    void (guides && [guides.v.length, guides.h.length, ...guides.v, ...guides.h]);
    renderer?.requestDraw();
  });

  // ---------------------------------------------------------------- drawing

  function sizeCanvas(c: HTMLCanvasElement, dpr: number) {
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  function drawOverlay() {
    const r = renderer;
    if (!r || !overlay) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = sizeCanvas(overlay, dpr);
    if (rulerTop) sizeCanvas(rulerTop, dpr);
    if (rulerLeft) sizeCanvas(rulerLeft, dpr);
    if (!r.hasImage) return;

    const W = r.imageWidth, H = r.imageHeight, s = r.scale;
    const vw = overlay.clientWidth, vh = overlay.clientHeight;
    // visible area in image px (bounding box of the rotated viewport)
    const pts = [r.viewToImage(0, 0), r.viewToImage(vw, 0), r.viewToImage(0, vh), r.viewToImage(vw, vh)];
    const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
    const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));

    if (opt.extras) {
      const m = r.matrix;
      ctx.setTransform(dpr * m[0], dpr * m[3], dpr * m[1], dpr * m[4], dpr * m[2], dpr * m[5]);
      const lw = 1 / s; // 1 css px
      const x0 = Math.max(0, minX), x1 = Math.min(W, maxX), y0 = Math.max(0, minY), y1 = Math.min(H, maxY);
      const lines = (xs: number[], ys: number[], ya: number, yb: number, xa: number, xb: number) => {
        ctx.beginPath();
        for (const x of xs) { ctx.moveTo(x, ya); ctx.lineTo(x, yb); }
        for (const y of ys) { ctx.moveTo(xa, y); ctx.lineTo(xb, y); }
        ctx.stroke();
      };
      const range = (from: number, to: number, step: number) => {
        const out: number[] = [];
        for (let v = Math.ceil(from / step) * step; v <= to; v += step) out.push(v);
        return out;
      };

      // pixel grid (only when zoomed in enough to see the pixels)
      if (opt.pixelGrid && s >= 8 && x1 > x0 && y1 > y0) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = "rgba(150, 150, 150, 0.45)";
        lines(range(x0, x1, 1), range(y0, y1, 1), y0, y1, x0, x1);
      }

      // composition grid (inside the image)
      if (opt.grid !== "off") {
        let xs: number[] = [], ys: number[] = [];
        if (opt.grid === "thirds") { xs = [W / 3, (2 * W) / 3]; ys = [H / 3, (2 * H) / 3]; }
        else if (opt.grid === "center") { xs = [W / 2]; ys = [H / 2]; }
        else {
          const step = Math.max(1, opt.gridPx);
          if (step * s >= 4) { xs = range(Math.max(step, x0), Math.min(W - 0.5, x1), step); ys = range(Math.max(step, y0), Math.min(H - 0.5, y1), step); }
        }
        ctx.lineWidth = lw;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
        ctx.setLineDash([]);
        lines(xs, ys, 0, H, 0, W);
        ctx.strokeStyle = "rgba(255, 120, 220, 0.85)";
        ctx.setLineDash([4 / s, 4 / s]);
        lines(xs, ys, 0, H, 0, W);
        ctx.setLineDash([]);
      }

      // guides (across the whole visible area, like Photoshop)
      if (guidesOn() && guides) {
        ctx.lineWidth = lw;
        for (const axis of ["v", "h"] as const) {
          guides[axis].forEach((g, i) => {
            const isHot = hot?.axis === axis && hot.index === i;
            ctx.strokeStyle = isHot ? "#ffffff" : "#28e0ff";
            ctx.lineWidth = isHot ? 2 * lw : lw;
            if (axis === "v") lines([g], [], minY, maxY, 0, 0);
            else lines([], [g], 0, 0, minX, maxX);
          });
        }
      }
    }

    if (showRulers) drawRulers(r, dpr);
  }

  /** Nice tick spacing (1, 2, 5 x 10^n image px) for about `minCss` css px between labels. */
  function niceStep(scale: number, minCss: number) {
    const raw = minCss / scale;
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const k of [1, 2, 5, 10]) if (k * p >= raw) return Math.max(1, k * p);
    return Math.max(1, 10 * p);
  }

  function drawRulers(r: Renderer, dpr: number) {
    const step = niceStep(r.scale, 64);
    const minor = step >= 10 ? step / 10 : step >= 5 ? step / 5 : step >= 2 ? step / 2 : 0;
    for (const [c, horizontal] of [[rulerTop, true], [rulerLeft, false]] as const) {
      if (!c) continue;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const len = horizontal ? c.clientWidth : c.clientHeight;
      const off = RULER; // the rulers start after the corner box
      ctx.fillStyle = "#262626";
      ctx.fillRect(0, 0, horizontal ? len : RULER, horizontal ? RULER : len);
      // image coordinate along this ruler at css position t (rotation is 0 here; flip only reverses x)
      const at = (t: number) => (horizontal ? r.viewToImage(t + off, 0)[0] : r.viewToImage(0, t + off)[1]);
      const pos = (v: number) => (horizontal ? r.imageToView(v, 0)[0] : r.imageToView(0, v)[1]) - off;
      const a = at(0), b = at(len);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      ctx.strokeStyle = "#6a6a6a";
      ctx.fillStyle = "#a0a0a0";
      ctx.font = "10px Consolas, 'Cascadia Mono', monospace";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (minor) {
        for (let v = Math.ceil(lo / minor) * minor; v <= hi; v += minor) {
          const t = Math.round(pos(v)) + 0.5;
          if (horizontal) { ctx.moveTo(t, RULER - 4); ctx.lineTo(t, RULER); } else { ctx.moveTo(RULER - 4, t); ctx.lineTo(RULER, t); }
        }
      }
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const t = Math.round(pos(v)) + 0.5;
        if (horizontal) { ctx.moveTo(t, 0); ctx.lineTo(t, RULER); } else { ctx.moveTo(0, t); ctx.lineTo(RULER, t); }
      }
      ctx.stroke();
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const t = Math.round(pos(v));
        if (horizontal) ctx.fillText(String(v), t + 3, 10);
        else { ctx.save(); ctx.translate(10, t + 3); ctx.rotate(-Math.PI / 2); ctx.textAlign = "right"; ctx.fillText(String(v), 0, 0); ctx.restore(); }
      }
      // mouse position marker
      if (mouse) {
        const t = Math.round((horizontal ? mouse[0] : mouse[1]) - off) + 0.5;
        ctx.strokeStyle = "#4a9eff";
        ctx.beginPath();
        if (horizontal) { ctx.moveTo(t, 0); ctx.lineTo(t, RULER); } else { ctx.moveTo(0, t); ctx.lineTo(RULER, t); }
        ctx.stroke();
      }
      ctx.strokeStyle = "#3a3a3a";
      ctx.beginPath();
      if (horizontal) { ctx.moveTo(0, RULER - 0.5); ctx.lineTo(len, RULER - 0.5); } else { ctx.moveTo(RULER - 0.5, 0); ctx.lineTo(RULER - 0.5, len); }
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- interaction

  /** css px relative to the canvas */
  function local(e: PointerEvent | WheelEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function guideAt(cx: number, cy: number): { axis: "v" | "h"; index: number } | null {
    if (!renderer?.hasImage || !guidesOn() || !guides) return null;
    const [ix, iy] = renderer.viewToImage(cx, cy);
    let best: { axis: "v" | "h"; index: number } | null = null;
    let bestD = HIT;
    guides.v.forEach((g, i) => { const d = Math.abs(ix - g) * renderer!.scale; if (d < bestD) { bestD = d; best = { axis: "v", index: i }; } });
    guides.h.forEach((g, i) => { const d = Math.abs(iy - g) * renderer!.scale; if (d < bestD) { bestD = d; best = { axis: "h", index: i }; } });
    return best;
  }

  function angle(cx: number, cy: number) {
    return Math.atan2(cy - canvas.clientHeight / 2, cx - canvas.clientWidth / 2);
  }

  function onWheel(e: WheelEvent) {
    if (!renderer?.hasImage) return;
    e.preventDefault();
    const [cx, cy] = local(e);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    renderer.zoomAt(renderer.scale * factor, cx, cy);
  }

  function onPointerDown(e: PointerEvent) {
    if (!renderer?.hasImage) return;
    const [cx, cy] = local(e);
    if (e.button === 0 && rDown) {
      drag = { kind: "rotate", start: angle(cx, cy), startRot: renderer.rotation };
    } else if (e.button === 0 && !spaceDown && guideAt(cx, cy)) {
      const g = guideAt(cx, cy)!;
      drag = { kind: "guide", ...g };
      hot = g;
    } else if (e.button === 0 || e.button === 1 || spaceDown) {
      drag = { kind: "pan", x: e.clientX, y: e.clientY };
    } else {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    updateCursor(cx, cy);
  }

  /** New guide dragged out of a ruler (top ruler: horizontal guide, left ruler: vertical guide). */
  function onRulerDown(e: PointerEvent, axis: "v" | "h") {
    if (!renderer?.hasImage || !guides || e.button !== 0) return;
    opt.extras = true;
    opt.guides = true;
    const [cx, cy] = local(e);
    const [ix, iy] = renderer.viewToImage(cx, cy);
    guides[axis].push(Math.round(axis === "v" ? ix : iy));
    drag = { kind: "guide", axis, index: guides[axis].length - 1 };
    hot = { axis, index: guides[axis].length - 1 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent) {
    const r = renderer;
    if (!r) return;
    const [cx, cy] = local(e);
    mouse = [cx, cy];
    if (drag?.kind === "pan") {
      r.panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else if (drag?.kind === "rotate") {
      let deg = drag.startRot + ((angle(cx, cy) - drag.start) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      r.rotateTo(deg);
    } else if (drag?.kind === "guide" && guides) {
      const [ix, iy] = r.viewToImage(cx, cy);
      guides[drag.axis][drag.index] = Math.round(drag.axis === "v" ? ix : iy);
    } else {
      updateCursor(cx, cy);
    }
    if (r.hasImage) {
      const [ix, iy] = r.viewToImage(cx, cy);
      oncursor?.([ix, iy]);
    }
    if (showRulers) r.requestDraw(); // ruler mouse marker
  }

  function onPointerUp(e: PointerEvent) {
    if (drag?.kind === "guide" && guides) {
      // dropped on a ruler or outside the view: delete the guide (like Photoshop)
      const [cx, cy] = local(e);
      const outside = cx < 0 || cy < 0 || cx > canvas.clientWidth || cy > canvas.clientHeight;
      const onRuler = showRulers && (cx < RULER || cy < RULER);
      if (outside || onRuler) guides[drag.axis].splice(drag.index, 1);
      hot = null;
    }
    drag = null;
    const [cx, cy] = local(e);
    updateCursor(cx, cy);
  }

  function onLeave() {
    if (drag) return;
    mouse = null;
    oncursor?.(null);
    if (hot) hot = null;
    if (showRulers) renderer?.requestDraw();
  }

  function updateCursor(cx: number, cy: number) {
    if (drag?.kind === "pan") { cursorClass = "grabbing"; return; }
    if (drag?.kind === "rotate" || rDown) { cursorClass = "rotate"; return; }
    if (drag?.kind === "guide") { cursorClass = drag.axis === "v" ? "col" : "row"; return; }
    const g = spaceDown ? null : guideAt(cx, cy);
    if (g?.axis !== hot?.axis || g?.index !== hot?.index) hot = g;
    cursorClass = g ? (g.axis === "v" ? "col" : "row") : "";
  }

  // R pressed / released: show the rotate cursor
  $effect(() => {
    const r = rDown;
    untrack(() => { if (!drag) cursorClass = r ? "rotate" : cursorClass === "rotate" ? "" : cursorClass; });
  });
</script>

<div class="viewer">
  <canvas
    bind:this={canvas}
    class="gl {cursorClass}"
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onpointerleave={onLeave}
  ></canvas>
  <canvas bind:this={overlay} class="overlay"></canvas>
  {#if showRulers}
    <canvas bind:this={rulerTop} class="ruler top" title="ドラッグで水平ガイドを作成"
      onpointerdown={(e) => onRulerDown(e, "h")} onpointermove={onPointerMove} onpointerup={onPointerUp}></canvas>
    <canvas bind:this={rulerLeft} class="ruler left" title="ドラッグで垂直ガイドを作成"
      onpointerdown={(e) => onRulerDown(e, "v")} onpointermove={onPointerMove} onpointerup={onPointerUp}></canvas>
    <div class="ruler corner"></div>
  {/if}
</div>

<style>
  .viewer { position: absolute; inset: 0; }
  canvas { position: absolute; display: block; }
  .gl, .overlay { inset: 0; width: 100%; height: 100%; }
  .gl { cursor: grab; touch-action: none; }
  .gl.grabbing { cursor: grabbing; }
  .gl.col { cursor: col-resize; }
  .gl.row { cursor: row-resize; }
  .gl.rotate { cursor: crosshair; }
  .overlay { pointer-events: none; }
  .ruler { background: #262626; touch-action: none; }
  .ruler.top { left: 18px; right: 0; top: 0; height: 18px; width: calc(100% - 18px); cursor: row-resize; }
  .ruler.left { top: 18px; bottom: 0; left: 0; width: 18px; height: calc(100% - 18px); cursor: col-resize; }
  .ruler.corner { position: absolute; left: 0; top: 0; width: 18px; height: 18px; background: #262626; border-right: 1px solid #3a3a3a; border-bottom: 1px solid #3a3a3a; }
</style>
