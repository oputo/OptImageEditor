<script lang="ts">
  // Canvas view: owns the WebGL renderer and the view interaction
  // (zoom / pan / rotate with R + drag), plus the 2D overlay (grid, pixel grid, guides) and the rulers.
  // While comparing, every interaction goes to the view of the pane under the mouse, and the overlay is
  // drawn per pane (plus the A / B labels and the swipe divider).
  import { onMount, untrack } from "svelte";
  import { Renderer, applyInverse, type Affine, type Pane, type View } from "./renderer";
  import { viewOptions as opt } from "./viewOptions.svelte";
  import type { Guides } from "./viewerState.svelte";
  import {
    FONT_SIZES, WIDTHS, annotTool, constrain, drawSelection, drawShape, shapeAt, translate,
    type Annotations, type Shape,
  } from "./annotations.svelte";
  import { modeOf, outline, selTool, type Sel, type SelMode, type SelTool } from "./selection.svelte";

  let { renderer = $bindable(), guides = null, annot = null, sel = null, labels = null, oncursor, onsplit, onselshape }: {
    renderer?: Renderer;
    /** selection of the shown image (marching ants) */
    sel?: Sel | null;
    /** a shape drawn with a selection tool (image px; empty `pts`: a click without dragging) */
    onselshape?: (tool: SelTool, pts: number[], mode: SelMode) => void;
    guides?: Guides | null;
    /** annotations of the shown image (drawn and edited while an annotation tool is active) */
    annot?: Annotations | null;
    /** names shown on the panes while comparing */
    labels?: { a: string; b: string } | null;
    /** image px (of image A) under the mouse (null when outside the canvas) */
    oncursor?: (p: [number, number] | null) => void;
    /** swipe divider dragged to `v` (0..1 of the width) */
    onsplit?: (v: number) => void;
  } = $props();

  const RULER = 18; // css px
  const HIT = 5; // css px: distance at which a guide can be grabbed
  const SPLIT_HIT = 7; // css px: distance at which the swipe divider can be grabbed

  let canvas: HTMLCanvasElement;
  let overlay: HTMLCanvasElement;
  let rulerTop = $state<HTMLCanvasElement>();
  let rulerLeft = $state<HTMLCanvasElement>();
  let cursorClass = $state("");
  let spaceDown = false;
  let rDown = $state(false);
  let hasImage = $state(false);
  let rotated = $state(false);
  let sideBySide = $state(false);
  let mouse: [number, number] | null = null; // css px in the canvas

  type Drag =
    | { kind: "pan"; view: View; x: number; y: number }
    | { kind: "rotate"; view: View; cx: number; cy: number; start: number; startRot: number }
    | { kind: "guide"; axis: "v" | "h"; index: number }
    | { kind: "split" }
    | { kind: "draw"; shape: Shape; x0: number; y0: number }
    | { kind: "move"; shape: Shape; x: number; y: number; moved: boolean }
    | { kind: "sel"; tool: "rect" | "ellipse" | "lasso"; mode: SelMode; pts: number[]; shiftAtStart: boolean; shiftReleased: boolean };
  let drag: Drag | null = null;
  let hot: { axis: "v" | "h"; index: number } | null = $state(null); // guide under the mouse / being dragged

  const showRulers = $derived(opt.rulers && hasImage && !rotated && !sideBySide);
  /** annotation tool in use (not while comparing) */
  const annotating = () => !!annot && !!annotTool.tool && !renderer?.compare;
  /** text being typed: position in css px and image px */
  let textEdit = $state<{ cx: number; cy: number; ix: number; iy: number; size: number; color: string; value: string; replace: Shape | null } | null>(null);
  const guidesOn = () => opt.extras && opt.guides && !!guides;
  /** selection tool in use (not while comparing / annotating) */
  const selecting = () => !!selTool.tool && !!onselshape && !renderer?.compare && !annotating();
  /** polygon being clicked (image px) and the mouse position for its rubber band */
  let poly = $state<{ pts: number[]; mode: SelMode } | null>(null);
  let polyMouse: [number, number] | null = null;
  let lastPolyClick: { t: number; cx: number; cy: number } | null = null;
  // marching ants: the outline of the selection, as a path in image px (made once per selection)
  const selPath = $derived.by(() => {
    if (!sel) return null;
    const segs = outline(sel);
    const p = new Path2D();
    if (!segs) { p.rect(sel.x, sel.y, sel.w, sel.h); return p; }
    for (let i = 0; i < segs.length; i += 4) { p.moveTo(segs[i], segs[i + 1]); p.lineTo(segs[i + 2], segs[i + 3]); }
    return p;
  });
  // the ants march while there is a selection (or a polygon being drawn)
  $effect(() => {
    if (!sel && !poly) return;
    const t = setInterval(() => renderer?.requestDraw(), 120);
    return () => clearInterval(t);
  });
  // the polygon is dropped when the tool changes
  $effect(() => { if (selTool.tool !== "poly") untrack(() => { if (poly) { poly = null; renderer?.requestDraw(); } }); });

  onMount(() => {
    const r = new Renderer(canvas);
    renderer = r;
    const off = r.onFrame(() => {
      hasImage = r.hasImage;
      rotated = r.rotation !== 0;
      sideBySide = r.compare?.mode === "side";
      drawOverlay();
    });
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(canvas);
    r.resize();
    // polygon keys go first (capture): Enter closes, Esc cancels, Backspace removes the last point
    const polyKey = (e: KeyboardEvent) => {
      if (!poly) return;
      if (e.key === "Enter") finishPoly();
      else if (e.key === "Escape") poly = null;
      else if (e.key === "Backspace" || e.key === "Delete") { poly.pts = poly.pts.slice(0, -2); if (!poly.pts.length) poly = null; }
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
      renderer?.requestDraw();
    };
    window.addEventListener("keydown", polyKey, true);
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown = true;
      if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey && !e.altKey) rDown = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown = false;
      if (e.code === "KeyR") rDown = false;
    };
    const blur = () => { spaceDown = false; rDown = false; };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    return () => {
      off();
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keydown", polyKey, true);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
      r.clear();
    };
  });

  // redraw the overlay when options / guides change
  $effect(() => {
    void [opt.extras, opt.guides, opt.grid, opt.gridPx, opt.pixelGrid, opt.rulers, showRulers, hot];
    void (guides && [guides.v.length, guides.h.length, ...guides.v, ...guides.h]);
    void (labels && [labels.a, labels.b]);
    void annot?.version;
    void annot?.selected;
    void annotTool.tool;
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
    const panes = r.panes();
    if (opt.extras) for (const p of panes) drawExtras(ctx, p, dpr, r.imageWidth, r.imageHeight);
    if (!r.compare && panes.length) drawSelectionAnts(ctx, panes[0], dpr);
    if (annot && !r.compare && panes.length) drawAnnotations(ctx, panes[0], dpr);
    if (r.compare) drawCompareChrome(ctx, r, panes, dpr);
    if (showRulers) drawRulers(r, dpr);
  }

  const setMatrix = (ctx: CanvasRenderingContext2D, m: Affine, dpr: number) =>
    ctx.setTransform(dpr * m[0], dpr * m[3], dpr * m[1], dpr * m[4], dpr * m[2], dpr * m[5]);

  function drawAnnotations(ctx: CanvasRenderingContext2D, p: Pane, dpr: number) {
    ctx.save();
    setMatrix(ctx, p.matrix, dpr);
    for (const s of annot!.shapes) drawShape(ctx, s);
    if (drag?.kind === "draw") drawShape(ctx, drag.shape);
    const sel = drag?.kind === "move" ? drag.shape : annot!.shapes.find((s) => s.id === annot!.selected);
    if (sel && annotTool.tool === "select") drawSelection(ctx, sel, 1 / p.view.scale);
    ctx.restore();
  }

  /** marching ants of the selection and of the shape being drawn with a selection tool */
  function drawSelectionAnts(ctx: CanvasRenderingContext2D, p: Pane, dpr: number) {
    const s = p.view.scale;
    const live = new Path2D();
    let hasLive = false;
    if (drag?.kind === "sel") {
      const q = drag.pts;
      hasLive = true;
      if (drag.tool === "lasso") { live.moveTo(q[0], q[1]); for (let i = 2; i < q.length; i += 2) live.lineTo(q[i], q[i + 1]); }
      else {
        const [x0, y0, x1, y1] = q;
        if (drag.tool === "rect") live.rect(Math.round(Math.min(x0, x1)), Math.round(Math.min(y0, y1)), Math.round(Math.abs(x1 - x0)), Math.round(Math.abs(y1 - y0)));
        else live.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      }
    } else if (poly) {
      hasLive = true;
      const q = poly.pts;
      live.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) live.lineTo(q[i], q[i + 1]);
      if (polyMouse) live.lineTo(polyMouse[0], polyMouse[1]);
    }
    if (!selPath && !hasLive) return;
    ctx.save();
    setMatrix(ctx, p.matrix, dpr);
    ctx.lineWidth = 1 / s;
    const offset = ((performance.now() / 60) % 8) / s;
    for (const path of [selPath, hasLive ? live : null]) {
      if (!path) continue;
      ctx.setLineDash([]);
      ctx.strokeStyle = "#ffffff";
      ctx.stroke(path);
      ctx.setLineDash([4 / s, 4 / s]);
      ctx.lineDashOffset = -offset;
      ctx.strokeStyle = "#000000";
      ctx.stroke(path);
    }
    if (poly) {
      // the first point: click it to close
      ctx.setLineDash([]);
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(poly.pts[0] - 3 / s, poly.pts[1] - 3 / s, 6 / s, 6 / s);
    }
    ctx.restore();
  }

  /** Bounding box (in the matrix's source space) of the pane rectangle. */
  function visibleBox(m: Affine, p: Pane) {
    const pts = [applyInverse(m, p.x, p.y), applyInverse(m, p.x + p.w, p.y), applyInverse(m, p.x, p.y + p.h), applyInverse(m, p.x + p.w, p.y + p.h)];
    return {
      minX: Math.min(...pts.map((q) => q[0])), maxX: Math.max(...pts.map((q) => q[0])),
      minY: Math.min(...pts.map((q) => q[1])), maxY: Math.max(...pts.map((q) => q[1])),
    };
  }

  /** Pixel grid, composition grid and guides of one pane (clipped to it). Grid and guides live in A-space. */
  function drawExtras(ctx: CanvasRenderingContext2D, p: Pane, dpr: number, W: number, H: number) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(p.x, p.y, p.w, p.h);
    ctx.clip();
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

    // pixel grid of the image shown in this pane (its own pixels), only when zoomed in enough
    if (opt.pixelGrid && p.texScale >= 8) {
      const b = visibleBox(p.texMatrix, p);
      const x0 = Math.max(0, b.minX), x1 = Math.min(p.set.width, b.maxX), y0 = Math.max(0, b.minY), y1 = Math.min(p.set.height, b.maxY);
      if (x1 > x0 && y1 > y0) {
        setMatrix(ctx, p.texMatrix, dpr);
        ctx.lineWidth = 1 / p.texScale;
        ctx.strokeStyle = "rgba(150, 150, 150, 0.45)";
        lines(range(x0, x1, 1), range(y0, y1, 1), y0, y1, x0, x1);
      }
    }

    const s = p.view.scale;
    const lw = 1 / s; // 1 css px
    const { minX, maxX, minY, maxY } = visibleBox(p.matrix, p);
    setMatrix(ctx, p.matrix, dpr);

    // composition grid (inside the image)
    if (opt.grid !== "off") {
      const x0 = Math.max(0, minX), x1 = Math.min(W, maxX), y0 = Math.max(0, minY), y1 = Math.min(H, maxY);
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
    ctx.restore();
  }

  /** A / B labels and the swipe divider. */
  function drawCompareChrome(ctx: CanvasRenderingContext2D, r: Renderer, panes: Pane[], dpr: number) {
    const c = r.compare!;
    const W = overlay.clientWidth, H = overlay.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "12px 'Segoe UI', 'Yu Gothic UI', sans-serif";
    ctx.textBaseline = "middle";
    const label = (which: "A" | "B", x: number, alignRight: boolean) => {
      const name = which === "A" ? labels?.a ?? "" : labels?.b ?? "";
      const text = `${which}  ${name.length > 40 ? name.slice(0, 39) + "…" : name}`;
      const w = ctx.measureText(text).width + 16;
      const x0 = alignRight ? x - w : x;
      ctx.fillStyle = which === "A" ? "rgba(30, 90, 160, 0.85)" : "rgba(150, 70, 20, 0.85)";
      ctx.beginPath();
      ctx.roundRect(x0, 8, w, 22, 4);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(text, x0 + 8, 19);
    };
    if (c.mode === "side") {
      for (const p of panes) label(p.which, p.x + 8, false);
    } else if (c.mode === "swipe") {
      label("A", 8, false);
      label("B", W - 8, true);
      const x = Math.round(Math.min(1, Math.max(0, c.split)) * W) + 0.5;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      // handle
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(x, H / 2, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#333";
      ctx.beginPath();
      ctx.moveTo(x - 9, H / 2); ctx.lineTo(x - 3, H / 2 - 5); ctx.lineTo(x - 3, H / 2 + 5); ctx.closePath();
      ctx.moveTo(x + 9, H / 2); ctx.lineTo(x + 3, H / 2 - 5); ctx.lineTo(x + 3, H / 2 + 5); ctx.closePath();
      ctx.fill();
    } else {
      label(c.showB ? "B" : "A", 8, false);
    }
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

  /** A-space point under canvas point (cx, cy), and the pane there. */
  function pick(cx: number, cy: number): { pane: Pane; ix: number; iy: number } | null {
    const pane = renderer?.paneAt(cx, cy);
    if (!pane) return null;
    const [ix, iy] = applyInverse(pane.matrix, cx, cy);
    return { pane, ix, iy };
  }

  function guideAt(cx: number, cy: number): { axis: "v" | "h"; index: number } | null {
    if (!renderer?.hasImage || !guidesOn() || !guides) return null;
    const pk = pick(cx, cy);
    if (!pk) return null;
    const s = pk.pane.view.scale;
    let best: { axis: "v" | "h"; index: number } | null = null;
    let bestD = HIT;
    guides.v.forEach((g, i) => { const d = Math.abs(pk.ix - g) * s; if (d < bestD) { bestD = d; best = { axis: "v", index: i }; } });
    guides.h.forEach((g, i) => { const d = Math.abs(pk.iy - g) * s; if (d < bestD) { bestD = d; best = { axis: "h", index: i }; } });
    return best;
  }

  function onSplitHandle(cx: number) {
    const c = renderer?.compare;
    if (!c || c.mode !== "swipe") return false;
    return Math.abs(cx - c.split * canvas.clientWidth) <= SPLIT_HIT;
  }

  function onWheel(e: WheelEvent) {
    const r = renderer;
    if (!r?.hasImage) return;
    e.preventDefault();
    const [cx, cy] = local(e);
    const pane = r.paneAt(cx, cy);
    if (!pane) return;
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    pane.view.zoomAt(pane.view.scale * factor, cx - pane.ox, cy - pane.oy);
    r.requestDraw();
  }

  function onPointerDown(e: PointerEvent) {
    const r = renderer;
    if (!r?.hasImage) return;
    const [cx, cy] = local(e);
    const pane = r.paneAt(cx, cy);
    if (!pane) return;
    if (e.button === 0 && !rDown && !spaceDown && annotating()) {
      e.preventDefault(); // no focus change: a text box opened here keeps the focus
      if (!annotDown(e, cx, cy, pane)) return;
    } else if (e.button === 0 && !rDown && !spaceDown && selecting()) {
      e.preventDefault();
      if (!selDown(e, cx, cy, pane)) return;
    } else if (e.button === 0 && rDown) {
      const pcx = pane.ox + pane.view.vw / 2, pcy = pane.oy + pane.view.vh / 2;
      drag = { kind: "rotate", view: pane.view, cx: pcx, cy: pcy, start: Math.atan2(cy - pcy, cx - pcx), startRot: pane.view.rotation };
    } else if (e.button === 0 && !spaceDown && onSplitHandle(cx)) {
      drag = { kind: "split" };
    } else if (e.button === 0 && !spaceDown && guideAt(cx, cy)) {
      const g = guideAt(cx, cy)!;
      drag = { kind: "guide", ...g };
      hot = g;
    } else if (e.button === 0 || e.button === 1 || spaceDown) {
      drag = { kind: "pan", view: pane.view, x: e.clientX, y: e.clientY };
    } else {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    updateCursor(cx, cy);
  }

  /** Starts a selection shape. Returns false when nothing needs a pointer capture (polygon clicks). */
  function selDown(e: PointerEvent, cx: number, cy: number, pane: Pane): boolean {
    const [ix, iy] = applyInverse(pane.matrix, cx, cy);
    const tool = selTool.tool!;
    if (tool === "poly") {
      // double click: pointerdown's `detail` is not reliable in WebView2, so time and distance decide
      const now = performance.now();
      const dbl = !!lastPolyClick && now - lastPolyClick.t < 450 && Math.hypot(cx - lastPolyClick.cx, cy - lastPolyClick.cy) < 6;
      lastPolyClick = { t: now, cx, cy };
      if (!poly) { poly = { pts: [ix, iy], mode: modeOf(e) }; renderer?.requestDraw(); return false; }
      const near = Math.hypot(ix - poly.pts[0], iy - poly.pts[1]) * pane.view.scale < 7;
      if (near || dbl) { lastPolyClick = null; finishPoly(); return false; }
      poly.pts = [...poly.pts, ix, iy];
      renderer?.requestDraw();
      return false;
    }
    drag = { kind: "sel", tool, mode: modeOf(e), pts: tool === "lasso" ? [ix, iy] : [ix, iy, ix, iy], shiftAtStart: e.shiftKey, shiftReleased: false };
    return true;
  }

  function finishPoly() {
    const p = poly;
    poly = null;
    polyMouse = null;
    if (!p) return;
    onselshape?.("poly", p.pts.length >= 6 ? p.pts : [], p.mode);
    renderer?.requestDraw();
  }

  function selMove(e: PointerEvent, cx: number, cy: number) {
    const pane = renderer?.panes()[0];
    if (!pane || drag?.kind !== "sel") return;
    const [ix, iy] = applyInverse(pane.matrix, cx, cy);
    if (drag.tool === "lasso") {
      const n = drag.pts.length;
      if (Math.hypot(ix - drag.pts[n - 2], iy - drag.pts[n - 1]) * pane.view.scale >= 1.5) drag.pts = [...drag.pts, ix, iy];
    } else {
      let [x, y] = [ix, iy];
      // Shift pressed to add (at the start) does not make a square; Shift pressed (again) while dragging does
      if (!e.shiftKey) drag.shiftReleased = true;
      if (e.shiftKey && (!drag.shiftAtStart || drag.shiftReleased)) {
        // square / circle
        const dx = x - drag.pts[0], dy = y - drag.pts[1], d = Math.max(Math.abs(dx), Math.abs(dy));
        x = drag.pts[0] + Math.sign(dx || 1) * d;
        y = drag.pts[1] + Math.sign(dy || 1) * d;
      }
      drag.pts = [drag.pts[0], drag.pts[1], x, y];
    }
    renderer?.requestDraw();
  }

  function selUp() {
    if (drag?.kind !== "sel") return;
    const d = drag;
    const scale = renderer?.panes()[0]?.view.scale ?? 1;
    const q = d.pts;
    const tiny = d.tool === "lasso" ? q.length < 6 : Math.abs(q[2] - q[0]) * scale < 2 && Math.abs(q[3] - q[1]) * scale < 2;
    onselshape?.(d.tool, tiny ? [] : q, d.mode);
    renderer?.requestDraw();
  }

  /** Starts drawing / selecting with the annotation tool. Returns false when nothing needs a pointer capture. */
  function annotDown(e: PointerEvent, cx: number, cy: number, pane: Pane): boolean {
    const a = annot!;
    const [ix, iy] = applyInverse(pane.matrix, cx, cy);
    const px = 1 / pane.view.scale; // image px per css px
    const tool = annotTool.tool!;
    if (textEdit) { commitText(); return false; }
    if (tool === "select") {
      const s = shapeAt(a.shapes, ix, iy, 6 * px);
      a.selected = s?.id ?? null;
      if (!s) return false;
      if (e.detail >= 2 && s.kind === "text") { editText(s, pane); return false; }
      drag = { kind: "move", shape: s, x: ix, y: iy, moved: false };
      return true;
    }
    if (tool === "text") {
      const s = shapeAt(a.shapes.filter((x) => x.kind === "text"), ix, iy, 2 * px);
      if (s) { editText(s, pane); return false; }
      const size = FONT_SIZES[annotTool.widthIndex];
      textEdit = { cx, cy: cy - size * 0.1, ix, iy, size: size * px, color: annotTool.color, value: "", replace: null };
      return false;
    }
    a.selected = null;
    const shape: Shape = {
      id: a.nextId(), kind: tool, color: annotTool.color, width: WIDTHS[annotTool.widthIndex] * px,
      pts: tool === "pen" ? [ix, iy] : [ix, iy, ix, iy],
    };
    drag = { kind: "draw", shape, x0: ix, y0: iy };
    return true;
  }

  function annotMove(e: PointerEvent, cx: number, cy: number) {
    const pane = renderer?.panes()[0];
    if (!pane || !drag) return;
    const [ix, iy] = applyInverse(pane.matrix, cx, cy);
    if (drag.kind === "draw") {
      const s = drag.shape;
      if (s.kind === "pen") {
        const n = s.pts.length;
        if (Math.hypot(ix - s.pts[n - 2], iy - s.pts[n - 1]) * pane.view.scale >= 1.5) s.pts = [...s.pts, ix, iy];
      } else {
        const [x, y] = e.shiftKey ? constrain(s.kind, drag.x0, drag.y0, ix, iy) : [ix, iy];
        s.pts = [drag.x0, drag.y0, x, y];
      }
    } else if (drag.kind === "move") {
      drag.shape = translate(drag.shape, ix - drag.x, iy - drag.y);
      drag.x = ix;
      drag.y = iy;
      drag.moved = true;
    }
    renderer?.requestDraw();
  }

  function annotUp() {
    const a = annot;
    if (!a || !drag) return;
    if (drag.kind === "draw") {
      const s = drag.shape;
      const p = s.pts;
      const tiny = s.kind !== "pen" && Math.hypot(p[2] - p[0], p[3] - p[1]) * (renderer?.panes()[0]?.view.scale ?? 1) < 3;
      if (!tiny) a.add(s);
    } else if (drag.kind === "move" && drag.moved) {
      a.replace(drag.shape);
    }
  }

  // ---- text

  function editText(s: Shape, pane: Pane) {
    const [cx, cy] = [pane.matrix[0] * s.pts[0] + pane.matrix[1] * s.pts[1] + pane.matrix[2], pane.matrix[3] * s.pts[0] + pane.matrix[4] * s.pts[1] + pane.matrix[5]];
    textEdit = { cx, cy, ix: s.pts[0], iy: s.pts[1], size: s.size ?? 24, color: s.color, value: s.text ?? "", replace: s };
  }

  function commitText() {
    const t = textEdit;
    const a = annot;
    textEdit = null;
    if (!t || !a) return;
    const text = t.value.replace(/\s+$/, "");
    if (t.replace) {
      if (!text) a.remove(t.replace.id);
      else if (text !== t.replace.text) a.replace({ ...t.replace, text });
      return;
    }
    if (!text) return;
    a.add({ id: a.nextId(), kind: "text", color: t.color, width: t.size / 8, pts: [t.ix, t.iy], text, size: t.size });
  }

  function focusText(el: HTMLTextAreaElement) {
    queueMicrotask(() => { el.focus(); el.select(); });
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
    if (drag?.kind === "draw" || drag?.kind === "move") {
      annotMove(e, cx, cy);
    } else if (drag?.kind === "sel") {
      selMove(e, cx, cy);
    } else if (poly) {
      const pane = r.panes()[0];
      if (pane) { polyMouse = applyInverse(pane.matrix, cx, cy) as [number, number]; r.requestDraw(); }
      updateCursor(cx, cy);
    } else if (drag?.kind === "pan") {
      drag.view.panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
      r.requestDraw();
    } else if (drag?.kind === "rotate") {
      let deg = drag.startRot + ((Math.atan2(cy - drag.cy, cx - drag.cx) - drag.start) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      drag.view.rotateTo(deg);
      r.requestDraw();
    } else if (drag?.kind === "split") {
      onsplit?.(Math.min(1, Math.max(0, cx / canvas.clientWidth)));
    } else if (drag?.kind === "guide" && guides) {
      const pk = pick(cx, cy);
      if (pk) guides[drag.axis][drag.index] = Math.round(drag.axis === "v" ? pk.ix : pk.iy);
    } else {
      updateCursor(cx, cy);
    }
    if (r.hasImage) {
      const pk = pick(cx, cy);
      if (pk) oncursor?.([pk.ix, pk.iy]);
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
    if (drag?.kind === "draw" || drag?.kind === "move") annotUp();
    if (drag?.kind === "sel") selUp();
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
    if (annotating() && !spaceDown && !rDown) {
      const t = annotTool.tool;
      if (t === "select") {
        const pk = pick(cx, cy);
        cursorClass = drag?.kind === "move" || (pk && annot && shapeAt(annot.shapes, pk.ix, pk.iy, 6 / pk.pane.view.scale)) ? "move" : "";
      } else {
        cursorClass = t === "text" ? "text" : "draw";
      }
      return;
    }
    if (drag?.kind === "rotate" || rDown) { cursorClass = "rotate"; return; }
    if ((selecting() || drag?.kind === "sel") && !spaceDown) { cursorClass = "draw"; return; }
    if (drag?.kind === "guide") { cursorClass = drag.axis === "v" ? "col" : "row"; return; }
    if (drag?.kind === "split" || (!spaceDown && onSplitHandle(cx))) { cursorClass = "col"; return; }
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
  {#if textEdit}
    {@const scale = renderer?.panes()[0]?.view.scale ?? 1}
    <textarea class="annot-text" rows="1" use:focusText bind:value={textEdit.value}
      style:left="{textEdit.cx}px" style:top="{textEdit.cy}px" style:color={textEdit.color}
      style:font-size="{textEdit.size * scale}px" style:min-width="{textEdit.size * scale * 4}px"
      style:height="{(textEdit.value.split('\n').length * 1.25 + 0.2) * textEdit.size * scale}px"
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { textEdit = null; }
        else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitText(); }
      }}
      onblur={commitText}></textarea>
  {/if}
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
  .gl.draw { cursor: crosshair; }
  .gl.text { cursor: text; }
  .gl.move { cursor: move; }
  .annot-text {
    position: absolute; z-index: 5; margin: 0; padding: 0; border: 1px dashed rgba(255, 255, 255, 0.7);
    background: rgba(0, 0, 0, 0.25); font-weight: bold; line-height: 1.25; resize: none; overflow: hidden;
    font-family: "Segoe UI", "Yu Gothic UI", "Hiragino Sans", sans-serif; outline: none;
    -webkit-text-stroke: 0.5px rgba(0, 0, 0, 0.6);
  }
  .overlay { pointer-events: none; }
  .ruler { background: #262626; touch-action: none; }
  .ruler.top { left: 18px; right: 0; top: 0; height: 18px; width: calc(100% - 18px); cursor: row-resize; }
  .ruler.left { top: 18px; bottom: 0; left: 0; width: 18px; height: calc(100% - 18px); cursor: col-resize; }
  .ruler.corner { position: absolute; left: 0; top: 0; width: 18px; height: 18px; background: #262626; border-right: 1px solid #3a3a3a; border-bottom: 1px solid #3a3a3a; }
</style>
