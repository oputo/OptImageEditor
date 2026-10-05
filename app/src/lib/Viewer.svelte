<script lang="ts">
  // Canvas view: owns the WebGL renderer and the zoom / pan interaction.
  import { onMount } from "svelte";
  import { Renderer } from "./renderer";

  let { renderer = $bindable(), onzoom }: { renderer?: Renderer; onzoom?: (scale: number) => void } = $props();

  let canvas: HTMLCanvasElement;
  let panning = $state(false);
  let spaceDown = false;
  let lastX = 0;
  let lastY = 0;

  onMount(() => {
    const r = new Renderer(canvas);
    renderer = r;
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(canvas);
    r.resize();
    const kd = (e: KeyboardEvent) => { if (e.code === "Space") spaceDown = true; };
    const ku = (e: KeyboardEvent) => { if (e.code === "Space") spaceDown = false; };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      r.clear();
    };
  });

  function onWheel(e: WheelEvent) {
    if (!renderer?.hasImage) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    renderer.zoomAt(renderer.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    onzoom?.(renderer.scale);
  }

  function onPointerDown(e: PointerEvent) {
    if (!renderer?.hasImage) return;
    if (e.button === 0 || e.button === 1 || spaceDown) {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!panning || !renderer) return;
    renderer.panBy(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
  }

  const endPan = () => (panning = false);
</script>

<canvas
  bind:this={canvas}
  class:panning
  onwheel={onWheel}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endPan}
  onpointercancel={endPan}
></canvas>

<style>
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
    touch-action: none;
  }
  canvas.panning { cursor: grabbing; }
</style>
