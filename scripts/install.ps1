# Agency CLI -- one-shot install (dev / linked global)
# Usage: irm https://raw.githubusercontent.com/.../install.ps1 | iex
#   or:  .\scripts\install.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "Agency CLI install" -ForegroundColor Cyan
Write-Host "  Root: $Root"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Error "pnpm is required. Install: https://pnpm.io/installation"
}

# Global CLI bins live under PNPM_HOME; ensure it exists and is on PATH.
if (-not $env:PNPM_HOME) {
  $env:PNPM_HOME = Join-Path $env:LOCALAPPDATA "pnpm"
}
if (-not (Test-Path $env:PNPM_HOME)) {
  pnpm setup | Out-Null
  Write-Host "Ran pnpm setup. Open a NEW terminal after install so PATH includes PNPM_HOME." -ForegroundColor Yellow
}

Push-Location $Root
try {
  pnpm install
  pnpm build

  # Link @agency/cli (not the private root package -- root has no bin entries).
  Push-Location (Join-Path $Root "packages\cli")
  try {
    pnpm install -g .
    if ($LASTEXITCODE -ne 0) { throw "pnpm install -g @agency/cli failed" }
  } catch {
    throw $_
  } finally {
    Pop-Location
  }

  $globalBin = Join-Path (pnpm root -g) ".bin"
  if (Test-Path $globalBin) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$globalBin*") {
      [Environment]::SetEnvironmentVariable("Path", "$globalBin;$userPath", "User")
      $env:Path = "$globalBin;$env:Path"
      Write-Host "Added global bin to user PATH: $globalBin" -ForegroundColor DarkGray
    }
  }
  Write-Host ""
  $skills = Join-Path $env:USERPROFILE ".cursor\skills-cursor"
  if (Test-Path $skills) {
    $env:AGENCY_SKILLS_ROOT = $skills
    Write-Host "AGENCY_SKILLS_ROOT=$skills (this session)" -ForegroundColor DarkGray
    Write-Host "Persist: [Environment]::SetEnvironmentVariable('AGENCY_SKILLS_ROOT', '$skills', 'User')" -ForegroundColor DarkGray
  } else {
    $repoMockSkills = Join-Path $Root "tests\fixtures\mock-skills"
    if (Test-Path $repoMockSkills) {
      $env:AGENCY_SKILLS_ROOT = $repoMockSkills
      Write-Host "AGENCY_SKILLS_ROOT not found. Falling back to repository mock-skills: $repoMockSkills" -ForegroundColor Yellow
    }
  }

  Write-Host ""
  Write-Host "Installing Playwright Chromium browser binaries for agent browser capability..." -ForegroundColor Cyan
  npx playwright install chromium

  pnpm exec agency setup --project-root $Root

  Write-Host ""
  Write-Host "Done. Daily use:" -ForegroundColor Green
  Write-Host "  acg                              # TUI"
  Write-Host "  agency setup --project-root .    # re-index + config check"
  Write-Host "  .\scripts\smoke.ps1              # full smoke"
  Write-Host ""
  Write-Host "LLM: copy scripts\config.example.json -> $env:USERPROFILE\.agency\config.json"
} catch {
  throw $_
} finally {
  Pop-Location
}
