"""Extraction-policy candidate generation for GLiNER-style providers (I5-17).

Aggregates reviewer corrections across eligible feedback events:

- A ``fieldId`` corrected two or more times proposes a ``fieldAliases``
  entry (canonical fieldId -> fieldId-derived snake_case alias) and is
  listed under ``supplementalFields``.
- When such corrections carry a structured ``target.valuePath``, a
  ``labelMappings`` entry binds the provider-side label to the canonical
  fieldId.

Output is a single ``extraction-policy-candidate.v1`` artifact in state
CANDIDATE; the active GLiNER mapping is never mutated.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "learning"))

from learning.feedback.events import eligible_events, load_event_root  # noqa: E402
from learning.util import atomic_write_json, digest, validate  # noqa: E402

SCHEMA = "extraction-policy-candidate.v1.schema.json"
SCHEMA_VERSION = "document-intelligence.extraction-policy-candidate.v1"
CANDIDATE_ID_DOMAIN = "learning.extraction-policy-candidate-id.v1"

CORRECTION_MIN_COUNT = 2


def _snake_alias(field_id: str) -> str:
    """Deterministic snake_case alias derived from a fieldId."""
    alias = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", field_id)
    alias = re.sub(r"[^A-Za-z0-9]+", "_", alias)
    return alias.strip("_").lower()


def generate_policy_candidates(
    events: list[dict],
    *,
    target_provider: str = "gliner",
    parent_authority_fingerprint: str,
    policy_ref: str,
) -> list[dict]:
    """Derive extraction-policy-candidate.v1 artifacts from corrections."""
    correction_counts: dict[str, int] = {}
    field_event_ids: dict[str, set[str]] = {}
    value_path_fields: set[str] = set()
    for event in events:
        for correction in event["review"]["corrections"]:
            target = correction["target"]
            field_id = target["fieldId"]
            correction_counts[field_id] = correction_counts.get(field_id, 0) + 1
            field_event_ids.setdefault(field_id, set()).add(event["eventId"])
            if "valuePath" in target:
                value_path_fields.add(field_id)

    qualifying = sorted(
        field_id
        for field_id, count in correction_counts.items()
        if count >= CORRECTION_MIN_COUNT
    )
    if not qualifying:
        return []

    proposed_changes: dict = {
        "fieldAliases": {field_id: _snake_alias(field_id) for field_id in qualifying},
        "supplementalFields": qualifying,
    }
    label_mappings = {
        _snake_alias(field_id): field_id
        for field_id in qualifying
        if field_id in value_path_fields
    }
    if label_mappings:
        proposed_changes["labelMappings"] = label_mappings

    event_ids = sorted(
        {event_id for field_id in qualifying for event_id in field_event_ids[field_id]}
    )
    parent_authority = {
        "activeAuthorityFingerprint": parent_authority_fingerprint,
        "policyRef": policy_ref,
    }
    candidate = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": digest(
            {
                "domain": CANDIDATE_ID_DOMAIN,
                "kind": "EXTRACTION_POLICY",
                "targetProvider": target_provider,
                "parentAuthority": parent_authority,
                "proposedChanges": proposed_changes,
                "feedbackEventIds": event_ids,
            }
        ),
        "kind": "EXTRACTION_POLICY",
        "state": "CANDIDATE",
        "targetProvider": target_provider,
        "parentAuthority": parent_authority,
        "proposedChanges": proposed_changes,
        "provenance": {"feedbackEventIds": event_ids},
        "limitations": [
            "Derived from reviewer corrections only; no active-authority mutation.",
            "Aliases and labels are fieldId-derived snake_case proposals "
            "requiring human confirmation.",
        ],
    }
    candidate["candidateFingerprint"] = digest(candidate)
    validate(candidate, SCHEMA)
    return [candidate]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-root", type=Path, required=True)
    parser.add_argument("--parent-authority-fingerprint", required=True)
    parser.add_argument("--policy-ref", required=True)
    parser.add_argument("--target-provider", default="gliner")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    events = list(eligible_events(load_event_root(args.events_root)))
    candidates = generate_policy_candidates(
        events,
        target_provider=args.target_provider,
        parent_authority_fingerprint=args.parent_authority_fingerprint,
        policy_ref=args.policy_ref,
    )
    for candidate in candidates:
        atomic_write_json(
            args.out / "extraction-policy-candidates" / f"{candidate['candidateId']}.json",
            candidate,
        )
    print(
        json.dumps(
            {
                "candidateCount": len(candidates),
                "candidateIds": [c["candidateId"] for c in candidates],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
