"""Template-discovery candidate generation (I5-15, I5-16).

Consumes eligible feedback events and proposes governed template candidates:

- ``NEW_TEMPLATE`` — events whose review reasons flag a template miss
  (``TEMPLATE_UNMATCHED`` / ``TEMPLATE_NO_MATCH`` / ``TEMPLATE_AMBIGUOUS``)
  and whose authority carries no ``selectedTemplateRef`` indicate the
  document class lacks a usable template.
- ``ALIAS_CHANGE`` — when two or more events in a document class correct the
  same ``target.fieldId``, the extractor plausibly needs an additional alias
  for that field.

Every artifact validates against ``template-candidate.v1`` and remains
CANDIDATE; nothing here mutates active authority.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "learning"))

from learning.candidates.registry import register  # noqa: E402
from learning.feedback.events import eligible_events, load_event_root  # noqa: E402
from learning.util import (  # noqa: E402
    atomic_write_json,
    canonical_json,
    digest,
    sha256_file,
    validate,
)

SCHEMA = "template-candidate.v1.schema.json"
SCHEMA_VERSION = "document-intelligence.template-candidate.v1"
CANDIDATE_ID_DOMAIN = "learning.template-candidate-id.v1"

TEMPLATE_MISS_REASONS = {"TEMPLATE_UNMATCHED", "TEMPLATE_NO_MATCH", "TEMPLATE_AMBIGUOUS"}
ALIAS_MIN_EVENT_COUNT = 2


def _snake_alias(field_id: str) -> str:
    """Deterministic snake_case alias derived from a fieldId."""
    alias = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", field_id)
    alias = re.sub(r"[^A-Za-z0-9]+", "_", alias)
    return alias.strip("_").lower()


def _document_class(event: dict) -> str:
    return event["authority"]["schemaRef"]["schemaId"]


def _field_ids(events: list[dict]) -> list[str]:
    return sorted(
        {
            correction["target"]["fieldId"]
            for event in events
            for correction in event["review"]["corrections"]
        }
    )


def _structure_descriptor_fingerprint(events: list[dict]) -> str:
    """Digest of the group's schemaRefs plus sorted corrected fieldIds."""
    schema_refs = sorted(
        {canonical_json(e["authority"]["schemaRef"]) for e in events}
    )
    return digest(
        {
            "domain": "learning.structure-descriptor.v1",
            "schemaRefs": schema_refs,
            "fieldIds": _field_ids(events),
        }
    )


def _base_authority_fingerprint(events: list[dict]) -> str:
    """Template-catalog fingerprint(s) of the supporting events' authority."""
    catalogs = sorted({e["authority"]["templateCatalogFingerprint"] for e in events})
    if len(catalogs) == 1:
        return catalogs[0]
    return digest({"domain": "learning.base-authority.v1", "templateCatalogFingerprints": catalogs})


def _finalize(candidate: dict) -> dict:
    candidate["candidateFingerprint"] = digest(candidate)
    validate(candidate, SCHEMA)
    return candidate


def _candidate_id(operation: str, document_class: str, event_ids: list[str]) -> str:
    return digest(
        {
            "domain": CANDIDATE_ID_DOMAIN,
            "kind": "TEMPLATE_DISCOVERY",
            "operation": operation,
            "documentClass": document_class,
            "supportingEventIds": event_ids,
        }
    )


