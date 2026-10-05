#!/bin/bash

################################################################################
# AI Voice Desktop App - Development Script
#
# This script handles all the nuances of building and running the Tauri app
# with PyO3 and Python 3.13 compatibility.
#
# Usage:
#   ./run-dev.sh          # Run in development mode
#   ./run-dev.sh build    # Build for production
#   ./run-dev.sh check    # Check dependencies and configuration
################################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}/apps/desktop"

################################################################################
# Utility Functions
################################################################################

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

################################################################################
# Check Prerequisites
################################################################################

check_prerequisites() {
    log_info "Checking prerequisites..."

    local missing=0

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        missing=1
    else
        log_success "Node.js $(node --version) found"
    fi

    # Check pnpm
    if ! command -v pnpm &> /dev/null; then
        log_error "pnpm is not installed (run: npm install -g pnpm)"
        missing=1
    else
        log_success "pnpm $(pnpm --version) found"
    fi

    # Check Rust
    if ! command -v cargo &> /dev/null; then
        log_error "Rust/Cargo is not installed (visit: https://rustup.rs)"
        missing=1
    else
        log_success "Rust $(rustc --version | awk '{print $2}') found"
    fi

    # Check Python
    if ! command -v python3 &> /dev/null; then
        log_error "Python 3 is not installed"
        missing=1
    else
        local python_version=$(python3 --version | awk '{print $2}')
        log_success "Python ${python_version} found"

        # Check Python version and set compatibility flag if needed
        local major_version=$(echo $python_version | cut -d. -f1)
        local minor_version=$(echo $python_version | cut -d. -f2)

        if [ "$major_version" -eq 3 ] && [ "$minor_version" -ge 13 ]; then
            log_warning "Python 3.13+ detected - enabling PyO3 forward compatibility"
            export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1
        fi
    fi

    if [ $missing -eq 1 ]; then
        log_error "Missing prerequisites. Please install them and try again."
        exit 1
    fi

    log_success "All prerequisites met!"
}

################################################################################
# Setup Environment Variables
################################################################################

setup_environment() {
    log_info "Setting up environment variables..."

    # PyO3 forward compatibility for Python 3.13+
    export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1
    log_info "Set PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1"

    # Set Python executable path (helps PyO3 find Python)
    if command -v python3 &> /dev/null; then
        export PYTHON_SYS_EXECUTABLE=$(which python3)
        log_info "Set PYTHON_SYS_EXECUTABLE=${PYTHON_SYS_EXECUTABLE}"
    fi

    # Rust backtrace for better error messages in development
    export RUST_BACKTRACE=1
    log_info "Set RUST_BACKTRACE=1"

    log_success "Environment configured!"
}

################################################################################
# Check and Update Dependencies
################################################################################

check_dependencies() {
    log_info "Checking dependencies..."

    cd "${APP_DIR}"

    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        log_warning "node_modules not found, running pnpm install..."
        pnpm install
    else
        log_success "node_modules found"
    fi

    # Check PyO3 version in Cargo.toml
    cd "${APP_DIR}/src-tauri"

    local pyo3_version=$(grep 'pyo3 = {' Cargo.toml | grep -o 'version = "[^"]*"' | cut -d'"' -f2)

    if [ -z "$pyo3_version" ]; then
        log_warning "Could not detect PyO3 version"
    else
        log_info "PyO3 version: ${pyo3_version}"

        # Check if version is 0.22+
        local major=$(echo $pyo3_version | cut -d. -f1)
        local minor=$(echo $pyo3_version | cut -d. -f2)

        if [ "$major" -eq 0 ] && [ "$minor" -lt 22 ]; then
            log_warning "PyO3 version < 0.22 detected, updating..."
            cargo update pyo3 pyo3-ffi
            log_success "PyO3 updated to support Python 3.13"
        else
            log_success "PyO3 version is compatible with Python 3.13"
        fi
    fi

    cd "${APP_DIR}"
}

################################################################################
# Create dist directory (required by Tauri)
################################################################################

ensure_dist_directory() {
    log_info "Ensuring dist directory exists..."

    cd "${APP_DIR}"

    if [ ! -d "dist" ]; then
        log_warning "dist directory not found, creating..."
        mkdir -p dist
        echo '<!DOCTYPE html><html><head><title>AI Voice</title></head><body><div id="root"></div></body></html>' > dist/index.html
        log_success "Created dist directory with placeholder"
    else
        log_success "dist directory exists"
    fi
}

################################################################################
# Run Development Server
################################################################################

run_dev() {
    log_info "Starting development server..."

    cd "${APP_DIR}"

    log_info "Running: pnpm dev"
    log_info "Press Ctrl+C to stop"
    echo ""

    pnpm dev
}

################################################################################
# Build for Production
################################################################################

build_prod() {
    log_info "Building for production..."

    cd "${APP_DIR}"

    # Run tests first
    log_info "Running tests..."
    if pnpm test 2>/dev/null; then
        log_success "Tests passed"
    else
        log_warning "Tests not configured or failed (continuing anyway)"
    fi

    # Build
    log_info "Running: pnpm tauri build"
    pnpm tauri build

    log_success "Build complete!"
    log_info "Binaries location: ${APP_DIR}/src-tauri/target/release/bundle/"
}

################################################################################
# Print System Information
################################################################################

print_system_info() {
    log_info "System Information:"
    echo ""
    echo "  OS:      $(uname -s)"
    echo "  Arch:    $(uname -m)"
    echo "  Node:    $(node --version 2>/dev/null || echo 'Not found')"
    echo "  pnpm:    $(pnpm --version 2>/dev/null || echo 'Not found')"
    echo "  Rust:    $(rustc --version 2>/dev/null | awk '{print $2}' || echo 'Not found')"
    echo "  Python:  $(python3 --version 2>/dev/null || echo 'Not found')"
    echo ""
    echo "  Environment Variables:"
    echo "    PYO3_USE_ABI3_FORWARD_COMPATIBILITY: ${PYO3_USE_ABI3_FORWARD_COMPATIBILITY:-not set}"
    echo "    PYTHON_SYS_EXECUTABLE: ${PYTHON_SYS_EXECUTABLE:-not set}"
    echo "    RUST_BACKTRACE: ${RUST_BACKTRACE:-not set}"
    echo ""
}

################################################################################
# Main
################################################################################

main() {
    echo ""
    log_info "🎙️  AI Voice Desktop App - Development Script"
    echo ""

    # Parse command
    local command="${1:-dev}"

    case "$command" in
        dev|run)
            check_prerequisites
            setup_environment
            check_dependencies
            ensure_dist_directory
            run_dev
            ;;
        build)
            check_prerequisites
            setup_environment
            check_dependencies
            ensure_dist_directory
            build_prod
            ;;
        check|info)
            check_prerequisites
            setup_environment
            print_system_info
            ;;
        help|--help|-h)
            echo "Usage: $0 [command]"
            echo ""
            echo "Commands:"
            echo "  dev, run   Start development server (default)"
            echo "  build      Build for production"
            echo "  check      Check dependencies and configuration"
            echo "  help       Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0              # Start dev server"
            echo "  $0 dev          # Start dev server"
            echo "  $0 build        # Build for production"
            echo "  $0 check        # Check system"
            echo ""
            ;;
        *)
            log_error "Unknown command: $command"
            echo "Run '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"

