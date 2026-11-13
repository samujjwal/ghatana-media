#!/usr/bin/env python3
"""Validate the checked-in material scope definitions for the freeze program.

Each ``docs/evidence/increment*-material-scope.v1.json`` declares three
non-overlapping scopes:

- ``semanticMaterial`` — source code, configs, frozen acceptance policies, and
  manifests that affect runtime behavior.
- ``executionEnvironment`` — lockfiles, installed/runtime dependency
  identities, native binaries/models, runtime/profile configuration.
- ``evidenceAndStatus`` — receipts, campaign results, verification JSON,
  INCREMENT-* status documents, closure manifests.

Only A+B may invalidate behavioral evidence; C must never invalidate the
behavior it records.  This checker fails closed when:

- any include entry does not resolve to a real path (or runtime identity),
- the three scopes overlap,
- a file that feeds a bound semantic/environment fingerprint is not
  classified into A or B (unclassified fingerprint input), or
- a declared evidenceAndStatus path feeds a semantic fingerprint
  (self-invalidation risk).
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEVELOPMENTS = ROOT.parents[2]
GHARBATAI = DEVELOPMENTS / "gharbatai"
EVIDENCE_DIR = ROOT / "docs/evidence"

sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "evaluation"))
sys.path.insert(0, str(ROOT / "evaluation" / "increment4a"))

SCOPE_FILES = {
    "increment3": EVIDENCE_DIR / "increment3-material-scope.v1.json",
    "increment4": EVIDENCE_DIR / "increment4-material-scope.v1.json",
    "increment4a": EVIDENCE_DIR / "increment4a-material-scope.v1.json",
    "increment5": EVIDENCE_DIR / "increment5-material-scope.v1.json",
    "increment6": EVIDENCE_DIR / "increment6-material-scope.v1.json",
}

SCOPE_NAMES = ("semanticMaterial", "executionEnvironment", "evidenceAndStatus")


def _load_scopes() -> dict[str, dict]:
    scopes: dict[str, dict] = {}
    for increment, path in SCOPE_FILES.items():
        scopes[increment] = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    return scopes


def _entry_exists(entry: str) -> bool:
    if entry.startswith("runtime:"):
        return True
    if entry.startswith("worker:"):
        return (ROOT / entry[len("worker:"):]).exists()
    if " " in entry:
        return True  # descriptive runtime entries such as "products/org database (...)"
    return (GHARBATAI / entry).exists() or (ROOT / entry).exists()


def _expand_worker_paths(entries: list[str]) -> set[str]:
    files: set[str] = set()
    for entry in entries:
        if entry.startswith(("runtime:", "worker:")) or " " in entry or "*" in entry:
            continue
        path = ROOT / entry
        if path.is_file():
            files.add(entry)
        elif path.is_dir():
            for item in sorted(path.rglob("*")):
                if item.is_file() and "__pycache__" not in item.parts and ".pytest_cache" not in item.parts:
                    files.add(str(item.relative_to(ROOT)))
    return files


def _fingerprinted_worker_files() -> dict[str, set[str]]:
    """Files whose bytes feed a bound semantic/environment fingerprint."""
    import yaml  # noqa: PLC0415

    spec_path = ROOT / "evaluation/increment4a/implementation-material.yaml"
    spec = yaml.safe_load(spec_path.read_text(encoding="utf-8"))
    sets_ = spec.get("sourceSets") if isinstance(spec, dict) else {}
    semantic: set[str] = set()
    for entries in (sets_ or {}).values():
        semantic |= _expand_worker_paths(list(entries or []))
    semantic |= _expand_worker_paths(yaml_source_sets()["increment3_semantic"])
    environment: set[str] = set()
    for entry in (
        "uv.lock",
        "evaluation/environment.yaml",
        "evaluation/increment4a/environment.yaml",
        "models/model-manifest.yaml",
        "models/increment4a/model-manifest.yaml",
        "models/increment4a/language-registry.yaml",
    ):
        if (ROOT / entry).is_file():
            environment.add(entry)
    environment |= _expand_worker_paths(["profiles/", "routing/"])
    return {"semantic": semantic, "environment": environment}


def yaml_source_sets() -> dict[str, list[str]]:
    return {
        "increment3_semantic": [
            "src/document_intelligence/",
            "clients/typescript/",
            "contracts/",
            "evaluation/manifest.yaml",
            "evaluation/acceptance.yaml",
            "evaluation/corpus/",
            "evaluation/run_evaluation.py",
            "evaluation/metrics.py",
            "evaluation/generate_corpus.py",
            "tests/",
            "conftest.py",
            "pyproject.toml",
            "pytest.ini",
            "scripts/verify_increment3.py",
            "scripts/preflight_increment3.py",
            "scripts/verify_models.py",
        ],
    }


def _covers(includes: list[str], worker_file: str) -> bool:
    for entry in includes:
        if entry.startswith(("runtime:", "worker:")) or " " in entry:
            continue
        pattern = entry.rstrip("/")
        if worker_file == pattern or worker_file.startswith(pattern + "/"):
            return True
        if "*" in entry and fnmatch.fnmatch(worker_file, entry):
            return True
    return False


def _is_excluded(excludes: list[str], worker_file: str) -> bool:
    for entry in excludes:
        pattern = entry.rstrip("/")
        if fnmatch.fnmatch(worker_file, pattern) or worker_file.startswith(pattern + "/") or fnmatch.fnmatch(worker_file, pattern + "/*"):
            return True
    return False


def check() -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    scopes = _load_scopes()
    for increment, path in SCOPE_FILES.items():
        doc = scopes.get(increment) or {}
        if not path.is_file():
            errors.append(f"{increment}: scope file missing ({path.name})")
            continue
        if doc.get("schemaVersion") != "document-intelligence.material-scope.v1":
            errors.append(f"{increment}: wrong schemaVersion")
        if doc.get("increment") != increment:
            errors.append(f"{increment}: increment field mismatch")
        declared = doc.get("scopes") or {}
        for name in SCOPE_NAMES:
            if name not in declared:
                errors.append(f"{increment}: scope {name} missing")
        includes = {name: list((declared.get(name) or {}).get("includes") or []) for name in SCOPE_NAMES}
        for name in SCOPE_NAMES:
            for entry in includes[name]:
                if not _entry_exists(entry):
                    errors.append(f"{increment}.{name}: include does not resolve: {entry}")
        for left, right in (("semanticMaterial", "executionEnvironment"), ("semanticMaterial", "evidenceAndStatus"), ("executionEnvironment", "evidenceAndStatus")):
            overlap = set(includes[left]) & set(includes[right])
            if overlap:
                errors.append(f"{increment}: scopes {left}/{right} overlap on {sorted(overlap)[:5]}")
        # No evidence/status path may sit inside a semantic or environment
        # include unless the including scope explicitly excludes it.
        for name in ("semanticMaterial", "executionEnvironment"):
            scope_excludes = list((declared.get(name) or {}).get("excludes") or [])
            for c_entry in includes["evidenceAndStatus"]:
                if c_entry.startswith(("worker:", "runtime:")) or " " in c_entry:
                    continue
                if _covers(scope_excludes, c_entry) or c_entry in scope_excludes:
                    continue
                for ab_entry in includes[name]:
                    if ab_entry.startswith(("worker:", "runtime:")) or " " in ab_entry:
                        continue
                    if c_entry == ab_entry or c_entry.startswith(ab_entry.rstrip("/") + "/"):
                        errors.append(f"{increment}: evidence path {c_entry} inside {name} include {ab_entry}")

    # Coverage: every file that feeds a bound fingerprint must be classified
    # into some increment scope's semanticMaterial or executionEnvironment,
    # and must never sit inside an evidenceAndStatus include.
    try:
        fingerprinted = _fingerprinted_worker_files()
    except Exception as exc:  # pragma: no cover - defensive; fail closed
        errors.append(f"could not enumerate fingerprinted files: {exc}")
        fingerprinted = {"semantic": set(), "environment": set()}
    union_a: list[str] = []
    union_b: list[str] = []
    union_c: list[str] = []
    union_excludes: list[str] = []
    for doc in scopes.values():
        declared = doc.get("scopes") or {}
        union_a += list((declared.get("semanticMaterial") or {}).get("includes") or [])
        union_b += list((declared.get("executionEnvironment") or {}).get("includes") or [])
        union_c += list((declared.get("evidenceAndStatus") or {}).get("includes") or [])
        union_excludes += list((declared.get("semanticMaterial") or {}).get("excludes") or [])
        union_excludes += list((declared.get("executionEnvironment") or {}).get("excludes") or [])
    for klass in ("semantic", "environment"):
        for worker_file in sorted(fingerprinted.get(klass) or set()):
            if _is_excluded(union_excludes, worker_file):
                continue
            if _covers(union_c, worker_file):
                errors.append(f"fingerprinted file {worker_file} is classified as evidenceAndStatus")
                continue
            if not _covers(union_a, worker_file) and not _covers(union_b, worker_file):
                errors.append(f"fingerprinted file {worker_file} is not classified in any scope")

    return {
        "materialScopes": "FAIL" if errors else ("PASS" if not warnings else "PASS_WITH_WARNINGS"),
        "errors": errors,
        "warnings": warnings,
        "scopeFiles": {name: str(path) for name, path in SCOPE_FILES.items()},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print the full report")
    args = parser.parse_args()
    report = check()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["materialScopes"].startswith("PASS") else 2


if __name__ == "__main__":
    raise SystemExit(main())
