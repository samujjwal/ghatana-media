#!/usr/bin/env python3
"""Canonical capability-registry verifier (P0-05, P0-06, I4A-08).

Checks both directions:

  QUALIFIED + consumerAdmission ALLOWED -> the capability is advertised by an
      accepted authority artifact
  DEFERRED / NOT_QUALIFIED / UNSUPPORTED -> consumerAdmission DENIED, a
      futureOwner is declared, and the capability is NOT advertised

The registry is authority; accepted/excluded run artifacts are evidence.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "capabilities/document-intelligence-capabilities.yaml"
ACCEPTED_4A = ROOT / "capabilities/increment4a.accepted.json"
RUNTIME_AUTHORITY = ROOT / "capabilities/increment4a.runtime-authority.json"
I3_CAPABILITIES = ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"

DEVELOPMENT_STATES = {"QUALIFIED", "NOT_QUALIFIED", "UNSUPPORTED", "NOT_APPLICABLE"}
FUTURE_OWNERS = {
    "DEFERRED_TO_INCREMENT_5",
    "DEFERRED_TO_INCREMENT_6",
    "DEFERRED_TO_RELEASE_READINESS",
    "DEFERRED_TO_EXTERNAL_CERTIFICATION",
    "UNSUPPORTED_BY_DESIGN",
    "NONE",
}
ADMISSIONS = {"ALLOWED", "DENIED"}


def _load(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def advertised_ids() -> set[str]:
    """Capability ids currently advertised by accepted authority artifacts."""
    ids: set[str] = set()
    accepted = json.loads(ACCEPTED_4A.read_text())
    for entry in accepted.get("accepted", []):
        cid = entry.get("capabilityId")
        if cid:
            ids.add(cid)
    # The I3 canonical capabilities.json advertises by provider scope, not
    # per-language ids; derive the advertised id set from the registry's
    # declared I3 surface (parser.pdf.text.{en,ne}, parser.image.text.{en,ne},
    # extraction.schema-guided.{en,ne}, embedding.structure.minilm).
    if I3_CAPABILITIES.exists():
        i3 = json.loads(I3_CAPABILITIES.read_text())
        langs = {"en", "ne"}
        for entry in i3.get("accepted", []):
            caps = entry.get("capabilities", {})
            for lang in langs & set(caps.get("supportedLanguages", [])):
                for media in caps.get("mediaTypes", []):
                    if media == "application/pdf":
                        ids.add(f"parser.pdf.text.{lang}")
                    elif media in {"image/png", "image/jpeg"}:
                        ids.add(f"parser.image.text.{lang}")
            if caps.get("supportedValueTypes"):
                for lang in langs:
                    ids.add(f"extraction.schema-guided.{lang}")
            if caps.get("modelRef"):
                ids.add("embedding.structure.minilm")
    return ids


def excluded_ids() -> set[str]:
    authority = json.loads(RUNTIME_AUTHORITY.read_text())
    return {e["capabilityId"] for e in authority.get("excluded", [])}


def check(registry_path: Path = REGISTRY) -> list[str]:
    errors: list[str] = []
    registry = _load(registry_path)
    if registry.get("schemaVersion") != "document-intelligence.capabilities.v1":
        return ["registry must declare schemaVersion document-intelligence.capabilities.v1"]
    profiles = set((registry.get("profiles") or {}).keys())
    capabilities = registry.get("capabilities") or {}
    advertised = advertised_ids()
    excluded = excluded_ids()

    for cid, cap in capabilities.items():
        ctx = f"capability {cid}"
        for field in ("capabilityId", "ownerIncrement", "developmentState", "consumerAdmission", "profiles", "futureOwner"):
            pass  # capabilityId is the mapping key; other fields checked below
        state = cap.get("developmentState")
        admission = cap.get("consumerAdmission")
        owner = cap.get("futureOwner")
        if state not in DEVELOPMENT_STATES:
            errors.append(f"{ctx}: invalid developmentState {state}")
        if admission not in ADMISSIONS:
            errors.append(f"{ctx}: invalid consumerAdmission {admission}")
        if owner not in FUTURE_OWNERS:
            errors.append(f"{ctx}: invalid/missing futureOwner {owner}")
        if cap.get("ownerIncrement") is None:
            errors.append(f"{ctx}: missing ownerIncrement")
        for profile in cap.get("profiles", []):
            if profile not in profiles:
                errors.append(f"{ctx}: unknown profile {profile}")

        if admission == "ALLOWED" and state != "QUALIFIED":
            errors.append(f"{ctx}: ALLOWED requires QUALIFIED")
        if state in {"NOT_QUALIFIED", "UNSUPPORTED", "NOT_APPLICABLE"} and admission != "DENIED":
            errors.append(f"{ctx}: non-qualified capability must be DENIED")
        if state in {"NOT_QUALIFIED", "UNSUPPORTED"} and owner in {None, "NONE"}:
            errors.append(f"{ctx}: non-qualified capability requires a futureOwner")
        if state == "QUALIFIED" and admission == "ALLOWED" and cid not in advertised:
            errors.append(f"{ctx}: advertised but absent from accepted authority evidence")
        if state in {"NOT_QUALIFIED", "UNSUPPORTED"} and cid in advertised:
            errors.append(f"{ctx}: non-qualified capability advertised by accepted authority")

    for cid in advertised - set(capabilities):
        errors.append(f"advertised capability {cid} missing from registry")
    for cid in excluded - set(capabilities):
        errors.append(f"excluded capability {cid} missing from registry")
    for cid in excluded & advertised:
        errors.append(f"capability {cid} is both excluded and advertised")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=REGISTRY)
    args = parser.parse_args(argv)
    errors = check(args.registry)
    if errors:
        print(json.dumps({"status": "FAIL", "errors": errors}, indent=2))
        return 1
    print(json.dumps({"status": "PASS"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
