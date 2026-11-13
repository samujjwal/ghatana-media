"""Learning artifact retention policy (I5-31).

Retention is defined independently per artifact class — feedback events,
dataset snapshots, candidate artifacts, rejected candidates, and promotion
evidence — by a checked-in retention-policy.v1 document. Expiry is evaluated
against the policy; nothing is deleted implicitly.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from .util import validate

ARTIFACT_CLASSES = (
    "feedbackEvents",
    "datasetSnapshots",
    "candidateArtifacts",
    "rejectedCandidates",
    "promotionEvidence",
)


def load_retention_policy(path: Path) -> dict:
    policy = yaml.safe_load(path.read_text(encoding="utf-8"))
    validate(policy, "retention-policy.v1.schema.json")
    return policy


def retention_for(policy: dict, artifact_class: str) -> str | int:
    """Return 'INDEFINITE' or a day count for the artifact class."""
    entry = policy["classes"][artifact_class]
    retention = entry["retention"]
    if retention == "INDEFINITE":
        return "INDEFINITE"
    return int(retention["days"])


def is_expired(policy: dict, artifact_class: str, created_at: str, now: str) -> bool:
    retention = retention_for(policy, artifact_class)
    if retention == "INDEFINITE":
        return False
    created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    current = datetime.fromisoformat(now.replace("Z", "+00:00"))
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current >= created + timedelta(days=retention)


def revocation_propagates(policy: dict, artifact_class: str) -> bool:
    return bool(policy["classes"][artifact_class].get("revocationPropagates", False))
