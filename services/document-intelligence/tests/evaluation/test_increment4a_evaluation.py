from __future__ import annotations

import importlib.util
import hashlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LANE = ROOT / "evaluation/increment4a"
sys.path.insert(0, str(ROOT))

from evaluation.increment4a.metrics import aggregate, error_rate, percentile  # noqa: E402
from evaluation.increment4a.run_qualification import digest, evaluate, fingerprints, implementation_fingerprints, project_capabilities  # noqa: E402
import evaluation.increment4a.run_qualification as qualification  # noqa: E402


def test_qualification_binds_its_local_metrics_module() -> None:
    assert qualification.aggregate.__module__ == "evaluation.increment4a.metrics"


def test_metrics_measure_observations_without_defaulting_missing_surface() -> None:
    metrics = aggregate([{"expectedText": "one two", "actualText": "one too", "latencyMs": 10, "error": None}])
    assert metrics["text.cer"] > 0
    assert metrics["text.wer"] == 0.5
    assert metrics["runtime.p95LatencyMs"] == 10
    assert "language.accuracy" not in metrics
    assert error_rate("", "x") == 1
    assert percentile([10, 20], 0.95) == 19.5


def test_incomplete_observations_cannot_qualify_or_promote() -> None:
    summary, capabilities = evaluate([])
    assert summary["status"] == "NOT_RUN"
    assert summary["missingFixtures"]
    assert capabilities["accepted"] == []


def test_failed_threshold_cannot_promote() -> None:
    manifest = __import__("yaml").safe_load((LANE / "manifest.yaml").read_text())
    observations = []
    for fixture in manifest["fixtures"]:
        observations.append({
            "fixtureId": fixture["fixtureId"], "expectedText": "good", "actualText": "bad",
            "expectedLanguage": fixture["language"], "actualLanguage": "wrong", "layoutIoU": 0,
            "structureAccuracy": 0, "entityF1": 0.0, "fallbackEligible": fixture["mode"] == "ocr-fallback",
            "fallbackAttempted": False, "fallbackSucceeded": False, "latencyMs": 40000,
            "peakRssDeltaMb": 3000, "cancellationCheckMs": 2000, "error": None,
            "providerProvenance": {"providerRef": "ghatana.paddleocr", "providerVersion": "0.1.0", "modelRef": "PP-OCRv5-en", "modelVersion": "pinned"},
        })
    summary, capabilities = evaluate(observations)
    assert summary["status"] == "FAIL"
    assert capabilities["accepted"] == []
    assert all(len(value) == 64 for value in fingerprints().values())


