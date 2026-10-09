<script lang="ts">
  // Layers panel. 2-a: tree, visibility, blend mode, opacity / fill, mask on/off.
  // 2-b: every change goes through ViewerState (undo history, dirty flag): new layer / group, duplicate, delete,
  // drag to reorder (pointer events: HTML5 drag & drop does not work in the Windows webview while native file drop is on),
  // double click to rename, clipping mask, save.
  import { BLEND_LABEL, BLEND_MODES, LOCK_ALL, LOCK_PIXELS, LOCK_POSITION, LOCK_TRANSPARENCY, type DocLayer, type LayerBlendMode } from "./psdDoc";
  import type { Tab, ViewerState } from "./viewerState.svelte";
  import { modeOf } from "./selection.svelte";

  let { vs, tab, onsave, onmsg }: { vs: ViewerState; tab: Tab | null; onsave: (saveAs: boolean) => void; onmsg: (text: string) => void } = $props();

  // merge menu (phase 2-c)
  let mergeMenu = $state(false);
  async function merge(kind: "down" | "visible" | "flatten") {
    mergeMenu = false;
    if (!tab) return;
    const m = kind === "down" ? vs.mergeDown(tab) : kind === "visible" ? vs.mergeVisible(tab) : await vs.flatten(tab);
    if (m) onmsg(m);
  }
  const LOCKS = [
    { flag: LOCK_TRANSPARENCY, icon: "▦", label: "透明部分をロック" },
    { flag: LOCK_PIXELS, icon: "✎", label: "画像をロック" },
    { flag: LOCK_POSITION, icon: "✥", label: "位置をロック" },
    { flag: LOCK_ALL, icon: "🔒", label: "すべてをロック" },
  ];
  const hasLock = (l: DocLayer, f: number) => ((l.locks >>> 0) & f) !== 0;

  const L = $derived(tab?.layers ?? null);
  type Row = { l: DocLayer; depth: number; clipped: boolean };

  // panel order: top layer first; children of collapsed groups are hidden
  const rows = $derived.by(() => {
    const out: Row[] = [];
    const visit = (layers: DocLayer[], depth: number) => {
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        out.push({ l, depth, clipped: l.clipping });
        if (l.children && l.open) visit(l.children, depth + 1);
      }
    };
    if (L) visit(L.tree, 0);
    return out;
  });

  const find = (id: number | null) => {
    if (id === null || !L) return null;
    const walk = (ls: DocLayer[]): DocLayer | null => {
      for (const l of ls) { if (l.id === id) return l; const r = l.children ? walk(l.children) : null; if (r) return r; }
      return null;
    };
    return walk(L.tree);
  };
  const selected = $derived(find(L?.selectedId ?? null));
  const total = $derived.by(() => {
    let n = 0;
    const walk = (ls: DocLayer[]) => { for (const x of ls) { n++; if (x.children) walk(x.children); } };
    if (L) walk(L.tree);
    return n;
  });

  function update(id: number, patch: Parameters<ViewerState["updateLayer"]>[2], key: string | null = null) {
    if (tab) vs.updateLayer(tab, id, patch, key);
  }
  /** property change for every selected layer */
  function updateSel(patch: Parameters<ViewerState["updateLayer"]>[2], key: string | null = null) {
    if (tab) vs.updateSelected(tab, patch, key);
  }
  const selNodes = $derived((L?.selection ?? []).map((id) => find(id)).filter((x): x is DocLayer => !!x));
  /** the selected layers disagree on `k` (shown as "—") */
  const mixed = (k: "blendMode" | "opacity" | "fill" | "clipping") =>
    !!selected && selNodes.some((x) => (k === "fill" || k === "clipping" ? !x.children : true) && x[k] !== selected[k]);
  const isSel = (id: number) => !!L && (L.selection.includes(id) || (!L.selection.length && L.selectedId === id));

  // ---- eye: click toggles; press + drag over other rows gives them the same state (one undo step)
  let eyeDrag: { hidden: boolean; key: string } | null = null;
  let eyeSeq = 0;
  function eyeDown(l: DocLayer, e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || !tab) return;
    if (e.altKey) { toggleEye(l, e); return; }
    solo = null;
    eyeDrag = { hidden: !l.hidden, key: `eye:${++eyeSeq}` };
    vs.setHiddenDrag(tab, l.id, eyeDrag.hidden, eyeDrag.key);
  }
  function eyeEnter(l: DocLayer, e: PointerEvent) {
    if (!eyeDrag || !tab) return;
    if (!(e.buttons & 1)) { eyeDrag = null; return; }
    if (l.hidden !== eyeDrag.hidden) vs.setHiddenDrag(tab, l.id, eyeDrag.hidden, eyeDrag.key);
  }

  // Alt+click on an eye: show only this layer (again: restore)
  let solo: { id: number; saved: Map<number, boolean> } | null = null;
  function toggleEye(target: DocLayer, e: MouseEvent) {
    if (!tab || !L) return;
    const id = target.id;
    void e;
    vs.edit(tab, null, (tree) => {
      const all: DocLayer[] = [];
      const walk = (ls: DocLayer[]) => { for (const x of ls) { all.push(x); if (x.children) walk(x.children); } };
      walk(tree);
      const l = all.find((x) => x.id === id);
      if (!l) return;
        if (solo?.id === id) {
        for (const x of all) x.hidden = solo.saved.get(x.id) ?? x.hidden;
        solo = null;
        return;
      }
      const saved = new Map(all.map((x) => [x.id, x.hidden]));
      // keep the ancestors of l visible
      const path = new Set<number>();
      const mark = (ls: DocLayer[]): boolean => {
        for (const x of ls) {
          if (x.id === id || (x.children && mark(x.children))) { path.add(x.id); return true; }
        }
        return false;
      };
      mark(tree);
      const inside = new Set<number>();
      const under = (x: DocLayer) => { inside.add(x.id); x.children?.forEach(under); };
      under(l);
      for (const x of all) x.hidden = path.has(x.id) ? false : inside.has(x.id) ? x.hidden : true;
      solo = { id, saved };
    });
  }

  // ---- rename (double click on the name)
  let renaming = $state<number | null>(null);
  function startRename(l: DocLayer) { renaming = l.id; }
  function focusSelect(el: HTMLInputElement) { el.focus(); el.select(); }
  function finishRename(l: DocLayer, el: HTMLInputElement, commit: boolean) {
    if (renaming !== l.id) return;
    renaming = null;
    const name = el.value.trim();
    if (commit && name && name !== l.name) update(l.id, { name });
  }

  // ---- drag to reorder
  type Drop = { id: number; where: "above" | "below" | "inside" };
  let drag = $state<{ id: number; y0: number; active: boolean; drop: Drop | null } | null>(null);
  let listEl: HTMLDivElement | undefined = $state();

  // ---- selection: click = only this, Ctrl+click = add / remove, Shift+click = range (panel order)
  let anchor: number | null = null;
  let collapseTo: number | null = null; // a click (no drag) on a multi-selected row selects only it

  function onRowDown(l: DocLayer, e: PointerEvent) {
    if (e.button !== 0 || renaming !== null || !L || !tab) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    const cls = (e.target as HTMLElement).classList;
    // Ctrl+click on the thumbnail: select the layer's opaque pixels (+Shift add, +Alt subtract, +Shift+Alt intersect)
    if ((e.ctrlKey || e.metaKey) && cls.contains("thumb")) {
      vs.selectFromLayer(tab, l.id, modeOf(e));
      return;
    }
    // mask thumbnail: click = edit the mask, Ctrl = selection from it, Shift = on / off, Alt = show it
    if (cls.contains("mthumb") && l.mask) {
      if (e.ctrlKey || e.metaKey) vs.selectFromMask(tab, l.id, modeOf(e));
      else if (e.shiftKey) { vs.select(tab, [l.id]); update(l.id, { maskDisabled: !l.mask.disabled }); }
      else if (e.altKey) { vs.select(tab, [l.id]); vs.showMask(tab, L.maskView === l.id ? null : l.id); }
      else { vs.select(tab, [l.id]); vs.setMaskTarget(tab, true); }
      return;
    }
    if (cls.contains("thumb") && !e.shiftKey) { vs.select(tab, [l.id]); vs.setMaskTarget(tab, false); }
    collapseTo = null;
    if (e.ctrlKey || e.metaKey) {
      const has = L.selection.includes(l.id);
      const base = L.selection.length ? L.selection : L.selectedId !== null ? [L.selectedId] : [];
      vs.select(tab, has ? base.filter((x) => x !== l.id) : [...base, l.id], has ? null : l.id);
      anchor = l.id;
      return;
    }
    if (e.shiftKey && anchor !== null) {
      const ids = rows.map((r) => r.l.id);
      const a = ids.indexOf(anchor), b = ids.indexOf(l.id);
      if (a >= 0 && b >= 0) {
        vs.select(tab, ids.slice(Math.min(a, b), Math.max(a, b) + 1), l.id);
        return;
      }
    }
    anchor = l.id;
    if (L.selection.includes(l.id) && L.selection.length > 1) {
      vs.select(tab, L.selection, l.id); // keep the selection for dragging them together
      collapseTo = l.id;
    } else {
      vs.select(tab, [l.id]);
    }
    // pointer capture only once the drag starts: capturing on down would retarget click / dblclick to the list
    drag = { id: l.id, y0: e.clientY, active: false, drop: null };
  }

  function onListMove(e: PointerEvent) {
    if (!drag) return;
    if (!drag.active) {
      if (!(e.buttons & 1)) { drag = null; return; }
      if (Math.abs(e.clientY - drag.y0) < 5) return;
      drag.active = true;
      listEl?.setPointerCapture(e.pointerId);
    }
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".row");
    const id = el ? Number(el.dataset.id) : NaN;
    const target = find(id);
    if (!el || !target || id === drag.id) { drag.drop = null; return; }
    const r = el.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    const where: Drop["where"] = target.children ? (f < 0.25 ? "above" : f > 0.75 ? "below" : "inside") : f < 0.5 ? "above" : "below";
    drag.drop = { id, where };
    // auto-scroll near the edges
    if (listEl) {
      const lr = listEl.getBoundingClientRect();
      if (e.clientY < lr.top + 20) listEl.scrollTop -= 8;
      else if (e.clientY > lr.bottom - 20) listEl.scrollTop += 8;
    }
  }

  function onListUp() {
    const d = drag;
    drag = null;
    if (d && !d.active && collapseTo !== null && tab) vs.select(tab, [collapseTo]);
    collapseTo = null;
    if (!d?.active || !d.drop || !tab) return;
    vs.move(tab, d.id, d.drop.id, d.drop.where);
  }

  function thumb(canvas: HTMLCanvasElement, t: DocLayer["thumb"]) {
    const draw = (t: DocLayer["thumb"]) => {
      const S = 40;
      canvas.width = S; canvas.height = S;
      const ctx = canvas.getContext("2d")!;
      for (let y = 0; y < S; y += 5) for (let x = 0; x < S; x += 5) {
        ctx.fillStyle = (x + y) % 10 === 0 ? "#6b6b6b" : "#525252";
        ctx.fillRect(x, y, 5, 5);
      }
      if (!t) return;
      const c = new OffscreenCanvas(t.w, t.h);
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.w, t.h), 0, 0);
      ctx.drawImage(c, (S - t.w) / 2, (S - t.h) / 2);
    };
    draw(t);
    return { update: draw };
  }

  const KIND_BADGE: Record<string, string> = { text: "T", smart: "SO", fill: "塗", adjustment: "調" };
  const pct = (v: number) => Math.round(v * 100);
  const kb = (n: number) => (n / 2 ** 20).toFixed(1) + " MB";
