#!/usr/bin/env python3
"""Validate per-leaf declared dependency sets for the freeze program.

``docs/evidence/leaf-dependencies.v1.json`` declares, for every proof leaf,
which authorities it depends on (``dependsOn``) and which it must not bind
(``doesNotDependOn``).  This checker resolves the keys each leaf actually
bound at record time and reports:

- ``covered`` — every declared dependency is bound in the leaf's own evidence;
- ``satisfiedViaSealAuthority`` — a declared dependency is absent from the
  leaf record but bound current by another authoritative artifact (recorded,
  non-blocking);
- ``UNDER_BOUND`` — a declared dependency is recorded nowhere authoritative
  (blocking; the leaf cannot detect drift of that input);
- ``OVER_BOUND`` — the leaf binds a key it declared doesNotDependOn
  (blocking; causes unnecessary invalidation).

Read-only: it never writes evidence.
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
CATALOG_PATH = EVIDENCE_DIR / "leaf-dependencies.v1.json"
INVENTORY_PATH = EVIDENCE_DIR / "proof-inventory.v2.json"
RECEIPTS_PATH = ROOT / "evaluation/increment4a/test-receipts.json"
REQUIRED_TESTS_PATH = ROOT / "evaluation/increment4a/required-tests.yaml"
STRICT_RECEIPT_PATH = EVIDENCE_DIR / "increment3-strict-receipt.json"
SNAPSHOT_PATH = EVIDENCE_DIR / "material-snapshot.v1.json"
CAMPAIGN_MANIFEST = (
    GHARBATAI / "products/org/docs/document-extraction/evaluation/results/campaign-manifest.json"
)
ORG_EVAL = CAMPAIGN_MANIFEST.parent.parent

SEAL_STATUSES = {"REUSE", "PASS", "MEASURED", "CLEAR", "FROZEN", "ACTIVE", "ADMITTED"}


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _inventory() -> dict[str, dict]:
    records = (_load(INVENTORY_PATH).get("records")) or []
    by_leaf: dict[str, dict] = {}
    for record in records:
        leaf = (record.get("proofIdentity") or {}).get("leafId") or record.get("leafId")
        if leaf:
            by_leaf[leaf] = record
    return by_leaf


def _record_bound_keys(record: dict) -> set[str]:
    keys: set[str] = set()
    for section in ("materialAuthority", "dependencyAuthority", "executionAuthority", "evaluatorAuthority"):
        keys |= set(((record.get(section) or {}).get("inputs") or {}).keys())
    keys |= set((record.get("inputFingerprint") or {}).keys())
    return keys


def _record_status(record: dict) -> str:
    return ((record.get("result") or {}).get("status")) or record.get("status") or "UNKNOWN"


def _receipt_runner_maps() -> tuple[set[str], set[str]]:
    import yaml  # noqa: PLC0415

    data = yaml.safe_load(REQUIRED_TESTS_PATH.read_text(encoding="utf-8")) if REQUIRED_TESTS_PATH.is_file() else {}
    return set((data or {}).get("pytest") or {}), set((data or {}).get("vitest") or {})


def _campaign_bound_keys(manifest: dict, leaf: str) -> tuple[set[str], set[str]]:
    """Return (leaf-local bound keys, campaign-authority bound keys).

    Leaf-local keys are what the leaf's own evidence artifact records;
    campaign-authority keys (sharedAuthority, productImplementation areas,
    leafInventory) are bound once by the manifest for the whole run and may
    satisfy a leaf's dependsOn but do not count against doesNotDependOn.
    """
    campaign = set((manifest.get("sharedAuthority") or {}).keys())
    campaign |= set(((manifest.get("productImplementation") or {}).get("areas") or {}).keys())
    campaign |= set((manifest.get("leafInventory") or {}).keys())
    local: set[str] = set()
    artifact_name = leaf.split(".", 1)[1] if leaf.startswith("increment4.") else leaf
    artifact = (manifest.get("artifacts") or {}).get(artifact_name)
    if artifact and artifact.get("path"):
        doc = _load(ORG_EVAL / artifact["path"])
        local |= set((doc.get("fingerprints") or {}).keys())
        local |= set((doc.get("runtimeEvidence") or {}).keys())
    return local, campaign


def _seal_level_keys() -> set[str]:
    keys = set((_load(SNAPSHOT_PATH).get("currentFingerprints") or {}).keys())
    keys |= set((_load(SNAPSHOT_PATH).get("fingerprints") or {}).keys())
    return keys


def _leaf_ids(catalog: dict, inventory: dict[str, dict]) -> dict[str, str]:
    """Map concrete leaf ids to their catalog pattern."""
    pytest_leaves, vitest_leaves = _receipt_runner_maps()
    concrete: dict[str, str] = {}
    known_patterns = sorted(catalog.keys(), key=len, reverse=True)
    for leaf in inventory:
        for pattern in known_patterns:
            if pattern.endswith("*") and leaf.startswith(pattern[:-1]):
                concrete[leaf] = pattern
                break
            if leaf == pattern:
                concrete[leaf] = pattern
                break
    receipts = (_load(RECEIPTS_PATH).get("receipts")) or {}
    for leaf in receipts:
        runner = "vitest" if leaf in vitest_leaves else ("pytest" if leaf in pytest_leaves else "pytest")
        concrete[f"increment4a.testReceipt.{leaf}"] = f"increment4a.testReceipt.{runner}.*"
    return concrete


def check() -> dict:
    catalog_doc = _load(CATALOG_PATH)
    if catalog_doc.get("schemaVersion") != "document-intelligence.leaf-dependencies.v1":
        return {"leafDependencies": "FAIL", "errors": ["leaf-dependencies.v1.json missing or wrong schemaVersion"], "leaves": {}}
    catalog = catalog_doc.get("leaves") or {}
    inventory = _inventory()
    manifest = _load(CAMPAIGN_MANIFEST)
    seal_keys = _seal_level_keys()
    receipts = (_load(RECEIPTS_PATH).get("receipts")) or {}
    concrete = _leaf_ids(catalog, inventory)

    errors: list[str] = []
    leaves: dict[str, dict] = {}
    for leaf_id, pattern in sorted(concrete.items()):
        declared = catalog.get(pattern) or {}
        depends_on = set(declared.get("dependsOn") or [])
        excluded = set(declared.get("doesNotDependOn") or [])
        evidence = declared.get("evidence") or "inventory"

        bound: set[str] = set()
        local_bound: set[str] = set()
        if leaf_id.startswith("increment3.strictGate"):
            record = inventory.get(leaf_id) or {}
            bound = _record_bound_keys(record) | set((_load(STRICT_RECEIPT_PATH).get("inputFingerprints") or {}).keys())
            local_bound = bound
            status = _record_status(record)
        elif leaf_id.startswith("increment4a.testReceipt."):
            leaf_name = leaf_id.rsplit(".", 1)[-1]
            entry = receipts.get(leaf_name) or {}
            bound = set(entry.keys()) - {"status", "verifiedAt", "nodeIds"}
            local_bound = bound
            status = entry.get("status") or "NOT_RUN"
        elif evidence == "campaignManifest":
            local_bound, campaign_bound = _campaign_bound_keys(manifest, leaf_id)
            bound = local_bound | campaign_bound
            status = "PASS"
        else:
            record = inventory.get(leaf_id) or {}
            bound = _record_bound_keys(record)
            local_bound = bound
            status = _record_status(record)

        missing = sorted(depends_on - bound)
        via_seal = sorted(key for key in missing if key in seal_keys)
        under_bound = sorted(key for key in missing if key not in seal_keys)
        over_bound = sorted(local_bound & excluded)
        verdict = "covered"
        if missing and not under_bound:
            verdict = "satisfiedViaSealAuthority"
        if under_bound:
            verdict = "UNDER_BOUND"
        if over_bound:
            verdict = "OVER_BOUND"

        seal_relevant = status in SEAL_STATUSES
        if seal_relevant and verdict in {"UNDER_BOUND", "OVER_BOUND"}:
            errors.append(f"{leaf_id}: {verdict} missing={under_bound} overBound={over_bound}")
        leaves[leaf_id] = {
            "catalogPattern": pattern,
            "status": status,
            "verdict": verdict,
            "boundKeys": sorted(bound),
            "missing": missing,
            "satisfiedViaSealAuthority": via_seal,
            "underBound": under_bound,
            "overBound": over_bound,
        }

    declared_concrete = [leaf for leaf, pattern in concrete.items() if pattern in catalog]
    uncovered_required = [
        leaf for leaf in inventory
        if leaf not in concrete and _record_status(inventory[leaf]) in SEAL_STATUSES
    ]
    if uncovered_required:
        errors.append(f"leaves lack a declared dependency set: {sorted(uncovered_required)}")

    return {
        "leafDependencies": "FAIL" if errors else "PASS",
        "catalog": str(CATALOG_PATH),
        "catalogSha256": _sha256(CATALOG_PATH),
        "evaluatedLeaves": len(leaves),
        "declaredPatterns": len(catalog),
        "leaves": leaves,
        "errors": errors,
        "uncataloguedSealLeaves": uncovered_required,
    }


def _sha256(path: Path) -> str | None:
    import hashlib  # noqa: PLC0415

    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    args = parser.parse_args()
    report = check()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["leafDependencies"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
