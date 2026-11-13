#!/usr/bin/env python3
"""Explicit Increment-4A freeze operation.

Freezes acceptance/environment state, refreshes every recorded authority
fingerprint from the current files, and writes the authoritative
``material-lock.json``.  The freeze is a deliberate, auditable step — it is
never implied by a passing test run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
LANE = ROOT / "evaluation/increment4a"
LOCK_PATH = LANE / "material-lock.json"
LOCK_ARCHIVE = LANE / "material-locks"
LOCK_SCHEMA = "increment4a.material-lock.v4"
sys.path.insert(0, str(LANE))
from implementation_material import implementation_fingerprints  # noqa: E402

DEFAULT_REASONS = [
    "PPTX_NOTE_SEMANTIC_CORRECTION",
    "PROMOTED_RUNTIME_BINDING",
    "CAPABILITY_CLOSURE_RECONCILIATION",
    "HYBRID_LANGUAGE_DIMENSIONS",
    "DOCX_RENDER_ASSET_PINNING",
    "HI_MR_SCHEMA_GUIDED_EXTRACTION_DEFERRED_TO_FUTURE_RELEASE",
]

FROZEN_MATERIAL = {
    "manifest": LANE / "manifest.yaml",
    "acceptance": LANE / "acceptance.yaml",
    "environment": LANE / "environment.yaml",
    "corpus": LANE / "corpus",
    "runtimeCalibration": LANE / "calibration/runtime-latency.json",
    "requiredTests": LANE / "required-tests.yaml",
    "implementationMaterial": LANE / "implementation-material.yaml",
    "modelManifest": ROOT / "models/increment4a/model-manifest.yaml",
    "languageRegistry": ROOT / "models/increment4a/language-registry.yaml",
    "hybridRouting": ROOT / "routing/hybrid-pdf.v1.yaml",
    "parserRouting": ROOT / "routing/parser-routing.v1.yaml",
    "workerProfile": ROOT / "profiles/increment4a.yaml",
}

AUTHORITY_FILES = {
    "modelManifestSha256": ROOT / "models/increment4a/model-manifest.yaml",
    "increment3ModelManifestSha256": ROOT / "models/model-manifest.yaml",
    "increment3AcceptanceSha256": ROOT / "evaluation/acceptance.yaml",
    "increment3EnvironmentSha256": ROOT / "evaluation/environment.yaml",
    "increment3CorpusManifestSha256": ROOT / "evaluation/manifest.yaml",
    "increment4aQualificationSha256": LANE / "qualification.yaml",
    "increment4aAcceptanceSha256": LANE / "acceptance.yaml",
    "increment4aLanguageRegistrySha256": ROOT / "models/increment4a/language-registry.yaml",
    "uvLockSha256": ROOT / "uv.lock",
    "pyprojectSha256": ROOT / "pyproject.toml",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def material_sha256(path: Path) -> str:
    if not path.exists():
        return "MISSING"
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    elif path.is_dir():
        for child in sorted(item for item in path.rglob("*") if item.is_file() and "__pycache__" not in item.parts and ".pytest_cache" not in item.parts):
            digest.update(str(child.relative_to(path)).encode())
            digest.update(child.read_bytes())
    return digest.hexdigest()


def _runtime_snapshot() -> dict:
    """Reuse the model verifier's snapshot so fingerprints agree exactly."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("verify_models", ROOT / "scripts/verify_models.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    packages = yaml.safe_load((ROOT / "models/increment4a/model-manifest.yaml").read_text())["runtime"]["packages"]
    actual, _ = module._runtime_snapshot(sorted(packages))
    return actual


def _archive_existing_lock(parent_material_fingerprint: str) -> Path | None:
    """Move the superseded lock aside under its canonical material identity."""
    if not LOCK_PATH.is_file():
        return None
    if not parent_material_fingerprint:
        raise ValueError("an existing material lock requires --parent-material-fingerprint")
    LOCK_ARCHIVE.mkdir(parents=True, exist_ok=True)
    target = LOCK_ARCHIVE / f"{parent_material_fingerprint}.json"
    target.write_bytes(LOCK_PATH.read_bytes())
    return target


