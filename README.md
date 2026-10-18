# OptImageEditor

軽量な画像ビューワー兼エディタ（PSD / PNG / JPG / WebP / EXR / HDR）。Photoshop のうち作者が使う機能だけを持ち、ローカル AI（ComfyUI）と連携することを目指す個人開発のツール。Windows 向け。

- 状態: 開発中（未リリース）。ビューワー、PSD のレイヤー表示・編集・保存、選択範囲・レイヤーマスク、ペイント、切り抜き・回転（スマートオブジェクトをラスタライズせずに回転）、ComfyUI 連携（背景除去・指示で編集）まで実装済み
- 技術構成: Tauri 2 + Svelte 5 + TypeScript + ag-psd（patch-package で改修）+ WebGL2。Rust 側で PSD の高速デコード・保存、EXR / HDR のデコードを行う

## アプリ

`app/` — Tauri 2 + Vite + TypeScript。起動方法は `app/README.md` を参照。

## ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/mvp_plan.md` | MVP 計画とフェーズ分け、技術構成の比較 |
| `docs/ps_feature_inventory.md` | Photoshop 機能の棚卸し（使用頻度と難度） |
| `docs/psd_samples_findings.md` | サンプル PSD の解析結果、合成と保存の知見 |
| `docs/perf_ipc.md` | 読み込み性能と Rust ⇄ WebView の受け渡しの計測 |
| `docs/build_env.md` | ビルド環境（ビルド生成物の置き場所） |
| `docs/release.md` | リリースの運用（版番号・dev 版と配布版の分離・自動アップデート） |
| `CHANGELOG.md` | 変更履歴 |

## 検証（spike）

| フォルダ | 内容 |
|---|---|
| `spike/ag-psd-roundtrip/` | ag-psd による PSD 往復テストと、未知ブロックを保持する改修（フェーズ 0） |

## ツール

- `tools/psd_scan.py` — PSD のレイヤー構成と機能の使用状況を集計する（`pip install psd-tools`）

## ComfyUI 連携について

AI パネルは、アプリの Rust 側から ComfyUI に HTTP / WebSocket で接続します。ComfyUI を `--enable-cors-header` 付きで起動する必要はありません（以前の版では必要でした。今は外して起動してください）。

- 接続先は AI パネルで設定します（既定は `http://127.0.0.1:18188`）。`http://` のみ対応です（`https://` は未対応）
- `--listen` で ComfyUI を LAN に公開している場合は、同じネットワークの他の機器からも操作できる状態になる点に注意してください

## ライセンス

- **ソースコード**: [PolyForm Noncommercial License 1.0.0](LICENSE.md)。営利目的でない個人の学習・研究・趣味での利用と、非営利団体での利用に限り、使用・改変・再配布できます。商用利用（報酬を伴う制作を含む）は、このライセンスでは許諾されません。
- **配布するアプリ（インストーラ・実行ファイル）**: [利用規約](EULA.md)に従います。配布者から直接受け取った方は、業務での利用も可能です。
- **サードパーティ**: 依存ライブラリはそれぞれのライセンスに従います（[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。`app/patches/` の ag-psd 改変部分は、ag-psd の MIT License にも従います。
- 商用利用のライセンスについては、作者（info@oputo.com）にお問い合わせください。

## 開発への参加について

個人で開発しているため、外部からのプルリクエストは受け付けていません。不具合の報告や要望は Issue で受け付けることがありますが、対応は約束できません。

## 商標

Adobe および Photoshop は Adobe Inc. の米国およびその他の国における商標または登録商標です。本ソフトウェアは Adobe Inc. と提携しておらず、Adobe Inc. の承認や支援も受けていません。PSD 形式への対応は、互換性のための記述です。
