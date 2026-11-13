#!/usr/bin/env python3
"""Self-contained Increment-3 execution preflight.

The strict gate must distinguish an unavailable execution environment from a
provider or evaluation failure. This probe never installs packages, downloads
models, or mutates the repository.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import platform
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".models"

REQUIRED_MODULES = {
    "pytest": "pytest",
    "pytest_asyncio": "pytest-asyncio",
    "yaml": "pyyaml",
    "PIL": "pillow",
    "numpy": "numpy",
    "psutil": "psutil",
    "docling": "docling",
    "paddleocr": "paddleocr",
    "paddle": "paddlepaddle",
    "gliner": "gliner",
    "transformers": "transformers",
    "sentence_transformers": "sentence-transformers",
}


def check_module(module_name: str, distribution: str) -> dict[str, object]:
    try:
        importlib.import_module(module_name)
        version = importlib.metadata.version(distribution)
        return {"name": distribution, "status": "PASS", "version": version}
    except (ImportError, importlib.metadata.PackageNotFoundError) as error:
        return {"name": distribution, "status": "FAIL", "detail": str(error)}


def model_checks() -> list[dict[str, object]]:
    if not MODEL_ROOT.is_dir():
        return [{"name": "modelAssets", "status": "FAIL", "detail": str(MODEL_ROOT)}]
    checks: list[dict[str, object]] = []
    for directory in sorted(MODEL_ROOT.iterdir()):
        if not directory.is_dir() or directory.name == "tesseract-runtime":
            continue
        marker = directory / ".artifact.sha256"
        payload = any(
            path.is_file()
            for path in directory.rglob("*")
            if path.name not in {".artifact.sha256", "PROVISIONING_REQUIRED"}
        )
        checks.append({
            "name": directory.name,
            "status": "PASS" if marker.is_file() and payload and not (directory / "PROVISIONING_REQUIRED").exists() else "FAIL",
            "marker": marker.is_file(),
            "payload": payload,
        })
    return checks or [{"name": "modelAssets", "status": "FAIL", "detail": "no provisioned model directories"}]


def run() -> dict[str, object]:
    checks: list[dict[str, object]] = [
        {
            "name": "python",
            "status": "PASS" if sys.version_info >= (3, 10) else "FAIL",
            "version": platform.python_version(),
            "executable": sys.executable,
        },
        {"name": "modelAssetRoot", "status": "PASS" if MODEL_ROOT.is_dir() else "FAIL", "path": str(MODEL_ROOT)},
    ]
    checks.extend(check_module(module, distribution) for module, distribution in REQUIRED_MODULES.items())
    checks.extend(model_checks())
    owned_python = ROOT / ".venv" / "bin" / "python"
    uv_path = shutil.which("uv")
    checks.append({
        "name": "executionBootstrap",
        "status": "PASS" if owned_python.is_file() or uv_path else "FAIL",
        "ownedPython": str(owned_python) if owned_python.is_file() else None,
        "uv": uv_path,
    })
    status = "READY" if all(check.get("status") == "PASS" for check in checks) else "ENVIRONMENT_NOT_READY"
    return {
        "schemaVersion": "document-intelligence.increment3.preflight.v1",
        "status": status,
        "python": sys.version,
        "executable": sys.executable,
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="emit the machine-readable preflight payload")
    parser.parse_args()
    payload = run()
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["status"] == "READY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
