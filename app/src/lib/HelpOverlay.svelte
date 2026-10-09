<script lang="ts">
  // F1: shortcut list (Photoshop-compatible keys; letters are matched by physical key, so they work with the IME on).
  let { onclose }: { onclose: () => void } = $props();

  const GROUPS: { title: string; keys: [string, string][] }[] = [
    { title: "ファイル・タブ", keys: [
      ["Ctrl+O", "開く"], ["Ctrl+V", "クリップボードの画像を新しいタブで開く"], ["Ctrl+W", "タブを閉じる"],
      ["Ctrl+Shift+T", "閉じたタブを開き直す"], ["Ctrl+Tab / Ctrl+Shift+Tab", "タブの切り替え"],
      ["← → / PageUp PageDown", "フォルダ内の前 / 次の画像"], ["Home / End", "フォルダの最初 / 最後"], ["F5", "読み直し"],
      ["Ctrl+S / Ctrl+Shift+S", "PSD を上書き保存 / 別名で保存（注釈がある時の Ctrl+Shift+S は PNG 保存）"],
      ["Ctrl+Alt+Shift+W", "書き出し（PNG / JPG / WebP）"], ["Ctrl+Alt+I", "画像解像度（指定サイズで書き出し）"],
      ["Ctrl+Alt+C", "カンバスサイズ（PSD）"],
    ] },
    { title: "表示", keys: [
      ["Ctrl+0 / Ctrl+1", "全体表示 / 100%"], ["Ctrl+＋ / Ctrl+－ / ホイール", "拡大 / 縮小"], ["スペース + ドラッグ", "スクロール"],
      ["R + ドラッグ / Esc", "表示の回転 / 回転を戻す"], ["Shift+H", "左右反転"], ["N", "ナビゲーター"],
      ["Ctrl+R", "定規"], ["G", "グリッド"], ["Ctrl+H", "ガイド・グリッドの一括表示"], ["F11", "全画面"],
      ["Ctrl+2〜6", "チャンネル表示 RGB / R / G / B / アルファ"], ["C / 1 2 3 / X", "比較 / 表示方法 / A・B 切替"],
      ["F2 / F3", "計測パネル / 読み込み方式の切り替え（開発用）"],
    ] },
    { title: "レイヤー（F7 でパネル）", keys: [
      ["F4", "PS の統合画像 ⇄ レイヤー合成"], ["Ctrl+Z / Ctrl+Shift+Z", "取り消し / やり直し"],
      ["Ctrl+Shift+N / Ctrl+J", "新規レイヤー / 複製"], ["Ctrl+G / Ctrl+Alt+G", "グループ化 / クリッピングマスク"],
      ["Delete", "削除"], ["Ctrl+E / Ctrl+Shift+E", "結合（下と・グループ・選択）/ 表示レイヤーを結合"],
      ["Ctrl / Shift + クリック", "複数選択（追加 / 範囲）"], ["目をドラッグ", "表示をまとめて切り替え"],
      ["Alt + 目をクリック", "そのレイヤーだけ表示"],
      ["マスクのサムネイル", "クリック: マスクを編集対象 / Ctrl: 選択範囲に / Shift: 有効・無効 / Alt: マスクを表示"],
      ["Delete / Ctrl+I（マスク編集中）", "選択部分を隠す / マスクを反転"], ["名前をダブルクリック", "名前の変更"],
    ] },
    { title: "選択範囲", keys: [
      ["M / Shift+M", "長方形選択 / 楕円形選択"], ["L / Shift+L", "なげなわ / 多角形選択（クリックで頂点、Enter か始点クリックで閉じる）"],
      ["Shift / Alt / Shift+Alt", "（押してから描く）追加 / 除外 / 交差"], ["Shift（描画中）", "正方形・正円"],
      ["Ctrl+A / Ctrl+D / Ctrl+Shift+D", "すべて選択 / 解除 / 再選択"], ["Ctrl+Shift+I", "選択範囲の反転"],
      ["Ctrl+サムネイルをクリック", "レイヤーの不透明部分を選択"], ["Ctrl+J / Ctrl+Shift+J", "選択部分をコピー / カットした新しいレイヤー"],
      ["Delete", "選択部分を消去（選択が無い時はレイヤーを削除）"], ["Ctrl+C / Ctrl+X / Ctrl+V", "コピー / カット / 新しいレイヤーとして貼り付け"],
    ] },
    { title: "注釈", keys: [
      ["P / L / A / U / T / V", "ペン / 直線 / 矢印 / 四角 / テキスト / 選択"], ["Shift", "45° 刻み・正方形"],
      ["Ctrl+Shift+C", "注釈込みの画像をコピー"], ["Delete", "選択した図形を削除"], ["Esc", "選択解除 → 注釈を終了"],
    ] },
    { title: "AI（ComfyUI）", keys: [
      ["F8", "AI パネル（背景除去 / 指示で編集）"], ["Ctrl+Enter", "実行（パネルの入力欄で）"], ["Esc", "実行中は中止 / パネルを閉じる"],
    ] },
  ];
</script>

<div class="back" role="presentation" onmousedown={onclose}>
  <div class="box" role="dialog" aria-label="ショートカット一覧" tabindex="-1">
    <h2>ショートカット一覧 <span class="hint">F1 / Esc / クリックで閉じる</span></h2>
    <div class="cols">
      {#each GROUPS as g (g.title)}
        <section>
          <h3>{g.title}</h3>
          {#each g.keys as [k, d] (k)}
            <div class="k"><kbd>{k}</kbd><span>{d}</span></div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 60; display: flex; align-items: center; justify-content: center; }
  .box { background: #262626; border: 1px solid #555; border-radius: 8px; padding: 14px 18px; max-width: min(1100px, 94vw); max-height: 90vh; overflow: auto; font-size: 12px; outline: none; }
  h2 { margin: 0 0 10px; font-size: 15px; }
  .hint { color: var(--muted); font-size: 11px; font-weight: normal; margin-left: 10px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  h3 { margin: 0 0 6px; font-size: 12px; color: #cfe3ff; }
  .k { display: flex; gap: 8px; padding: 2px 0; }
  kbd { flex: none; min-width: 120px; color: #fff; font-family: inherit; font-size: 11px; background: #3a3a3a; border: 1px solid #555; border-radius: 3px; padding: 0 4px; align-self: flex-start; }
  .k span { color: var(--text); }
</style>
