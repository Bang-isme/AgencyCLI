# Agency CLI -- one-shot install (dev / linked global)
# Usage: .\scripts\install.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "           Agency CLI Installer" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Root Path: $Root" -ForegroundColor Gray

# 1. Detect initial Node.js
$nodePath = "node"
$nodeFound = $false

if (Get-Command "node" -ErrorAction SilentlyContinue) {
    $nodePath = "node"
    $nodeFound = $true
    $version = & $nodePath -v
    Write-Host "Detected System Node.js: $version" -ForegroundColor Green
    
    # Restrict Node version due to SQLite binary compatibility on Windows
    if ($version -notmatch "^v(20|22|24|25|26)\.") {
        Write-Error "Node.js version v20, v22, v24, v25, or v26 is required (detected $version). Please install a supported Node.js LTS version (https://nodejs.org/) and run this installer again."
        exit 1
    }
}

if (-not $nodeFound) {
    Write-Error "Node.js (v20 or v22 LTS) is required to install and run Agency CLI. Please install Node.js from https://nodejs.org/ and try again."
    exit 1
}


# 2. Check for pnpm
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "pnpm is not detected. Attempting to enable corepack..." -ForegroundColor Yellow
    try {
        & corepack enable pnpm
        if (Get-Command pnpm -ErrorAction SilentlyContinue) {
            Write-Host "pnpm enabled successfully via corepack!" -ForegroundColor Green
        }
    } catch {
        Write-Host "Failed to enable corepack: $_. Trying fallback npm installation..." -ForegroundColor Yellow
    }
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "pnpm is still not detected. Attempting to install pnpm globally via npm..." -ForegroundColor Yellow
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        try {
            & npm install -g pnpm --silent
            Write-Host "pnpm installed successfully!" -ForegroundColor Green
            
            $npmGlobalDir = Join-Path $env:APPDATA "npm"
            if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
                $pnpmCmd = Join-Path $npmGlobalDir "pnpm.cmd"
                if (Test-Path $pnpmCmd) {
                    $env:Path = "$npmGlobalDir;$env:Path"
                    Write-Host "Added $npmGlobalDir to active PATH." -ForegroundColor Gray
                } else {
                    throw "pnpm executable not found after installation."
                }
            }
        } catch {
            Write-Error "Failed to install pnpm automatically: $_. Please install it manually: npm install -g pnpm"
            exit 1
        }
    } else {
        Write-Error "pnpm is required, and npm is missing. Please make sure Node.js is installed correctly."
        exit 1
    }
}

# Ensure PNPM_HOME is configured and on PATH
if (-not $env:PNPM_HOME) {
    $env:PNPM_HOME = Join-Path $env:LOCALAPPDATA "pnpm"
}
$pnpmBin = Join-Path $env:PNPM_HOME "bin"

# Explicitly create directories on disk to avoid pnpm warnings
if (-not (Test-Path $env:PNPM_HOME)) {
    New-Item -ItemType Directory -Path $env:PNPM_HOME -Force | Out-Null
    Write-Host "Created pnpm home directory." -ForegroundColor Gray
}
if (-not (Test-Path $pnpmBin)) {
    New-Item -ItemType Directory -Path $pnpmBin -Force | Out-Null
    Write-Host "Created pnpm global bin directory." -ForegroundColor Gray
}

# Run setup to initialize shell config
pnpm setup | Out-Null

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$currentUserPaths = $userPath -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }
$currentPaths = $env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }

$pathsToAdd = @($env:PNPM_HOME, $pnpmBin)
foreach ($p in $pathsToAdd) {
    $normalizedP = $p.Trim().TrimEnd('\')
    if ($currentUserPaths -notcontains $normalizedP) {
        [Environment]::SetEnvironmentVariable("Path", "$p;$userPath", "User")
        $userPath = "$p;$userPath"
        $currentUserPaths = $userPath -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }
        Write-Host "Added to user PATH: $p" -ForegroundColor Green
    }
    if ($currentPaths -notcontains $normalizedP) {
        $env:Path = "$p;$env:Path"
        $currentPaths = $env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }
    }
}

