# OptImageEditor app

Tauri 2 + Svelte 5 + Vite + TypeScript。現在はフェーズ 1-c（ナビゲーター、表示の回転・左右反転、定規、ガイド、グリッド、ピクセルグリッド）まで実装済み。676MB の PSD を約 0.19 秒で表示する（詳細は `docs/perf_ipc.md`）。

## 前提（Windows）

| ツール | 確認方法 |
|---|---|
| Node.js 22 以上 | `node -v` |
| Rust（MSVC ツールチェーン） | `rustc -V`、`rustup default` が `stable-x86_64-pc-windows-msvc` |
| Microsoft C++ Build Tools（「C++ によるデスクトップ開発」） | Visual Studio Installer で確認 |
| WebView2 | Windows 11 は標準で搭載 |

## 起動

```powershell
cd D:\google\github\OptImageEditor\app
npm install          # postinstall で patches/ の ag-psd 改修が自動で当たる
npm run tauri dev    # 開発用に起動する
npm run tauri build  # 配布用にビルドする（D:\build-cache\OptImageEditor\release\ に exe、bundle\nsis\ にインストーラ）
```

- ブラウザだけで UI を確認する場合: `npm run dev` を実行して http://localhost:1420 を開く（ファイルパスに関わる機能は無効）
- 型チェック: `npm run check`
- Cargo のビルド生成物は Google ドライブの同期を避けるため `D:\build-cache\OptImageEditor` に出力する（`src-tauri/.cargo/config.toml`。経緯は `docs/build_env.md`）

## 操作

| 操作 | 内容 |
|---|---|
| ドラッグ＆ドロップ / 「開く」/ Ctrl+O | ファイルを開く（複数ファイルのドロップは、それぞれ新しいタブで開く。既に開いているファイルはそのタブへ切り替える） |
| タブのクリック / Ctrl+Tab / Ctrl+Shift+Tab | タブの切り替え（直近の 2 タブは GPU に残すので即時。それより古いタブは開き直す） |
| タブの × / 中クリック / Ctrl+W | タブを閉じる（GPU のテクスチャを解放する） |
| Ctrl+Shift+T | 閉じたタブを開き直す |
| タブバーの空白をダブルクリック | ファイルを開く |
| → / PageDown、← / PageUp | 同じフォルダの次 / 前の画像（端まで行くと反対側へ戻る）。表示の 0.15 秒後に前後の画像を先読みするので、続けて送ると即時に切り替わる |
| Home / End | フォルダ内の最初 / 最後の画像 |
| ホイール | カーソル位置を中心に拡大・縮小 |
| R を押しながらドラッグ | 表示を回転（画面の中心で回る。Shift で 15° 刻み）。Esc、またはステータスバーの「回転 n°」をクリックで 0° に戻す。「表示」メニューに ±90° ボタン |
| Shift+H | 左右反転して表示（画像そのものは変えない） |
| N | ナビゲーターの表示 / 非表示（クリック・ドラッグで表示位置を移動、スライダーで 1〜6400%） |
| Ctrl+R | 定規の表示 / 非表示（表示を回転している間は隠す） |
| 定規からドラッグ | ガイドを作成（上の定規 → 水平、左の定規 → 垂直）。ガイドはドラッグで移動、定規か画面の外へ戻すと削除。タブごとに保持し、フォルダ内を送っても残る |
| G | グリッドのオン / オフ（種類は「表示」メニューで、三分割 / 中心線 / 格子（間隔 px 指定）） |
| Ctrl+H | ガイド・グリッド・ピクセルグリッドをまとめて表示 / 非表示 |
| 左ドラッグ / 中ドラッグ / Space+ドラッグ | 移動（パン） |
| Ctrl+0 / Ctrl+1 / Ctrl+＋ / Ctrl+－ | 全体表示 / 100% / 拡大 / 縮小 |
| F11 | 全画面 |
| F2 | 計測パネルの表示 / 非表示（「コピー」で計測結果をクリップボードへ） |
| F3 / F5 | （計測用）読み込み方式の切り替え（共有メモリ / IPC 一括 / IPC 分割並列）/ 再読み込み |
| 「表示」メニュー | 上記の表示設定（設定は localStorage の `oie.view` に保存）、ピクセルグリッド（800% 以上で表示）、ガイドの一括消去 |
| ≡ メニュー | 最近使ったファイル（20 件、起動画面にも 10 件表示）/ 履歴を消去 /「プログラムから開く」に登録・登録を解除 |
| 起動時の引数 | `optimageeditor.exe <画像のパス>...` で、その画像を開いて起動する。既に起動している場合は、そのウィンドウに新しいタブで開く（二重起動の防止） |

## 構成

