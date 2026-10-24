# リリースの運用

一人で開発する規模に合わせ、軽い運用にする。

| 項目 | 方針 |
|---|---|
| ブランチ | `main` だけで開発し、リリースのたびにタグ（`v0.2.0` 等）を打つ。緊急の修正が要る時だけ、タグからブランチを切る |
| 配信 | GitHub Releases（本体のインストーラと updater 用の `latest.json`） |
| ビルド・署名 | オーナーの PC でリリース用スクリプトを実行する（署名用の秘密鍵は PC の外に出さない） |

## 版番号

- [Semantic Versioning](https://semver.org/lang/ja/) に従う。正式公開までは `0.x`
  - 機能の追加（フェーズの完了など）: minor を上げる（`0.2.0` → `0.3.0`）
  - 修正だけ: patch を上げる（`0.3.0` → `0.3.1`）
  - 試験版: `0.3.0-beta.1` のように接尾辞を付ける
- 版番号は `app/package.json` の `version` が正。`app/src-tauri/tauri.conf.json` は `"version": "../package.json"` で参照する。`app/src-tauri/Cargo.toml` の `version` は、リリース用スクリプトで同じ値にそろえる
- 変更点は `CHANGELOG.md` の「未リリース」に書きためて、リリース時に版番号の見出しに変える
- リリースの区切り: 細かい修正はすぐには出さずに「未リリース」に貯め、機能のまとまりなど、しっかりした区切りが付いた時に出す

## dev 版と配布版の分離

| | dev 版（開発中） | 配布版（インストール） |
|---|---|---|
| 起動 | `npm run app`（`tauri dev --config src-tauri/tauri.dev.conf.json`） | インストーラで入れたもの |
| 識別子 | `com.oputo.optimageeditor.dev` | `com.oputo.optimageeditor` |
| 表示名 | OptImageEditor Dev | OptImageEditor |
| 設定の置き場 | `%APPDATA%\com.oputo.optimageeditor.dev\` | `%APPDATA%\com.oputo.optimageeditor\` |
| 「プログラムから開く」 | ProgID `OptImageEditor.Dev.Image` のみ | ProgID `OptImageEditor.Image` + `Applications\optimageeditor.exe` |

- 識別子は、配布版の設定の置き場・WebView のデータ（最近使ったファイル等）・多重起動の判定・自動アップデートの対象を決める。**配布を始めた後は `com.oputo.optimageeditor` を変えない**
- `tauri.dev.conf.json` は `tauri.conf.json` に上書きで重ねる（配列は丸ごと置き換わる）。`app.windows` を変えた時は両方を直す
- `npm run tauri build` は配布版の識別子でビルドする（何も指定しない時に配布版になる側を既定にしている）

## 自動アップデート

Tauri 2 の updater プラグイン（tauri-plugin-updater 2.14）を使う。最初に配布するビルドから入れておく（入っていないビルドを配ると、その人には手作業で入れ直してもらうことになる）。

- アプリ: 起動の 5 秒後に確認し、新しい版があればツールバーに「更新 x.y.z」を出す（dev 版は自動では確認しない）。「ヘルプ → アップデートを確認」で手動でも確認できる。更新ダイアログには `latest.json` の `notes`（＝ CHANGELOG のその版の節）を表示する
- 未保存の変更がある時は更新しない（先に保存してもらう）。Windows ではインストーラを起動した時点でアプリが終了し、インストール後に自動で起動し直す（インストールモードは `passive`）
- 通しの確認（2026-10-19、v0.2.0 → v0.2.1、ノート PC）: 起動 5 秒後に「更新 0.2.1」→ ダイアログ → 「今すぐ更新」でアプリが終了し、0.2.1 で自動的に起動し直した。ダウンロードとインストールは短く、画面上ではほぼ見えない
- dev 版（`npm run app`）は確認まではできるが、インストールはしない
- 実装: `app/src-tauri/src/update.rs`（`update_check` / `update_install`）、`app/src/lib/update.ts`、設定は `tauri.conf.json` の `plugins.updater`

### 配信先（endpoints）

| 順 | URL | 役割 |
|---|---|---|
| 1 | `https://github.com/oputo/OptImageEditor/releases/latest/download/latest.json` | 本番。GitHub Releases の最新版（Pre-release と下書きは対象外） |
| 2 | `https://oputo.com/apps/optimageeditor/latest.json` | 予備（oputo-portal の `public/apps/optimageeditor/latest.json`。GitHub Actions で VPS に配信。**VPS に手で置かない**: デプロイの rsync --delete で消える） |

- URL は配布済みのアプリに埋め込まれるので、**変えない**（変える時は、新しい URL を入れた版を古い URL 経由で配ってから）
- プラグインの動き（2.14.0 のソースで確認）: 上から順に問い合わせ、接続エラーや 2xx 以外（404 等）なら次へ進む。**2xx で JSON でない応答（HTML のページ等）が返ると、次へ進まずに確認全体が失敗する**。転送はたどる。最初に見つかった版を使い、それが今の版より新しければ更新あり
- 1 番目が GitHub なので、2 番目は GitHub に届かない時だけ使われる。oputo-portal 側の `latest.json` は毎回更新しなくてもよい（古くても害はない）
- 将来 GitHub での配布をやめる時: GitHub の Releases を消す（404 になる）と、2 番目が使われる

### 署名鍵

更新ファイルは署名し、アプリは `tauri.conf.json` の `plugins.updater.pubkey`（公開鍵）で検証する。

1. 鍵を作る（1 回だけ。オーナーの PC で）:
   ```powershell
   cd D:\google\github\OptImageEditor\app
   npx tauri signer generate -w "$env:USERPROFILE\.tauri\optimageeditor.key"
   ```
   パスワードを聞かれるので設定する。`optimageeditor.key`（秘密鍵）と `optimageeditor.key.pub`（公開鍵）ができる
2. 公開鍵（`.pub` の中身）を `tauri.conf.json` の `plugins.updater.pubkey` に入れてコミットする（公開してよい）
3. **秘密鍵とパスワードを PC の外にもバックアップする**（パスワード管理ソフト等。リポジトリや同期フォルダに平文で置かない）。なくすと、配布済みのアプリに更新を届けられなくなる（新しい鍵の版は、古い版のアプリが受け付けない）

## リリースの手順

前提: 署名鍵がある、`main` に未コミットの変更がない、`CHANGELOG.md` の「未リリース」にこの版の変更点が書いてある（利用者が読む文面として書く。更新ダイアログに表示される）。

```powershell
cd D:\google\github\OptImageEditor
powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 0.2.0
# 予備の配信先も更新する時: -Portal（oputo-portal の public/apps/optimageeditor/ にコピー。コミットと push は oputo-portal 側で）
```

スクリプトがすること:
1. 版番号を更新（`app/package.json`・`package-lock.json`・`Cargo.toml`）
2. 署名付きでビルド（`tauri.release.conf.json` で `createUpdaterArtifacts` を有効にする。秘密鍵とパスワードは環境変数で渡し、終わったら消す）。失敗したら版番号の変更を元に戻して中止
3. `D:\build-cache\OptImageEditor\release-out\v0.2.0\` に、インストーラ・署名（`.sig`）・`latest.json`・`notes.md` を置く
4. CHANGELOG の「未リリース」を版番号の見出しに変え、コミット（`Release v0.2.0`）と注釈付きタグ（`v0.2.0`）

その後（手作業）:
1. GitHub Desktop で push（タグも上がったか確認）
2. `https://github.com/oputo/OptImageEditor/releases/new?tag=v0.2.0` で、上の 3 ファイル（インストーラ・`.sig`・`latest.json`）を添付し、本文に `notes.md` を貼って公開（Pre-release にはしない）
3. 別の PC で「ヘルプ → アップデートを確認」
4. 初回の配布時など、サイトの表示を変える時は oputo.com 側（`https://oputo.com/apps/#optimageeditor`）に依頼する

- 普段の `npm run tauri build` は署名なし（更新用のファイルは作らない）。動作確認用のインストーラはこれで作ってよい

## 配布前に済ませること

- ~~ComfyUI との通信を Rust 側経由にする~~（済み。ComfyUI 側の `--enable-cors-header` は不要になった）
- ~~自動アップデートの組み込み~~（済み。署名鍵は 2026-10-18 に作成、公開鍵の ID は `2AC27777A4CB0174`）
