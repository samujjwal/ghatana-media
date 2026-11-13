#!/usr/bin/env python3
"""Implementation-lock builder and read-only checker (LOCK-01).

Builds ``docs/evidence/document-intelligence-implementation-lock.v1.json`` —
the IMPLEMENTATION_COMPLETE barrier from ``docs/PROGRAM.md``. The lock binds
the final intended source shape of the implementation epoch:

  source material scopes        wire protocol schemas
  runtime/profile definitions   DB migrations
  model manifests               provider catalogs
  learning schemas              I6 routing/scheduler configuration
  test/catalog inventories      verification implementations

After the lock, only fixes demonstrated by verification failures may change
bound material; each fix feeds the proof graph and invalidates only the
affected leaves. ``--check`` re-derives every fingerprint and reports drift
without executing providers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEVELOPMENTS = ROOT.parents[2]
GHARBATAI = DEVELOPMENTS / "gharbatai"
EVIDENCE_DIR = ROOT / "docs" / "evidence"
LOCK_PATH = EVIDENCE_DIR / "document-intelligence-implementation-lock.v1.json"
LOCK_SCHEMA = "document-intelligence.implementation-lock.v1"

sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "evaluation"))

import build_material_snapshot as snapshot  # noqa: E402
from campaign_guards import tree_digest  # noqa: E402


def sha256_file(path: Path) -> str | None:
    return snapshot.sha256_file(path) if path.is_file() else None


def _file_map(base: Path, pattern: str) -> dict[str, str]:
    return {
        str(p.relative_to(base)): sha256_file(p)
        for p in sorted(base.rglob(pattern))
        if p.is_file() and "__pycache__" not in p.parts
    }


def _git_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            check=True, capture_output=True,
        ).stdout.decode().strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _components() -> dict[str, Any]:
    prisma_dir = GHARBATAI / "products/org/packages/db/prisma"
    migrations_dir = prisma_dir / "migrations"
    migration_files = (
        _file_map(migrations_dir, "*.sql") if migrations_dir.is_dir() else {}
    )
    return {
        "materialScopes": _file_map(EVIDENCE_DIR, "*-material-scope.v1.json"),
        "profiles": _file_map(ROOT / "profiles", "*.yaml"),
        "wireProtocol": {
            **_file_map(ROOT / "contracts", "*.md"),
            **_file_map(ROOT / "contracts", "*.json"),
            **_file_map(ROOT / "contracts" / "schemas", "*.json"),
        },
        "database": {
            "migrations": migration_files,
            "compatibilityManifest": sha256_file(
                GHARBATAI
                / "products/org/docs/document-extraction/database-schema-compatibility.json"
            ),
        },
        "modelManifests": _file_map(ROOT / "models", "*.yaml"),
        "providerCatalogs": _file_map(ROOT / "capabilities", "*.*"),
        "learningSchemas": _file_map(ROOT / "learning" / "schemas", "*.json"),
        "learningPolicies": _file_map(ROOT / "learning" / "policies", "*.yaml"),
        "routingConfiguration": _file_map(ROOT / "routing", "*.yaml"),
        "sourceMaterial": {
            "worker": tree_digest(
                [
                    ROOT / "src/document_intelligence",
                    ROOT / "contracts",
                    ROOT / "routing",
                    ROOT / "profiles",
                    ROOT / "learning/active_learning",
                    ROOT / "learning/calibration",
                    ROOT / "learning/candidates",
                    ROOT / "learning/datasets/build_dataset.py",
                    ROOT / "learning/datasets/export_dataset.py",
                    ROOT / "learning/datasets/__init__.py",
                    ROOT / "learning/feedback/events.py",
                    ROOT / "learning/feedback/__init__.py",
                    ROOT / "learning/models",
                    ROOT / "learning/policies",
                    ROOT / "learning/policy",
                    ROOT / "learning/promotion",
                    ROOT / "learning/schemas",
                    ROOT / "learning/templates",
                    ROOT / "learning/__init__.py",
                    ROOT / "learning/audit.py",
                    ROOT / "learning/retention.py",
                    ROOT / "learning/tenant_scope.py",
                    ROOT / "learning/util.py",
                    ROOT / "learning/README.md",
                    ROOT / "pyproject.toml",
                    ROOT / "uv.lock",
                ]
            ),
            "productLearning": tree_digest(
                [
                    GHARBATAI
                    / "products/org/apps/api/src/modules/document-extraction-learning",
                ]
            ),
            "productExtraction": tree_digest(
                [
                    GHARBATAI
                    / "products/org/apps/api/src/modules/document-extraction",
                ]
            ),
        },
        "testInventory": {
            "workerTests": tree_digest([ROOT / "tests"]),
            "clientTests": tree_digest([ROOT / "clients/typescript/tests"]),
            "requiredInventory": sha256_file(
                EVIDENCE_DIR / "required-inventory.v1.json"
            ),
            "proofGraph": sha256_file(
                ROOT / "verification/document-intelligence-proof-graph.yaml"
            ),
        },
        "verificationImplementations": {
            **_file_map(ROOT / "scripts", "*.py"),
            **_file_map(ROOT / "evaluation", "*.py"),
            **_file_map(ROOT / "evaluation" / "increment6", "*.py"),
            **_file_map(ROOT / "evaluation" / "increment6" / "runners", "*.py"),
            **_file_map(ROOT / "evaluation" / "increment4a", "*.py"),
        },
        "evaluationAuthorities": {
            **_file_map(ROOT / "evaluation", "*.yaml"),
            **_file_map(ROOT / "evaluation" / "increment6", "*.yaml"),
            **_file_map(ROOT / "evaluation" / "increment6" / "schemas", "*.json"),
            **_file_map(ROOT / "evaluation" / "increment6" / "corpus", "*.yaml"),
            **_file_map(
                ROOT / "evaluation" / "increment6" / "runners" / "configs", "*.yaml"
            ),
        },
        "deploymentAuthorities": {
            **_file_map(ROOT / "deployment", "*.yaml"),
            **_file_map(ROOT / "deployment", "*.json"),
            **_file_map(ROOT / "release", "*.json"),
        },
    }


def build() -> dict[str, Any]:
    components = _components()
    lock: dict[str, Any] = {
        "schemaVersion": LOCK_SCHEMA,
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "gitCommit": _git_commit(),
        "barrier": "IMPLEMENTATION_COMPLETE",
        "postLockPolicy": {
            "allowed": ["fixes demonstrated by verification failures"],
            "forbidden": [
                "feature additions",
                "refactors",
                "new formats",
                "new policies",
                "new provider behavior",
            ],
            "invalidation": "dependency-graph scoped: only affected leaves re-verify",
        },
        "boundComponents": components,
    }
    lock["lockFingerprint"] = "sha256:" + hashlib.sha256(
        json.dumps(components, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return lock


def check() -> dict[str, Any]:
    existing = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    current = _components()
    drift = {}
    for name, bound in existing.get("boundComponents", {}).items():
        now = current.get(name)
        if bound != now:
            if isinstance(bound, dict) and isinstance(now, dict):
                drift[name] = sorted(
                    k for k in set(bound) | set(now) if bound.get(k) != now.get(k)
                )
            else:
                drift[name] = "component changed"
    return {
        "schemaVersion": f"{LOCK_SCHEMA}.check",
        "status": "PASS" if not drift else "FAIL",
        "lockFingerprint": existing.get("lockFingerprint"),
        "recomputedFingerprint": "sha256:"
        + hashlib.sha256(
            json.dumps(current, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "drift": drift,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        result = check()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["status"] == "PASS" else 1
    lock = build()
    LOCK_PATH.write_text(
        json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"wrote": str(LOCK_PATH), "lockFingerprint": lock["lockFingerprint"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
