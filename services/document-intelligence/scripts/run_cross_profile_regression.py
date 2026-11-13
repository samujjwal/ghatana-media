#!/usr/bin/env python3
"""Execute the cross-profile isolation regression and record its receipt.

This is the *execute* step for the cross-profile check: it runs the dedicated
pytest node under the strict offline environment and writes a fingerprint-bound
receipt to ``docs/evidence/cross-profile-regression.v1.json``.  Verification is
a separate concern — ``build_freeze_set.py --check`` consumes this receipt
read-only and marks it stale when any bound fingerprint drifts.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECEIPT_PATH = ROOT / "docs/evidence/cross-profile-regression.v1.json"
RECEIPT_SCHEMA = "document-intelligence.cross-profile-regression.v1"
TEST_NODE = "tests/integration/test_profile_isolation.py::test_increment4a_profile_does_not_mutate_default_authority"

sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "evaluation" / "increment4a"))

import build_material_snapshot as snapshot  # noqa: E402
from implementation_material import implementation_fingerprints  # noqa: E402

INCREMENT3_PROVIDER_AUTHORITY = ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"
INCREMENT4A_RUNTIME_AUTHORITY = ROOT / "capabilities/increment4a.runtime-authority.json"


def bound_fingerprints() -> dict[str, str | None]:
    impl = implementation_fingerprints(ROOT)
    return {
        "providerSemanticsFingerprint": impl["providerSemanticsFingerprint"],
        "canonicalProviderAuthoritySha256": snapshot.sha256_file(INCREMENT3_PROVIDER_AUTHORITY),
        "increment4aRuntimeAuthoritySha256": snapshot.sha256_file(INCREMENT4A_RUNTIME_AUTHORITY),
        "workerLifecycleFingerprint": snapshot.tree_fingerprint(
            ROOT / "src/document_intelligence", ["runtime", "lifecycle.py", "app.py", "health.py"]
        ),
        "testSpecSha256": snapshot.sha256_file(ROOT / "tests/integration/test_profile_isolation.py"),
    }


def main() -> int:
    env = os.environ.copy()
    env["DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS"] = "1"
    env["DOCUMENT_INTELLIGENCE_OFFLINE"] = "true"
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["DOCUMENT_INTELLIGENCE_MODEL_CACHE"] = str(ROOT / ".models")
    with tempfile.TemporaryDirectory(prefix="cross-profile-regression-") as tmp:
        junit_path = Path(tmp) / "junit.xml"
        command = [sys.executable, "-m", "pytest", TEST_NODE, f"--junitxml={junit_path}", "-q", "-p", "no:cacheprovider"]
        completed = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, check=False)
        junit_sha = snapshot.sha256_file(junit_path) if junit_path.is_file() else None
    status = "PASS" if completed.returncode == 0 else "FAIL"
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA,
        "status": status,
        "runId": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "completedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "command": " ".join(command),
        "testNodeIds": [TEST_NODE],
        "fingerprints": bound_fingerprints(),
        "junitSha256": junit_sha,
        "outputTail": (completed.stdout + completed.stderr)[-2000:],
    }
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = RECEIPT_PATH.with_name(RECEIPT_PATH.name + ".tmp")
    tmp.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(RECEIPT_PATH)
    print(json.dumps({"crossProfileRegression": status, "receipt": str(RECEIPT_PATH)}, indent=2, sort_keys=True))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
