<script lang="ts">
  // Tab strip: click = activate, × / middle click = close, double click on empty space = open.
  import type { Tab } from "./viewerState.svelte";

  let { tabs, activeId, onactivate, onclose, onopen }: {
    tabs: Tab[];
    activeId: number | null;
    onactivate: (id: number) => void;
    onclose: (id: number) => void;
    onopen: () => void;
  } = $props();

  let strip: HTMLDivElement;

  // keep the active tab visible
  $effect(() => {
    void activeId;
    strip?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
</script>

<div class="tabbar" bind:this={strip} role="tablist" tabindex="-1" ondblclick={(e) => { if (e.target === strip) onopen(); }}>
  {#each tabs as t (t.id)}
    <div
      class="tab"
      class:active={t.id === activeId}
      class:error={!!t.error}
      role="tab"
      tabindex="0"
      aria-selected={t.id === activeId}
      title={t.path ?? t.name}
      onmousedown={(e) => { if (e.button === 1) { e.preventDefault(); onclose(t.id); } else if (e.button === 0) onactivate(t.id); }}
      onkeydown={(e) => { if (e.key === "Enter") onactivate(t.id); }}
    >
      {#if t.loading}<span class="spin" aria-label="読み込み中"></span>{/if}
      <span class="name">{t.name}</span>
      <button class="x" title="閉じる (Ctrl+W)" onmousedown={(e) => e.stopPropagation()} onclick={() => onclose(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .tabbar {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 30px;
    padding: 0 6px;
    background: #232323;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    overflow-y: hidden;
    flex: none;
    scrollbar-width: thin;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    min-width: 80px;
    height: 26px;
    padding: 0 4px 0 10px;
    background: #2e2e2e;
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    color: var(--muted);
    cursor: default;
    flex: none;
  }
  .tab:hover { background: #353535; }
  .tab.active { background: var(--bg); color: var(--text); border-color: #4a4a4a; }
  .tab.error .name { color: #ffb4a8; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .x {
    border: none;
    background: transparent;
    color: inherit;
    width: 18px;
    height: 18px;
    line-height: 16px;
    padding: 0;
    border-radius: 3px;
    font-size: 14px;
    cursor: pointer;
  }
  .x:hover { background: #555; color: #fff; }
  .spin {
    width: 10px;
    height: 10px;
    border: 2px solid #666;
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