def discover_template_candidates(
    events: list[dict], *, embedding_model_identity: str
) -> list[dict]:
    """Derive template-candidate.v1 artifacts from feedback events."""
    groups: dict[str, list[dict]] = {}
    for event in events:
        groups.setdefault(_document_class(event), []).append(event)

    candidates: list[dict] = []
    for document_class in sorted(groups):
        group = sorted(groups[document_class], key=lambda e: e["eventId"])
        descriptor_fp = _structure_descriptor_fingerprint(group)

        unmatched = [
            e
            for e in group
            if TEMPLATE_MISS_REASONS & set(e["review"]["reviewReasons"])
            and "selectedTemplateRef" not in e["authority"]
        ]
        if unmatched:
            event_ids = sorted(e["eventId"] for e in unmatched)
            candidates.append(
                _finalize(
                    {
                        "schemaVersion": SCHEMA_VERSION,
                        "candidateId": _candidate_id(
                            "NEW_TEMPLATE", document_class, event_ids
                        ),
                        "kind": "TEMPLATE_DISCOVERY",
                        "state": "CANDIDATE",
                        "operation": "NEW_TEMPLATE",
                        "proposal": {
                            "documentClass": document_class,
                            "structureDescriptorFingerprint": descriptor_fp,
                        },
                        "provenance": {
                            "supportingFeedbackEventIds": event_ids,
                            "embeddingModelIdentity": embedding_model_identity,
                            "structureDescriptorFingerprints": [descriptor_fp],
                        },
                        "limitations": [
                            "Proposed from template-miss review reasons only; "
                            "structure descriptor is a schema/field digest, not a learned template."
                        ],
                    }
                )
            )

        corrections_per_field: dict[str, set[str]] = {}
        for event in group:
            for correction in event["review"]["corrections"]:
                corrections_per_field.setdefault(
                    correction["target"]["fieldId"], set()
                ).add(event["eventId"])
        alias_changes = [
            {"fieldId": field_id, "alias": _snake_alias(field_id), "action": "ADD"}
            for field_id in sorted(corrections_per_field)
            if len(corrections_per_field[field_id]) >= ALIAS_MIN_EVENT_COUNT
        ]
        if alias_changes:
            event_ids = sorted(
                {
                    event_id
                    for field_id in corrections_per_field
                    if len(corrections_per_field[field_id]) >= ALIAS_MIN_EVENT_COUNT
                    for event_id in corrections_per_field[field_id]
                }
            )
            candidates.append(
                _finalize(
                    {
                        "schemaVersion": SCHEMA_VERSION,
                        "candidateId": _candidate_id(
                            "ALIAS_CHANGE", document_class, event_ids
                        ),
                        "kind": "TEMPLATE_DISCOVERY",
                        "state": "CANDIDATE",
                        "operation": "ALIAS_CHANGE",
                        "proposal": {
                            "documentClass": document_class,
                            "aliasChanges": alias_changes,
                        },
                        "provenance": {
                            "supportingFeedbackEventIds": event_ids,
                            "embeddingModelIdentity": embedding_model_identity,
                            "structureDescriptorFingerprints": [descriptor_fp],
                        },
                        "limitations": [
                            "Aliases are fieldId-derived snake_case proposals; "
                            "human review must confirm extractor-facing naming."
                        ],
                    }
                )
            )
    return candidates


def _evaluator_implementation_fingerprint() -> str:
    return "sha256:" + sha256_file(Path(__file__).resolve())


def emit(
    root: Path,
    events: list[dict],
    embedding_model_identity: str,
    registry_root: Path,
    created_at: str,
) -> list[dict]:
    """Discover candidates, write artifacts under ``root``, and register each.

    ``root`` receives a copy of every emitted candidate artifact at
    ``<root>/template-candidates/<candidateId>.json``; ``registry_root`` is the
    governed candidate registry. Returns the registered manifests.
    """
    candidates = discover_template_candidates(
        events, embedding_model_identity=embedding_model_identity
    )
    evaluator_fp = _evaluator_implementation_fingerprint()
    manifests: list[dict] = []
    for candidate in candidates:
        supporting = [
            e for e in events if e["eventId"] in set(candidate["provenance"]["supportingFeedbackEventIds"])
        ]
        dependencies = {
            "baseAuthorityFingerprint": _base_authority_fingerprint(supporting),
            "datasetFingerprint": digest(
                {
                    "domain": "learning.template-discovery-input.v1",
                    "eventIds": sorted(e["eventId"] for e in events),
                }
            ),
            "evaluatorImplementationFingerprint": evaluator_fp,
            # Registry identity is derived from the dependency bundle alone;
            # binding the artifact digest keeps sibling candidates (e.g.
            # NEW_TEMPLATE vs ALIAS_CHANGE for one documentClass) distinct.
            "templateAssetFingerprints": {"candidateArtifact": digest(candidate)},
        }
        manifest = register(
            registry_root,
            kind="TEMPLATE_DISCOVERY",
            artifact=candidate,
            dependencies=dependencies,
            created_at=created_at,
        )
        atomic_write_json(
            root / "template-candidates" / f"{candidate['candidateId']}.json",
            candidate,
        )
        manifests.append(manifest)
    return manifests


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-root", type=Path, required=True)
    parser.add_argument("--embedding-model-identity", required=True)
    parser.add_argument("--registry-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--created-at", required=True)
    args = parser.parse_args(argv)

    events = list(eligible_events(load_event_root(args.events_root)))
    manifests = emit(
        args.out,
        events,
        args.embedding_model_identity,
        args.registry_root,
        args.created_at,
    )
    print(
        json.dumps(
            {
                "candidateCount": len(manifests),
                "candidateIds": [m["candidateId"] for m in manifests],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
