# PyO3 0.22 Migration Fix Summary

## Issue Fixed
Updated PyO3 from 0.21 to 0.22 to support Python 3.13

## Changes Required

### 1. ✅ DONE - Cargo.toml
- Updated `pyo3 = "0.22"` in Cargo.toml
- Ran `cargo update pyo3 pyo3-ffi`

### 2. ✅ DONE - API Method Renames
- `py.import()` → `py.import_bound()`
- `PyDict::new()` → `PyDict::new_bound()`
- `py.run()` → `py.run_bound()`
- `PyModule::from_code()` → `PyModule::from_code_bound()`

### 3. ✅ DONE - Module Imports
- Fixed module resolution in ml_integration_commands.rs
- Added proper `crate::` prefixes

### 4. 🔧 IN PROGRESS - Bound<T> API Changes
The biggest change in PyO3 0.22 is that many methods now return `Bound<T>` instead of `&PyAny`.

**Old API (0.21):**
```rust
dict.get_item("key")  // Returns Option<&PyAny>
    .and_then(|v| v.extract().ok())
```

**New API (0.22):**
```rust
dict.get_item("key").ok()  // Returns Option<Bound<PyAny>>
    .and_then(|v| v.extract().ok())
```

### Files Needing Bound<T> Fixes:
- `src/python.rs` - Multiple extract/downcast calls
- `src/ml_model_bridge.rs` - PyModule interaction

## Quick Fix for Python 3.13

**Option 1: Use Forward Compatibility Flag (Temporary)**
```bash
export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1
pnpm tauri build
```

**Option 2: Complete Migration (Recommended)**
- Update all `get_item()` calls to handle `Result<Option<Bound<T>>>`
- Update all `.extract()` and `.downcast()` calls for new API

## Status
- ✅ Dependency updated to 0.22
- ✅ Basic API renames complete
- 🔧 Bound<T> API migration in progress

## Recommendation
Use Option 1 (forward compatibility flag) for immediate build success, then complete Option 2 for proper migration.

---

## Build Nuances & Requirements

### Python Version Compatibility
- **Required:** Python 3.10, 3.11, 3.12, or 3.13
- **PyO3 0.22:** Supports Python 3.10-3.13
- **Issue:** If you have Python 3.13, must use PyO3 0.22+ or set forward compatibility flag

### Environment Variables for Build

**Required for Python 3.13:**
```bash
export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1
```

**Optional - Python Path (if not in system PATH):**
```bash
export PYTHON_SYS_EXECUTABLE=/path/to/python3
```

**Optional - Cross-compilation:**
```bash
export PYO3_CROSS_LIB_DIR=/path/to/python/lib
export PYO3_CROSS_PYTHON_VERSION=3.13
```

### Platform-Specific Requirements

#### macOS
```bash
# Install Python if needed
brew install python@3.13

# May need to set Python path
export PYTHON_SYS_EXECUTABLE=$(which python3)

# Build with compatibility flag
PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1 pnpm tauri build
```

#### Linux
```bash
# Install Python development headers
sudo apt-get install python3-dev  # Debian/Ubuntu
sudo yum install python3-devel     # RHEL/CentOS

# Build with compatibility flag
PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1 pnpm tauri build
```

#### Windows
```powershell
# Install Python from python.org

# Set environment variable
$env:PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1

# Build
pnpm tauri build
```

### Common Build Issues

**Issue 1: Python version too new**
```
error: the configured Python interpreter version (3.13) is newer than PyO3's maximum supported version
```
**Fix:** Set `PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1`

**Issue 2: Python not found**
```
error: Could not find Python
```
**Fix:** Install Python or set `PYTHON_SYS_EXECUTABLE`

**Issue 3: Missing Python headers**
```
error: could not find Python.h
```
**Fix:** Install python3-dev/python3-devel package

**Issue 4: Cargo build fails with PyO3 errors**
```
error: failed to run custom build command for `pyo3-ffi`
```
**Fix:** Update to PyO3 0.22+ with `cargo update pyo3 pyo3-ffi`

### Development Workflow

**Initial Setup:**
```bash
cd products/shared-services/ai-voice/apps/desktop

# Install dependencies
pnpm install

# Update Rust dependencies
cd src-tauri
cargo update pyo3 pyo3-ffi
cd ..
```

**Development Mode:**
```bash
# Set environment variable
export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1

# Run dev server
pnpm dev
```

**Production Build:**
```bash
# Set environment variable
export PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1

# Build for production
pnpm tauri build
```

### Automated Script
See `run-dev.sh` for automated setup that handles all these nuances.

