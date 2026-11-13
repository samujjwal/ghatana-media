#!/usr/bin/env python3
"""Native/runtime dependency identity supplement for the freeze program.

``evaluation/increment4a/environment.yaml`` pins the Python package set, but
wheel-bundled native libraries (for example ``pypdfium2_raw/libpdfium.so``)
and system executables (Tesseract OCR) carry behavior the package version
alone does not capture.  This supplement records their identities so native
drift invalidates provider-bound evidence instead of escaping detection.

Default mode writes ``docs/evidence/native-runtime-supplement.v1.json``.
``--check`` is read-only and reports STALE when any recorded identity no
longer matches the live runtime.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / "docs/evidence"
SUPPLEMENT_PATH = EVIDENCE_DIR / "native-runtime-supplement.v1.json"
SUPPLEMENT_SCHEMA = "document-intelligence.native-runtime-supplement.v1"
VENV_SITE = ROOT / ".venv/lib/python3.12/site-packages"

NATIVE_WHEEL_LIBS = {
    "pypdfium2": VENV_SITE / "pypdfium2_raw/libpdfium.so",
}

SYSTEM_EXECUTABLES = ("tesseract",)


def _sha256_file(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _tool_version(command: list[str]) -> str:
    try:
        result = subprocess.run(command, text=True, capture_output=True, check=False)
    except OSError:
        return "MISSING"
    return (result.stdout.strip() or result.stderr.strip() or "MISSING").splitlines()[0]


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "MISSING"


def collect() -> dict[str, object]:
    identities: dict[str, object] = {
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable,
        },
        "uv": {"version": _tool_version(["uv", "--version"]).split()[-1]},
    }
    for package, lib_path in NATIVE_WHEEL_LIBS.items():
        identities[package] = {
            "packageVersion": _package_version(package),
            "sharedLibraryPath": str(lib_path.relative_to(ROOT)) if lib_path.is_file() else None,
            "sharedLibrarySha256": _sha256_file(lib_path),
        }
    for name in SYSTEM_EXECUTABLES:
        binary = shutil.which(name)
        identities[name] = {
            "executablePath": binary,
            "executableSha256": _sha256_file(Path(binary)) if binary else None,
            "version": _tool_version([name, "--version"]) if binary else "MISSING",
        }
    return identities


def build() -> dict[str, object]:
    return {
        "schemaVersion": SUPPLEMENT_SCHEMA,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "identities": collect(),
        "invalidationContract": (
            "Any change to a recorded native/runtime identity marks this supplement "
            "STALE under --check and routes back through the affected provider-bound "
            "leaves; it never auto-repairs frozen evidence."
        ),
    }


def check() -> dict[str, object]:
    if not SUPPLEMENT_PATH.is_file():
        return {"nativeRuntimeSupplement": "FAIL", "reason": "SUPPLEMENT_MISSING"}
    try:
        recorded = json.loads(SUPPLEMENT_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"nativeRuntimeSupplement": "FAIL", "reason": f"INVALID_JSON:{exc}"}
    if recorded.get("schemaVersion") != SUPPLEMENT_SCHEMA:
        return {"nativeRuntimeSupplement": "FAIL", "reason": "SCHEMA_MISMATCH"}
    current = collect()
    recorded_identities = recorded.get("identities") or {}
    stale: list[str] = []
    for name, identity in current.items():
        if recorded_identities.get(name) != identity:
            stale.append(name)
    return {
        "nativeRuntimeSupplement": "FAIL" if stale else "PASS",
        "staleIdentities": stale,
        "disposition": "STALE_ROUTE_BACK_TO_AFFECTED_LEAVES" if stale else "CURRENT",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read-only verification; writes nothing")
    args = parser.parse_args()
    if args.check:
        result = check()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["nativeRuntimeSupplement"] == "PASS" else 2
    supplement = build()
    SUPPLEMENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(supplement, indent=2, sort_keys=True) + "\n"
    unchanged = SUPPLEMENT_PATH.exists() and SUPPLEMENT_PATH.read_text(encoding="utf-8") == text
    if not unchanged:
        tmp = SUPPLEMENT_PATH.with_name(SUPPLEMENT_PATH.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(SUPPLEMENT_PATH)
    print(json.dumps({"nativeRuntimeSupplement": "DECLARED", "path": str(SUPPLEMENT_PATH), "written": not unchanged}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
