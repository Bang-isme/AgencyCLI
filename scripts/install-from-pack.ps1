# Install @agency/cli globally from dist-packs/ tarballs (after pnpm pack:local).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PackDir = Join-Path $Root "dist-packs"

if (-not (Test-Path $PackDir)) {
  Write-Error "Run pnpm pack:local first"
}

$order = @(
  "agency-providers-*.tgz",
  "agency-core-*.tgz",
  "agency-skills-bridge-*.tgz",
  "agency-tui-*.tgz",
  "agency-cli-*.tgz"
)

Write-Host "Installing from $PackDir (global)..." -ForegroundColor Cyan
foreach ($pattern in $order) {
  $file = Get-ChildItem $PackDir -Filter $pattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $file) {
    Write-Error "Missing pack: $pattern"
  }
  Write-Host "  npm i -g $($file.Name)"
  npm install -g $file.FullName
}

Write-Host ""
Write-Host "Installed. Try: acg" -ForegroundColor Green
