from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from document_intelligence.governance import (  # noqa: E402
    EnvironmentTier,
    GovernanceError,
    RawObservation,
    Rescoreability,
    VerificationAction,
    build_source_snapshot,
    canonical_filesystem_identity,
    compose_profiles,
    environment_authority,
    minimum_necessary_verification,
)
from document_intelligence.runtime.capability_advertising import (  # noqa: E402
    CapabilityAdvertisingError,
    require_exact_capability_advertisement,
)
from learning.candidate_safety import CandidateArtifactError, validate_candidate_artifact  # noqa: E402
from learning.gc import (  # noqa: E402
    GenerationBarrier,
    RetentionIntegrityError,
    finalize_quarantine,
    plan_gc,
    quarantine,
    verify_retained_artifact,
)


def test_raw_observation_is_immutable_and_fingerprint_bound() -> None:
    observation = RawObservation(
        observation_id="fixture-1",
        captured_at="2026-01-01T00:00:00+00:00",
        producer_authority="ghatana.paddleocr",
        provider_ref="ghatana.paddleocr",
        model_identity={"family": "paddleocr", "digest": "sha256:" + "a" * 64},
        payload={"text": "safe fixture", "regions": [{"x": 0.1, "y": 0.2}]},
        rescoreability=Rescoreability(True, True),
    )
    record = observation.to_record()
    assert RawObservation.from_record(record).to_record() == record
    tampered = {**record, "payload": {"text": "changed"}}
    with pytest.raises(GovernanceError, match="fingerprint"):
        RawObservation.from_record(tampered)
    with pytest.raises(GovernanceError, match="sensitive"):
        RawObservation(
            observation.observation_id,
            observation.captured_at,
            observation.producer_authority,
            observation.provider_ref,
            observation.model_identity,
            {"apiKey": "not-retainable"},
            observation.rescoreability,
        ).to_record()


def test_minimum_verification_ladder_distinguishes_rescore_from_provider_run() -> None:
    assert minimum_necessary_verification(
        dependency_changed=False, behavioral_change=True, raw_observation_compatible=False, focused_proof_sufficient=False
    ) is VerificationAction.REUSE_PASS
    assert minimum_necessary_verification(
        dependency_changed=True, behavioral_change=False, raw_observation_compatible=False, focused_proof_sufficient=False
    ) is VerificationAction.RECONCILE
    assert minimum_necessary_verification(
        dependency_changed=True, behavioral_change=True, raw_observation_compatible=True, focused_proof_sufficient=False
    ) is VerificationAction.RE_SCORE
    assert minimum_necessary_verification(
        dependency_changed=True, behavioral_change=True, raw_observation_compatible=False, focused_proof_sufficient=False
    ) is VerificationAction.PROVIDER_EXECUTION


def test_filesystem_identity_rejects_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    inside = root / "material.txt"
    inside.write_text("inside", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    assert canonical_filesystem_identity(inside, root)["repoRelativePath"] == "material.txt"
    link = root / "escape.txt"
    link.symlink_to(outside)
    with pytest.raises(GovernanceError, match="escapes"):
        canonical_filesystem_identity(link, root)


def test_source_snapshot_fails_closed_without_repository_metadata(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    (root / "owned.txt").write_text("owned", encoding="utf-8")
    with pytest.raises(GovernanceError, match="tracked state"):
        build_source_snapshot(root, ("owned.txt",))


def test_environment_authority_ignores_irrelevant_host_values() -> None:
    first = environment_authority(
        {"pythonAbi": "3.12", "hostname": "a", "runtimeClass": "CPU_X86_64"},
        {EnvironmentTier.PYTHON_RUNTIME_BOUND},
    )
    second = environment_authority(
        {"pythonAbi": "3.12", "hostname": "b", "runtimeClass": "GPU_CUDA"},
        {EnvironmentTier.PYTHON_RUNTIME_BOUND},
    )
    assert first["environmentFingerprint"] == second["environmentFingerprint"]


def test_profile_composition_has_explicit_precedence_and_rejects_ambiguous_duplicates() -> None:
    composed = compose_profiles(
        {"providers": ["canonical"], "languages": ["en"]},
        {"providers": ["extension"], "languages": ["en", "ne"]},
        {"providerOverrides": {"extension": {"enabled": False}}, "languages": ["en", "ne", "hi"]},
    )
    assert composed["providers"] == ["canonical", "extension"]
    assert composed["languages"] == ["en", "ne", "hi"]
    with pytest.raises(GovernanceError, match="duplicates"):
        compose_profiles({"providers": ["canonical"]}, {"providers": ["canonical"]})


def test_gc_generation_barrier_and_two_stage_deletion(tmp_path: Path) -> None:
    active = tmp_path / "active.json"
    stale = tmp_path / "stale.json"
    active.write_text("active", encoding="utf-8")
    stale.write_text("stale", encoding="utf-8")
    barrier = GenerationBarrier()
    barrier.begin("run-1", (str(active),))
    plan = plan_gc((active, stale), reachable=(), barrier=barrier)
    assert plan.candidates == (stale,)
    moved = quarantine(plan, tmp_path / "quarantine")
    assert not stale.exists() and moved
    barrier.complete("run-1")
    assert finalize_quarantine(moved, reachable=(), barrier=barrier) == moved


def test_retained_artifact_integrity_rejects_corruption(tmp_path: Path) -> None:
    artifact = tmp_path / "evidence.json"
    artifact.write_text(json.dumps({"status": "PASS"}), encoding="utf-8")
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    verify_retained_artifact(
        artifact,
        expected_sha256=digest,
        expected_size=artifact.stat().st_size,
        manifest={"schemaVersion": "evidence.v1", "status": "COMPLETE"},
    )
    artifact.write_text("corrupt", encoding="utf-8")
    with pytest.raises(RetentionIntegrityError):
        verify_retained_artifact(artifact, expected_sha256=digest)


def test_candidate_artifact_policy_rejects_pickle_like_formats(tmp_path: Path) -> None:
    unsafe = tmp_path / "candidate.pkl"
    unsafe.write_bytes(b"pickle")
    with pytest.raises(CandidateArtifactError, match="sandbox"):
        validate_candidate_artifact(unsafe)
    safe = tmp_path / "candidate.safetensors"
    safe.write_bytes(b"tensor")
    assert validate_candidate_artifact(safe)["loaderPolicy"] == "SAFE_DECLARATIVE"


def test_negative_capability_advertisement_cannot_leak() -> None:
    registry = {
        "capabilities": {
            "ocr.en": {"developmentState": "QUALIFIED", "consumerAdmission": "ALLOWED", "profiles": ["default"]},
            "extraction.hi": {"developmentState": "NOT_QUALIFIED", "consumerAdmission": "DENIED", "profiles": ["default"]},
        }
    }
    assert require_exact_capability_advertisement(registry, "default", ["ocr.en"]) == {"ocr.en"}
    with pytest.raises(CapabilityAdvertisingError):
        require_exact_capability_advertisement(registry, "default", ["ocr.en", "extraction.hi"])
