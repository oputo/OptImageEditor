# OptImageEditor app（フェーズ 0: 最小ビューワー）

Tauri 2 + Vite + TypeScript。PSD / PSB / PNG / JPG / WebP を開き、WebGL2 で表示する。読み込み時間とメモリ使用量を画面右下に表示する。

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
npm run tauri dev    # 初回は Rust の依存関係のビルドで数分かかる
```

- 配布用のビルド: `npm run tauri build`（`src-tauri/target/release/` に exe、NSIS インストーラも生成）
- ブラウザだけで確認する場合: `npm run dev` を実行し、http://localhost:1420 を開く（Tauri なし）

## 操作

| 操作 | 内容 |
|---|---|
| ドラッグ＆ドロップ / 「開く」/ Ctrl+O | ファイルを開く |
| ホイール | カーソル位置を中心に拡大・縮小 |
| 左ドラッグ / 中ドラッグ / Space+ドラッグ | 移動（パン） |
| Ctrl+0 / Ctrl+1 / Ctrl+＋ / Ctrl+－ | 全体表示 / 100% / 拡大 / 縮小 |
| 「計測をコピー」 | 計測結果をクリップボードへコピーする |

## 構成

| ファイル | 役割 |
|---|---|
| `src/decoder.worker.ts` | Web Worker でデコードする。PSD は ag-psd で統合画像だけを読む（レイヤーの画素とスマートオブジェクトの中身は読み飛ばす）。PNG / JPG は `createImageBitmap` で読む |
| `src/psdSlice.ts` | PSD / PSB のレイヤー部分を読み飛ばし、ヘッダー・リソース・統合画像だけを `File.slice()` で読む（数百 MB の PSD でもディスクから読む量を数十 MB に抑える） |
| `src/renderer.ts` | WebGL2 の描画。`MAX_TEXTURE_SIZE`（上限 8192）を超える画像はタイルに分割する。縮小時はミップマップ、200% 以上ではニアレストネイバー。透明部分は市松模様で表示 |
| `src/main.ts` | ファイルを開く処理、ズーム・パン、計測値の表示 |
| `patches/ag-psd+31.0.2.patch` | 未知ブロックを保持する改修（`spike/ag-psd-roundtrip` を参照）。patch-package で自動適用 |

## 制約（フェーズ 0）

- PSD は統合画像だけを表示する。統合画像が無い PSD（PS の「互換性を優先」がオフで保存されたもの）はエラーになる。
- 16 / 32bit の PSD は、表示用に 8bit へ変換する。
- Tauri 側のドラッグ＆ドロップ（ファイルパスの取得）は無効にし、HTML5 のドロップを使っている。ファイルパスが要る機能（同じフォルダの前後の画像へ送る、上書き保存）はフェーズ 1 で実装する。
