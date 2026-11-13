from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import fp, make_event, write_event_root  # noqa: E402
from learning.feedback.events import (  # noqa: E402
    eligible_events,
    event_root_fingerprint,
    exclusion_report,
    load_event_root,
    verify_event,
)


def test_valid_event_verifies(tmp_path: Path):
    event = make_event("a")
    assert verify_event(event)["eventId"] == event["eventId"]


def test_tampered_event_fingerprint_fails(tmp_path: Path):
    event = make_event("a")
    event["review"]["reviewRevision"] = 99
    with pytest.raises(ValueError, match="fingerprint mismatch"):
        verify_event(event)


def test_missing_required_field_fails(tmp_path: Path):
    event = make_event("a")
    del event["authority"]["materialFingerprint"]
    event["eventFingerprint"] = "sha256:" + "0" * 64
    with pytest.raises(ValueError, match="materialFingerprint"):
        verify_event(event)


def test_tombstone_excludes_but_preserves(tmp_path: Path):
    event = make_event("a")
    tombstone = {
        "schemaVersion": "document-intelligence.feedback-tombstone.v1",
        "eventId": event["eventId"],
        "kind": "REVOKED",
        "reasonCode": "SUBJECT_ERASURE",
        "tombstonedAt": "2026-09-21T02:00:00Z",
        "tombstoneFingerprint": fp("tombstone"),
    }
    root = write_event_root(tmp_path / "root", [event], [tombstone])
    loaded = load_event_root(root)
    assert len(loaded.events) == 1
    assert eligible_events(loaded) == ()
    assert exclusion_report(loaded)[0]["reason"] == "TOMBSTONED"


def test_ineligible_events_excluded_with_reason(tmp_path: Path):
    root = write_event_root(tmp_path / "root", [make_event("a", eligibility="EXCLUDED")])
    loaded = load_event_root(root)
    assert eligible_events(loaded) == ()
    assert exclusion_report(loaded)[0]["reason"] == "ELIGIBILITY_EXCLUDED"


def test_event_root_fingerprint_stable(tmp_path: Path):
    root = write_event_root(tmp_path / "root", [make_event("a"), make_event("b")])
    first = event_root_fingerprint(load_event_root(root))
    second = event_root_fingerprint(load_event_root(root))
    assert first == second