def test_verifier_reports_canonical_lane_truthfully() -> None:
    spec = importlib.util.spec_from_file_location("verify_increment4a", ROOT / "scripts/verify_increment4a.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    assert module.evaluation_checks() == ("PASS", "PASS", "PASS")
    assert set(module.material_fingerprints()) == {
        *{f"{name}Fingerprint" for name in module.FROZEN_MATERIAL},
        "providerSemanticsFingerprint",
        "evaluationImplementationFingerprint",
    }


def test_reused_observations_with_unrecorded_provider_semantics_are_stale() -> None:
    observations = [{
        "fixtureId": "DOCX-EN-001",
        "status": "PASS",
        "providerProvenance": {
            "providerRef": "ghatana.docling-docx",
            "providerVersion": "0.1.0",
            "modelRef": "docling-rendered-docx-pipeline",
            "modelVersion": "pinned-docling-runtime",
        },
    }]
    reuse = {
        "observationSourceRunId": "legacy-r4",
        "sourceObservationsFingerprint": digest(observations),
        "sourceSummaryFingerprint": "1" * 64,
        "sourceProviderSemanticsFingerprint": None,
        "historicalProviderSemanticsBinding": "UNRECORDED",
        "providerExecutionReused": True,
    }

    summary, capabilities = evaluate(observations, reuse)

    assert summary["status"] == "STALE"
    assert summary["fixtureLeaves"]["DOCX-EN-001"]["status"] == "STALE"
    assert summary["requiredLeaves"]["fixture:DOCX-EN-001"]["status"] == "STALE"
    assert summary["observationReuse"]["providerSemanticsBindingStatus"] == "STALE"
    assert capabilities["qualificationStatus"] == "STALE"
    assert capabilities["promotable"] is False
    assert capabilities["accepted"] == []


def test_reused_observations_with_mismatched_provider_semantics_are_stale() -> None:
    observations = [{
        "fixtureId": "DOCX-EN-001",
        "status": "PASS",
        "providerProvenance": {
            "providerRef": "ghatana.docling-docx",
            "providerVersion": "0.1.0",
            "modelRef": "docling-rendered-docx-pipeline",
            "modelVersion": "pinned-docling-runtime",
        },
    }]
    reuse = {
        "observationSourceRunId": "old-semantics-run",
        "sourceObservationsFingerprint": digest(observations),
        "sourceSummaryFingerprint": "1" * 64,
        "sourceProviderSemanticsFingerprint": "0" * 64,
        "historicalProviderSemanticsBinding": "RECORDED",
        "providerExecutionReused": True,
    }

    summary, capabilities = evaluate(observations, reuse)

    assert summary["status"] == "STALE"
    assert summary["requiredLeaves"]["fixture:DOCX-EN-001"]["status"] == "STALE"
    assert summary["observationReuse"]["providerSemanticsBindingStatus"] == "STALE"
    assert capabilities["promotable"] is False
    assert capabilities["accepted"] == []


def test_reused_observations_with_current_provider_semantics_remain_eligible() -> None:
    source_run = LANE / "results/20260922T010529Z-canonical"
    observations = json.loads((source_run / "observations.json").read_text(encoding="utf-8"))
    source_summary = json.loads((source_run / "summary.json").read_text(encoding="utf-8"))
    current_provider_fingerprint = implementation_fingerprints(ROOT)["providerSemanticsFingerprint"]
    assert source_summary["providerSemanticsFingerprint"] == current_provider_fingerprint
    reuse = {
        "observationSourceRunId": source_run.name,
        "sourceObservationsFingerprint": digest(observations),
        "sourceSummaryFingerprint": "1" * 64,
        "sourceProviderSemanticsFingerprint": current_provider_fingerprint,
        "sourceEvaluationImplementationFingerprint": source_summary["evaluationImplementationFingerprint"],
        "historicalProviderSemanticsBinding": "RECORDED",
        "providerExecutionReused": True,
    }

    summary, capabilities = evaluate(observations, reuse)

    assert summary["status"] == "PASS"
    assert summary["observationReuse"]["providerSemanticsBindingStatus"] == "PASS"
    assert summary["observationReuse"]["expectedProviderSemanticsFingerprint"] == current_provider_fingerprint
    assert capabilities["promotable"] is True
    assert capabilities["accepted"]


def _write_anchored_direct_source(lane: Path, run_id: str) -> tuple[Path, list[dict], str, str]:
    run = lane / "results" / run_id
    run.mkdir(parents=True)
    observations = [{"fixtureId": "DOCX-EN-001", "status": "PASS"}]
    observations_fingerprint = digest(observations)
    implementation = implementation_fingerprints(ROOT)
    materials = qualification.material_fingerprints()
    material_fingerprint = digest(materials)
    raw_fingerprints = [digest(observations[0])]
    attestation = qualification.build_direct_campaign_attestation(
        observations,
        implementation,
        implementation,
        materials,
        materials,
    )
    attestation_bytes = json.dumps(attestation, sort_keys=True).encode() + b"\n"
    provider_fingerprint = implementation["providerSemanticsFingerprint"]
    (run / "observations.json").write_text(json.dumps(observations), encoding="utf-8")
    (run / "campaign-attestation.json").write_bytes(attestation_bytes)
    summary_path = run / "summary.json"
    summary_path.write_text(json.dumps({
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": provider_fingerprint,
        "evaluationImplementationFingerprint": implementation["evaluationImplementationFingerprint"],
        "materialFingerprints": materials,
        "materialFingerprint": material_fingerprint,
        "rawObservationFingerprints": raw_fingerprints,
    }), encoding="utf-8")
    (run / "lineage.json").write_text(json.dumps({
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": provider_fingerprint,
        "evaluationImplementationFingerprint": implementation["evaluationImplementationFingerprint"],
        "materialFingerprints": materials,
        "rawObservationFingerprints": raw_fingerprints,
        "providerCampaignExecution": "EXECUTED",
        "providerExecutionReused": False,
        "directCampaignAttestationFingerprint": hashlib.sha256(attestation_bytes).hexdigest(),
    }), encoding="utf-8")
    return summary_path, observations, observations_fingerprint, provider_fingerprint


def test_source_run_must_be_pinned_by_active_canonical_summary_hash(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(qualification, "HERE", tmp_path)
    summary_path, observations, observations_fingerprint, provider_fingerprint = _write_anchored_direct_source(tmp_path, "source-a")
    (tmp_path / "canonical-run.json").write_text(json.dumps({
        "schemaVersion": "increment4a.canonical-run.v1",
        "state": "ACTIVE",
        "runId": "source-a",
        "summaryFingerprint": qualification.sha256(summary_path),
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": provider_fingerprint,
    }), encoding="utf-8")

    loaded, reuse = qualification._load_source_observations("source-a")

    assert loaded == observations
    assert reuse["sourceObservationsFingerprint"] == observations_fingerprint
    assert reuse["sourceSummaryFingerprint"] == qualification.sha256(summary_path)

    summary_path.write_text(summary_path.read_text(encoding="utf-8") + " ", encoding="utf-8")
    with pytest.raises(ValueError, match="not pinned|superseded-run authority"):
        qualification._load_source_observations("source-a")


def test_superseded_source_requires_matching_summary_and_provider_fingerprints(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(qualification, "HERE", tmp_path)
    summary_path, observations, _, provider_fingerprint = _write_anchored_direct_source(tmp_path, "source-a")
    (tmp_path / "superseded-runs.json").write_text(json.dumps({
        "schemaVersion": "increment4a.superseded-runs.v1",
        "runs": [{
            "runId": "source-a",
            "state": "SUPERSEDED",
            "summaryFingerprint": qualification.sha256(summary_path),
            "observationsFingerprint": digest(observations),
            "providerSemanticsFingerprint": provider_fingerprint,
        }],
    }), encoding="utf-8")

    loaded, reuse = qualification._load_source_observations("source-a")

    assert loaded == observations
    assert reuse["sourceSummaryFingerprint"] == qualification.sha256(summary_path)


@pytest.mark.parametrize(
    "archive",
    [
        {"schemaVersion": "wrong", "runs": []},
        {"schemaVersion": "increment4a.superseded-runs.v1", "runs": {}},
    ],
)
def test_source_reuse_rejects_malformed_superseded_archive(tmp_path: Path, monkeypatch, archive: dict) -> None:
    monkeypatch.setattr(qualification, "HERE", tmp_path)
    _write_anchored_direct_source(tmp_path, "source-a")
    (tmp_path / "superseded-runs.json").write_text(json.dumps(archive), encoding="utf-8")

    with pytest.raises(ValueError, match="superseded-run authority is missing or malformed"):
        qualification._load_source_observations("source-a")


def test_source_run_requires_a_valid_own_reuse_binding(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(qualification, "HERE", tmp_path)
    summary_path, _, observations_fingerprint, provider_fingerprint = _write_anchored_direct_source(tmp_path, "source-a")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    invalid_reuse = {"observationSourceRunId": "missing-child", "providerExecutionReused": True}
    summary["observationReuse"] = invalid_reuse
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    (summary_path.parent / "lineage.json").write_text(json.dumps({
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": provider_fingerprint,
        "providerExecutionReused": True,
        "observationReuse": invalid_reuse,
    }), encoding="utf-8")
    (tmp_path / "canonical-run.json").write_text(json.dumps({
        "schemaVersion": "increment4a.canonical-run.v1",
        "state": "ACTIVE",
        "runId": "source-a",
        "summaryFingerprint": qualification.sha256(summary_path),
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": provider_fingerprint,
    }), encoding="utf-8")

    with pytest.raises(ValueError, match="missing readable summary"):
        qualification._load_source_observations("source-a")


def test_direct_campaign_attestation_builder_and_validator_accept_matching_evidence() -> None:
    observations = [{"fixtureId": "DOCX-EN-001", "status": "PASS"}]
    implementation = implementation_fingerprints(ROOT)
    materials = qualification.material_fingerprints()

    attestation = qualification.build_direct_campaign_attestation(observations, implementation, implementation, materials, materials)

    assert qualification.validate_direct_campaign_attestation(observations, attestation) == attestation
    with pytest.raises(ValueError, match="changed during"):
        qualification.build_direct_campaign_attestation(observations, implementation, {}, materials, materials)


def test_run_qualification_rejects_normalized_observations_without_attestation(tmp_path: Path, monkeypatch) -> None:
    observations_path = tmp_path / "observations.json"
    observations_path.write_text(json.dumps([{"fixtureId": "DOCX-EN-001", "status": "PASS"}]))
    output = tmp_path / "run-output"
    monkeypatch.setattr(sys, "argv", ["run_qualification.py", "--observations", str(observations_path), "--output", str(output)])

    assert qualification.main() == 2
    assert not output.exists()


def test_run_qualification_rejects_forged_direct_campaign_attestation(tmp_path: Path, monkeypatch) -> None:
    observations = [{"fixtureId": "DOCX-EN-001", "status": "PASS"}]
    observations_path = tmp_path / "observations.json"
    observations_path.write_text(json.dumps(observations))
    implementation = implementation_fingerprints(ROOT)
    materials = qualification.material_fingerprints()
    attestation = qualification.build_direct_campaign_attestation(observations, implementation, implementation, materials, materials)
    attestation["observationsFingerprint"] = "0" * 64
    observations_path.with_suffix(".attestation.json").write_text(json.dumps(attestation))
    output = tmp_path / "run-output"
    monkeypatch.setattr(sys, "argv", ["run_qualification.py", "--observations", str(observations_path), "--output", str(output)])

    assert qualification.main() == 2
    assert not output.exists()


def test_run_campaign_observations_only_writes_bound_attestation(tmp_path: Path, monkeypatch) -> None:
    spec = importlib.util.spec_from_file_location("increment4a_run_campaign_test", LANE / "run_campaign.py")
    campaign = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(campaign)
    observations = [{
        "fixtureId": "DOCX-EN-001",
        "status": "PASS",
        "providerProvenance": {"providerRef": "ghatana.docling-docx", "providerVersion": "test", "modelRef": "test", "modelVersion": "test"},
        "rawObservation": {"text": "measured"},
    }]
    output = tmp_path / "observations.json"
    monkeypatch.setattr(campaign, "produce", lambda _manifest: observations)
    monkeypatch.setattr(sys, "argv", ["run_campaign.py", "--observations-only", str(output)])

    assert campaign.main() == 0

    attestation_path = output.with_suffix(".attestation.json")
    attestation = json.loads(attestation_path.read_text(encoding="utf-8"))
    assert attestation["providerCampaignExecution"] == "EXECUTED"
    assert attestation["providerExecutionReused"] is False
    assert qualification.validate_direct_campaign_attestation(
        json.loads(output.read_text(encoding="utf-8")), attestation
    ) == attestation


def test_run_qualification_persists_matching_direct_campaign_attestation(tmp_path: Path, monkeypatch) -> None:
    observations = [{"fixtureId": "DOCX-EN-001", "status": "PASS"}]
    observations_path = tmp_path / "observations.json"
    observations_path.write_text(json.dumps(observations))
    implementation = implementation_fingerprints(ROOT)
    materials = qualification.material_fingerprints()
    attestation = qualification.build_direct_campaign_attestation(observations, implementation, implementation, materials, materials)
    attestation_bytes = json.dumps(attestation, ensure_ascii=False, indent=2, sort_keys=True).encode() + b"\n"
    observations_path.with_suffix(".attestation.json").write_bytes(attestation_bytes)
    output = tmp_path / "run-output"
    monkeypatch.setattr(sys, "argv", ["run_qualification.py", "--observations", str(observations_path), "--output", str(output)])

    assert qualification.main() == 1  # The one-observation fixture is incomplete, but its campaign receipt is valid.
    lineage = json.loads((output / "lineage.json").read_text())
    assert lineage["providerCampaignExecution"] == "EXECUTED"
    assert lineage["providerExecutionReused"] is False
    assert lineage["directCampaignAttestationFingerprint"] == hashlib.sha256(attestation_bytes).hexdigest()
    assert (output / "campaign-attestation.json").read_bytes() == attestation_bytes


def test_capability_state_is_provider_and_language_dimensional() -> None:
    manifest = __import__("yaml").safe_load((LANE / "manifest.yaml").read_text())
    policy = __import__("yaml").safe_load((LANE / "acceptance.yaml").read_text())
    provenance = {
        "providerRef": "ghatana.paddleocr", "providerVersion": "3.7.0",
        "modelRef": "PP-OCRv5-devanagari-shared", "modelVersion": "pinned",
    }
    observations = [
        {
            "capability": "ocr.paddle.hi", "capabilityId": "ocr.paddle.hi", "language": "hi",
            "expectedText": "चालान १००१", "actualText": "चालान १००१",
            "expectedLanguage": "hi", "actualLanguage": "hi", "providerProvenance": provenance,
        },
        {
            "capability": "extraction.schema-guided.hi", "capabilityId": "extraction.schema-guided.hi", "language": "hi",
            "entityF1": 0.25, "evidenceAccuracy": 0.9,
            "providerProvenance": {**provenance, "providerRef": "ghatana.gliner", "modelRef": "gliner-hi"},
        },
    ]
    projection = project_capabilities(observations, manifest, policy)
    assert projection["dimensions"]["ocr.paddle.hi"]["hi"]["status"] == "PASS"
    assert projection["dimensions"]["extraction.schema-guided.hi"]["hi"]["status"] == "FAIL"
    assert {item["capabilityId"] for item in projection["accepted"]} == {"ocr.paddle.hi"}
    assert all(item["language"] == "hi" for item in projection["accepted"])
    capability_ids = {item["capabilityId"] for item in projection["capabilities"]}
    assert "ocr.paddle.hi" in capability_ids
    assert "extraction.schema-guided.hi" in capability_ids
    assert "QUALIFIED" in {item["state"] for item in projection["capabilities"] if item["capabilityId"] == "ocr.paddle.hi"}
    assert "NOT_QUALIFIED" in {item["state"] for item in projection["capabilities"] if item["capabilityId"] == "extraction.schema-guided.hi"}
    assert "UNSUPPORTED_BY_DESIGN" in {item["state"] for item in projection["capabilities"]}
    assert not any(item["capabilityId"].startswith("language.") for item in projection["capabilities"])


def test_skipped_or_missing_required_leaves_are_not_run() -> None:
    summary, capabilities = evaluate([{"fixtureId": "DOCX-EN-001", "status": "NOT_RUN", "skipped": True}])
    assert summary["fixtureLeaves"]["DOCX-EN-001"]["status"] == "NOT_RUN"
    assert summary["requiredLeaves"]["fixture:DOCX-EN-001"]["status"] == "NOT_RUN"
    assert summary["status"] == "NOT_RUN"
    assert capabilities["accepted"] == []
