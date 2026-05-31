# Daily-use smoke check (Option A verification)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $env:AGENCY_SKILLS_ROOT) {
  $default = Join-Path $env:USERPROFILE ".cursor\skills-cursor"
  if (Test-Path $default) {
    $env:AGENCY_SKILLS_ROOT = $default
  } else {
    $repoMockSkills = Join-Path $Root "tests\fixtures\mock-skills"
    if (Test-Path $repoMockSkills) {
      $env:AGENCY_SKILLS_ROOT = $repoMockSkills
      Write-Host "AGENCY_SKILLS_ROOT not found. Falling back to repository mock-skills: $repoMockSkills" -ForegroundColor Yellow
    }
  }
}

Push-Location $Root
try {
  Write-Host "[1/9] build" -ForegroundColor Cyan
  pnpm -r build | Out-Null

  Write-Host "[2/9] test" -ForegroundColor Cyan
  pnpm -r test | Out-Null

  Write-Host "[3/9] setup" -ForegroundColor Cyan
  pnpm exec agency setup --project-root .

  Write-Host "[4/9] doctor" -ForegroundColor Cyan
  pnpm exec agency doctor

  Write-Host "[5/9] config + index" -ForegroundColor Cyan
  pnpm exec agency config path
  pnpm exec agency index --project-root .

  Write-Host "[6/9] route + workflow (no preflight)" -ForegroundColor Cyan
  pnpm exec agency route "fix flaky test" --project-root .
  pnpm exec agency workflow run create --project-root . --yes

  Write-Host "[7/9] agents list" -ForegroundColor Cyan
  pnpm exec agency agents list

  Write-Host "[8/9] egress proxy security verification" -ForegroundColor Cyan
  pnpm --filter @agency/security exec vitest run src/__tests__/egress-bypass-active.test.ts

  Write-Host "[9/9] dry-run packaging and publishing check" -ForegroundColor Cyan
  powershell -ExecutionPolicy Bypass -File scripts/publish.ps1 -SkipTest

  Write-Host ""
  Write-Host "Smoke OK. Launch TUI: acg" -ForegroundColor Green
} finally {
  Pop-Location
}
