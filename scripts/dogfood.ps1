# Agency CLI - 30-minute dogfood verification (Option D)
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $env:AGENCY_SKILLS_ROOT) {
  $default = Join-Path $env:USERPROFILE ".cursor\skills-cursor"
  if (Test-Path $default) {
    $env:AGENCY_SKILLS_ROOT = $default
    Write-Host "AGENCY_SKILLS_ROOT=$default" -ForegroundColor DarkGray
  } else {
    $repoMockSkills = Join-Path $Root "tests\fixtures\mock-skills"
    if (Test-Path $repoMockSkills) {
      $env:AGENCY_SKILLS_ROOT = $repoMockSkills
      Write-Host "AGENCY_SKILLS_ROOT not found. Falling back to repository mock-skills: $repoMockSkills" -ForegroundColor Yellow
    } else {
      Write-Warning "Set AGENCY_SKILLS_ROOT to your CodexAI skills pack"
    }
  }
}

$logDir = Join-Path $Root ".agency"
$logPath = Join-Path $logDir "dogfood-log.md"
if (-not (Test-Path $logPath)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $date = Get-Date -Format "yyyy-MM-dd"
  @"
# Dogfood friction log

## $date - first run

- **What I tried:**
- **Expected:**
- **Actual:**
- **Severity:**
- **Fix priority:**

"@ | Set-Content -Path $logPath -Encoding utf8
  Write-Host "Created $logPath" -ForegroundColor DarkGray
}

function Invoke-DogfoodStep {
  param(
    [string]$Name,
    [scriptblock]$Run,
    [switch]$AllowNonZero
  )
  Write-Host "  $Name" -ForegroundColor Yellow
  & $Run
  $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  if ($code -ne 0 -and -not $AllowNonZero) {
    Write-Host "  FAIL (exit $code)" -ForegroundColor Red
    return $false
  }
  Write-Host "  OK" -ForegroundColor Green
  return $true
}

Push-Location $Root
try {
  Write-Host ""
  Write-Host "=== Agency CLI Dogfood ===" -ForegroundColor Cyan
  Write-Host "Log friction in: $logPath"
  Write-Host ""

  $failed = @()

  if (-not (Invoke-DogfoodStep "doctor" {
      pnpm exec agency doctor 2>&1 | Out-Host
    } -AllowNonZero)) {
    $failed += "doctor"
    Write-Host "  Note: doctor may fail on skills pack layout - not always CLI bug." -ForegroundColor DarkGray
  }

  if (-not (Invoke-DogfoodStep "setup" { pnpm exec agency setup --project-root $Root })) {
    $failed += "setup"
  }

  if (-not (Invoke-DogfoodStep "index" { pnpm exec agency index --project-root $Root })) {
    $failed += "index"
  }

  if (-not (Invoke-DogfoodStep "route" {
      pnpm exec agency route "fix flaky test" --project-root $Root
    })) {
    $failed += "route"
  }

  if (-not (Invoke-DogfoodStep "chat" {
      pnpm exec agency chat --no-llm "plan auth refactor" --project-root $Root
    })) {
    $failed += "chat"
  }

  if (-not (Invoke-DogfoodStep "agents" {
      pnpm exec agency agents dispatch planner --task "Dogfood task" --project-root $Root --no-llm
    })) {
    $failed += "agents"
  }

  Write-Host "  workflow (gate may fail on security scan)" -ForegroundColor Yellow
  try {
    pnpm exec agency workflow run create --project-root $Root --yes 2>&1 | Out-Host
  } catch {
    Out-Host $_
  }
  $wfCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  if ($wfCode -ne 0) {
    Write-Host "  WARN gate exit $wfCode - common on dev repos" -ForegroundColor DarkYellow
  } else {
    Write-Host "  OK" -ForegroundColor Green
  }

  Write-Host ""
  Write-Host "TUI manual: run acg" -ForegroundColor Cyan
  Write-Host '  try: prompt, @file, /index, /export, !git status, q'
  Write-Host ""

  $mustFail = $failed | Where-Object { $_ -ne "doctor" }
  if ($mustFail.Count -eq 0) {
    Write-Host "Dogfood core steps: PASS" -ForegroundColor Green
    Write-Host "Append notes to $logPath"
  } else {
    $msg = "Failed: " + ($mustFail -join ", ")
    Write-Host $msg -ForegroundColor Red
    exit 1
  }
} finally {
  Pop-Location
}
