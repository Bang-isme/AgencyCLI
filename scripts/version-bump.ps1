# Bump version across all publishable @agency packages.
param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$dirs = @("providers", "core", "skills-bridge", "tui", "cli")
foreach ($d in $dirs) {
  $path = Join-Path (Join-Path (Join-Path $Root "packages") $d) "package.json"
  $json = Get-Content $path -Raw | ConvertFrom-Json
  $json.version = $Version
  $json | ConvertTo-Json -Depth 10 | Set-Content $path -Encoding utf8
  Write-Host "  packages/$d -> $Version"
}

Write-Host "Done. Run: pnpm -r build; pnpm smoke" -ForegroundColor Green
