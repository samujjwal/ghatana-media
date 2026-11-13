from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import fp, make_event  # noqa: E402
from learning.active_learning.queue import ActiveLearningQueue  # noqa: E402
from learning.active_learning.score import score_review  # noqa: E402
from learning.calibration.evaluate import (  # noqa: E402
    emit_calibration_candidate,
    evaluate_calibration,
)
from learning.candidates import registry  # noqa: E402
from learning.candidates.budget import check_regression_budget  # noqa: E402
from learning.candidates.evaluate import (  # noqa: E402
    evaluate_candidate_offline,
    record_evaluation,
)
from learning.candidates.shadow import emit_shadow_receipt  # noqa: E402
from learning.models.candidate_hook import build_model_candidate_manifest  # noqa: E402
from learning.policy.gliner_candidates import generate_policy_candidates  # noqa: E402
from learning.templates.discover import discover_template_candidates  # noqa: E402

AT = "2026-09-21T00:00:00Z"


def test_score_review_prioritizes_low_confidence():
    scored = score_review(
        {"reasons": ["REQUIRED_FIELD_LOW_CONFIDENCE"], "fields": [{"fieldId": "f1", "confidence": 0.4, "status": "UNCERTAIN"}]}
    )
    assert "LOW_CONFIDENCE" in scored["reasonCodes"]
    assert scored["scoreComponents"]["lowConfidence"] > 0.5
    assert scored["priority"] > 0


def test_queue_lifecycle(tmp_path: Path):
    queue = ActiveLearningQueue(tmp_path)
    scored = score_review({"reasons": ["TEMPLATE_AMBIGUOUS"], "fields": []})
    entry = queue.enqueue("exec-1", scored, AT)
    assert entry["status"] == "QUEUED"
    again = queue.enqueue("exec-1", scored, AT)
    assert again["entryId"] == entry["entryId"]
    queue.claim(entry["entryId"], "reviewer-1", AT)
    queue.mark_reviewed(entry["entryId"], AT)
    assert queue.get(entry["entryId"])["status"] == "REVIEWED"


def test_queue_claim_conflict(tmp_path: Path):
    queue = ActiveLearningQueue(tmp_path)
    entry = queue.enqueue("exec-1", score_review({"reasons": ["TEMPLATE_AMBIGUOUS"], "fields": []}), AT)
    queue.claim(entry["entryId"], "a", AT)
    with pytest.raises(ValueError):
        queue.claim(entry["entryId"], "b", AT)


def test_budget_pass_and_fail():
    budget = {
        "schemaVersion": "document-intelligence.regression-budget.v1",
        "budgetRef": "b1",
        "version": 1,
        "bounds": {"maxQualityRegression": 0.0},
    }
    ok = check_regression_budget(budget, {"quality": 0.9}, {"quality": 0.91})
    assert ok["result"] == "PASS"
    bad = check_regression_budget(budget, {"quality": 0.9}, {"quality": 0.8})
    assert bad["result"] == "FAIL"
    assert bad["violations"]


def test_offline_evaluation_records_without_overwrite(tmp_path: Path):
    manifest = registry.register(
        tmp_path,
        kind="EXTRACTION_POLICY",
        artifact={"proposedChanges": {}},
        dependencies={
            "baseAuthorityFingerprint": fp("base"),
            "datasetFingerprint": fp("ds"),
            "evaluatorImplementationFingerprint": fp("ev"),
        },
        created_at=AT,
    )
    record = evaluate_candidate_offline(
        manifest,
        {"cases": [{"caseId": "c1", "correct": True}]},
        {"cases": [{"caseId": "c1", "correct": True}]},
        None,
        at=AT,
    )
    record_evaluation(tmp_path, manifest["candidateId"], record)
    loaded = registry.get(tmp_path, manifest["candidateId"])
    assert loaded["evaluation"]["candidateResultFingerprint"].startswith("sha256:")


def test_shadow_receipt_constraints_true(tmp_path: Path):
    receipt = emit_shadow_receipt(
        shadow_run_id="shadow-1",
        candidate_id="cand-1",
        candidate_fingerprint=fp("cand"),
        evaluation_set_fingerprint=fp("evalset"),
        active_authority_fingerprint=fp("active"),
        case_results=[{"caseId": "c1", "agrees": True}],
        executed_at=AT,
        out_path=tmp_path / "shadow.json",
    )
    assert receipt["constraints"]["userVisibleUnchanged"] is True
    assert receipt["constraints"]["activeAuthorityUnchanged"] is True


def test_calibration_ece_and_candidate(tmp_path: Path):
    observations = [
        {"confidence": 0.9, "correct": True},
        {"confidence": 0.8, "correct": False},
        {"confidence": 0.4, "correct": False},
        {"confidence": 1.0, "correct": True},
    ]
    metrics = evaluate_calibration(observations, bins=10)
    assert 0 <= metrics["metrics"]["expectedCalibrationError"] <= 1
    artifact = emit_calibration_candidate(
        observations,
        parent_authority_fingerprint=fp("active"),
        policy_ref="routing.v1",
        dataset_fingerprint=fp("ds"),
        algorithm={"name": "isotonic", "version": "1"},
        candidate_thresholds={"lowConfidenceReviewFloor": 0.75},
        limitations=["small sample"],
        out_path=tmp_path / "cal.json",
    )
    assert artifact["kind"] == "CONFIDENCE_CALIBRATION"
    assert artifact["state"] == "CANDIDATE"


def test_template_discovery_provenance():
    events = [
        make_event("a"),
        make_event("b"),
    ]
    for e in events:
        e["review"]["reviewReasons"] = ["TEMPLATE_UNMATCHED"]
        e["eventFingerprint"] = __import__("learning.util", fromlist=["digest"]).digest(
            {k: v for k, v in e.items() if k != "eventFingerprint"}
        )
    candidates = discover_template_candidates(events, embedding_model_identity="minilm-1110a24")
    assert candidates
    for candidate in candidates:
        assert candidate["kind"] == "TEMPLATE_DISCOVERY"
        assert candidate["provenance"]["supportingFeedbackEventIds"]


def test_gliner_policy_candidate():
    events = [make_event(str(i)) for i in range(3)]
    candidates = generate_policy_candidates(
        events,
        parent_authority_fingerprint=fp("active"),
        policy_ref="gliner-mapping.v1",
    )
    for candidate in candidates:
        assert candidate["kind"] == "EXTRACTION_POLICY"
        assert candidate["state"] == "CANDIDATE"


def test_model_candidate_hook(tmp_path: Path):
    manifest = build_model_candidate_manifest(
        base_model="sentence-transformers/all-MiniLM-L6-v2",
        model_asset_hashes={"model.safetensors": fp("weights")},
        reproducibility={
            "trainingCodeFingerprint": fp("trainer"),
            "datasetFingerprint": fp("ds"),
            "baseModelFingerprint": fp("base-model"),
            "dependencyLockFingerprint": fp("deps-lock"),
            "tokenizerFingerprint": fp("tokenizer"),
            "seed": 7,
            "hyperparameters": {"epochs": 1},
            "runtime": "python3.12",
            "nativeLibraries": [],
            "deterministic": True,
        },
        base_authority_fingerprint=fp("base"),
        evaluator_implementation_fingerprint=fp("ev"),
        created_at=AT,
        registry_root=tmp_path,
    )
    assert manifest["candidateKind"] == "MODEL"
    assert manifest["model"]["baseModel"] == "sentence-transformers/all-MiniLM-L6-v2"
    assert manifest["model"]["datasetFingerprint"] == fp("ds")
    assert manifest["dependencies"]["datasetFingerprint"] == fp("ds")
