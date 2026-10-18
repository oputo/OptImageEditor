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

## 自動アップデート（未実装）

Tauri 2 の updater プラグインを使う予定。最初に配布するビルドから入れておく（入っていないビルドを配ると、その人には手作業で入れ直してもらうことになる）。

- 署名鍵を作る。秘密鍵とパスワードは PC の外にもバックアップする（**なくすと、配布済みのアプリに更新を届けられなくなる**）
- 配信先の URL はアプリに埋め込まれる。複数指定できるので、将来の移転に備えて自分のドメインの URL も入れておくか検討する
- 更新時はアプリが終了するので、未保存の編集がある時は先に確認する

## 配布前に済ませること

- ComfyUI との通信を Rust 側経由にする（ComfyUI 側の `--enable-cors-header *` を不要にする）
- 自動アップデートの組み込み
