"""Shared fixtures for learning tests: minimal valid feedback events."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from learning.util import digest  # noqa: E402


def fp(label: str) -> str:
    return "sha256:" + (label.encode().hex() * 64)[:64]


def make_event(
    label: str,
    *,
    terminal_action: str = "ACCEPT",
    status: str = "COMPLETED",
    field_id: str = "identityDocumentNumber",
    language: str = "en",
    source_fp: str | None = None,
    review_id: str | None = None,
    eligibility: str = "ACCEPTED",
) -> dict:
    review_id = review_id or f"review-{label}"
    event = {
        "schemaVersion": "document-intelligence.feedback-event.v1",
        "eventId": fp(f"event-{label}"),
        "projectionVersion": "org.feedback-projection.v1",
        "projectedAt": "2026-09-21T00:00:00Z",
        "source": {
            "executionId": f"exec-{label}",
            "resultRef": {
                "executionId": f"exec-{label}",
                "revision": 1,
                "contentDigest": fp(f"result-{label}"),
            },
            "reviewRef": {"reviewId": review_id, "executionId": f"exec-{label}"},
            "sourceContentFingerprint": source_fp or fp(f"source-{label}"),
        },
        "review": {
            "status": status,
            "terminalAction": terminal_action,
            "reviewReasons": ["REQUIRED_FIELD_LOW_CONFIDENCE"],
            "reviewRevision": 2,
            "correctionRevision": 1,
            "correctionSetFingerprint": fp(f"corrections-{label}"),
            "corrections": [
                {
                    "correctionId": f"correction-{label}",
                    "target": {"fieldId": field_id},
                    "correctedValue": {"kind": "TEXT", "value": "x"},
                }
            ],
            "finalizedAt": "2026-09-21T00:05:00Z",
        },
        "authority": {
            "schemaRef": {"schemaId": "onboarding-identity", "version": 1},
            "schemaFingerprint": fp("schema"),
            "templateCatalogFingerprint": fp("catalog"),
            "routingPolicyFingerprint": fp("routing"),
            "materialFingerprint": fp(f"material-{label}"),
            "providerCatalogFingerprint": fp("providers"),
            "modelManifestFingerprint": fp("model"),
            "languageHint": language,
        },
        "privacy": {"pseudonymScheme": "org.learning-pseudonym.v1", "minimized": True},
        "eligibility": {
            "state": eligibility,
            "policyRef": "org.learning-eligibility.v1",
            "decidedAt": "2026-09-21T00:05:00Z",
            "reasonCodes": ["REVIEW_ACCEPTED"],
        },
    }
    event["eventFingerprint"] = digest(event)
    return event


def write_event_root(root: Path, events: list[dict], tombstones: list[dict] | None = None) -> Path:
    from learning.feedback.events import write_event_artifact, write_tombstone_artifact

    for event in events:
        write_event_artifact(root, event)
    for tombstone in tombstones or []:
        write_tombstone_artifact(root, tombstone)
    return root