def freeze(parent_material_fingerprint: str | None, reasons: list[str]) -> dict:
    environment_path = LANE / "environment.yaml"
    acceptance_path = LANE / "acceptance.yaml"

    acceptance = yaml.safe_load(acceptance_path.read_text())
    acceptance["state"] = "FROZEN"
    acceptance_path.write_text(yaml.safe_dump(acceptance, sort_keys=False, allow_unicode=True))

    manifest_doc = yaml.safe_load((LANE / "manifest.yaml").read_text())
    manifest_doc["state"] = "FROZEN"
    (LANE / "manifest.yaml").write_text(yaml.safe_dump(manifest_doc, sort_keys=False, allow_unicode=True))

    environment = yaml.safe_load(environment_path.read_text())
    environment["state"] = "FROZEN"
    manifest_path = ROOT / "models/increment4a/model-manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())
    manifest_authority = manifest.setdefault("authority", {})
    manifest_authority["state"] = "FROZEN"
    inherited = manifest_authority.setdefault("inheritedIncrement3", {})
    inherited["modelManifest"] = "models/model-manifest.yaml"
    inherited["modelManifestSha256"] = sha256(ROOT / "models/model-manifest.yaml")
    internal_fingerprints = manifest_authority.setdefault("fingerprints", {})
    for name, path in {
        "qualificationSha256": LANE / "qualification.yaml",
        "acceptanceSha256": LANE / "acceptance.yaml",
        "languageRegistrySha256": ROOT / "models/increment4a/language-registry.yaml",
        "uvLockSha256": ROOT / "uv.lock",
        "pyprojectSha256": ROOT / "pyproject.toml",
    }.items():
        internal_fingerprints[name] = sha256(path)
    uv_lock_sha256 = sha256(ROOT / "uv.lock")
    runtime_packages = manifest["runtime"]["packages"]
    manifest["runtime"]["uvLockSha256"] = uv_lock_sha256
    snapshot = _runtime_snapshot()
    manifest["runtime"]["packagesFingerprint"] = snapshot["packagesFingerprint"]
    manifest["runtime"]["pythonVersion"] = snapshot["pythonVersion"]
    manifest["runtime"]["uvVersion"] = snapshot["uvVersion"]
    manifest["runtime"]["platformFingerprint"] = snapshot["platformFingerprint"]
    manifest["runtime"]["hardwareFingerprint"] = snapshot["hardwareFingerprint"]
    manifest["runtime"]["platform"] = snapshot["platform"]
    manifest["runtime"]["hardware"] = snapshot["hardware"]
    manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True))
    profile_path = ROOT / "profiles/increment4a.yaml"
    profile = yaml.safe_load(profile_path.read_text())
    profile["modelManifestSha256"] = sha256(manifest_path)
    profile_path.write_text(yaml.safe_dump(profile, sort_keys=False, allow_unicode=True))
    environment["runtime"]["packages"] = dict(sorted(runtime_packages.items()))
    environment["runtime"]["packagesFingerprint"] = snapshot["packagesFingerprint"]
    environment["runtime"]["uvLockSha256"] = uv_lock_sha256
    authority = environment.get("authorityFingerprints", {})
    for key, path in AUTHORITY_FILES.items():
        authority[key] = sha256(path)
    environment["authorityFingerprints"] = authority
    environment_path.write_text(yaml.safe_dump(environment, sort_keys=False, allow_unicode=True))

    _archive_existing_lock(parent_material_fingerprint or "")
    lock = {
        "schemaVersion": LOCK_SCHEMA,
        "state": "FROZEN",
        "parentMaterialFingerprint": parent_material_fingerprint,
        "reason": reasons,
        "frozenAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "materialFingerprints": {name: material_sha256(path) for name, path in FROZEN_MATERIAL.items()},
        **implementation_fingerprints(ROOT),
    }
    LOCK_PATH.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
    return lock


def verify_lock() -> bool:
    if not LOCK_PATH.is_file():
        return False
    try:
        lock = json.loads(LOCK_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if lock.get("state") != "FROZEN" or lock.get("schemaVersion") != LOCK_SCHEMA:
        return False
    return (
        lock.get("materialFingerprints") == {name: material_sha256(path) for name, path in FROZEN_MATERIAL.items()}
        and {key: lock.get(key) for key in implementation_fingerprints(ROOT)} == implementation_fingerprints(ROOT)
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify material-lock.json matches live material")
    parser.add_argument("--parent-material-fingerprint", default=None, help="canonical material fingerprint of the superseded lock; required when a lock already exists")
    parser.add_argument("--reason", action="append", dest="reasons", default=None, help="freeze reason code; repeatable")
    args = parser.parse_args()
    if args.check:
        ok = verify_lock()
        print(json.dumps({"materialLock": "PASS" if ok else "FAIL"}))
        return 0 if ok else 1
    lock = freeze(args.parent_material_fingerprint, args.reasons or list(DEFAULT_REASONS))
    print(json.dumps({"state": lock["state"], "frozenAt": lock["frozenAt"], "materialFingerprints": lock["materialFingerprints"]}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
