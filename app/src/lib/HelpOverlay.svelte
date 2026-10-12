<script lang="ts">
  // F1: shortcut list (Photoshop-compatible keys; letters are matched by physical key, so they work with the IME on).
  // One tab per category (the list grew too long for one page) plus a search over all of them. The last tab is
  // remembered (localStorage "oie.help"). Later the key assignment editor can live in this dialog.
  import { untrack } from "svelte";
  let { onclose }: { onclose: () => void } = $props();

  const GROUPS: { title: string; short: string; keys: [string, string][] }[] = [
    { title: "ファイル・タブ", short: "ファイル", keys: [
      ["Ctrl+O", "開く"], ["Ctrl+V", "クリップボードの画像を開く（レイヤーを読み込んだ PSD では新しいレイヤー、それ以外は新しいタブ）"], ["Ctrl+W", "タブを閉じる"],
      ["Ctrl+Shift+T", "閉じたタブを開き直す"], ["Ctrl+Tab / Ctrl+Shift+Tab", "タブの切り替え"],
      ["← → / PageUp PageDown", "フォルダ内の前 / 次の画像"], ["Home / End", "フォルダの最初 / 最後"], ["F5", "読み直し"],
      ["Ctrl+S / Ctrl+Shift+S", "上書き保存 / 別名で保存（PNG・JPG を編集中は、Ctrl+S で統合して上書き、Ctrl+Shift+S で PSD などに保存。貼り付けた画像は保存先を尋ねる。注釈があればレイヤーにするか確認）"],
      ["Ctrl+Alt+Shift+W", "書き出し（PNG / JPG / WebP）"], ["Ctrl+Alt+I", "画像解像度（指定サイズで書き出し）"],
      ["Ctrl+Alt+C", "カンバスサイズ（PSD）"],
      ["C", "切り抜き（ハンドルで調整、Shift で縦横比を保つ、Enter で確定 / Esc で中止）"],
      ["編集 →「画像の回転」", "90° / 180° 回転・左右 / 上下反転（文書全体）"],
    ] },
    { title: "表示", short: "表示", keys: [
      ["Ctrl+0 / Ctrl+1", "全体表示 / 100%"], ["Ctrl+＋ / Ctrl+－ / ホイール", "拡大 / 縮小"], ["スペース + ドラッグ", "スクロール"],
      ["R + ドラッグ / Esc", "表示の回転 / 回転を戻す"], ["Shift+H", "左右反転"], ["N", "ナビゲーター"],
      ["Ctrl+R", "定規"], ["G", "グリッド"], ["Ctrl+H", "ガイド・グリッドの一括表示"], ["F11", "全画面"],
      ["Ctrl+2〜6", "チャンネル表示 RGB / R / G / B / アルファ"], ["Shift+C / 1 2 3 / X", "比較 / 表示方法 / A・B 切替"],
      ["F2 / F3", "計測パネル / 読み込み方式の切り替え（開発用）"],
    ] },
    { title: "レイヤー（F7 でパネル）", short: "レイヤー", keys: [
      ["F4", "PS の統合画像 ⇄ レイヤー合成"], ["Ctrl+Z / Ctrl+Shift+Z", "取り消し / やり直し"],
      ["Ctrl+Shift+N / Ctrl+J", "新規レイヤー / 複製"], ["Ctrl+G / Ctrl+Alt+G", "グループ化 / クリッピングマスク"],
      ["Delete", "削除"], ["Ctrl+E / Ctrl+Shift+E", "結合（下と・グループ・選択）/ 表示レイヤーを結合"],
      ["Ctrl+Alt+Shift+E", "複写結合（表示中の画像を一番上の新しいレイヤーに）"],
      ["Ctrl / Shift + クリック", "複数選択（追加 / 範囲）"], ["目をドラッグ", "表示をまとめて切り替え"],
      ["Alt + 目をクリック", "そのレイヤーだけ表示"],
      ["マスクのサムネイル", "クリック: マスクを編集対象 / Ctrl: 選択範囲に / Shift: 有効・無効 / Alt: マスクを表示"],
      ["Delete / Ctrl+I（マスク編集中）", "選択部分を隠す / マスクを反転"], ["名前をダブルクリック", "名前の変更"],
    ] },
    { title: "選択範囲", short: "選択範囲", keys: [
      ["M / Shift+M", "長方形選択 / 楕円形選択"], ["L / Shift+L", "なげなわ / 多角形選択（クリックで頂点。ダブルクリック・始点クリック・Enter で閉じる）"],
      ["Shift / Alt / Shift+Alt", "（押してから描く）追加 / 除外 / 交差"], ["Shift（描画中）", "正方形・正円"],
      ["Ctrl+A / Ctrl+D / Ctrl+Shift+D", "すべて選択 / 解除 / 再選択"], ["Ctrl+Shift+I", "選択範囲の反転"],
      ["Ctrl+サムネイルをクリック", "レイヤーの不透明部分を選択"], ["Ctrl+J / Ctrl+Shift+J", "選択部分をコピー / カットした新しいレイヤー"],
      ["Delete", "選択部分を消去（選択が無い時はレイヤーを削除）"], ["Ctrl+C / Ctrl+X / Ctrl+V", "コピー / カット / 新しいレイヤーとして貼り付け"],
    ] },
    { title: "ペイント", short: "ペイント", keys: [
      ["B / E / I", "ブラシ / 消しゴム / スポイト"], ["Alt + クリック（ブラシ中）", "スポイト（描画色を取得）"],
      ["[ / ]", "直径（スポイトは取得範囲）"], ["Shift+[ / Shift+]", "硬さ（25% 刻み）"], ["1〜9 / 0", "不透明度 10〜90% / 100%"],
      ["右ドラッグ（ペンのサイドボタン）", "左右: 直径 / 上下: 硬さ（Shift: 不透明度）"],
      ["上部バーのメーター", "押したまま左右に動かして変更（ペン可）、ホイールでも変更。設定はツールごとに保持"],
      ["Shift + クリック", "前のストロークの終点から直線"], ["X / D", "描画色と背景色を入れ替え / 初期値（黒・白）"],
      ["Alt+Delete / Ctrl+Delete", "描画色 / 背景色で塗りつぶし（選択範囲があればその中）"],
      ["マスクのサムネイルをクリック", "ブラシ・消しゴム・塗りつぶしをマスクに（グレーで描く）"],
    ] },
    { title: "注釈", short: "注釈", keys: [
      ["U", "注釈を開始（前回のツール。最初は矢印）"], ["Shift+U（注釈中）", "矢印 → 直線 → 四角 → ペン → テキストの順に切り替え"],
      ["P / L / A / T / V", "ペン / 直線 / 矢印 / テキスト / 選択"], ["Shift", "45° 刻み・正方形"],
      ["Ctrl+Shift+C", "注釈込みの画像をコピー"], ["バーの「レイヤーに」", "注釈を「注釈」レイヤーにする（保存に含まれる）"], ["Delete", "選択した図形を削除"], ["Esc", "選択解除 → 注釈を終了"],
    ] },
    { title: "AI（ComfyUI）", short: "AI", keys: [
      ["F8", "AI パネル（背景除去 / 指示で編集）"], ["Ctrl+Enter", "実行（パネルの入力欄で）"], ["Esc", "実行中は中止 / パネルを閉じる"],
    ] },
  ];

  const KEY = "oie.help";
  let tab = $state((() => { try { return Math.min(GROUPS.length - 1, Math.max(0, Number(localStorage.getItem(KEY)) || 0)); } catch { return 0; } })());
  let query = $state("");
  $effect(() => { const t = tab; untrack(() => { try { localStorage.setItem(KEY, String(t)); } catch { /* storage unavailable */ } }); });

  // search: every category, rows whose key or description contains the text (case-insensitive)
  const found = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return GROUPS.map((g) => ({ ...g, keys: g.keys.filter(([k, d]) => k.toLowerCase().includes(q) || d.toLowerCase().includes(q)) })).filter((g) => g.keys.length);
  });
  const shown = $derived(found ?? [GROUPS[tab]]);

  function onkey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "F1") { e.preventDefault(); if (query && e.key === "Escape") query = ""; else onclose(); return; }
    if (query) return;
    if (e.key === "ArrowRight" || (e.ctrlKey && e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); tab = (tab + 1) % GROUPS.length; }
    else if (e.key === "ArrowLeft" || (e.ctrlKey && e.key === "Tab" && e.shiftKey)) { e.preventDefault(); tab = (tab + GROUPS.length - 1) % GROUPS.length; }
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= GROUPS.length && (e.target as HTMLElement).tagName !== "INPUT") { e.preventDefault(); tab = Number(e.key) - 1; }
  }
  function focus(el: HTMLElement) { queueMicrotask(() => el.focus()); }
