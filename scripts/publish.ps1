# Publish @agency/* packages to npm in dependency order.
param(
  [switch]$Publish,
  [switch]$SkipTest,
  [string]$RepoUrl = $env:AGENCY_REPO_URL
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$Order = @(
  "@agency/providers",
  "@agency/core",
  "@agency/skills-bridge",
  "@agency/tui",
  "@agency/cli"
)

function Set-RepoMetadata {
  param([string]$PackageDir, [string]$Url)
  if (-not $Url) { return }
  $pkgPath = Join-Path $PackageDir "package.json"
  $json = Get-Content $pkgPath -Raw | ConvertFrom-Json
  if (-not $json.repository) {
    $repoObj = @{
      type = "git"
      url = $Url
    }
    $json | Add-Member -NotePropertyName repository -NotePropertyValue $repoObj
    $json | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding utf8
  }
}

Push-Location $Root
try {
  Write-Host "=== Agency CLI Publish ===" -ForegroundColor Cyan

  # 1. Enforce dirty workspace check
  $gitStatus = git status --porcelain
  if ($gitStatus) {
    if ($Publish) {
      throw "Git working directory is dirty. Please commit or stash your changes before publishing."
    } else {
      Write-Warning "Git working directory is dirty. In production publish mode, this will halt the release."
    }
  }

  # 2. Check branch and warn if not on main/master
  $activeBranch = git rev-parse --abbrev-ref HEAD
  if ($activeBranch -ne "main" -and $activeBranch -ne "master") {
    Write-Warning "You are on branch '$activeBranch'. Releases are recommended to be run from 'main' or 'master' branch."
  }

  # 3. Read version from packages/cli/package.json
  $cliPkgPath = Join-Path (Join-Path $Root "packages") "cli" | Join-Path -ChildPath "package.json"
  if (-not (Test-Path $cliPkgPath)) {
    throw "Could not find packages/cli/package.json at $cliPkgPath"
  }
  $cliJson = Get-Content $cliPkgPath -Raw | ConvertFrom-Json
  $Version = $cliJson.version
  if (-not $Version) {
    throw "Could not parse version from packages/cli/package.json"
  }
  Write-Host "Target Release Version: v$Version" -ForegroundColor Cyan

  if (-not $Publish) {
    Write-Host "DRY-RUN mode (pass -Publish to upload)" -ForegroundColor Yellow
  }

  if (-not $SkipTest) {
    Write-Host "Running tests..." -ForegroundColor Cyan
    pnpm -r test
    if ($LASTEXITCODE -ne 0) { throw "tests failed" }
  }

  Write-Host "Building..." -ForegroundColor Cyan
  pnpm -r build
  if ($LASTEXITCODE -ne 0) { throw "build failed" }

  foreach ($name in $Order) {
    $pkgName = $name -replace "@agency/", ""
    $dir = Join-Path (Join-Path $Root "packages") $pkgName
    Set-RepoMetadata -PackageDir $dir -Url $RepoUrl

    Write-Host ""
    Write-Host "Package: $name" -ForegroundColor Yellow
    Push-Location $dir
    try {
      $pubArgs = @("publish", "--access", "public", "--no-git-checks")
      if (-not $Publish) { $pubArgs += "--dry-run" }
      pnpm @pubArgs
      if ($LASTEXITCODE -ne 0) { throw "$(if ($Publish) { 'publish' } else { 'dry-run' }) failed for $name" }
    } catch {
      throw $_
    } finally {
      Pop-Location
    }
  }

  Write-Host ""
  if ($Publish) {
    Write-Host "Published. Users: npm i -g @agency/cli" -ForegroundColor Green

    # 4. Create and push Git tag v$Version
    Write-Host "Creating Git tag v$Version..." -ForegroundColor Cyan
    git tag -a "v$Version" -m "Release v$Version"
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Git tag 'v$Version' already exists."
    } else {
      Write-Host "Successfully created Git tag 'v$Version'." -ForegroundColor Green
      Write-Host "Pushing tag 'v$Version' to origin..." -ForegroundColor Cyan
      git push origin "v$Version"
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to push Git tag 'v$Version' to origin."
      }
    }
  } else {
    Write-Host "Dry-run OK. Run: .\scripts\publish.ps1 -Publish" -ForegroundColor Green
    Write-Host "Note: In production mode, this would automatically tag v$Version and push to origin." -ForegroundColor Yellow
  }
} catch {
  throw $_
} finally {
  Pop-Location
}
