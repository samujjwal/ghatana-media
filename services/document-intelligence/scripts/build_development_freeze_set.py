#!/usr/bin/env python3
"""Development freeze-set v2 builder and read-only reconciler (SEAL-01).

Builds ``docs/evidence/document-intelligence-development-freeze-set.v2.json`` —
the F9 global seal from ``docs/PROGRAM.md``. The v2 set *references* (never
rewrites) ``document-intelligence-freeze-set.v1.json`` and the implementation
lock, and binds the Increment-5/Increment-6 development authority:

  sections:            increment5 + increment6 freeze evidence
  profileAuthorities:  profile manifests and default-catalog stability
  crossChecks:         old default unchanged; I5/I6 candidates never silently
                       activated; deferred capabilities accounted; no stale
                       proof dependencies

Reconciliation executes zero provider tests: it only re-reads artifacts,
recomputes fingerprints, and re-runs the read-only checkers. ``--check``
re-derives every bound value and reports drift without writing.
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
EVIDENCE_DIR = ROOT / "docs" / "evidence"
V1_PATH = EVIDENCE_DIR / "document-intelligence-freeze-set.v1.json"
V2_PATH = EVIDENCE_DIR / "document-intelligence-development-freeze-set.v2.json"
LOCK_PATH = EVIDENCE_DIR / "document-intelligence-implementation-lock.v1.json"
V2_SCHEMA = "document-intelligence.development-freeze-set.v2"
CAPABILITY_REGISTRY = ROOT / "capabilities" / "document-intelligence-capabilities.yaml"

sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "evaluation"))

import build_material_snapshot as snapshot  # noqa: E402


def sha256_file(path: Path) -> str | None:
    return snapshot.sha256_file(path) if path.is_file() else None


def _file_map(base: Path, pattern: str) -> dict[str, Any]:
    return {
        str(p.relative_to(base)): sha256_file(p)
        for p in sorted(base.rglob(pattern))
        if p.is_file() and "__pycache__" not in p.parts
    }


def _run_read_only(script: str, *args: str) -> dict[str, Any]:
    """Run a read-only verifier; no provider execution is ever allowed here."""
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / script), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        payload = {"rawStdout": result.stdout[-500:], "rawStderr": result.stderr[-500:]}
    return {"exitCode": result.returncode, "output": payload}


def _capability_states() -> dict[str, Any]:
    import yaml  # noqa: PLC0415

    registry = yaml.safe_load(CAPABILITY_REGISTRY.read_text(encoding="utf-8")) or {}
    states: dict[str, str] = {}
    for entry in registry.get("capabilities") or []:
        if isinstance(entry, dict) and entry.get("id"):
            states[str(entry["id"])] = str(entry.get("state", "UNDECLARED"))
    return states


def _components() -> dict[str, Any]:
    freeze_v1 = _run_read_only("build_freeze_set.py", "--check")
    verify_i5 = _run_read_only("verify_increment5.py")
    verify_i6 = _run_read_only("verify_increment6.py", "--strict")
    lock_check = _run_read_only("build_implementation_lock.py", "--check")
    scopes = _run_read_only("check_material_scopes.py")
    capability = _run_read_only("check_capability_registry.py")
    default_catalog = _run_read_only("check_default_catalog_stability.py")

    proof_graph = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_proof_graph.py"), "check"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    try:
        proof_graph_payload = json.loads(proof_graph.stdout)
    except json.JSONDecodeError:
        proof_graph_payload = {"raw": proof_graph.stdout[-500:]}

    capability_states = _capability_states()
    deferred = sorted(cid for cid, state in capability_states.items() if state != "QUALIFIED")

    i5_receipt = EVIDENCE_DIR / "increment5-strict-receipt.json"
    readiness_dir = ROOT / "release" / "readiness"

    components: dict[str, Any] = {
        "extendsFreezeSetV1": {
            "path": V1_PATH.relative_to(ROOT).as_posix(),
            "sha256": sha256_file(V1_PATH),
            "check": freeze_v1,
        },
        "implementationLock": {
            "path": LOCK_PATH.relative_to(ROOT).as_posix(),
            "sha256": sha256_file(LOCK_PATH),
            "check": lock_check,
        },
        "sections": {
            "increment5": {
                "strictReceipt": {
                    "path": i5_receipt.relative_to(ROOT).as_posix(),
                    "sha256": sha256_file(i5_receipt),
                },
                "verify": verify_i5,
                "capabilityRegistrySha256": sha256_file(CAPABILITY_REGISTRY),
                "learningSchemas": _file_map(ROOT / "learning" / "schemas", "*.json"),
                "learningPolicies": _file_map(ROOT / "learning" / "policies", "*.yaml"),
            },
            "increment6": {
                "strictVerify": verify_i6,
                "releaseReadiness": _file_map(readiness_dir, "*.json")
                if readiness_dir.is_dir()
                else {},
                "deploymentAuthorities": {
                    **_file_map(ROOT / "deployment", "*.yaml"),
                    **_file_map(ROOT / "deployment", "*.json"),
                },
                "acceptanceSha256": sha256_file(
                    ROOT / "evaluation/increment6/acceptance.yaml"
                ),
                "environmentSha256": sha256_file(
                    ROOT / "evaluation/increment6/environment.yaml"
                ),
                "semanticEnvironmentSha256": sha256_file(
                    ROOT / "evaluation/semantic-environment.v1.yaml"
                ),
            },
        },
        "profileAuthorities": {
            "profiles": _file_map(ROOT / "profiles", "*.yaml"),
            "defaultCatalogStability": default_catalog,
        },
        "crossChecks": {
            "oldDefaultUnchanged": "PASS"
            if default_catalog["exitCode"] == 0
            else "FAIL",
            "candidatesNeverSilentlyActivated": capability,
            "deferredCapabilitiesAccounted": deferred,
            "noStaleProofDeps": {
                "proofGraph": {
                    "exitCode": proof_graph.returncode,
                    "output": proof_graph_payload,
                },
                "materialScopes": scopes,
                "implementationLock": lock_check,
            },
        },
        "proofInventory": {
            "path": "docs/evidence/proof-inventory.v2.json",
            "sha256": sha256_file(EVIDENCE_DIR / "proof-inventory.v2.json"),
        },
        "verificationImplementations": {
            **_file_map(ROOT / "scripts", "*.py"),
            **_file_map(ROOT / "verification", "*.yaml"),
        },
    }
    return components


def _status(components: dict[str, Any]) -> tuple[str, list[str]]:
    errors: list[str] = []

    def require(ok: bool, label: str) -> None:
        if not ok:
            errors.append(label)

    v1 = components["extendsFreezeSetV1"]["check"]
    require(v1["exitCode"] == 0, "freeze-set.v1 check is not PASS")
    lock = components["implementationLock"]["check"]
    require(lock["exitCode"] == 0, "implementation lock check is not PASS")
    i5 = components["sections"]["increment5"]
    require(i5["verify"]["exitCode"] == 0, "verify_increment5 is not PASS")
    receipt = i5["strictReceipt"]
    if receipt["sha256"] is None:
        errors.append("increment5 strict receipt missing")
    else:
        doc = json.loads((ROOT / receipt["path"]).read_text(encoding="utf-8"))
        require(doc.get("status") == "PASS", "increment5 strict receipt is not PASS")
    i6 = components["sections"]["increment6"]
    strict = i6["strictVerify"]
    require(strict["exitCode"] == 0, "verify_increment6 --strict is not PASS")
    require(bool(i6["releaseReadiness"]), "increment6 release readiness missing")
    profiles = components["profileAuthorities"]
    require(
        profiles["defaultCatalogStability"]["exitCode"] == 0,
        "default catalog stability is not PASS",
    )
    require(
        components["crossChecks"]["candidatesNeverSilentlyActivated"]["exitCode"]
        == 0,
        "capability registry check is not PASS",
    )
    deps = components["crossChecks"]["noStaleProofDeps"]
    require(deps["proofGraph"]["exitCode"] == 0, "proof graph check is not PASS")
    require(
        deps["materialScopes"]["exitCode"] == 0,
        "material scope check is not PASS",
    )
    return ("PASS" if not errors else "FAIL"), errors


def build() -> dict[str, Any]:
    components = _components()
    status, errors = _status(components)
    seal: dict[str, Any] = {
        "schemaVersion": V2_SCHEMA,
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "sealState": "SEALED" if status == "PASS" else "OPEN",
        "status": status,
        "errors": errors,
        **components,
    }
    seal["freezeSetFingerprint"] = "sha256:" + hashlib.sha256(
        json.dumps(components, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return seal


def check() -> dict[str, Any]:
    existing = json.loads(V2_PATH.read_text(encoding="utf-8"))
    current = _components()
    bound = {k: v for k, v in existing.items() if k in current}
    drift = {}
    for name, bound_value in bound.items():
        now = current.get(name)
        if bound_value != now:
            drift[name] = "component changed"
    return {
        "schemaVersion": f"{V2_SCHEMA}.check",
        "status": "PASS" if not drift else "FAIL",
        "freezeSetFingerprint": existing.get("freezeSetFingerprint"),
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
    seal = build()
    V2_PATH.write_text(
        json.dumps(seal, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "wrote": str(V2_PATH),
                "status": seal["status"],
                "sealState": seal["sealState"],
                "freezeSetFingerprint": seal["freezeSetFingerprint"],
                "errors": seal["errors"],
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if seal["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
