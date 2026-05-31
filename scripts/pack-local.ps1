# Build and pack workspace packages for local/offline install testing.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Out = Join-Path $Root "dist-packs"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Push-Location $Root
try {
  pnpm -r build
  $order = @(
    "@agency/providers",
    "@agency/skills-bridge",
    "@agency/core",
    "@agency/tui",
    "@agency/cli"
  )
  foreach ($pkg in $order) {
    Write-Host "Packing $pkg ..." -ForegroundColor Cyan
    pnpm --filter $pkg pack --pack-destination $Out | Out-Null
  }
  Write-Host ""
  Write-Host "Tarballs in: $Out" -ForegroundColor Green
  Write-Host "Global install from repo (recommended): .\scripts\install.ps1"
} finally {
  Pop-Location
}
