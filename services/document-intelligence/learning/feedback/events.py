"""Feedback-event loading, verification, and tombstone application (I5-07).

An event root is a directory of immutable artifacts:

    <root>/events/<eventId>.json
    <root>/tombstones/<eventId>.json

Events are validated against ``feedback-event.v1`` and their fingerprints are
recomputed — a tampered or partial artifact is rejected, never repaired.
Tombstoned events remain readable for audit but are excluded from every
dataset build.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ..util import canonical_json, digest, load_json, validate
from .governance import assess_event, reviewer_verdict

EVENT_SCHEMA = "feedback-event.v1.schema.json"
EVENT_SCHEMA_BY_VERSION = {
    # Consumers accept v1 (pre-tenant-metadata) and v2 (tenant/ownership)
    # events; producers choose the schema matching their projected metadata.
    "document-intelligence.feedback-event.v1": "feedback-event.v1.schema.json",
    "document-intelligence.feedback-event.v2": "feedback-event.v2.schema.json",
}
TOMBSTONE_SCHEMA = "tombstone.v1.schema.json"
TOMBSTONE_SCHEMA_VERSION = "document-intelligence.feedback-tombstone.v1"

TERMINAL_ELIGIBLE_STATES = {"ACCEPTED"}


@dataclass(frozen=True)
class EventRoot:
    root: Path
    events: tuple[dict, ...]
    tombstones: tuple[dict, ...]


def verify_event(event: dict) -> dict:
    schema = EVENT_SCHEMA_BY_VERSION.get(event.get("schemaVersion"))
    if schema is None:
        raise ValueError(
            f"unknown feedback event schemaVersion {event.get('schemaVersion')!r}"
        )
    validate(event, schema)
    body = {k: v for k, v in event.items() if k != "eventFingerprint"}
    if digest(body) != event["eventFingerprint"]:
        raise ValueError(f"feedback event {event.get('eventId')} fingerprint mismatch")
    # Legacy projections may omit reviewer authority.  When present, its
    # revision binding is part of the immutable event boundary.
    review = event.get("review")
    if isinstance(review, dict) and review.get("reviewerAuthority") is not None:
        valid, reasons, _ = reviewer_verdict(review)
        if not valid:
            raise ValueError(
                f"feedback event {event.get('eventId')} reviewer authority invalid: {','.join(reasons)}"
            )
    return event


def load_event_root(root: Path) -> EventRoot:
    events_dir = root / "events"
    tombstones_dir = root / "tombstones"
    events: list[dict] = []
    tombstones: list[dict] = []
    if events_dir.is_dir():
        for path in sorted(events_dir.glob("*.json")):
            events.append(verify_event(load_json(path)))
    if tombstones_dir.is_dir():
        for path in sorted(tombstones_dir.glob("*.json")):
            tombstone = load_json(path)
            try:
                validate(tombstone, TOMBSTONE_SCHEMA)
            except ValueError as exc:
                raise ValueError(f"tombstone {path.name} invalid: {exc}") from exc
            tombstones.append(tombstone)
    return EventRoot(root=root, events=tuple(events), tombstones=tuple(tombstones))


def tombstoned_ids(event_root: EventRoot) -> set[str]:
    return {t["eventId"] for t in event_root.tombstones}


def eligible_events(event_root: EventRoot) -> tuple[dict, ...]:
    """Events eligible for learning: ACCEPTED and not tombstoned."""
    excluded = tombstoned_ids(event_root)
    return tuple(
        event
        for event in event_root.events
        if event["eligibility"]["state"] in TERMINAL_ELIGIBLE_STATES
        and event["eventId"] not in excluded
        and assess_event(event).eligible
    )


def exclusion_report(event_root: EventRoot) -> list[dict]:
    """Every non-eligible event with the reason a dataset build must record."""
    excluded = tombstoned_ids(event_root)
    report = []
    for event in event_root.events:
        if event["eventId"] in excluded:
            report.append({"eventId": event["eventId"], "reason": "TOMBSTONED"})
        elif event["eligibility"]["state"] not in TERMINAL_ELIGIBLE_STATES:
            report.append(
                {
                    "eventId": event["eventId"],
                    "reason": f"ELIGIBILITY_{event['eligibility']['state']}",
                }
            )
        else:
            verdict = assess_event(event)
            if not verdict.eligible:
                report.append(
                    {
                        "eventId": event["eventId"],
                        "reason": verdict.reason_codes[0] if verdict.reason_codes else "GOVERNANCE_EXCLUDED",
                    }
                )
    return report


def event_root_fingerprint(event_root: EventRoot) -> str:
    return digest(
        {
            "domain": "learning.event-root.v1",
            "events": sorted(e["eventId"] for e in event_root.events),
            "tombstones": sorted(t["eventId"] for t in event_root.tombstones),
        }
    )


def write_event_artifact(root: Path, event: dict) -> Path:
    """Write-once append: identical re-write is a no-op, divergence conflicts."""
    from ..util import atomic_write_json

    verify_event(event)
    target = root / "events" / f"{_sanitize(event['eventId'])}.json"
    if target.exists():
        existing = load_json(target)
        if canonical_json(existing) != canonical_json(event):
            raise ValueError(f"feedback event conflict at {target}")
        return target
    atomic_write_json(target, event)
    return target


def write_tombstone_artifact(root: Path, tombstone: dict) -> Path:
    from ..util import atomic_write_json

    validate(tombstone, TOMBSTONE_SCHEMA)
    target = root / "tombstones" / f"{_sanitize(tombstone['eventId'])}.json"
    if not target.exists():
        atomic_write_json(target, tombstone)
    return target


def _sanitize(event_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in event_id)
