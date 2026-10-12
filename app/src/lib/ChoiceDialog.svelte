<script lang="ts">
  // A question with several answers (the native dialog only has two buttons). Enter: the first answer,
  // Esc / clicking outside: the last one (cancel).
  let { text, options, onchoose }: { text: string; options: string[]; onchoose: (i: number) => void } = $props();
  let box: HTMLDivElement;
  $effect(() => { (box.querySelector("button") as HTMLButtonElement | null)?.focus(); });
</script>

<div class="back" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) onchoose(options.length - 1); }}>
  <div class="dlg" role="dialog" aria-modal="true" tabindex="-1" bind:this={box}
    onkeydown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onchoose(options.length - 1); }
    }}>
    <p>{text}</p>
    <div class="btns">
      {#each options as o, i (o)}
        <button class:primary={i === 0} onclick={() => onchoose(i)}>{o}</button>
      {/each}
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.35); }
  .dlg {
    position: absolute; left: 50%; top: 30%; transform: translate(-50%, -50%); max-width: 520px;
    background: #2b2b2b; border: 1px solid #555; border-radius: 8px; padding: 14px 16px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); font-size: 13px; outline: none;
  }
  p { margin: 0 0 14px; white-space: pre-line; line-height: 1.6; }
  .btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 4px; padding: 5px 12px; font: inherit; cursor: pointer; }
  button.primary { background: #2f4f73; border-color: var(--accent); color: #fff; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
