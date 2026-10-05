# OptImageEditor

軽量な画像ビューワー兼エディタ（PSD / PNG / JPG）。Photoshop のうち自分が使う機能だけを持ち、ローカル AI（ComfyUI）と密に連携することを目指す。

- 状態: フェーズ 0（技術検証）
- 技術構成（検証中）: Tauri 2 + TypeScript + ag-psd + WebGL2 / WebGPU（T 案）。結果が悪ければ Rust 中核の R 案に切り替える

## ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/mvp_plan.md` | MVP 計画とフェーズ分け、技術構成の比較 |
| `docs/ps_feature_inventory.md` | Photoshop 機能の棚卸し（使用頻度と難度） |
| `docs/psd_samples_findings.md` | サンプル PSD の解析結果 |

## ツール

- `tools/psd_scan.py` — PSD のレイヤー構成と機能の使用状況を集計する（`pip install psd-tools`）
