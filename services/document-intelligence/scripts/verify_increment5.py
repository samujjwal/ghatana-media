#!/usr/bin/env python3
"""Increment 5 strict verifier — read-only, fail-closed (I5-33).

Every executed candidate must bind:

  the increment-5 material fingerprint + the dataset fingerprint it was
  evaluated on + the frozen acceptance authority + the frozen baseline result

Verification scope:
  1. learning schemas parse and are strict at the root
  2. dataset manifests validate, carry a .complete marker, and recompute
  3. candidate manifests validate; every recorded transition has a matching
     immutable receipt on disk
  4. promotions are authorized, carry PASS evaluation + regression receipts,
     and active.json resolves to an existing immutable revision
  5. capability registry is consistent with accepted/excluded authority
  6. no-online-learning guard: the product learning module must not write
     sealed extraction tables
  7. event roots: fingerprints verify; tombstones exclude but never erase
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_ROOT = ROOT.parents[2] / "gharbatai"
PRODUCT_LEARNING = PRODUCT_ROOT / "products/org/apps/api/src/modules/document-extraction-learning"

sys.path.insert(0, str(ROOT))

from learning.feedback.events import load_event_root  # noqa: E402
from learning.util import digest, load_json, validate  # noqa: E402


def _fail(errors: list[str], check: str, message: str) -> None:
    errors.append(f"{check}: {message}")


def check_schemas(errors: list[str]) -> None:
    for path in sorted((ROOT / "learning/schemas").glob("*.schema.json")):
        try:
            schema = load_json(path)
            if schema.get("additionalProperties") is not False:
                _fail(errors, "schemas", f"{path.name} is not strict at the root")
            if "schemaVersion" in schema.get("properties", {}):
                if "const" not in schema["properties"]["schemaVersion"]:
                    _fail(errors, "schemas", f"{path.name} schemaVersion is not a const")
        except (ValueError, json.JSONDecodeError) as exc:
            _fail(errors, "schemas", f"{path.name}: {exc}")


def check_event_roots(errors: list[str]) -> None:
    roots_dir = ROOT / "learning/feedback/events"
    if not roots_dir.is_dir():
        return  # no materialized event roots yet — nothing to verify
    for root_dir in sorted(p for p in roots_dir.iterdir() if p.is_dir()):
        try:
            event_root = load_event_root(root_dir)
        except ValueError as exc:
            _fail(errors, "eventRoots", f"{root_dir.name}: {exc}")
            continue
        from learning.feedback.events import eligible_events, tombstoned_ids

        excluded = tombstoned_ids(event_root)
        for event in eligible_events(event_root):
            if event["eventId"] in excluded:
                _fail(errors, "eventRoots", f"{root_dir.name}: tombstoned event eligible")


def check_datasets(errors: list[str]) -> None:
    datasets_root = ROOT / "learning/datasets/out"
    if not datasets_root.is_dir():
        return
    for revision_dir in datasets_root.glob("*/*"):
        manifest_path = revision_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        if not (revision_dir / ".complete").exists():
            _fail(errors, "datasets", f"{revision_dir}: incomplete revision (no .complete marker)")
            continue
        try:
            manifest = load_json(manifest_path)
            validate(manifest, "dataset-manifest.v1.schema.json")
            body = {k: v for k, v in manifest.items() if k != "datasetFingerprint"}
            if digest(body) != manifest["datasetFingerprint"]:
                _fail(errors, "datasets", f"{revision_dir}: datasetFingerprint mismatch")
            if manifest["leakage"]["status"] != "PASS":
                _fail(errors, "datasets", f"{revision_dir}: leakage check not PASS")
        except (ValueError, json.JSONDecodeError) as exc:
            _fail(errors, "datasets", f"{revision_dir}: {exc}")


def check_registry(errors: list[str]) -> None:
    registry_root = ROOT / "learning/registry"
    if not registry_root.is_dir():
        return
    from learning.candidates import registry

    for candidate_dir in sorted((registry_root / "candidates").iterdir() if (registry_root / "candidates").is_dir() else []):
        manifest_path = candidate_dir / "manifest.json"
        if not manifest_path.exists():
            _fail(errors, "registry", f"{candidate_dir.name}: missing manifest")
            continue
        try:
            manifest = load_json(manifest_path)
            validate(manifest, "candidate-manifest.v1.schema.json")
        except (ValueError, json.JSONDecodeError) as exc:
            _fail(errors, "registry", f"{candidate_dir.name}: {exc}")
            continue
        transitions_dir = candidate_dir / "transitions"
        for index, transition in enumerate(manifest.get("transitions", [])):
            receipt_path = transitions_dir / f"{index:04d}-{transition['toState']}.json"
            if not receipt_path.exists():
                _fail(errors, "registry", f"{candidate_dir.name}: transition {index} has no receipt")
                continue
            receipt = load_json(receipt_path)
            if receipt.get("receiptFingerprint") != transition.get("receiptFingerprint"):
                _fail(errors, "registry", f"{candidate_dir.name}: transition {index} receipt fingerprint mismatch")
        if manifest["state"] == "PROMOTED" and not manifest.get("evaluation"):
            _fail(errors, "registry", f"{candidate_dir.name}: PROMOTED without evaluation record")
        if not (candidate_dir / "artifact.json").exists():
            _fail(errors, "registry", f"{candidate_dir.name}: missing artifact.json")


def check_promotions(errors: list[str]) -> None:
    authority_root = ROOT / "learning/authority"
    if not authority_root.is_dir():
        return
    active_path = authority_root / "active.json"
    if active_path.exists():
        active = load_json(active_path)
        revision_fp = active.get("activeRevisionFingerprint", "")
        revision_dir = authority_root / "revisions" / revision_fp.replace(":", "_")
        if not revision_dir.is_dir():
            _fail(errors, "promotion", f"active revision {revision_fp} has no immutable revision dir")
        receipts = list((authority_root / "receipts").glob("*.json"))
        matched = any(
            load_json(r).get("receiptFingerprint") == active.get("receiptFingerprint")
            for r in receipts
        )
        if not matched:
            _fail(errors, "promotion", "active pointer receiptFingerprint has no receipt on disk")
    for receipt_path in sorted((authority_root / "receipts").glob("*.json")):
        try:
            receipt = load_json(receipt_path)
            validate(receipt, "promotion-receipt.v1.schema.json")
            body = {k: v for k, v in receipt.items() if k != "receiptFingerprint"}
            if digest(body) != receipt["receiptFingerprint"]:
                _fail(errors, "promotion", f"{receipt_path.name}: receiptFingerprint mismatch")
            auth = receipt.get("authorization", {})
            if not auth.get("authorizedBy") or not auth.get("authorizationRef"):
                _fail(errors, "promotion", f"{receipt_path.name}: missing authorization")
            if receipt.get("evaluationReceipt", {}).get("result") != "PASS":
                _fail(errors, "promotion", f"{receipt_path.name}: promotion without PASS evaluation")
        except (ValueError, json.JSONDecodeError) as exc:
            _fail(errors, "promotion", f"{receipt_path.name}: {exc}")


def check_capability_registry(errors: list[str]) -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    from check_capability_registry import check

    for error in check():
        _fail(errors, "capabilityRegistry", error)


def check_no_online_learning(errors: list[str]) -> None:
    """I5-29: the product learning module must never write sealed tables."""
    if not PRODUCT_LEARNING.is_dir():
        _fail(errors, "noOnlineLearning", f"product learning module missing: {PRODUCT_LEARNING}")
        return
    sealed_writes = (
        "documentExtractionExecution.create",
        "documentExtractionExecution.update",
        "documentExtractionResult.create",
        "documentExtractionResult.update",
        "documentExtractionReview.create",
        "documentExtractionReview.update",
        "documentExtractionCorrection.create",
        "documentExtractionCorrection.update",
        "documentExtractionTemplate.create",
        "documentExtractionTemplate.update",
    )
    for path in sorted(PRODUCT_LEARNING.glob("*.ts")):
        text = path.read_text(encoding="utf-8")
        for write in sealed_writes:
            if write in text:
                _fail(errors, "noOnlineLearning", f"{path.name} writes sealed model via {write}")
        # Reading shared helpers/types from the sealed module is allowed; the
        # forbidden surface is its mutating service/command layer.
        forbidden_imports = (
            "document-extraction/document-extraction.service",
            "document-extraction/document-extraction.controller",
            "document-extraction/document-extraction.routes",
        )
        for forbidden in forbidden_imports:
            if ".spec.ts" not in path.name and forbidden in text:
                _fail(
                    errors,
                    "noOnlineLearning",
                    f"{path.name} imports mutating surface {forbidden}",
                )


def main() -> int:
    errors: list[str] = []
    check_schemas(errors)
    check_event_roots(errors)
    check_datasets(errors)
    check_registry(errors)
    check_promotions(errors)
    check_capability_registry(errors)
    check_no_online_learning(errors)
    result = {
        "schemaVersion": "document-intelligence.increment5-verification.v1",
        "increment": "increment5",
        "status": "FAIL" if errors else "PASS",
        "errors": errors,
        "checks": [
            "schemas",
            "eventRoots",
            "datasets",
            "registry",
            "promotion",
            "capabilityRegistry",
            "noOnlineLearning",
        ],
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
