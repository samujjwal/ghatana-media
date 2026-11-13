#!/usr/bin/env python3
"""Required-inventory fingerprints (P0-04).

Binds three inventories so a previously green denominator can never be reused
after a new mandatory leaf, capability, or required test appears:

    requiredLeafInventoryFingerprint        proof-graph + sealed catalog leaves
    requiredCapabilityInventoryFingerprint  canonical capability registry
    testCatalogFingerprint                  required-tests.yaml content

Writes docs/evidence/required-inventory.v1.json; --check reconciles.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/evidence/required-inventory.v1.json"
PROOF_GRAPH = ROOT / "verification/document-intelligence-proof-graph.yaml"
LEAF_CATALOG = ROOT / "docs/evidence/leaf-dependencies.v1.json"
CAPABILITIES = ROOT / "capabilities/document-intelligence-capabilities.yaml"
REQUIRED_TESTS = ROOT / "evaluation/increment4a/required-tests.yaml"


def _digest(value) -> str:
    return "sha256:" + hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def compute() -> dict:
    graph = yaml.safe_load(PROOF_GRAPH.read_text(encoding="utf-8"))
    catalog = json.loads(LEAF_CATALOG.read_text(encoding="utf-8"))
    capabilities = yaml.safe_load(CAPABILITIES.read_text(encoding="utf-8"))
    tests = yaml.safe_load(REQUIRED_TESTS.read_text(encoding="utf-8"))
    return {
        "schemaVersion": "document-intelligence.required-inventory.v1",
        "requiredLeafInventoryFingerprint": _digest(
            {
                "graphLeaves": sorted(graph.get("leaves", {})),
                "catalogLeaves": sorted(catalog.get("leaves", {})),
            }
        ),
        "requiredCapabilityInventoryFingerprint": _digest(capabilities.get("capabilities", {})),
        "testCatalogFingerprint": _digest(tests),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read-only reconcile")
    args = parser.parse_args()
    computed = compute()
    if args.check:
        if not OUT.exists():
            print(json.dumps({"status": "FAIL", "errors": ["required-inventory.v1.json missing"]}))
            return 1
        recorded = json.loads(OUT.read_text(encoding="utf-8"))
        recorded.pop("generatedAt", None)
        if recorded != computed:
            print(
                json.dumps(
                    {
                        "status": "FAIL",
                        "errors": ["required inventory fingerprints drifted"],
                        "recorded": recorded,
                        "computed": computed,
                    },
                    indent=2,
                )
            )
            return 1
        print(json.dumps({"status": "PASS", **computed}, indent=2))
        return 0
    from datetime import datetime, timezone

    computed["generatedAt"] = (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    OUT.write_text(json.dumps(computed, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": "DECLARED", **{k: v for k, v in computed.items() if k != 'generatedAt'}}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
