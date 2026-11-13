#!/usr/bin/env python3
"""Build the release-readiness manifest (I6-47).

Collects:

- gate receipts from ``release/readiness/receipts/<gateId>.json`` — each
  receipt is a JSON document carrying at least ``{gateId, status}``; its
  fingerprint is the canonical-JSON sha256 of the receipt file bytes' parsed
  content (omitted-field convention is not needed — receipts are leaf docs);
- capability admission state from
  ``scripts/check_capability_registry.check`` — qualifiedIds are
  consumerAdmission=ALLOWED entries, deniedIds are DENIED; any registry
  error is an inconsistency and fails the build;
- ``sbomFingerprint`` / ``offlineBundleFingerprint`` /
  ``operationalEnvelopeFingerprint`` — content sha256 of the generated
  deployment artifacts.

The manifest is written atomically to
``release/readiness/readiness-manifest.v1.json`` with a ``manifestFingerprint``
over the document minus that field. ``readinessId`` is content-derived
(deterministic) so ``--check`` reproduction is stable.

FAIL (exit 2) when: any required gate is not PASS, a receipt is missing or
drifted, the capability registry is inconsistent, or a bound deployment
artifact is missing. A NOT_READY manifest is still written — non-readiness
is itself evidence. ``--check`` is read-only: recompute + compare, reject
missing/drifted receipts, verify the stored fingerprint.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_capability_registry  # noqa: E402

MANIFEST_SCHEMA = "document-intelligence.release-readiness.v1"
GATES_SCHEMA = "document-intelligence.deployment-gates.v1"
VOLATILE_FIELDS = {"generatedAt", "manifestFingerprint"}


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _fingerprint(value) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _load_gates(root: Path) -> list[dict]:
    path = root / "deployment/deployment-gates.v1.yaml"
    if not path.is_file():
        raise ValueError("deployment/deployment-gates.v1.yaml missing")
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if doc.get("schemaVersion") != GATES_SCHEMA:
        raise ValueError(f"gates file schemaVersion must be {GATES_SCHEMA}")
    return list(doc.get("gates") or [])


def _load_receipt(receipts_dir: Path, gate_id: str) -> tuple[dict | None, Path]:
    path = receipts_dir / f"{gate_id}.json"
    if not path.is_file():
        return None, path
    try:
        return json.loads(path.read_text(encoding="utf-8")), path
    except json.JSONDecodeError as exc:
        raise ValueError(f"receipt {path.name} invalid json: {exc}")


def _capability_admission(root: Path) -> dict:
    """Registry-derived admission sets; rebind module paths for --root."""
    check_capability_registry.REGISTRY = root / "capabilities/document-intelligence-capabilities.yaml"
    check_capability_registry.ACCEPTED_4A = root / "capabilities/increment4a.accepted.json"
    check_capability_registry.RUNTIME_AUTHORITY = root / "capabilities/increment4a.runtime-authority.json"
    check_capability_registry.I3_CAPABILITIES = (
        root / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"
    )
    errors = check_capability_registry.check(check_capability_registry.REGISTRY)
    registry = yaml.safe_load(
        check_capability_registry.REGISTRY.read_text(encoding="utf-8")
    )
    capabilities = registry.get("capabilities") or {}
    qualified = sorted(
        cid for cid, cap in capabilities.items() if cap.get("consumerAdmission") == "ALLOWED"
    )
    denied = sorted(
        cid for cid, cap in capabilities.items() if cap.get("consumerAdmission") == "DENIED"
    )
    return {
        "qualifiedIds": qualified,
        "deniedIds": denied,
        "registryCheck": "FAIL" if errors else "PASS",
        "registryErrors": errors,
    }


def build(root: Path, receipts_dir: Path) -> tuple[dict, list[str]]:
    errors: list[str] = []
    gates = _load_gates(root)

    gate_records = []
    for gate in sorted(gates, key=lambda g: g["id"]):
        gate_id = gate["id"]
        receipt, receipt_path = _load_receipt(receipts_dir, gate_id)
        try:
            rel_receipt = str(receipt_path.relative_to(root))
        except ValueError:
            rel_receipt = str(receipt_path)
        record = {
            "gateId": gate_id,
            "required": bool(gate.get("required", False)),
            "receiptPath": rel_receipt if receipt else None,
        }
        if receipt is None:
            record["status"] = "NOT_RUN"
            record["receiptFingerprint"] = None
            if gate.get("required"):
                errors.append(f"required gate {gate_id} has no receipt")
        else:
            status = str(receipt.get("status") or "FAIL")
            if receipt.get("gateId") != gate_id:
                errors.append(f"receipt {receipt_path.name} gateId mismatch")
                status = "FAIL"
            record["status"] = status if status in {"PASS", "FAIL", "NOT_RUN"} else "FAIL"
            record["receiptFingerprint"] = _fingerprint(receipt)
            if gate.get("required") and record["status"] != "PASS":
                errors.append(f"required gate {gate_id} status is {record['status']}")
        gate_records.append(record)

    admission = _capability_admission(root)
    if admission["registryCheck"] != "PASS":
        errors.append(
            "capabilityAdmission inconsistency: " + "; ".join(admission["registryErrors"][:5])
        )

    fingerprints = {}
    for key, rel in (
        ("sbomFingerprint", "deployment/sbom/sbom.v1.json"),
        ("offlineBundleFingerprint", "deployment/sbom/offline-bundle-manifest.v1.json"),
        ("operationalEnvelopeFingerprint", "deployment/operational-envelope.v1.yaml"),
    ):
        target = root / rel
        if not target.is_file():
            errors.append(f"bound artifact missing: {rel}")
            fingerprints[key] = "sha256:" + "0" * 64
        else:
            fingerprints[key] = f"sha256:{_sha256_file(target)}"

    manifest = {
        "schemaVersion": MANIFEST_SCHEMA,
        "increment": "increment6",
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "gates": gate_records,
        "capabilityAdmission": admission,
        **fingerprints,
        "status": "READY" if not errors else "NOT_READY",
    }
    manifest["readinessId"] = "readiness-" + hashlib.sha256(
        _canonical(
            {
                "gates": gate_records,
                "capabilityAdmission": {
                    k: v for k, v in admission.items() if k != "registryErrors"
                },
                **fingerprints,
            }
        )
    ).hexdigest()[:16]
    manifest["manifestFingerprint"] = _fingerprint(
        {k: v for k, v in manifest.items() if k != "manifestFingerprint"}
    )
    return manifest, errors


def check(root: Path, receipts_dir: Path, manifest_path: Path) -> dict:
    errors: list[str] = []
    if not manifest_path.is_file():
        return {"releaseReadiness": "FAIL", "errors": [f"manifest missing: {manifest_path}"]}
    try:
        stored = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"releaseReadiness": "FAIL", "errors": [f"manifest invalid json: {exc}"]}
    try:
        regenerated, build_errors = build(root, receipts_dir)
    except ValueError as exc:
        return {"releaseReadiness": "FAIL", "errors": [str(exc)]}

    comparable_stored = {k: v for k, v in stored.items() if k not in VOLATILE_FIELDS}
    comparable_regen = {k: v for k, v in regenerated.items() if k not in VOLATILE_FIELDS}
    if comparable_stored != comparable_regen:
        errors.append("stored manifest does not match recomputed state (drift or missing receipts)")
    expected_fp = _fingerprint(
        {k: v for k, v in stored.items() if k != "manifestFingerprint"}
    )
    if stored.get("manifestFingerprint") != expected_fp:
        errors.append("stored manifestFingerprint does not cover stored content")
    # Re-verify each recorded receipt still exists and digests identically.
    for gate in stored.get("gates", []):
        receipt_path = gate.get("receiptPath")
        if not receipt_path:
            continue
        target = root / receipt_path
        if not target.is_file():
            errors.append(f"receipt missing on disk: {receipt_path}")
            continue
        try:
            receipt = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            errors.append(f"receipt unreadable: {receipt_path}")
            continue
        if _fingerprint(receipt) != gate.get("receiptFingerprint"):
            errors.append(f"receipt drifted: {receipt_path}")
    errors.extend(build_errors)
    return {
        "releaseReadiness": "FAIL" if errors else "PASS",
        "status": stored.get("status"),
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--receipts-dir", type=Path, default=None,
        help="gate receipts dir (default: <root>/release/readiness/receipts)",
    )
    parser.add_argument(
        "--output", type=Path, default=None,
        help="manifest output (default: <root>/release/readiness/readiness-manifest.v1.json)",
    )
    parser.add_argument("--check", action="store_true", help="read-only re-verification")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    receipts_dir = args.receipts_dir or root / "release/readiness/receipts"
    output = args.output or root / "release/readiness/readiness-manifest.v1.json"

    if args.check:
        result = check(root, receipts_dir, output)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["releaseReadiness"] == "PASS" else 2

    try:
        manifest, errors = build(root, receipts_dir)
    except ValueError as exc:
        print(json.dumps({"releaseReadiness": "FAIL", "errors": [str(exc)]}, indent=2))
        return 2
    _atomic_write(output, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "releaseReadiness": "DECLARED",
                "status": manifest["status"],
                "readinessId": manifest["readinessId"],
                "manifest": str(output),
                "manifestFingerprint": manifest["manifestFingerprint"],
                "errors": errors,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if manifest["status"] == "READY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
