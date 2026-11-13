#!/usr/bin/env python3
"""Provision the pinned Increment-4A office-renderer font assets.

The DOCX remediation renderer (reportlab) needs a real Latin font and a real
Devanagari font — neither family covers the other's script, so both must be
provisioned to render mixed-script documents truthfully.  This script copies
the pinned, hash-verified font binaries from the host font installation into
``.models/office-renderer/fonts`` and records the tree digest in
``.artifact.sha256`` — the value declared in the model manifest.  No network
access and no system package installation are required; a missing or tampered
source font fails closed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR_NAME = "office-renderer"

# Pinned host font binaries: asset name -> (source path, sha256 of the file).
PINNED_FONTS = {
    "DejaVuSans.ttf": (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280",
    ),
    "NotoSansDevanagari-Regular.ttf": (
        "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
        "79a470365ccb210fa3c7d8d8ff2e005ef9d983cfd067f735a0caf7e15070ca9f",
    ),
}


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file() and item.name != ".artifact.sha256"):
        digest.update(str(path.relative_to(root)).encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def provision(cache_root: Path) -> Path:
    target = cache_root / ASSET_DIR_NAME
    staging = target.with_name(f"{target.name}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    fonts_dir = staging / "fonts"
    fonts_dir.mkdir(parents=True)
    try:
        for name, (source, expected) in PINNED_FONTS.items():
            origin = Path(source)
            if not origin.is_file():
                raise SystemExit(f"pinned font source missing: {source}")
            actual = _sha256(origin)
            if actual != expected:
                raise SystemExit(f"sha256 mismatch for {source}: {actual} != {expected}")
            shutil.copyfile(origin, fonts_dir / name)
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


def font_dir(root: Path) -> Path:
    return root / "fonts"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-root", type=Path, default=Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(ROOT / ".models"))))
    parser.add_argument("--check", action="store_true", help="verify the provisioned assets only")
    args = parser.parse_args()
    target = args.cache_root / ASSET_DIR_NAME
    if args.check:
        if not verify(target):
            print(json.dumps({"ok": False, "status": "not provisioned or digest mismatch"}))
            return 1
        print(json.dumps({"ok": True, "status": "verified"}))
        return 0
    target = provision(args.cache_root)
    if not verify(target):
        print(json.dumps({"ok": False, "status": "post-provision verification failed"}))
        return 1
    print(json.dumps({"ok": True, "status": "provisioned", "path": str(target), "fonts": sorted(PINNED_FONTS)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