| ファイル | 役割 |
|---|---|
| `src/App.svelte` | 画面全体（ツールバー / タブバー / ビュー / ステータスバー / ≡ メニュー / 起動画面）、キー操作 |
| `src/lib/viewerState.svelte.ts` | タブの状態管理（`ViewerState`）。タブごとの表示位置、フォルダ内の移動、GPU キャッシュ（表示中 > 次 > 前 > 直近 2 タブ、上限 2GB）、前後の先読み、閉じたタブの履歴 |
| `src/lib/TabBar.svelte` | タブバー |
| `src/lib/recent.svelte.ts` | 最近使ったファイル（localStorage の `oie.recent`、最大 20 件） |
| `src/lib/Viewer.svelte` | キャンバスと、ズーム・パン・回転の操作。2D のオーバーレイ（グリッド / ピクセルグリッド / ガイド）と定規。オーバーレイは renderer の `onFrame` で画像と同じフレームに描く |
| `src/lib/Navigator.svelte` | ナビゲーター。縮小画像は renderer の `thumbnail()` が GPU 上で作る（TextureSet ごとに 1 回） |
| `src/lib/viewOptions.svelte.ts` | 表示設定（ナビゲーター / 定規 / ガイド / グリッド）。localStorage の `oie.view` |
| `src/lib/renderer.ts` | WebGL2 の描画。画像ごとのテクスチャ（`TextureSet`）を複数保持し、`show` で切り替える。表示の変換は 2×3 の行列（左右反転 → 回転 → 拡大縮小 → 移動）で、`viewToImage` / `imageToView` で座標を変換する。`MAX_TEXTURE_SIZE`（上限 8192）を超える画像はタイルに分割する。縮小時はミップマップ、200% 以上はニアレストネイバー。透明部分は市松模様 |
| `src/lib/loader.ts` | ファイルの読み込みからデコードまで（デコード処理は Web Worker） |
| `src/lib/decoder.worker.ts` | PSD は ag-psd で統合画像だけを読む。PNG / JPG は `createImageBitmap` |
| `src-tauri/src/composite.rs` | PSD / PSB の統合画像デコーダ（RGB / グレー、8 / 16bit、非圧縮 / RLE）。行単位で並列に RGBA へ展開し、透明がある場合は白マットを除去する。テスト: `python ../tools/composite_ref.py <dir>` の後、`OIE_SAMPLES=<dir> cargo test --release -- --nocapture samples` |
| `src/lib/psdSlice.ts` | PSD / PSB のレイヤー部分を読み飛ばし、必要な範囲だけを読む |
| `src/lib/source.ts` | ファイルの範囲読み込みの共通部分（Tauri: Rust の `read_range` / ブラウザ: `File.slice`） |
| `src/lib/desktop.ts` | Tauri 連携（ネイティブのドラッグ＆ドロップ、ファイルダイアログ、フォルダ一覧、起動時の引数、ウィンドウタイトル、全画面、二重起動時のファイル受け取り、「プログラムから開く」の登録、確認ダイアログ） |
| `src-tauri/src/lib.rs` | Rust コマンド: `load_composite_shared`（統合画像を Rust でデコードし、WebView2 の共有メモリで渡す）/ `read_range_shared`（共有メモリでの範囲読み込み）/ `read_range`（IPC、フォールバック用）/ `file_info` / `list_images`（自然順ソート）/ `startup_paths` / `register_open_with`（HKCU に ProgID `OptImageEditor.Image` と各拡張子の `OpenWithProgids` を登録・解除。管理者権限は不要）/ `open_default_apps_settings`。二重起動の防止は `tauri-plugin-single-instance`（2 回目の起動の引数を `oie://open-paths` イベントで送る） |
| `patches/ag-psd+31.0.2.patch` | 未知ブロックを保持する改修（`spike/ag-psd-roundtrip` を参照）。patch-package で自動適用 |

## 制約（現時点）

- PSD は統合画像だけを表示する。統合画像が無い PSD（PS の「互換性を優先」がオフで保存されたもの）はエラーになる。
- 16 / 32bit の PSD は、表示用に 8bit へ変換する。
- `.svelte.ts` のモジュール名は、同じフォルダの `.svelte` コンポーネントと大文字小文字違いで重ねない（Windows ではファイル名の大文字小文字を区別しないため、`./lib/viewer.svelte` が `Viewer.svelte` に解決されてしまう）。
- 「プログラムから開く」の登録は exe の場所を書き込むので、dev ビルドで登録すると `D:\build-cache\OptImageEditor\debug\optimageeditor.exe` が登録される。配布用ビルドに切り替えたら登録し直す。
- 未実装: EXR、比較表示、ナビゲーター、ガイド / グリッド
