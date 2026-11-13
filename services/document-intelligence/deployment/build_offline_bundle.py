#!/usr/bin/env python3
"""Resolve deployment/offline-bundle.v1.yaml into a verified bundle manifest (I6-28).

Every asset declared in the descriptor is resolved against its named source
manifest (``models/model-manifest.yaml`` / ``models/increment4a/model-manifest.yaml``):

- the descriptor ``sha256`` must equal the manifest-declared ``artifactSha256``
  (or the selected sub-record sha for ``ref:selector`` entries);
- ``cachePath`` directories are re-digested with the canonical asset tree
  digest (sorted relative paths + file bytes, excluding ``PROVISIONING_REQUIRED``
  and ``.artifact.sha256`` markers — the same convention verify_models.py uses);
- ``path`` entries are single files verified by content sha256;
- ``pythonRuntime.uvLockSha256`` is verified against the real ``uv.lock`` and
  ``pythonRuntime.version`` against the running interpreter;
- every ``applicationSources`` path is digested as sorted
  (root-relative path, content sha256) pairs;
- every ``policyRefs`` file is sha256'd.

The result is written atomically (tmp + rename) to
``deployment/sbom/offline-bundle-manifest.v1.json`` with a
``manifestFingerprint`` computed over the document with that field omitted —
the same omitted-field convention as run-publication manifests.

Fails closed: any unresolved ref, declared-digest mismatch, missing file, or
content drift is a hard FAIL (exit 2). ``--check`` is read-only: it re-resolves
the descriptor and compares with the recorded manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "evaluation"))

from campaign_guards import digest as _canonical_digest  # noqa: E402

MANIFEST_SCHEMA = "document-intelligence.offline-bundle-manifest.v1"
DESCRIPTOR_SCHEMA = "document-intelligence.offline-bundle.v1"
SKIP_NAMES = {"PROVISIONING_REQUIRED", ".artifact.sha256"}
SKIP_PARTS = {"__pycache__", ".pytest_cache"}


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _asset_tree_digest(root: Path) -> str:
    """Canonical artifact-tree digest (verify_models.py convention)."""
    hasher = hashlib.sha256()
    for item in sorted(
        p for p in root.rglob("*") if p.is_file() and p.name not in SKIP_NAMES
    ):
        hasher.update(str(item.relative_to(root)).encode("utf-8"))
        hasher.update(item.read_bytes())
    return hasher.hexdigest()


def _source_set(root: Path, rel: str) -> tuple[str, int]:
    """Digest a file or directory as sorted (rel-path, sha256) pairs."""
    base = root / rel
    if base.is_file():
        files = [base]
    elif base.is_dir():
        files = sorted(
            p
            for p in base.rglob("*")
            if p.is_file() and not (SKIP_PARTS & set(p.parts))
        )
    else:
        raise FileNotFoundError(rel)
    pairs = [[str(p.relative_to(root)), _sha256_file(p)] for p in files]
    return _canonical_digest(pairs), len(files)


def _load_manifest(root: Path, rel: str) -> dict:
    path = root / rel
    if not path.is_file():
        raise FileNotFoundError(f"source manifest missing: {rel}")
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _iter_manifest_entries(manifest: dict):
    for entry in manifest.get("artifacts", []) or []:
        if isinstance(entry, dict):
            yield entry
    for entry in manifest.get("models", []) or []:
        if isinstance(entry, dict):
            yield entry


def _entry_refs(entry: dict) -> set[str]:
    refs = set()
    for key in ("artifactId", "cacheKey"):
        if entry.get(key):
            refs.add(str(entry[key]))
    provider = entry.get("providerRef")
    model = entry.get("modelRef")
    revision = entry.get("modelRevision") or entry.get("modelVersion")
    if provider and model and revision:
        refs.add(f"{provider}/{model}@{revision}")
    return refs


def _select_sha(entry: dict, selector: str | None) -> str | None:
    if selector is None:
        return entry.get("artifactSha256")
    if selector == "executable":
        exe = entry.get("executable") or {}
        return exe.get("sha256")
    if selector.startswith("traineddata."):
        lang = selector.split(".", 1)[1]
        record = (entry.get("traineddata") or {}).get(lang) or {}
        return record.get("sha256")
    if selector.startswith("fontAssets."):
        role = selector.split(".", 1)[1]
        record = (entry.get("fontAssets") or {}).get(role) or {}
        return record.get("sha256")
    return None


def _resolve_asset(root: Path, asset: dict, manifests: dict[str, dict]) -> dict:
    ref = asset.get("ref")
    declared = asset.get("sha256")
    source = asset.get("source")
    if not ref or not declared or not source:
        raise ValueError(f"asset entry incomplete (needs ref/sha256/source): {asset}")
    base_ref, _, selector = ref.partition(":")
    manifest = manifests[source]
    matched = None
    for entry in _iter_manifest_entries(manifest):
        if base_ref in _entry_refs(entry):
            matched = entry
            break
    if matched is None:
        raise ValueError(f"unresolved asset ref {base_ref!r} in {source}")
    manifest_sha = _select_sha(matched, selector or None)
    if not manifest_sha:
        raise ValueError(f"no declared digest for {ref!r} in {source}")
    if manifest_sha != declared:
        raise ValueError(
            f"declared digest mismatch for {ref!r}: descriptor={declared} manifest={manifest_sha}"
        )

    resolved = {
        "ref": ref,
        "sha256": declared,
        "source": source,
        "status": "VERIFIED",
    }
    if asset.get("kind"):
        resolved["kind"] = asset["kind"]

    cache_path = asset.get("cachePath")
    file_path = asset.get("path")
    if cache_path and file_path:
        raise ValueError(f"asset {ref!r} may not declare both cachePath and path")
    if cache_path:
        target = root / cache_path
        if not target.is_dir():
            raise ValueError(f"corrupt/missing asset tree for {ref!r}: {cache_path}")
        actual = _asset_tree_digest(target)
        if actual != declared:
            raise ValueError(
                f"corrupt asset tree for {ref!r}: {cache_path} digest={actual}"
            )
        resolved["cachePath"] = cache_path
        resolved["verifiedDigest"] = actual
    if file_path:
        target = root / file_path
        if not target.is_file():
            raise ValueError(f"missing asset file for {ref!r}: {file_path}")
        actual = _sha256_file(target)
        if actual != declared:
            raise ValueError(
                f"corrupt asset file for {ref!r}: {file_path} digest={actual}"
            )
        resolved["path"] = file_path
        resolved["verifiedDigest"] = actual
    return resolved


def resolve(root: Path, descriptor_path: Path) -> dict:
    descriptor = yaml.safe_load(descriptor_path.read_text(encoding="utf-8"))
    if not isinstance(descriptor, dict):
        raise ValueError("descriptor is not a mapping")
    if descriptor.get("schemaVersion") != DESCRIPTOR_SCHEMA:
        raise ValueError(f"descriptor schemaVersion must be {DESCRIPTOR_SCHEMA}")

    sources = {
        str(a.get("source"))
        for a in (descriptor.get("modelAssets") or [])
        + (descriptor.get("nativeAssets") or [])
        if isinstance(a, dict) and a.get("source")
    }
    manifests = {src: _load_manifest(root, src) for src in sorted(sources)}

    resolved_models = [
        _resolve_asset(root, a, manifests)
        for a in descriptor.get("modelAssets") or []
    ]
    resolved_native = [
        _resolve_asset(root, a, manifests)
        for a in descriptor.get("nativeAssets") or []
    ]

    runtime = descriptor.get("pythonRuntime") or {}
    uv_lock = root / "uv.lock"
    if not uv_lock.is_file():
        raise ValueError("uv.lock missing — pythonRuntime cannot be verified")
    uv_sha = _sha256_file(uv_lock)
    if runtime.get("uvLockSha256") != uv_sha:
        raise ValueError(
            f"uv.lock drift: descriptor={runtime.get('uvLockSha256')} actual={uv_sha}"
        )
    declared_version = str(runtime.get("version") or "")
    actual_version = platform.python_version()
    if declared_version and declared_version != actual_version:
        raise ValueError(
            f"python version mismatch: descriptor={declared_version} actual={actual_version}"
        )
    python_runtime = {
        "version": actual_version,
        "uvLockSha256": uv_sha,
        "status": "VERIFIED",
    }

    app_sources: dict[str, dict] = {}
    for rel in descriptor.get("applicationSources") or []:
        digest_hex, count = _source_set(root, rel)
        app_sources[rel] = {"digest": digest_hex, "fileCount": count}

    policy_refs: dict[str, str] = {}
    for rel in descriptor.get("policyRefs") or []:
        target = root / rel
        if not target.is_file():
            raise ValueError(f"policy ref missing: {rel}")
        policy_refs[rel] = f"sha256:{_sha256_file(target)}"

    manifest = {
        "schemaVersion": MANIFEST_SCHEMA,
        "bundleId": descriptor.get("bundleId"),
        "increment": descriptor.get("increment"),
        "networkMode": descriptor.get("networkMode", "offline"),
        "remoteFetchCount": descriptor.get("remoteFetchCount", 0),
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "descriptorSha256": f"sha256:{_sha256_file(descriptor_path)}",
        "modelAssets": resolved_models,
        "nativeAssets": resolved_native,
        "pythonRuntime": python_runtime,
        "applicationSources": app_sources,
        "policyRefs": policy_refs,
    }
    manifest["manifestFingerprint"] = _canonical_digest(
        {k: v for k, v in manifest.items() if k != "manifestFingerprint"}
    )
    return manifest


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _comparable(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k not in {"generatedAt", "manifestFingerprint"}}


def check(root: Path, descriptor_path: Path, output_path: Path) -> dict:
    errors: list[str] = []
    if not output_path.is_file():
        return {"offlineBundle": "FAIL", "errors": [f"manifest missing: {output_path}"]}
    try:
        stored = json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"offlineBundle": "FAIL", "errors": [f"manifest invalid json: {exc}"]}
    try:
        regenerated = resolve(root, descriptor_path)
    except (ValueError, FileNotFoundError) as exc:
        return {"offlineBundle": "FAIL", "errors": [f"re-resolution failed: {exc}"]}
    if _comparable(stored) != _comparable(regenerated):
        errors.append("recorded manifest does not match re-resolved descriptor")
    expected_fp = _canonical_digest(
        {k: v for k, v in stored.items() if k != "manifestFingerprint"}
    )
    if stored.get("manifestFingerprint") != expected_fp:
        errors.append("stored manifestFingerprint does not cover stored content")
    return {"offlineBundle": "FAIL" if errors else "PASS", "errors": errors}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--descriptor", type=Path, default=None,
        help="bundle descriptor (default: <root>/deployment/offline-bundle.v1.yaml)",
    )
    parser.add_argument(
        "--output", type=Path, default=None,
        help="manifest output (default: <root>/deployment/sbom/offline-bundle-manifest.v1.json)",
    )
    parser.add_argument("--check", action="store_true", help="read-only re-verification")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    descriptor = args.descriptor or root / "deployment/offline-bundle.v1.yaml"
    output = args.output or root / "deployment/sbom/offline-bundle-manifest.v1.json"

    if args.check:
        result = check(root, descriptor, output)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["offlineBundle"] == "PASS" else 2

    try:
        manifest = resolve(root, descriptor)
    except (ValueError, FileNotFoundError) as exc:
        print(json.dumps({"offlineBundle": "FAIL", "errors": [str(exc)]}, indent=2))
        return 2
    _atomic_write(output, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "offlineBundle": "DECLARED",
                "manifest": str(output),
                "manifestFingerprint": manifest["manifestFingerprint"],
                "modelAssets": len(manifest["modelAssets"]),
                "nativeAssets": len(manifest["nativeAssets"]),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
