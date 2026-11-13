from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import make_event, write_event_root  # noqa: E402
from learning.datasets.build_dataset import (  # noqa: E402
    assign_split,
    build_dataset,
    check_leakage,
    deduplicate,
)

POLICY = yaml.safe_load(
    (ROOT / "learning/policies/dataset-policy.v1.yaml").read_text(encoding="utf-8")
)


def _events() -> list[dict]:
    return [make_event(str(i), source_fp=None) for i in range(12)]


def test_build_is_deterministic(tmp_path: Path):
    events_root = write_event_root(tmp_path / "events", _events())
    first = build_dataset(events_root, POLICY, tmp_path / "out1", "ds", 1, "2026-09-21T00:00:00Z")
    second = build_dataset(events_root, POLICY, tmp_path / "out2", "ds", 1, "2026-09-21T00:00:00Z")
    assert first["datasetFingerprint"] == second["datasetFingerprint"]
    assert first["splits"]["train"]["count"] + first["splits"]["eval"]["count"] == 12


def test_completed_revision_never_overwritten(tmp_path: Path):
    events_root = write_event_root(tmp_path / "events", _events())
    out = tmp_path / "out"
    build_dataset(events_root, POLICY, out, "ds", 1, "2026-09-21T00:00:00Z")
    with pytest.raises(ValueError, match="already complete"):
        build_dataset(events_root, POLICY, out, "ds", 1, "2026-09-21T00:00:00Z")


def test_dedup_drops_same_source_and_lineage(tmp_path: Path):
    # Same source fingerprint + same review lineage -> canonical duplicate.
    a = make_event("a", source_fp="sha256:" + "1" * 64, review_id="shared")
    b = make_event("b", source_fp="sha256:" + "1" * 64, review_id="shared")
    kept, dropped = deduplicate([a, b], POLICY["dedupPolicy"]["canonicalKeys"])
    assert len(kept) == 1 and len(dropped) == 1


def test_distinct_sources_survive_dedup(tmp_path: Path):
    kept, dropped = deduplicate(_events(), POLICY["dedupPolicy"]["canonicalKeys"])
    assert len(kept) == 12 and dropped == []


def test_split_is_stable_and_group_safe(tmp_path: Path):
    event = _events()[0]
    assert assign_split(event, POLICY) == assign_split(event, POLICY)
    # A reprocessed variant of the same source must land in the same split.
    sibling = make_event("a2", source_fp=event["source"]["sourceContentFingerprint"])
    assert assign_split(sibling, POLICY) == assign_split(event, POLICY)


def test_leakage_checker_catches_source_crossing(tmp_path: Path):
    a = make_event("a", source_fp="sha256:" + "9" * 64)
    b = make_event("b", source_fp="sha256:" + "9" * 64)
    checks = check_leakage([a], [b])
    assert checks[0]["check"] == "SAME_SOURCE_ACROSS_SPLITS"
    assert checks[0]["status"] == "FAIL"


def test_manifest_validates_and_records_stats(tmp_path: Path):
    events_root = write_event_root(tmp_path / "events", _events())
    manifest = build_dataset(events_root, POLICY, tmp_path / "out", "ds", 1, "2026-09-21T00:00:00Z")
    assert manifest["schemaVersion"] == "document-intelligence.dataset-manifest.v2"
    assert manifest["tenantScope"] == "TENANT_LOCAL"
    assert manifest["leakage"]["status"] == "PASS"
    assert manifest["statistics"]["languages"]["en"] == 12
    assert manifest["statistics"]["correctionFrequencies"]["identityDocumentNumber"] == 12
