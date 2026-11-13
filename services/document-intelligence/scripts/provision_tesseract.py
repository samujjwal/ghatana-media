#!/usr/bin/env python3
"""Deterministically provision the Increment-4A Tesseract runtime.

Downloads the exact pinned Ubuntu package versions via ``apt-get download``,
verifies each ``.deb`` against the recorded SHA-256 digest, and extracts the
payloads into ``.models/tesseract-runtime`` with ``dpkg -x`` — no sudo and no
system package installation.  The resulting tree digest is written to
``.artifact.sha256`` and is the value recorded in the model manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT / ".models" / "tesseract-runtime"

# Pinned Ubuntu 24.04 (noble) packages: name=version -> sha256 of the .deb.
PINNED_PACKAGES = {
    "liblept5=1.82.0-3build4": "c2bb81d58f032b09917c0d50994cce905287a1596304a4e99681a03601456ea8",
    "libtesseract5=5.3.4-1build5": "a38438115dc203b5abc1e6a6b24eb5273ba82161a11faa2f619bf5f7622efb14",
    "tesseract-ocr=5.3.4-1build5": "2dfac382d77215aee0c3de4a2a2205505d5f2195e72e79b54ad32154fc08da77",
    "tesseract-ocr-eng=1:4.1.0-2": "b1996b3113c78663f4dd16cf18aa1f288b07e9624f8d4a0ddbd7d9b52a234ba7",
    "tesseract-ocr-hin=1:4.1.0-2": "e981cbcdbc396e054e512659d7b91cbe1a717e0f2add5f99f574739319e4dc5b",
    "tesseract-ocr-mar=1:4.1.0-2": "f320c783bfc9bcba8d3730f68bffaba9b313a514a599f8b313071169f26780f5",
    "tesseract-ocr-nep=1:4.1.0-2": "5883941462c4026bd467b1baa090fd4be781e6ac39091268b3757c9e4ceef28b",
}

TESSERACT_VERSION = "5.3.4"
TESSDATA_VERSION = "4.1.0-2"


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file() and item.name != ".artifact.sha256"):
        digest.update(str(path.relative_to(root)).encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _download(spec: str, directory: Path) -> Path:
    result = subprocess.run(["apt-get", "download", spec], cwd=directory, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"apt-get download failed for {spec}: {result.stderr.strip()}")
    name, _, version = spec.partition("=")
    candidates = sorted(directory.glob(f"{name}_{version.replace(':', '%3a')}_*.deb"))
    if not candidates:
        candidates = sorted(directory.glob(f"{name}_*.deb"))
    if len(candidates) != 1:
        raise SystemExit(f"could not identify downloaded .deb for {spec}: {sorted(item.name for item in directory.glob('*.deb'))}")
    return candidates[0]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def provision(cache_root: Path) -> Path:
    target = cache_root / "tesseract-runtime"
    staging = target.with_name(f"{target.name}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        with tempfile.TemporaryDirectory(prefix="tesseract-debs-") as temp:
            directory = Path(temp)
            for spec, expected in PINNED_PACKAGES.items():
                package = _download(spec, directory)
                actual = _sha256(package)
                if actual != expected:
                    raise SystemExit(f"sha256 mismatch for {spec}: {actual} != {expected}")
                subprocess.run(["dpkg", "-x", str(package), str(staging)], check=True)
        digest = tree_digest(staging)
        (staging / ".artifact.sha256").write_text(digest + "\n")
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)
        return target
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def verify(target: Path) -> bool:
    marker = target / ".artifact.sha256"
    if not marker.is_file():
        return False
    return marker.read_text().strip() == tree_digest(target)


def executable(root: Path) -> Path:
    return root / "usr/bin/tesseract"


def tessdata(root: Path) -> Path:
    return root / "usr/share/tesseract-ocr/5/tessdata"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-root", type=Path, default=Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(ROOT / ".models"))))
    parser.add_argument("--check", action="store_true", help="verify the provisioned runtime only")
    args = parser.parse_args()
    target = args.cache_root / "tesseract-runtime"
    if args.check:
        if not verify(target):
            print(json_result(False, "not provisioned or digest mismatch"))
            return 1
        print(json_result(True, "verified"))
        return 0
    target = provision(args.cache_root)
    if not verify(target):
        print(json_result(False, "post-provision verification failed"))
        return 1
    print(json_result(True, "provisioned", target))
    return 0


def json_result(ok: bool, status: str, target: Path | None = None) -> str:
    import json
    payload = {"ok": ok, "status": status, "version": TESSERACT_VERSION, "tessdataVersion": TESSDATA_VERSION}
    if target is not None:
        payload["path"] = str(target)
    return json.dumps(payload)


if __name__ == "__main__":
    sys.exit(main())
