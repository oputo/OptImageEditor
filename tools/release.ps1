<#
.SYNOPSIS
  OptImageEditor のリリース: 版番号の更新 → 署名付きビルド → latest.json の作成 → コミットとタグ。
  GitHub Releases へのアップロードと push は、最後に表示する手順で行う。詳しくは docs/release.md。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 0.2.0
  powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 0.2.1 -Portal   # oputo-portal にも latest.json をコピー
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  # 署名用の秘密鍵（tauri signer generate で作ったもの）
  [string]$KeyPath = (Join-Path $env:USERPROFILE ".tauri\optimageeditor.key"),
  # latest.json を oputo-portal の public/apps/optimageeditor/ にもコピーする（予備の配信先）
  [switch]$Portal,
  [string]$PortalDir = ""
)
$ErrorActionPreference = "Stop"

$utf8 = New-Object System.Text.UTF8Encoding($false)
$repo = Split-Path $PSScriptRoot -Parent
$app = Join-Path $repo "app"
$tag = "v$Version"
$ghRepo = "oputo/OptImageEditor"
if (-not $PortalDir) { $PortalDir = Join-Path (Split-Path $repo -Parent) "oputo-portal" }
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { "D:\build-cache\OptImageEditor" }  # app/src-tauri/.cargo/config.toml

function Fail([string]$m) { Write-Host "中止: $m" -ForegroundColor Red; exit 1 }
function ReadText([string]$p) { [IO.File]::ReadAllText($p, $utf8) }
function WriteText([string]$p, [string]$t) { [IO.File]::WriteAllText($p, $t, $utf8) }

Set-Location $repo

# ---------------------------------------------------------------- 確認
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { Fail "版番号の形式が違います: $Version（例: 0.2.0、0.3.0-beta.1）" }
if (git status --porcelain) { Fail "コミットされていない変更があります" }
$branch = git rev-parse --abbrev-ref HEAD
if ($branch -ne "main") { Fail "main ブランチで実行してください（今は $branch）" }
if (git tag --list $tag) { Fail "タグ $tag は既にあります" }
if (-not (Test-Path $KeyPath)) { Fail "署名鍵がありません: $KeyPath（docs/release.md の「署名鍵」を参照）" }
$current = (ReadText (Join-Path $app "package.json") | ConvertFrom-Json).version
if ([version]($Version -replace '-.*$', '') -lt [version]($current -replace '-.*$', '') -or $Version -eq $current) {
  Fail "版番号は今の版（$current）より大きくしてください"
}
$clPath = Join-Path $repo "CHANGELOG.md"
$cl = ReadText $clPath
$m = [regex]::Match($cl, '(?ms)^## \[未リリース\][ \t]*\r?\n(.*?)(?=^## |\z)')
if (-not $m.Success) { Fail "CHANGELOG.md に「## [未リリース]」の節がありません" }
$notes = $m.Groups[1].Value.Trim()
if (-not $notes) { Fail "CHANGELOG.md の「未リリース」が空です（この版の変更点を書いてください）" }

Write-Host "リリース $current → $Version" -ForegroundColor Cyan
Write-Host $notes
Write-Host ""

# ---------------------------------------------------------------- 版番号
Push-Location $app
npm version $Version --no-git-tag-version | Out-Null
$code = $LASTEXITCODE
Pop-Location
if ($code) { Fail "npm version に失敗しました" }
$cargoPath = Join-Path $app "src-tauri\Cargo.toml"
WriteText $cargoPath (([regex]'(?m)^version = "[^"]*"').Replace((ReadText $cargoPath), "version = `"$Version`"", 1))

# ---------------------------------------------------------------- 署名付きビルド
$sec = Read-Host "署名鍵のパスワード（設定していない場合は Enter）" -AsSecureString
$env:TAURI_SIGNING_PRIVATE_KEY = (ReadText $KeyPath).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
Push-Location $app
try {
  npx tauri build --config src-tauri/tauri.release.conf.json
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
if ($code) {
  git checkout -- .
  Fail "ビルドに失敗しました（版番号の変更は元に戻しました）"
}

$exeName = "OptImageEditor_${Version}_x64-setup.exe"
$exe = Join-Path $target "release\bundle\nsis\$exeName"
$sig = "$exe.sig"
if (-not (Test-Path $exe) -or -not (Test-Path $sig)) { Fail "インストーラか署名が見つかりません: $exe" }

# ---------------------------------------------------------------- latest.json（updater 用）
$out = Join-Path $target "release-out\$tag"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $exe, $sig $out -Force
$manifest = [ordered]@{
  version   = $Version
  notes     = $notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (ReadText $sig).Trim()
      url       = "https://github.com/$ghRepo/releases/download/$tag/$exeName"
    }
  }
}
WriteText (Join-Path $out "latest.json") ($manifest | ConvertTo-Json -Depth 5)
WriteText (Join-Path $out "notes.md") $notes

if ($Portal) {
  $dst = Join-Path $PortalDir "public\apps\optimageeditor"
  New-Item -ItemType Directory -Force $dst | Out-Null
  Copy-Item (Join-Path $out "latest.json") $dst -Force
  Write-Host "oputo-portal にコピーしました: $dst\latest.json（コミットと push は oputo-portal 側で）" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- CHANGELOG・コミット・タグ
$date = Get-Date -Format "yyyy-MM-dd"
WriteText $clPath ($cl.Remove($m.Index, $m.Length).Insert($m.Index, "## [未リリース]`n`n## $Version（$date）`n`n$notes`n`n"))
git add app/package.json app/package-lock.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock CHANGELOG.md
git commit -q -m "Release $tag"
if ($LASTEXITCODE) { Fail "コミットに失敗しました" }
git tag -a $tag -m "OptImageEditor $Version"

Write-Host ""
Write-Host "完了: $out" -ForegroundColor Green
Write-Host "次の手順:"
Write-Host "  1. GitHub Desktop で push（タグ $tag も GitHub に上がったか確認。上がらない場合は 2 の画面でタグ $tag を main に作る）"
Write-Host "  2. https://github.com/$ghRepo/releases/new?tag=$tag を開き、上のフォルダの $exeName / .sig / latest.json を添付、"
Write-Host "     本文に notes.md を貼って「Publish release」（Pre-release にはしない）"
Write-Host "  3. 別の PC で「ヘルプ → アップデートを確認」"