# 3. Clean up legacy wrappers
Write-Host "Cleaning up legacy wrappers to prevent conflicts..." -ForegroundColor Cyan
$legacyWrappers = @(
    (Join-Path $env:USERPROFILE ".gemini\antigravity\bin\agency.cmd"),
    (Join-Path $env:USERPROFILE ".gemini\antigravity\bin\acg.cmd"),
    (Join-Path $env:APPDATA "Antigravity\bin\agency.cmd"),
    (Join-Path $env:APPDATA "Antigravity\bin\acg.cmd"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\agency.cmd"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\acg.cmd"),
    (Join-Path $env:PNPM_HOME "agency"),
    (Join-Path $env:PNPM_HOME "agency.cmd"),
    (Join-Path $env:PNPM_HOME "agency.ps1"),
    (Join-Path $env:PNPM_HOME "acg"),
    (Join-Path $env:PNPM_HOME "acg.cmd"),
    (Join-Path $env:PNPM_HOME "acg.ps1")
)

foreach ($path in $legacyWrappers) {
    if (Test-Path $path) {
        try {
            Remove-Item $path -Force
            Write-Host "  Deleted: $path" -ForegroundColor DarkGray
        } catch {
            Write-Host "  Failed to delete: $path (Permission denied or in use)" -ForegroundColor Yellow
        }
    }
}

# 4. Global configurations folder (~/.agency)
$globalAgencyDir = Join-Path $env:USERPROFILE ".agency"
if (-not (Test-Path $globalAgencyDir)) {
    New-Item -ItemType Directory -Path $globalAgencyDir -Force | Out-Null
    Write-Host "Created global config folder: $globalAgencyDir" -ForegroundColor Green
}
$globalConfigPath = Join-Path $globalAgencyDir "config.json"
if (-not (Test-Path $globalConfigPath)) {
    $exampleConfig = Join-Path $Root "scripts\config.example.json"
    if (Test-Path $exampleConfig) {
        Copy-Item $exampleConfig $globalConfigPath
        Write-Host "Initialized global config template: $globalConfigPath" -ForegroundColor Green
    }
} else {
    Write-Host "Retained existing global config: $globalConfigPath" -ForegroundColor Green
}

