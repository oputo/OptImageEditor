# ビルド環境メモ

## ビルド生成物は Google ドライブの同期対象外に置く（2026-10-07）

### 症状

Google ドライブで `liboptimageeditor_lib.rlib` に「一部のファイルをダウンロードできません」というエラーが出る。「再試行」で消えても再発する。

### 原因（ChatGPT / Codex による DriveFS ログの調査結果）

- リポジトリは `D:\google\github\` にあり、`D:\google` は Google ドライブと同期されている。
- Rust / Tauri のビルド生成物 `app/src-tauri/target/`（約 4.9GB、約 4,900 ファイル）も同期対象になっていた。`.gitignore` は Git にしか効かず、Drive の同期対象からは外せない。
- ビルドのたびに約 264MB の `.rlib` が書き換わり、アップロードの途中で内容が変わる。その結果 `RegisterUpload Content fields don't match` / `ITEM_UPLOAD_ALREADY_IN_PROGRESS` の状態で競合していた。

### 対策

- `app/src-tauri/.cargo/config.toml` で `build.target-dir = "D:/build-cache/OptImageEditor"` を指定し、Cargo の生成物を同期対象外に出した。
- Tauri CLI はこの設定に従う（`npm run tauri dev` / `build` の出力先も同じ場所になる）。
- 配布用ビルドの exe とインストーラの場所: `D:\build-cache\OptImageEditor\release\`（`optimageeditor.exe`）と `...\release\bundle\nsis\`
- 古い `app/src-tauri/target/` は削除した。削除したファイルは Drive のゴミ箱に入るため、容量を空けるにはゴミ箱を空にする。

### 残っている同期対象（参考）

| フォルダ | サイズ | 状況 |
|---|---|---|
| `app/node_modules/` | 約 120MB / 約 5,300 ファイル | `npm install` したときだけ変わるので、競合は起きにくい。問題が出たら、リポジトリを同期対象外へ移すことを検討する |
| `app/dist/`、`app/src-tauri/gen/` | 小さい | ビルドのたびに書き換わるが、サイズが小さいため様子見 |
