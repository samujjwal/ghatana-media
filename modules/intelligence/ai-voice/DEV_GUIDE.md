# AI Voice Desktop App - Development Guide

## Quick Start

### macOS / Linux
```bash
cd products/shared-services/ai-voice
./run-dev.sh
```

### Windows
```powershell
cd products\shared-services\ai-voice
.\run-dev.ps1
```

That's it! The script handles all the build nuances automatically.

---

## What the Script Does

The `run-dev` script automatically:

1. ✅ **Checks all prerequisites** (Node.js, pnpm, Rust, Python)
2. ✅ **Detects Python version** and sets compatibility flags
3. ✅ **Configures environment variables** for PyO3/Python 3.13
4. ✅ **Updates dependencies** if needed (PyO3 0.22+)
5. ✅ **Creates required directories** (dist folder)
6. ✅ **Starts the development server** with proper configuration

---

## Manual Setup (If Needed)

### Prerequisites

**Required:**
- Node.js 18+ ([nodejs.org](https://nodejs.org))
- pnpm (`npm install -g pnpm`)
- Rust ([rustup.rs](https://rustup.rs))
- Python 3.10-3.13 ([python.org](https://python.org))

**Platform-Specific:**

**macOS:**
```bash
brew install python@3.13
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install python3 python3-dev build-essential
```

**Linux (RHEL/CentOS):**
```bash
sudo yum install python3 python3-devel gcc
```

**Windows:**
- Download Python from [python.org](https://python.org)
- Make sure to check "Add Python to PATH" during installation

---

## Commands

### Development Mode
```bash
# macOS/Linux
./run-dev.sh
./run-dev.sh dev

# Windows
.\run-dev.ps1
.\run-dev.ps1 dev
```

### Production Build
```bash
# macOS/Linux
./run-dev.sh build

# Windows
.\run-dev.ps1 build
```

### Check System
```bash
# macOS/Linux
./run-dev.sh check

# Windows
.\run-dev.ps1 check
```

---

## Build Nuances Handled

### 1. Python 3.13 Compatibility

**Issue:** PyO3 versions < 0.22 don't support Python 3.13

**Solution:** Script automatically:
- Detects Python 3.13
- Sets `PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1`
- Updates PyO3 to 0.22+ if needed

### 2. Python Path Detection

**Issue:** PyO3 might not find Python executable

**Solution:** Script automatically:
- Finds Python path with `which python3` (Unix) or `Get-Command` (Windows)
- Sets `PYTHON_SYS_EXECUTABLE` environment variable

### 3. Missing dist Directory

**Issue:** Tauri requires a `dist` directory

**Solution:** Script automatically:
- Creates `dist` directory if missing
- Adds placeholder HTML file

### 4. PyO3 Version Updates

**Issue:** Need to update Cargo dependencies for Python 3.13

**Solution:** Script automatically:
- Checks PyO3 version in Cargo.toml
- Runs `cargo update pyo3 pyo3-ffi` if needed

---

## Manual Environment Setup

If you prefer not to use the script:

### macOS / Linux
```bash
export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1
export PYTHON_SYS_EXECUTABLE=$(which python3)
export RUST_BACKTRACE=1

cd apps/desktop
pnpm install
pnpm dev
```

### Windows (PowerShell)
```powershell
$env:PYO3_USE_ABI3_FORWARD_COMPATIBILITY = "1"
$env:PYTHON_SYS_EXECUTABLE = (Get-Command python).Source
$env:RUST_BACKTRACE = "1"

cd apps\desktop
pnpm install
pnpm dev
```

---

## Troubleshooting

### Error: Python version too new
```
error: the configured Python interpreter version (3.13) is newer than PyO3's maximum supported version
```

**Fix:** Run the script - it handles this automatically  
Or manually: `export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1`

### Error: Python not found
```
error: Could not find Python
```

**Fix:** 
1. Install Python 3.10-3.13
2. Make sure `python3` (Unix) or `python` (Windows) is in PATH
3. Run the script - it will set the path

### Error: Missing Python headers
```
error: could not find Python.h
```

**Fix:**
- **Ubuntu/Debian:** `sudo apt-get install python3-dev`
- **RHEL/CentOS:** `sudo yum install python3-devel`
- **macOS:** Already included with Python
- **Windows:** Reinstall Python, check "Install development files"

### Error: Cargo build fails
```
error: failed to run custom build command for `pyo3-ffi`
```

**Fix:** Update PyO3
```bash
cd apps/desktop/src-tauri
cargo update pyo3 pyo3-ffi
```

Or run the script - it handles this automatically.

### Script permission denied (macOS/Linux)
```
Permission denied: ./run-dev.sh
```

**Fix:**
```bash
chmod +x run-dev.sh
./run-dev.sh
```

---

## Project Structure

```
ai-voice/
├── run-dev.sh              # Development script (Unix)
├── run-dev.ps1             # Development script (Windows)
├── PYO3_MIGRATION.md       # PyO3 migration details
├── apps/
│   └── desktop/
│       ├── src/            # React/TypeScript source
│       ├── src-tauri/      # Rust/Tauri backend
│       │   ├── src/
│       │   │   ├── lib.rs
│       │   │   ├── ml_model_bridge.rs
│       │   │   └── python.rs
│       │   └── Cargo.toml  # Rust dependencies
│       ├── dist/           # Build output (auto-created)
│       └── package.json
└── ...
```

---

## Development Workflow

### 1. First Time Setup
```bash
# Clone and navigate
cd products/shared-services/ai-voice

# Run the script - it handles everything
./run-dev.sh check  # Verify system
./run-dev.sh       # Start dev server
```

### 2. Daily Development
```bash
# Just run the script
./run-dev.sh

# App opens automatically
# Hot reload enabled
# Press Ctrl+C to stop
```

### 3. Production Build
```bash
# Build with script
./run-dev.sh build

# Binaries in:
# apps/desktop/src-tauri/target/release/bundle/
```

---

## Supported Platforms

| Platform | Status | Notes |
|----------|--------|-------|
| macOS (Intel) | ✅ Supported | Tested |
| macOS (Apple Silicon) | ✅ Supported | Tested |
| Linux (Ubuntu/Debian) | ✅ Supported | Requires python3-dev |
| Linux (RHEL/CentOS) | ✅ Supported | Requires python3-devel |
| Windows 10/11 | ✅ Supported | Tested |

---

## Environment Variables Reference

| Variable | Purpose | Auto-Set by Script |
|----------|---------|-------------------|
| `PYO3_USE_ABI3_FORWARD_COMPATIBILITY` | Enable Python 3.13 support | ✅ Yes |
| `PYTHON_SYS_EXECUTABLE` | Python path for PyO3 | ✅ Yes |
| `RUST_BACKTRACE` | Better error messages | ✅ Yes |
| `PYO3_CROSS_LIB_DIR` | Cross-compilation | ❌ Manual |
| `PYO3_CROSS_PYTHON_VERSION` | Cross-compilation | ❌ Manual |

---

## Additional Resources

- **PyO3 Migration Guide:** See [PYO3_MIGRATION.md](./PYO3_MIGRATION.md)
- **Tauri Documentation:** https://tauri.app/
- **PyO3 Documentation:** https://pyo3.rs/
- **Project Main Docs:** See [README.md](../../README.md)

---

## Getting Help

If you encounter issues:

1. **Run system check:** `./run-dev.sh check`
2. **Check logs:** Look for error messages in terminal
3. **Verify prerequisites:** All required tools installed?
4. **Check Python version:** `python3 --version`
5. **Check PyO3 version:** Look in `apps/desktop/src-tauri/Cargo.toml`

---

## Contributing

When contributing:

1. ✅ Always use the `run-dev.sh` script
2. ✅ Test on your platform before submitting
3. ✅ Update this README if adding new dependencies
4. ✅ Keep the script updated with any new build requirements

---

**Happy Coding!** 🎙️