# 5. Build monorepo
Push-Location $Root
try {
    Write-Host "Cleaning stale build artifacts for a clean build..." -ForegroundColor Cyan
    Get-ChildItem -Path $Root -Filter "tsconfig.tsbuildinfo" -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike "*node_modules*" } | Remove-Item -Force
    Get-ChildItem -Path $Root -Include "dist" -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike "*node_modules*" } | Remove-Item -Recurse -Force

    Write-Host "Installing monorepo dependencies..." -ForegroundColor Cyan
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

    # Download prebuilt SQLite binary if needed
    Write-Host "Configuring native SQLite binary compatibility..." -ForegroundColor Cyan
    $prebuildInstallBin = Get-ChildItem -Path (Join-Path $Root "node_modules\.pnpm") -Filter "bin.js" -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*prebuild-install*" } | Select-Object -First 1 -ExpandProperty FullName
    $betterSqliteDir = Get-ChildItem -Path (Join-Path $Root "node_modules\.pnpm") -Filter "better-sqlite3" -Directory -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*better-sqlite3@*" -and $_.FullName -notlike "*@types*" } | Select-Object -First 1 -ExpandProperty FullName
    
    if ($prebuildInstallBin -and $betterSqliteDir) {
        Push-Location $betterSqliteDir
        try {
            $currentNodeVersion = & node -v
            if ($currentNodeVersion -match '^v(\d+)\.') {
                $majorVer = $Matches[1]
                $targetVer = "$majorVer.0.0"
            } else {
                $targetVer = $currentNodeVersion.Substring(1)
            }
            Write-Host "  Running prebuild-install for target Node version $targetVer (resolved from $currentNodeVersion)..." -ForegroundColor Gray
            & node $prebuildInstallBin --target=$targetVer
            Write-Host "  Successfully resolved native SQLite binary for Node $currentNodeVersion!" -ForegroundColor Green
        } catch {
            Write-Host "  Failed to run prebuild-install: $_" -ForegroundColor Yellow
        } finally {
            Pop-Location
        }
    }

    Write-Host "Building monorepo packages..." -ForegroundColor Cyan
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }

    # Regenerate local bin shims now that dist folders are built
    Write-Host "Regenerating local workspace bin shims..." -ForegroundColor Cyan
    pnpm install --prefer-offline --silent

    # Link packages/cli globally
    Write-Host "Linking @agency/cli globally..." -ForegroundColor Cyan
    Push-Location (Join-Path $Root "packages\cli")
    try {
        npm link
        if ($LASTEXITCODE -ne 0) { throw "npm link failed" }
    } finally {
        Pop-Location
    }

    # Verify and add pnpm global bin to user PATH (legacy fallback check)
    try {
        $pnpmGlobalRoot = pnpm root -g 2>$null | Select-Object -Last 1
        if ($pnpmGlobalRoot) {
            $globalBin = Join-Path $pnpmGlobalRoot ".bin"
            if (Test-Path $globalBin) {
                $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
                if ($userPath -notlike "*$globalBin*") {
                    [Environment]::SetEnvironmentVariable("Path", "$globalBin;$userPath", "User")
                    $env:Path = "$globalBin;$env:Path"
                    Write-Host "Added global bin to user PATH: $globalBin" -ForegroundColor Green
                }
            }
        }
    } catch {
        # Ignore any errors in legacy fallback
    }

    # 6. Configure PowerShell Profile (only if PROFILE is defined)
    if ($PROFILE) {
        Write-Host "Configuring PowerShell profile..." -ForegroundColor Cyan
        $ProfileDir = Split-Path -Parent $PROFILE
        if (-not (Test-Path $ProfileDir)) {
            New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
        }

        $ProfileContent = ""
        if (Test-Path $PROFILE) {
            $ProfileContent = Get-Content $PROFILE -Raw
        }

        $SetupBlock = @'
# region AgencyCLI-Setup
function acg {
    $env:AGENCY_TUI = "true"
    agency @args
    Remove-Item env:\AGENCY_TUI -ErrorAction SilentlyContinue
}
# endregion AgencyCLI-Setup
'@

        if ($ProfileContent -match '(?s)# region AgencyCLI-Setup.*?# endregion AgencyCLI-Setup') {
            $NewContent = $ProfileContent -replace '(?s)# region AgencyCLI-Setup.*?# endregion AgencyCLI-Setup', $SetupBlock
        } else {
            if ($ProfileContent.Length -gt 0 -and -not $ProfileContent.EndsWith("`n")) {
                $NewContent = $ProfileContent + "`r`n" + $SetupBlock
            } else {
                $NewContent = $ProfileContent + $SetupBlock
            }
        }

        Set-Content -Path $PROFILE -Value $NewContent -Encoding utf8
        Write-Host "Updated PowerShell profile at: $PROFILE" -ForegroundColor Green

        # If dot-sourced, clean up memory cache of old functions and reload profile immediately
        if ($MyInvocation.InvocationName -eq '.') {
            Remove-Item function:agency -ErrorAction SilentlyContinue
            Remove-Item function:acg -ErrorAction SilentlyContinue
            . $PROFILE
            Write-Host "Reloaded profile functions in active session!" -ForegroundColor Green
        }
    } else {
        Write-Host "PowerShell PROFILE is not defined. Skipping profile configuration." -ForegroundColor Yellow
    }



    # 7. Install Playwright browser dependencies
    Write-Host "Installing Playwright Chromium browser binary..." -ForegroundColor Cyan
    try {
        pnpm dlx playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw "Playwright installation returned non-zero exit code" }
    } catch {
        Write-Host "  Warning: Playwright browser installation failed: $_" -ForegroundColor Yellow
        Write-Host "  You can manually install it later by running: pnpm dlx playwright install chromium" -ForegroundColor Yellow
    }

    # 8. Bootstrap setup command (verifies SQLite native bindings compatibility)
    Write-Host "Verifying SQLite native bindings & running initial setup..." -ForegroundColor Cyan
    node packages/cli/dist/index.js setup --project-root $Root

    Write-Host ""
    Write-Host "==============================================" -ForegroundColor Green
    Write-Host "  Agency CLI installation completed successfully!" -ForegroundColor Green
    Write-Host "==============================================" -ForegroundColor Green
    Write-Host "  Please RESTART your terminal (or run '. `$PROFILE') to apply the changes." -ForegroundColor Cyan
    Write-Host "  Daily usage:" -ForegroundColor Cyan
    Write-Host "    acg                              # Launches interactive TUI" -ForegroundColor Cyan
    Write-Host "    agency doctor                    # Performs diagnostic checks" -ForegroundColor Cyan
    Write-Host "    agency setup --project-root .    # Run index + check configurations" -ForegroundColor Cyan
    Write-Host "==============================================" -ForegroundColor Green

} catch {
    Write-Error "Installation failed: $_"
    throw $_
} finally {
    Pop-Location
}
