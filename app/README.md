# OptImageEditor app

Tauri 2 + Svelte 5 + Vite + TypeScript。現在はフェーズ 1-a（ビューワーの骨組み）が完了。676MB の PSD を約 0.19 秒で表示する（詳細は `docs/perf_ipc.md`）。

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
| ドラッグ＆ドロップ / 「開く」/ Ctrl+O | ファイルを開く |
| → / PageDown、← / PageUp | 同じフォルダの次 / 前の画像（端まで行くと反対側へ戻る） |
| Home / End | フォルダ内の最初 / 最後の画像 |
| ホイール | カーソル位置を中心に拡大・縮小 |
| 左ドラッグ / 中ドラッグ / Space+ドラッグ | 移動（パン） |
| Ctrl+0 / Ctrl+1 / Ctrl+＋ / Ctrl+－ | 全体表示 / 100% / 拡大 / 縮小 |
| Ctrl+W | 画像を閉じる（GPU のテクスチャを解放する） |
| F11 | 全画面 |
| F2 | 計測パネルの表示 / 非表示（「コピー」で計測結果をクリップボードへ） |
| F3 / F5 | （計測用）読み込み方式の切り替え（共有メモリ / IPC 一括 / IPC 分割並列）/ 再読み込み |
| 起動時の引数 | `optimageeditor.exe <画像のパス>` で、その画像を開いて起動する（「プログラムから開く」の土台） |

## 構成

| ファイル | 役割 |
|---|---|
| `src/App.svelte` | 画面全体（ツールバー / ビュー / ステータスバー）、キー操作、フォルダ内の移動 |
| `src/lib/Viewer.svelte` | キャンバスと、ズーム・パンの操作 |
| `src/lib/renderer.ts` | WebGL2 の描画。`MAX_TEXTURE_SIZE`（上限 8192）を超える画像はタイルに分割する。縮小時はミップマップ、200% 以上はニアレストネイバー。透明部分は市松模様 |
| `src/lib/loader.ts` | ファイルの読み込みからデコードまで（デコード処理は Web Worker） |
| `src/lib/decoder.worker.ts` | PSD は ag-psd で統合画像だけを読む。PNG / JPG は `createImageBitmap` |
| `src-tauri/src/composite.rs` | PSD / PSB の統合画像デコーダ（RGB / グレー、8 / 16bit、非圧縮 / RLE）。行単位で並列に RGBA へ展開し、透明がある場合は白マットを除去する。テスト: `python ../tools/composite_ref.py <dir>` の後、`OIE_SAMPLES=<dir> cargo test --release -- --nocapture samples` |
| `src/lib/psdSlice.ts` | PSD / PSB のレイヤー部分を読み飛ばし、必要な範囲だけを読む |
| `src/lib/source.ts` | ファイルの範囲読み込みの共通部分（Tauri: Rust の `read_range` / ブラウザ: `File.slice`） |
| `src/lib/desktop.ts` | Tauri 連携（ネイティブのドラッグ＆ドロップ、ファイルダイアログ、フォルダ一覧、起動時の引数、ウィンドウタイトル、全画面） |
| `src-tauri/src/lib.rs` | Rust コマンド: `load_composite_shared`（統合画像を Rust でデコードし、WebView2 の共有メモリで渡す）/ `read_range_shared`（共有メモリでの範囲読み込み）/ `read_range`（IPC、フォールバック用）/ `file_info` / `list_images`（自然順ソート）/ `startup_paths` |
| `patches/ag-psd+31.0.2.patch` | 未知ブロックを保持する改修（`spike/ag-psd-roundtrip` を参照）。patch-package で自動適用 |

## 制約（現時点）

- PSD は統合画像だけを表示する。統合画像が無い PSD（PS の「互換性を優先」がオフで保存されたもの）はエラーになる。
- 16 / 32bit の PSD は、表示用に 8bit へ変換する。
- 未実装: タブ、最近使ったファイル、「プログラムから開く」への登録、二重起動の防止、EXR、比較表示、ナビゲーター、ガイド / グリッド
