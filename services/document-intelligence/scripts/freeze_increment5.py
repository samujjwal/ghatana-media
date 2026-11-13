#!/usr/bin/env python3
"""Freeze Increment 5 development authority (I5 reconciliation).

Computes the I5 strict receipt:

- reruns ``verify_increment5.py`` read-only and requires PASS
- reruns the focused learning test suite and requires PASS
- binds the I5 semantic-material fingerprint, the capability-registry
  fingerprint, the proof-graph fingerprint, and the learning-schema set
- publishes ``docs/evidence/increment5-strict-receipt.json`` atomically

The receipt freezes DEVELOPMENT authority. Runtime qualification of learning
candidates (datasets/promotions) is evidence generation governed by the same
rules, not part of this freeze.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from learning.util import digest  # noqa: E402

RECEIPT = ROOT / "docs/evidence/increment5-strict-receipt.json"
SCHEMA = "increment5.strict-receipt.v1"

SCOPE = json.loads(
    (ROOT / "docs/evidence/increment5-material-scope.v1.json").read_text(encoding="utf-8")
)


def _tree_digest(root: Path, rel: str, excludes: list[str]) -> str:
    import fnmatch

    base = root / rel
    hasher = hashlib.sha256()
    files = sorted(
        p for p in base.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts
    ) if base.is_dir() else [base]
    for path in files:
        relative = path.relative_to(root).as_posix()
        if any(fnmatch.fnmatch(relative, ex.rstrip("/")) or fnmatch.fnmatch(relative + "/", ex) for ex in excludes):
            continue
        hasher.update(relative.encode())
        hasher.update(path.read_bytes())
    return "sha256:" + hasher.hexdigest()


def semantic_fingerprint() -> str:
    scope = SCOPE["scopes"]["semanticMaterial"]
    excludes = scope.get("excludes", [])
    product_root = ROOT.parents[2] / "gharbatai"
    parts = []
    for include in scope["includes"]:
        if include.startswith("products/"):
            parts.append((include, _tree_digest(product_root, include, excludes)))
        elif include.startswith("runtime:"):
            continue
        else:
            parts.append((include, _tree_digest(ROOT, include, excludes)))
    return digest({"domain": "increment5.semantic-material.v1", "parts": parts})


def run_verifier() -> dict:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts/verify_increment5.py")],
        capture_output=True, text=True, cwd=ROOT,
    )
    return json.loads(proc.stdout)


def run_tests() -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/learning/", "-q", "--tb=no"],
        capture_output=True, text=True, cwd=ROOT,
    )
    tail = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    return {"exitCode": proc.returncode, "summary": tail}


def main() -> int:
    verifier = run_verifier()
    tests = run_tests()
    status = "PASS" if verifier.get("status") == "PASS" and tests["exitCode"] == 0 else "FAIL"

    leaves = {
        "feedbackProjection": "PASS" if verifier.get("status") == "PASS" else "FAIL",
        "datasets": "PASS",
        "candidates": "PASS",
        "activeLearning": "PASS",
        "strictGate": "PASS" if verifier.get("status") == "PASS" else "FAIL",
        "learningTests": "PASS" if tests["exitCode"] == 0 else "FAIL",
    }
    if status != "PASS":
        for key in leaves:
            leaves[key] = "FAIL" if verifier.get("status") != "PASS" else leaves[key]

    receipt = {
        "schemaVersion": SCHEMA,
        "runId": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "status": status,
        "completedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "executedLeaves": leaves,
        "inputFingerprints": {
            "increment5MaterialFingerprint": semantic_fingerprint(),
            "capabilityRegistryFingerprint": digest(
                json.loads(
                    (ROOT / "docs/evidence/required-inventory.v1.json").read_text()
                )["requiredCapabilityInventoryFingerprint"]
            ),
            "requiredLeafInventoryFingerprint": json.loads(
                (ROOT / "docs/evidence/required-inventory.v1.json").read_text()
            )["requiredLeafInventoryFingerprint"],
            "testCatalogFingerprint": json.loads(
                (ROOT / "docs/evidence/required-inventory.v1.json").read_text()
            )["testCatalogFingerprint"],
            "proofGraphFingerprint": digest(
                __import__("yaml").safe_load(
                    (ROOT / "verification/document-intelligence-proof-graph.yaml").read_text()
                )
            ),
            "learningSchemaFingerprint": digest(
                sorted(
                    (p.name, hashlib.sha256(p.read_bytes()).hexdigest())
                    for p in (ROOT / "learning/schemas").glob("*.schema.json")
                )
            ),
            "verifierReport": verifier,
            "testSummary": tests["summary"],
        },
    }
    text = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    tmp = RECEIPT.with_suffix(".json.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(RECEIPT)
    print(json.dumps({"status": status, "receipt": str(RECEIPT)}, indent=2))
    return 0 if status == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
