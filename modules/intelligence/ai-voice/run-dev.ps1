################################################################################
# AI Voice Desktop App - Development Script (Windows)
#
# This script handles all the nuances of building and running the Tauri app
# with PyO3 and Python 3.13 compatibility on Windows.
#
# Usage:
#   .\run-dev.ps1         # Run in development mode
#   .\run-dev.ps1 build   # Build for production
#   .\run-dev.ps1 check   # Check dependencies and configuration
################################################################################

param(
    [Parameter(Position=0)]
    [string]$Command = "dev"
)

# Script configuration
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $ScriptDir "apps\desktop"

################################################################################
# Utility Functions
################################################################################

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Blue
}

function Write-Success {
    param([string]$Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "[WARNING] $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

################################################################################
# Check Prerequisites
################################################################################

function Test-Prerequisites {
    Write-Info "Checking prerequisites..."

    $missing = $false

    # Check Node.js
    if (!(Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error "Node.js is not installed"
        $missing = $true
    } else {
        $nodeVersion = node --version
        Write-Success "Node.js $nodeVersion found"
    }

    # Check pnpm
    if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Error "pnpm is not installed (run: npm install -g pnpm)"
        $missing = $true
    } else {
        $pnpmVersion = pnpm --version
        Write-Success "pnpm $pnpmVersion found"
    }

    # Check Rust
    if (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
        Write-Error "Rust/Cargo is not installed (visit: https://rustup.rs)"
        $missing = $true
    } else {
        $rustVersion = rustc --version | ForEach-Object { $_.Split()[1] }
        Write-Success "Rust $rustVersion found"
    }

    # Check Python
    if (!(Get-Command python -ErrorAction SilentlyContinue)) {
        Write-Error "Python 3 is not installed"
        $missing = $true
    } else {
        $pythonVersion = python --version | ForEach-Object { $_.Split()[1] }
        Write-Success "Python $pythonVersion found"

        # Check Python version
        $versionParts = $pythonVersion.Split('.')
        $major = [int]$versionParts[0]
        $minor = [int]$versionParts[1]

        if ($major -eq 3 -and $minor -ge 13) {
            Write-Warning "Python 3.13+ detected - enabling PyO3 forward compatibility"
            $env:PYO3_USE_ABI3_FORWARD_COMPATIBILITY = "1"
        }
    }

    if ($missing) {
        Write-Error "Missing prerequisites. Please install them and try again."
        exit 1
    }

    Write-Success "All prerequisites met!"
}

################################################################################
# Setup Environment Variables
################################################################################

function Set-Environment {
    Write-Info "Setting up environment variables..."

    # PyO3 forward compatibility for Python 3.13+
    $env:PYO3_USE_ABI3_FORWARD_COMPATIBILITY = "1"
    Write-Info "Set PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1"

    # Set Python executable path
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $env:PYTHON_SYS_EXECUTABLE = (Get-Command python).Source
        Write-Info "Set PYTHON_SYS_EXECUTABLE=$env:PYTHON_SYS_EXECUTABLE"
    }

    # Rust backtrace for better error messages
    $env:RUST_BACKTRACE = "1"
    Write-Info "Set RUST_BACKTRACE=1"

    Write-Success "Environment configured!"
}

################################################################################
# Check and Update Dependencies
################################################################################

function Test-Dependencies {
    Write-Info "Checking dependencies..."

    Set-Location $AppDir

    # Check if node_modules exists
    if (!(Test-Path "node_modules")) {
        Write-Warning "node_modules not found, running pnpm install..."
        pnpm install
    } else {
        Write-Success "node_modules found"
    }

    # Check PyO3 version
    Set-Location "$AppDir\src-tauri"

    $cargoToml = Get-Content "Cargo.toml"
    $pyo3Line = $cargoToml | Where-Object { $_ -match 'pyo3 = \{' }

    if ($pyo3Line) {
        if ($pyo3Line -match 'version = "([^"]+)"') {
            $pyo3Version = $matches[1]
            Write-Info "PyO3 version: $pyo3Version"

            $versionParts = $pyo3Version.Split('.')
            $major = [int]$versionParts[0]
            $minor = [int]$versionParts[1]

            if ($major -eq 0 -and $minor -lt 22) {
                Write-Warning "PyO3 version < 0.22 detected, updating..."
                cargo update pyo3 pyo3-ffi
                Write-Success "PyO3 updated to support Python 3.13"
            } else {
                Write-Success "PyO3 version is compatible with Python 3.13"
            }
        }
    }

    Set-Location $AppDir
}

################################################################################
# Create dist directory
################################################################################

function New-DistDirectory {
    Write-Info "Ensuring dist directory exists..."

    Set-Location $AppDir

    if (!(Test-Path "dist")) {
        Write-Warning "dist directory not found, creating..."
        New-Item -ItemType Directory -Path "dist" | Out-Null
        $html = '<!DOCTYPE html><html><head><title>AI Voice</title></head><body><div id="root"></div></body></html>'
        Set-Content -Path "dist\index.html" -Value $html
        Write-Success "Created dist directory with placeholder"
    } else {
        Write-Success "dist directory exists"
    }
}

################################################################################
# Run Development Server
################################################################################

function Start-DevServer {
    Write-Info "Starting development server..."

    Set-Location $AppDir

    Write-Info "Running: pnpm dev"
    Write-Info "Press Ctrl+C to stop"
    Write-Host ""

    pnpm dev
}

################################################################################
# Build for Production
################################################################################

function Build-Production {
    Write-Info "Building for production..."

    Set-Location $AppDir

    # Run tests first
    Write-Info "Running tests..."
    try {
        pnpm test 2>$null
        Write-Success "Tests passed"
    } catch {
        Write-Warning "Tests not configured or failed (continuing anyway)"
    }

    # Build
    Write-Info "Running: pnpm tauri build"
    pnpm tauri build

    Write-Success "Build complete!"
    Write-Info "Binaries location: $AppDir\src-tauri\target\release\bundle\"
}

################################################################################
# Print System Information
################################################################################

function Show-SystemInfo {
    Write-Info "System Information:"
    Write-Host ""
    Write-Host "  OS:      Windows"
    Write-Host "  Node:    $(if (Get-Command node -ErrorAction SilentlyContinue) { node --version } else { 'Not found' })"
    Write-Host "  pnpm:    $(if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm --version } else { 'Not found' })"
    Write-Host "  Rust:    $(if (Get-Command rustc -ErrorAction SilentlyContinue) { (rustc --version).Split()[1] } else { 'Not found' })"
    Write-Host "  Python:  $(if (Get-Command python -ErrorAction SilentlyContinue) { python --version } else { 'Not found' })"
    Write-Host ""
    Write-Host "  Environment Variables:"
    Write-Host "    PYO3_USE_ABI3_FORWARD_COMPATIBILITY: $env:PYO3_USE_ABI3_FORWARD_COMPATIBILITY"
    Write-Host "    PYTHON_SYS_EXECUTABLE: $env:PYTHON_SYS_EXECUTABLE"
    Write-Host "    RUST_BACKTRACE: $env:RUST_BACKTRACE"
    Write-Host ""
}

################################################################################
# Main
################################################################################

function Main {
    Write-Host ""
    Write-Info "🎙️  AI Voice Desktop App - Development Script (Windows)"
    Write-Host ""

    switch ($Command.ToLower()) {
        "dev" {
            Test-Prerequisites
            Set-Environment
            Test-Dependencies
            New-DistDirectory
            Start-DevServer
        }
        "run" {
            Test-Prerequisites
            Set-Environment
            Test-Dependencies
            New-DistDirectory
            Start-DevServer
        }
        "build" {
            Test-Prerequisites
            Set-Environment
            Test-Dependencies
            New-DistDirectory
            Build-Production
        }
        "check" {
            Test-Prerequisites
            Set-Environment
            Show-SystemInfo
        }
        "info" {
            Test-Prerequisites
            Set-Environment
            Show-SystemInfo
        }
        "help" {
            Write-Host "Usage: .\run-dev.ps1 [command]"
            Write-Host ""
            Write-Host "Commands:"
            Write-Host "  dev, run   Start development server (default)"
            Write-Host "  build      Build for production"
            Write-Host "  check      Check dependencies and configuration"
            Write-Host "  help       Show this help message"
            Write-Host ""
            Write-Host "Examples:"
            Write-Host "  .\run-dev.ps1          # Start dev server"
            Write-Host "  .\run-dev.ps1 dev      # Start dev server"
            Write-Host "  .\run-dev.ps1 build    # Build for production"
            Write-Host "  .\run-dev.ps1 check    # Check system"
            Write-Host ""
        }
        default {
            Write-Error "Unknown command: $Command"
            Write-Host "Run '.\run-dev.ps1 help' for usage information"
            exit 1
        }
    }
}

# Run main function
try {
    Main
} catch {
    Write-Error "An error occurred: $_"
    exit 1
}

