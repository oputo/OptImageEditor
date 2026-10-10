<script lang="ts">
  // Colour picker (phase 3-b): saturation / value square, hue bar, HEX and RGB fields. Changes apply live.
  import { untrack } from "svelte";
  import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "./paint.svelte";

  let { value, title, onchange, onclose }: { value: string; title: string; onchange: (hex: string) => void; onclose: () => void } = $props();

  const start = untrack(() => value);
  const [r0, g0, b0] = hexToRgb(start);
  let hsv = $state(rgbToHsv(r0, g0, b0));
  const rgb = $derived(hsvToRgb(hsv[0], hsv[1], hsv[2]).map((v) => Math.round(v * 255)) as [number, number, number]);
  const hex = $derived(rgbToHex(rgb[0], rgb[1], rgb[2]));
  let hexText = $state(start);
  $effect(() => { const h = hex; untrack(() => { hexText = h; onchange(h); }); });

  function setHex(t: string) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(t.trim());
    if (!m) return;
    const s = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
    const [r, g, b] = hexToRgb("#" + s);
    const h = rgbToHsv(r, g, b);
    hsv = [h[1] === 0 ? hsv[0] : h[0], h[1], h[2]];
  }
  function setRgb(i: number, v: number) {
    const c = [...rgb];
    c[i] = Math.max(0, Math.min(255, v || 0));
    const h = rgbToHsv(c[0] / 255, c[1] / 255, c[2] / 255);
    hsv = [h[1] === 0 ? hsv[0] : h[0], h[1], h[2]];
  }

  function dragOn(el: HTMLElement, f: (x: number, y: number) => void) {
    const go = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      f(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    };
    const down = (e: PointerEvent) => { el.setPointerCapture(e.pointerId); go(e); };
    const move = (e: PointerEvent) => { if (el.hasPointerCapture(e.pointerId)) go(e); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    return { destroy() { el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); } };
  }
  const sv = (el: HTMLElement) => dragOn(el, (x, y) => (hsv = [hsv[0], x, 1 - y]));
  const hue = (el: HTMLElement) => dragOn(el, (_x, y) => (hsv = [y * 359.9, hsv[1], hsv[2]]));
</script>

<div class="back" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="cp" role="dialog" aria-label={title} tabindex="-1"
    onkeydown={(e) => { e.stopPropagation(); if (e.key === "Escape" || e.key === "Enter") onclose(); }}>
    <div class="head"><span>{title}</span><span class="spacer"></span>
      <span class="sw" style:background={start} title="元の色（クリックで戻す）" role="button" tabindex="-1" onclick={() => setHex(start)} onkeydown={() => {}}></span>
      <span class="sw" style:background={hex} title="新しい色"></span>
    </div>
    <div class="row">
      <div class="sv" use:sv style:background="hsl({hsv[0]}, 100%, 50%)">
        <div class="wl"></div><div class="bl"></div>
        <div class="knob" style:left="{hsv[1] * 100}%" style:top="{(1 - hsv[2]) * 100}%"></div>
      </div>
      <div class="hue" use:hue><div class="hk" style:top="{(hsv[0] / 360) * 100}%"></div></div>
    </div>
    <div class="fields">
      <label>#<input class="hex" value={hexText.slice(1)} onchange={(e) => setHex((e.currentTarget as HTMLInputElement).value)} /></label>
      {#each ["R", "G", "B"] as c, i (c)}
        <label>{c}<input type="number" min="0" max="255" value={rgb[i]} onchange={(e) => setRgb(i, Number((e.currentTarget as HTMLInputElement).value))} /></label>
      {/each}
      <button onclick={onclose}>OK</button>
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 55; }
  .cp { position: absolute; left: 50%; top: 80px; transform: translateX(-50%); background: #2b2b2b; border: 1px solid #555; border-radius: 8px; padding: 10px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); font-size: 12px; outline: none; }
  .head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .spacer { flex: 1; }
  .sw { width: 28px; height: 18px; border: 1px solid #777; border-radius: 3px; cursor: pointer; }
  .row { display: flex; gap: 8px; }
  .sv { position: relative; width: 220px; height: 170px; border-radius: 3px; cursor: crosshair; touch-action: none; }
  .wl, .bl { position: absolute; inset: 0; border-radius: 3px; pointer-events: none; }
  .wl { background: linear-gradient(to right, #fff, rgba(255, 255, 255, 0)); }
  .bl { background: linear-gradient(to top, #000, rgba(0, 0, 0, 0)); }
  .knob { position: absolute; width: 10px; height: 10px; margin: -6px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 2px #000; pointer-events: none; }
  .hue { position: relative; width: 18px; height: 170px; border-radius: 3px; cursor: ns-resize; touch-action: none;
    background: linear-gradient(to bottom, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
  .hk { position: absolute; left: -2px; right: -2px; height: 4px; margin-top: -2px; border: 1px solid #fff; box-shadow: 0 0 2px #000; pointer-events: none; }
  .fields { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
  .fields label { display: flex; align-items: center; gap: 3px; color: var(--muted); }
  input { background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; padding: 2px 4px; width: 40px; }
  .hex { width: 58px; }
  button { background: #2f4f73; border: 1px solid var(--accent); color: #fff; border-radius: 4px; padding: 2px 12px; font: inherit; cursor: pointer; margin-left: auto; }
</style>
