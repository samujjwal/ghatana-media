"""Revocation propagation into the candidate registry (I5-40).

When feedback events are tombstoned after a dataset was built, candidates
whose ``dependencies.datasetFingerprint`` binds a dataset containing revoked
events become ineligible. The marker is a separate append-only artifact — the
candidate manifest itself is never rewritten:

    <registry>/candidates/<candidateId>/revocation.json

``promotion.promote`` refuses any candidate carrying this marker.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

from ..feedback.events import load_event_root, tombstoned_ids
from ..retention import revocation_propagates
from ..util import atomic_write_json, load_json
from . import registry

MARKER_NAME = "revocation.json"
MARKER_SCHEMA_VERSION = "document-intelligence.candidate-revocation.v1"


def marker_path(registry_root: Path, candidate_id: str) -> Path:
    return (
        Path(registry_root) / "candidates" / registry._safe(candidate_id) / MARKER_NAME
    )


def is_revoked(registry_root: Path, candidate_id: str) -> bool:
    return marker_path(registry_root, candidate_id).exists()


def dataset_manifest_for_fingerprint(
    datasets_root: Path, dataset_fingerprint: str
) -> dict | None:
    """Locate a completed dataset manifest by its fingerprint."""
    datasets_root = Path(datasets_root)
    if not datasets_root.is_dir():
        return None
    for manifest_path in sorted(datasets_root.glob("*/*/manifest.json")):
        revision_dir = manifest_path.parent
        if not (revision_dir / ".complete").exists():
            continue
        manifest = load_json(manifest_path)
        if manifest.get("datasetFingerprint") == dataset_fingerprint:
            return manifest
    return None


def revoked_event_ids(manifest: dict, datasets_root: Path, tombstoned: set[str]) -> set[str]:
    dataset_fingerprint = manifest.get("dependencies", {}).get("datasetFingerprint")
    if not dataset_fingerprint or not tombstoned:
        return set()
    dataset = dataset_manifest_for_fingerprint(datasets_root, dataset_fingerprint)
    if dataset is None:
        return set()
    accepted = set(dataset.get("source", {}).get("acceptedEventIds", []))
    return accepted & tombstoned


def apply_revocations(
    registry_root: Path,
    datasets_root: Path,
    event_roots: Iterable[Path],
    *,
    at: str,
    retention_policy: dict | None = None,
) -> list[str]:
    """Mark candidates ineligible when their bound dataset contains revoked
    events. Returns the candidate ids newly marked. Honors the retention
    policy's ``revocationPropagates`` flag for dataset snapshots: when the
    policy says revocation does not propagate, nothing is marked.
    """
    if retention_policy is not None and not revocation_propagates(
        retention_policy, "datasetSnapshots"
    ):
        return []
    tombstoned: set[str] = set()
    for root in event_roots:
        tombstoned |= tombstoned_ids(load_event_root(Path(root)))
    marked: list[str] = []
    for manifest in registry.list_candidates(Path(registry_root)):
        candidate_id = manifest["candidateId"]
        revoked = sorted(
            revoked_event_ids(manifest, datasets_root, tombstoned)
        )
        if not revoked or is_revoked(registry_root, candidate_id):
            continue
        marker = {
            "schemaVersion": MARKER_SCHEMA_VERSION,
            "candidateId": candidate_id,
            "candidateFingerprint": manifest["candidateFingerprint"],
            "datasetFingerprint": manifest["dependencies"]["datasetFingerprint"],
            "revokedEventIds": revoked,
            "status": "INELIGIBLE",
            "reason": "REVOKED_FEEDBACK_EVENTS",
            "markedAt": at,
        }
        atomic_write_json(marker_path(registry_root, candidate_id), marker)
        marked.append(candidate_id)
    return marked
