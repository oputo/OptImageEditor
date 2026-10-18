# OptImageEditor

軽量な画像ビューワー兼エディタ（PSD / PNG / JPG）。Photoshop のうち自分が使う機能だけを持ち、ローカル AI（ComfyUI）と密に連携することを目指す。

- 状態: フェーズ 0（技術検証）。PSD 入出力と表示性能の検証は合格（改修版 ag-psd + Tauri 2）。600MB 級の PSD を 0.2〜0.4 秒で表示
- 技術構成（検証中）: Tauri 2 + TypeScript + ag-psd + WebGL2 / WebGPU（T 案）。結果が悪ければ Rust 中核の R 案に切り替える

## アプリ

`app/` — Tauri 2 + Vite + TypeScript。起動方法は `app/README.md` を参照。

## ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/mvp_plan.md` | MVP 計画とフェーズ分け、技術構成の比較 |
| `docs/ps_feature_inventory.md` | Photoshop 機能の棚卸し（使用頻度と難度） |
| `docs/psd_samples_findings.md` | サンプル PSD の解析結果 |

## 検証（spike）

| フォルダ | 内容 |
|---|---|
| `spike/ag-psd-roundtrip/` | ag-psd による PSD 往復テストと、未知ブロックを保持する改修（フェーズ 0） |

## ツール

- `tools/psd_scan.py` — PSD のレイヤー構成と機能の使用状況を集計する（`pip install psd-tools`）

## ライセンス

- **ソースコード**: [PolyForm Noncommercial License 1.0.0](LICENSE.md)。営利目的でない個人の学習・研究・趣味での利用と、非営利団体での利用に限り、使用・改変・再配布できます。商用利用（報酬を伴う制作を含む）は、このライセンスでは許諾されません。
- **配布するアプリ（インストーラ・実行ファイル）**: [利用規約](EULA.md)に従います。配布者から直接受け取った方は、業務での利用も可能です。
- **サードパーティ**: 依存ライブラリはそれぞれのライセンスに従います（[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。`app/patches/` の ag-psd 改変部分は、ag-psd の MIT License にも従います。
- 商用利用のライセンスについては、作者にお問い合わせください。

## 商標

Adobe および Photoshop は Adobe Inc. の米国およびその他の国における商標または登録商標です。本ソフトウェアは Adobe Inc. と提携しておらず、Adobe Inc. の承認や支援も受けていません。PSD 形式への対応は、互換性のための記述です。