</script>

<svelte:window onmousedown={(e) => { if (mergeMenu && !(e.target as HTMLElement).closest(".mwrap")) mergeMenu = false; }} />

<aside class="panel">
  <header>
    <span class="title">レイヤー</span>
    {#if L?.status === "ready"}
      <span class="count">{total}</span>
      {#if L.dirty}<span class="dirty" title="未保存の変更があります (Ctrl+S で保存)">●</span>{/if}
      <span class="spacer"></span>
      <div class="seg" title="表示する画像 (F4)">
        <button class:on={!L.useLayers} onclick={() => tab && vs.setUseLayers(tab, false)}>PS の統合画像</button>
        <button class:on={L.useLayers} onclick={() => tab && vs.setUseLayers(tab, true)}>レイヤー合成</button>
      </div>
    {/if}
  </header>

  {#if !tab}
    <div class="msg">画像を開いてください</div>
  {:else if !L}
    <div class="msg">PSD / PSB のレイヤーを表示します</div>
  {:else if L.status === "loading"}
    <div class="msg"><span class="spin"></span> レイヤーを読み込み中…</div>
  {:else if L.status === "error"}
    <div class="msg err">{L.error}</div>
  {:else}
    <div class="list" role="listbox" aria-label="レイヤー" tabindex="-1" bind:this={listEl} class:dragging={drag?.active}
      onpointermove={onListMove} onpointerup={onListUp} onpointercancel={() => (drag = null)}>
      {#each rows as r (r.l.id)}
        {@const l = r.l}
        {@const dr = drag?.active && drag.drop?.id === l.id ? drag.drop.where : null}
        <div class="row" class:sel={isSel(l.id)} class:act={L.selectedId === l.id && L.selection.length > 1} class:dim={l.hidden}
          class:src={drag?.active && (drag.id === l.id || (L.selection.includes(drag.id) && L.selection.includes(l.id)))}
          class:d-above={dr === "above"} class:d-below={dr === "below"} class:d-inside={dr === "inside"}
          data-id={l.id} role="option" aria-selected={isSel(l.id)} tabindex="-1"
          style:padding-left="{4 + r.depth * 14}px"
          onpointerdown={(e) => onRowDown(l, e)} onpointerenter={(e) => eyeEnter(l, e)} onkeydown={() => {}}>
          <button class="eye" title="表示 / 非表示（Alt+クリック: このレイヤーだけ表示）"
            onpointerdown={(e) => eyeDown(l, e)} onclick={(e) => e.stopPropagation()}>{l.hidden ? "" : "●"}</button>
          {#if l.children}
            <button class="exp" title={l.open ? "閉じる" : "開く"} onclick={(e) => { e.stopPropagation(); l.open = !l.open; }}>{l.open ? "▾" : "▸"}</button>
            <span class="folder">▭</span>
          {:else}
            {#if r.clipped}<span class="clip" title="クリッピングマスク">↳</span>{/if}
            <canvas class="thumb" class:target={!!l.mask && !L.maskTarget && L.selectedId === l.id} use:thumb={l.thumb} title="Ctrl+クリック: 不透明部分を選択（+Shift 追加 / +Alt 除外）"></canvas>
          {/if}
          {#if l.mask && !l.children && l.mask.thumb}
            <canvas class="mthumb" class:target={L.maskTarget && L.selectedId === l.id} class:off={l.mask.disabled} class:viewing={L.maskView === l.id}
              use:thumb={l.mask.thumb} title="レイヤーマスク{l.mask.disabled ? '（無効）' : ''}。クリック: マスクを編集対象に / Ctrl+クリック: 選択範囲に / Shift+クリック: 有効・無効 / Alt+クリック: マスクを表示"></canvas>
          {:else if l.mask}<span class="maskmark" class:off={l.mask.disabled} title={l.mask.disabled ? "マスク（無効）" : "レイヤーマスク"}>◐</span>{/if}
          {#if renaming === l.id}
            <input class="rename" value={l.name} use:focusSelect
              onkeydown={(e) => { if (e.key === "Enter") finishRename(l, e.currentTarget, true); else if (e.key === "Escape") finishRename(l, e.currentTarget, false); e.stopPropagation(); }}
              onblur={(e) => finishRename(l, e.currentTarget, true)} />
          {:else}
            <span class="name" title="{l.name}（ダブルクリックで名前を変更）" role="textbox" tabindex="-1" ondblclick={() => startRename(l)}>{l.name}</span>
          {/if}
          {#if KIND_BADGE[l.kind]}<span class="badge">{KIND_BADGE[l.kind]}</span>{/if}
          {#if l.locks}<span class="lock" title="ロック">{hasLock(l, LOCK_ALL) ? "🔒" : "🔓"}</span>{/if}
          {#if l.warnings.length}<span class="warn" title={l.warnings.join("\n")}>⚠</span>{/if}
          {#if l.blendMode !== "normal" && l.blendMode !== "pass through"}<span class="mode">{BLEND_LABEL[l.blendMode]}</span>{/if}
        </div>
      {/each}
    </div>

    {#if selected}
      <div class="props">
        <div class="prow">
          <span class="lbl">描画モード</span>
          <select value={selected.blendMode} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) updateSel({ blendMode: v as LayerBlendMode }); (e.currentTarget as HTMLSelectElement).blur(); }}>
            {#if mixed("blendMode")}<option value="" selected>—</option>{/if}
            {#if selected.children}<option value="pass through">{BLEND_LABEL["pass through"]}</option>{/if}
            {#each BLEND_MODES as m (m)}<option value={m}>{BLEND_LABEL[m]}</option>{/each}
          </select>
        </div>
        <div class="prow">
          <span class="lbl">不透明度</span>
          <input type="range" min="0" max="100" value={pct(selected.opacity)} oninput={(e) => updateSel({ opacity: Number((e.currentTarget as HTMLInputElement).value) / 100 }, `opacity:${L.selection.join(",")}`)} />
          <span class="val">{mixed("opacity") ? "—" : `${pct(selected.opacity)}%`}</span>
        </div>
        {#if !selected.children}
          <div class="prow">
            <span class="lbl">塗り</span>
            <input type="range" min="0" max="100" value={pct(selected.fill)} oninput={(e) => updateSel({ fill: Number((e.currentTarget as HTMLInputElement).value) / 100 }, `fill:${L.selection.join(",")}`)} />
            <span class="val">{mixed("fill") ? "—" : `${pct(selected.fill)}%`}</span>
          </div>
        {/if}
        {#if !selected.children}
          <div class="prow">
            <span class="lbl">マスク</span>
            {#if selected.mask}
              <button class="mb" class:on={L.maskTarget} onclick={() => tab && vs.setMaskTarget(tab, !L.maskTarget)} title="描画・消去の対象をマスクにする（マスクのサムネイルをクリックでも同じ）">編集</button>
              <button class="mb" class:on={L.maskView === selected.id} onclick={() => tab && vs.showMask(tab, L.maskView === selected.id ? null : selected.id)} title="マスクを白黒で表示（Alt+サムネイル）">表示</button>
              <button class="mb" onclick={() => tab && onmsg(vs.applyMask(tab) ?? "")} title="マスクを画素に適用して削除">適用</button>
              <button class="mb" onclick={() => tab && onmsg(vs.deleteMask(tab) ?? "")} title="マスクを削除">削除</button>
            {:else}
              <button class="mb" onclick={(e) => tab && onmsg(vs.addMask(tab, e.altKey) ?? "")} title="レイヤーマスクを追加（選択範囲があればその形。Alt: 隠す）">追加</button>
            {/if}
          </div>
        {/if}
        {#if selected.mask}
          <label class="prow chk"><input type="checkbox" checked={!selected.mask.disabled} onchange={(e) => updateSel({ maskDisabled: !(e.currentTarget as HTMLInputElement).checked })} />レイヤーマスクを使う</label>
        {/if}
        {#if !selected.children}
          <label class="prow chk" title="下のレイヤーでクリッピング (Ctrl+Alt+G)"><input type="checkbox" checked={selected.clipping} indeterminate={mixed("clipping")} onchange={(e) => updateSel({ clipping: (e.currentTarget as HTMLInputElement).checked })} />クリッピングマスク</label>
        {/if}
        <div class="prow">
          <span class="lbl">ロック</span>
          {#each LOCKS as k (k.flag)}
            <button class="lk" class:on={hasLock(selected, k.flag)} title={k.label} onclick={() => tab && vs.toggleLock(tab, selected.id, k.flag)}>{k.icon}</button>
          {/each}
        </div>
        {#if selected.warnings.length}<div class="pwarn">⚠ {selected.warnings.join(" / ")}</div>{/if}
      </div>
    {/if}

    <div class="tools">
      <button disabled={!L.undoCount} onclick={() => tab && vs.undo(tab)} title="取り消し (Ctrl+Z)">↶</button>
      <button disabled={!L.redoCount} onclick={() => tab && vs.redo(tab)} title="やり直し (Ctrl+Shift+Z)">↷</button>
      <span class="sep"></span>
      <button onclick={() => tab && vs.newLayer(tab)} title="新規レイヤー (Ctrl+Shift+N)">＋</button>
      <button onclick={() => tab && vs.newGroup(tab)} title="新規グループ">▭</button>
      <button disabled={!selected} onclick={() => tab && vs.groupSelected(tab)} title="選択レイヤーをグループ化 (Ctrl+G)">G</button>
      <button disabled={!selected} onclick={() => tab && vs.duplicate(tab)} title="複製 (Ctrl+J)">⧉</button>
      <button disabled={!selected} onclick={() => tab && vs.deleteSelected(tab)} title="削除 (Delete)">🗑</button>
      <div class="mwrap">
        <button class:on={mergeMenu} onclick={() => (mergeMenu = !mergeMenu)} title="結合・統合">結合▾</button>
        {#if mergeMenu}
          <div class="mmenu" role="menu">
            <button role="menuitem" disabled={!selected} onclick={() => merge("down")}>{(L.selection.length > 1) ? "選択したレイヤーを結合" : selected?.children ? "グループを結合" : "下のレイヤーと結合"}<kbd>Ctrl+E</kbd></button>
            <button role="menuitem" onclick={() => merge("visible")}>表示レイヤーを結合<kbd>Ctrl+Shift+E</kbd></button>
            <button role="menuitem" onclick={() => merge("flatten")}>画像を統合</button>
          </div>
        {/if}
      </div>

    </div>

    <footer>
      <div class="frow">
        <button onclick={() => tab && vs.diffComposite(tab)} title="レイヤー合成と、ファイルに保存されている PS の統合画像を画素単位で比べる">PS との差を計測</button>
        <span class="spacer"></span>
      <button class="save" disabled={L.saving} onclick={() => onsave(false)} title={tab?.path ? "上書き保存 (Ctrl+S)。初回は元ファイルを .bak として残します" : "PSD をダウンロード（ブラウザ版）"}>{L.saving ? "保存中…" : "保存"}</button>
      <button disabled={L.saving || !tab?.path} onclick={() => onsave(true)} title="別名で保存 (Ctrl+Shift+S)">別名…</button>
      </div>
      {#if L.saving}<span class="savedinfo">保存中: {L.savePhase ?? "準備"}…</span>{/if}
      {#if L.saved}<span class="savedinfo" title={L.saved.path}>保存 {L.saved.ms.toFixed(0)} ms / {kb(L.saved.bytes)}</span>{/if}
      {#if L.diff}
        <span class="diff" class:good={L.diff.max <= 3} title="差（0〜255）: 最大 / 平均 / 差が 2 を超える画素の割合 / 8 を超える画素の割合">
          最大 {L.diff.max}　平均 {L.diff.mean.toFixed(3)}　&gt;2: {(L.diff.over2 * 100).toFixed(2)}%　&gt;8: {(L.diff.over8 * 100).toFixed(2)}%
        </span>
      {/if}
    </footer>
  {/if}
</aside>

<style>
  .panel {
    width: 300px; flex: none; display: flex; flex-direction: column; min-height: 0;
    background: var(--panel); border-left: 1px solid var(--border); font-size: 12px;
  }
  header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .title { font-weight: 600; white-space: nowrap; }
  .seg button, .tools button { white-space: nowrap; }
  .count { color: var(--muted); }
  .spacer { flex: 1; }
  .seg { display: flex; }
  .seg button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; padding: 1px 6px; font: inherit; font-size: 11px; cursor: pointer; margin-left: -1px; }
  .seg button:first-child { border-radius: 3px 0 0 3px; }
  .seg button:last-child { border-radius: 0 3px 3px 0; }
  .seg button.on { background: #2f4f73; border-color: var(--accent); color: #fff; position: relative; }
  .msg { padding: 16px 10px; color: var(--muted); display: flex; gap: 8px; align-items: center; }
  .msg.err { color: #ffb4a8; }
  .list { flex: 1; overflow-y: auto; min-height: 60px; }
  .row { display: flex; align-items: center; gap: 4px; height: 46px; padding-right: 6px; border-bottom: 1px solid #333; cursor: default; }
  .row:hover { background: #333; }
  .row.sel { background: #2f4f73; }
  .row.act { box-shadow: inset 3px 0 0 var(--accent); }
  .row.dim .name, .row.dim .thumb { opacity: 0.5; }
  .eye { width: 22px; height: 22px; flex: none; background: transparent; border: 1px solid #555; border-radius: 3px; color: var(--text); font-size: 10px; padding: 0; cursor: pointer; }
  .exp { width: 16px; flex: none; background: transparent; border: none; color: var(--text); padding: 0; cursor: pointer; }
  .folder { width: 40px; text-align: center; color: #c9a85a; font-size: 18px; flex: none; }
  .clip { color: var(--muted); flex: none; }
  .thumb { width: 40px; height: 40px; flex: none; border: 1px solid #444; }
  .maskmark { color: #ddd; flex: none; }
  .maskmark.off { color: #a33; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 10px; color: #cfe3ff; border: 1px solid #4a6a8a; border-radius: 3px; padding: 0 3px; flex: none; }
  .warn { color: #f0c040; flex: none; cursor: help; }
  .mode { font-size: 10px; color: var(--muted); flex: none; max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .props { border-top: 1px solid var(--border); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
  .prow { display: flex; align-items: center; gap: 6px; }
  .prow .lbl { width: 64px; color: var(--muted); flex: none; }
  .prow select { flex: 1; background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; }
  .prow input[type="range"] { flex: 1; accent-color: var(--accent); }
  .prow .val { width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
  .prow.chk { cursor: pointer; }
  .pwarn { color: #f0c040; font-size: 11px; }
  .mthumb { width: 40px; height: 40px; flex: none; border: 1px solid #555; background: #000; image-rendering: pixelated; }
  .mthumb.off { opacity: 0.4; outline: 2px solid #c33; outline-offset: -2px; }
  .mthumb.viewing { box-shadow: 0 0 0 2px #f0c040; }
  .thumb.target, .mthumb.target { border-color: #fff; box-shadow: 0 0 0 1px #fff; }
  .mb { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; padding: 1px 7px; font: inherit; font-size: 11px; cursor: pointer; }
  .mb.on { background: #2f4f73; border-color: var(--accent); color: #fff; }
  footer { border-top: 1px solid var(--border); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  footer button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; padding: 2px 8px; font: inherit; cursor: pointer; }
  .dirty { color: #f0c040; font-size: 11px; }
  .lock { font-size: 10px; flex: none; opacity: 0.8; }
  .lk { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; width: 26px; height: 22px; padding: 0; cursor: pointer; font-size: 12px; }
  .lk.on { background: #2f4f73; border-color: var(--accent); }
  .mwrap { position: relative; }
  .mmenu { position: absolute; bottom: 26px; right: 0; z-index: 10; background: #2b2b2b; border: 1px solid #555; border-radius: 4px; padding: 3px; display: flex; flex-direction: column; min-width: 220px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  .mmenu button { display: flex; justify-content: space-between; gap: 12px; background: transparent; border: none; color: var(--text); text-align: left; padding: 5px 8px; font: inherit; cursor: pointer; border-radius: 3px; }
  .mmenu button:hover:not(:disabled) { background: #2f4f73; }
  .mmenu button:disabled { opacity: 0.4; }
  .mmenu kbd { color: var(--muted); font-size: 10px; font-family: inherit; }
  .tools { display: flex; align-items: center; gap: 3px; padding: 4px 6px; border-top: 1px solid var(--border); }
  .tools button { background: #3a3a3a; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; min-width: 26px; height: 22px; padding: 0 5px; font: inherit; cursor: pointer; }
  .tools button:disabled { opacity: 0.4; cursor: default; }
  .tools .sep { width: 6px; }
  .frow { display: flex; align-items: center; gap: 4px; align-self: stretch; }
  footer button.save { background: #2f4f73; border-color: var(--accent); color: #fff; }
  .savedinfo { color: var(--muted); font-size: 11px; }
  .rename { flex: 1; min-width: 0; background: #1e1e1e; color: var(--text); border: 1px solid var(--accent); font: inherit; padding: 1px 3px; }
  .list.dragging { cursor: grabbing; }
  .row.src { opacity: 0.4; }
  .row.d-above { box-shadow: inset 0 2px 0 var(--accent); }
  .row.d-below { box-shadow: inset 0 -2px 0 var(--accent); }
  .row.d-inside { outline: 2px solid var(--accent); outline-offset: -2px; }
  .diff { color: #ffb4a8; font-variant-numeric: tabular-nums; font-size: 11px; }
  .diff.good { color: #9fe0a0; }
  .spin { width: 10px; height: 10px; border: 2px solid #666; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
