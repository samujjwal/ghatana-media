from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from learning import audit, retention  # noqa: E402

AT = "2026-09-21T00:00:00Z"


def test_audit_event_appends(tmp_path: Path):
    audit.audit_event(
        tmp_path, kind="DATASET_CREATED", at=AT, subject="sha256:" + "0" * 64,
        detail={"datasetFingerprint": "sha256:" + "1" * 64},
    )
    audit.audit_event(tmp_path, kind="PROMOTED", at=AT, subject="cand-1")
    lines = (tmp_path / "learning-audit.jsonl").read_text().strip().splitlines()
    assert len(lines) == 2


def test_audit_rejects_protected_keys(tmp_path: Path):
    with pytest.raises(ValueError, match="protected"):
        audit.audit_event(
            tmp_path, kind="DATASET_CREATED", at=AT, subject="x",
            detail={"documentText": "secret"},
        )


def test_audit_rejects_unknown_kind(tmp_path: Path):
    with pytest.raises(ValueError, match="unknown"):
        audit.audit_event(tmp_path, kind="NOPE", at=AT, subject="x")


def test_retention_policy_loads(tmp_path: Path):
    policy = retention.load_retention_policy(ROOT / "learning/policies/retention.v1.yaml")
    assert retention.retention_for(policy, "feedbackEvents") == "INDEFINITE"
    assert retention.retention_for(policy, "rejectedCandidates") == 1095


def test_expiry(tmp_path: Path):
    policy = retention.load_retention_policy(ROOT / "learning/policies/retention.v1.yaml")
    assert not retention.is_expired(policy, "feedbackEvents", AT, "2030-01-01T00:00:00Z")
    assert retention.is_expired(policy, "rejectedCandidates", AT, "2030-01-01T00:00:00Z")
    assert not retention.is_expired(policy, "rejectedCandidates", AT, "2027-01-01T00:00:00Z")