</script>

<div class="back" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="box" role="dialog" aria-label="ショートカット一覧" tabindex="-1" onkeydown={onkey} use:focus>
    <header>
      <h2>ショートカット一覧</h2>
      <input class="search" type="search" placeholder="検索（キー・機能）" bind:value={query} />
      <span class="hint">← → / 1〜{GROUPS.length}: タブ　F1 / Esc: 閉じる</span>
    </header>
    <div class="tabs" role="tablist">
      {#each GROUPS as g, i (g.title)}
        <button role="tab" aria-selected={!found && tab === i} class:on={!found && tab === i} onclick={() => { query = ""; tab = i; }}>{g.short}<span class="n">{g.keys.length}</span></button>
      {/each}
    </div>
    <div class="list">
      {#each shown as g (g.title)}
        {#if found}<h3>{g.title}</h3>{/if}
        {#each g.keys as [k, d] (k + d)}
          <div class="k"><kbd>{k}</kbd><span>{d}</span></div>
        {/each}
      {:else}
        <div class="none">「{query}」に一致するショートカットはありません</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 60; display: flex; align-items: center; justify-content: center; }
  .box { background: #262626; border: 1px solid #555; border-radius: 8px; width: min(760px, 94vw); height: min(620px, 88vh); display: flex; flex-direction: column; font-size: 12px; outline: none; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 16px 8px; }
  h2 { margin: 0; font-size: 15px; white-space: nowrap; }
  .search { flex: 1; min-width: 120px; max-width: 260px; background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 4px; font: inherit; padding: 3px 8px; }
  .hint { color: var(--muted); font-size: 11px; margin-left: auto; white-space: nowrap; }
  .tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid #444; flex-wrap: wrap; }
  .tabs button { background: transparent; color: var(--muted); border: 1px solid transparent; border-bottom: none; border-radius: 5px 5px 0 0; padding: 5px 12px; font: inherit; cursor: pointer; margin-bottom: -1px; }
  .tabs button:hover { color: var(--text); }
  .tabs button.on { background: #2f2f2f; color: #fff; border-color: #444; border-bottom: 1px solid #2f2f2f; }
  .n { margin-left: 6px; font-size: 10px; color: var(--muted); }
  .list { flex: 1; overflow: auto; padding: 10px 16px 14px; background: #2f2f2f; border-radius: 0 0 8px 8px; }
  h3 { margin: 10px 0 4px; font-size: 12px; color: #cfe3ff; }
  h3:first-child { margin-top: 0; }
  .k { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px solid #383838; }
  kbd { flex: none; width: 220px; color: #fff; font-family: inherit; font-size: 11px; background: #3a3a3a; border: 1px solid #555; border-radius: 3px; padding: 1px 6px; align-self: flex-start; }
  .k span { color: var(--text); line-height: 1.5; }
  .none { color: var(--muted); padding: 20px 0; }
</style>
