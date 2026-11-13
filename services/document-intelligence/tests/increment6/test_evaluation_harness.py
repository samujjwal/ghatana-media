"""Increment-6 evaluation harness tests (I6-06..I6-20 corpora/authorities, I6-36..I6-39 runners)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import jsonschema
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
LANE = ROOT / "evaluation/increment6"
sys.path.insert(0, str(ROOT))

from evaluation.increment6 import run_qualification as qualification  # noqa: E402
from evaluation.increment6.implementation_material import implementation_fingerprints, missing_sources  # noqa: E402
from evaluation.increment6.runners import chaos_runner, load_runner, soak_runner  # noqa: E402
from evaluation.increment6.runners.evidence_common import omitted_field_digest  # noqa: E402

SCHEMA = json.loads((LANE / "schemas/performance-evidence.v1.schema.json").read_text(encoding="utf-8"))
EXPECTED_LANES = {
    "scanned-pdf",
    "hybrid-provenance",
    "office-docx",
    "office-pptx",
    "office-xlsx",
    "hi-mr-ocr",
    "hi-mr-extraction",
    "complex-layout",
    "scanned-table-regression",
}
I4A_EXTRACTION_THRESHOLD = 0.8


def _manifest() -> dict:
    return yaml.safe_load((LANE / "manifest.yaml").read_text(encoding="utf-8"))


def _acceptance() -> dict:
    return yaml.safe_load((LANE / "acceptance.yaml").read_text(encoding="utf-8"))


def _lane_fixtures(lane_id: str) -> dict:
    return yaml.safe_load((LANE / "corpus" / lane_id / "fixtures.yaml").read_text(encoding="utf-8"))


def test_manifest_loads_and_declares_all_lanes() -> None:
    manifest = _manifest()
    assert manifest["schemaVersion"] == "increment6.manifest.v1"
    lanes = {lane["id"]: lane for lane in manifest["lanes"]}
    assert set(lanes) == EXPECTED_LANES
    for lane_id, lane in lanes.items():
        assert lane["purpose"]
        assert lane["ownerCapabilityIds"]
        assert (LANE / lane["corpusDir"]).is_dir()
        assert (LANE / lane["fixturesManifest"]).is_file()
    # Every owner capability is declared as a manifest dimension.
    dimension_ids = {item["capabilityId"] for item in manifest["capabilityDimensions"]}
    for lane in lanes.values():
        assert set(lane["ownerCapabilityIds"]) <= dimension_ids


def test_lane_fixture_manifests_parse_and_are_complete() -> None:
    manifest = _manifest()
    declared = qualification.load_lane_fixtures(manifest)
    assert len(declared) >= 3 * len(EXPECTED_LANES)
    assert {item["fixtureId"] for item in declared} == {
        fixture["fixtureId"]
        for lane_id in EXPECTED_LANES
        for fixture in _lane_fixtures(lane_id)["fixtures"]
    }
    for lane_id in EXPECTED_LANES:
        spec = _lane_fixtures(lane_id)
        assert spec["schemaVersion"] == "increment6.fixtures.v1"
        assert spec["lane"] == lane_id
        fixtures = spec["fixtures"]
        # scanned-pdf carries 8 fixtures (every document class x language
        # breadth); all other lanes carry 3-4 declared fixtures.
        assert 3 <= len(fixtures) <= (8 if lane_id == "scanned-pdf" else 4)
        for fixture in fixtures:
            assert fixture["fixtureId"]
            assert fixture["mediaType"]
            assert fixture["language"] in {"en", "ne", "hi", "mr"}
            assert fixture["truthSource"]
            assert "expectedDocumentClass" in fixture or "expectedCapability" in fixture


def test_fixture_binaries_are_declared_not_present_and_tolerated() -> None:
    for lane_id in EXPECTED_LANES:
        spec = _lane_fixtures(lane_id)
        assert spec["fixtureBinaryPolicy"] == "DECLARED_NOT_PRESENT"
        for fixture in spec["fixtures"]:
            assert fixture["binaryState"] == "DECLARED_NOT_PRESENT"
            # Manifest-level tolerance: the binary is absent but the lane loads.
            assert not (LANE / "corpus" / lane_id / fixture["file"]).exists()


def test_binary_dependent_lanes_are_deferred_without_widening_required_lanes() -> None:
    manifest = _manifest()
    lanes = {lane["id"]: lane for lane in manifest["lanes"]}
    dimensions = {
        item["capabilityId"]: item for item in manifest["capabilityDimensions"]
    }
    deferred_lanes = {
        "office-docx",
        "office-pptx",
        "office-xlsx",
        "hi-mr-ocr",
        "hi-mr-extraction",
        "complex-layout",
    }
    for lane_id in deferred_lanes:
        assert all(
            dimensions[capability_id]["closureDisposition"] == "DEFERRED_TO_FUTURE_RELEASE"
            for capability_id in lanes[lane_id]["ownerCapabilityIds"]
        )
        for capability_id in lanes[lane_id]["ownerCapabilityIds"]:
            dimension = dimensions[capability_id]
            assert dimension["deferredReason"].startswith("FIXTURE_BINARY_DECLARED_NOT_PRESENT")
            assert dimension["deferredTarget"] == "FUTURE_RELEASE"
            assert dimension["revisitTrigger"]
    assert all(
        dimensions[capability_id]["closureDisposition"] == "REQUIRED"
        for lane_id in ("scanned-pdf", "hybrid-provenance")
        for capability_id in lanes[lane_id]["ownerCapabilityIds"]
    )
    assert all(
        dimensions[capability_id]["closureDisposition"] == "UNSUPPORTED_BY_DESIGN"
        for capability_id in lanes["scanned-table-regression"]["ownerCapabilityIds"]
    )

    declared = qualification.load_lane_fixtures(manifest)
    by_id = {fixture["fixtureId"]: fixture for fixture in declared}
    assert by_id["I6-DOCX-EN-001"]["closureDisposition"] == "DEFERRED_TO_FUTURE_RELEASE"
    assert by_id["I6-SCAN-EN-001"]["closureDisposition"] == "REQUIRED"


def test_deferred_missing_fixture_is_not_promoted_to_required_evidence() -> None:
    manifest = _manifest()
    declared = qualification.load_lane_fixtures(manifest)
    leaves = qualification._fixture_leaves(
        [
            {
                "fixtureId": "I6-SCAN-EN-001",
                "status": "PASS",
                "providerProvenance": {
                    "providerRef": "test",
                    "providerVersion": "1",
                    "modelRef": "test",
                    "modelVersion": "1",
                },
            },
            {
                "fixtureId": "I6-DOCX-EN-001",
                "status": "NOT_RUN",
                "skipped": True,
            },
        ],
        declared,
    )
    assert leaves["I6-DOCX-EN-001"]["status"] == "NOT_RUN"
    assert leaves["I6-DOCX-EN-001"]["closureDisposition"] == "DEFERRED_TO_FUTURE_RELEASE"
    assert leaves["I6-SCAN-EN-001"]["closureDisposition"] == "REQUIRED"


def test_hi_mr_schema_extraction_uses_release_readiness_external_gate() -> None:
    registry = yaml.safe_load(
        (ROOT / "capabilities/document-intelligence-capabilities.yaml").read_text(
            encoding="utf-8"
        )
    )
    for capability_id in ("extraction.schema-guided.hi.v2", "extraction.schema-guided.mr.v2"):
        capability = registry["capabilities"][capability_id]
        assert capability["developmentState"] == "NOT_QUALIFIED"
        assert capability["consumerAdmission"] == "DENIED"
        assert capability["profiles"] == ["increment6"]
        assert capability["futureOwner"] == "DEFERRED_TO_RELEASE_READINESS"
        assert capability["reason"] == "EXTERNAL_CERTIFICATION_RELEASE_READINESS_GATE"


def test_acceptance_thresholds_cover_i6_surfaces() -> None:
    policy = _acceptance()
    metrics = policy["metrics"]
    assert metrics["classification.accuracy"] == {"operator": "gte", "value": 0.95}
    assert metrics["provenance.completeness"] == {"operator": "gte", "value": 1.0}
    # Office lanes reuse I4A-qualified providers: thresholds mirror increment4a.
    assert metrics["office.structureAccuracy"] == {"operator": "gte", "value": 0.9}
    assert metrics["language.accuracy"] == {"operator": "gte", "value": 0.95}
    assert policy["requirements"]["negativeLaneAssertions"]["scanned-table-regression"] == "UNSUPPORTED_BY_DESIGN"


def test_extraction_thresholds_are_lower_than_canonical_with_reason() -> None:
    policy = _acceptance()
    for capability in ("extraction.schema-guided.hi.v2", "extraction.schema-guided.mr.v2"):
        rules = policy["capabilityMetrics"][capability]
        for metric in ("gliner.entityF1", "gliner.evidenceAccuracy"):
            rule = rules[metric]
            assert rule["operator"] == "gte"
            assert rule["value"] < I4A_EXTRACTION_THRESHOLD
            assert isinstance(rule.get("reason"), str) and rule["reason"]


def test_scanned_table_regression_lane_asserts_unsupported() -> None:
    manifest = _manifest()
    lane = next(item for item in manifest["lanes"] if item["id"] == "scanned-table-regression")
    assert lane["negativeLane"] is True
    assert lane["expectedDisposition"] == "UNSUPPORTED_BY_DESIGN"
    spec = _lane_fixtures("scanned-table-regression")
    assert spec["negativeLane"] is True
    for fixture in spec["fixtures"]:
        assert fixture["expectedDisposition"] == "UNSUPPORTED_BY_DESIGN"
        capability = fixture["expectedCapability"]
        dimension = next(item for item in manifest["capabilityDimensions"] if item["capabilityId"] == capability)
        assert dimension["closureDisposition"] == "UNSUPPORTED_BY_DESIGN"


def test_material_fingerprints_cover_the_i6_authority_set() -> None:
    material = qualification.material_fingerprints()
    expected_keys = {
        "manifestFingerprint",
        "qualificationFingerprint",
        "acceptanceFingerprint",
        "environmentFingerprint",
        "corpusFingerprint",
        "requiredTestsFingerprint",
        "implementationMaterialFingerprint",
        "performanceEvidenceSchemaFingerprint",
        "scannedPdfRoutingFingerprint",
        "fallbackContractRoutingFingerprint",
        "workerProfileFingerprint",
        "providerSemanticsFingerprint",
        "evaluationImplementationFingerprint",
    }
    assert expected_keys <= set(material)
    for key, value in material.items():
        assert value == "MISSING" or (isinstance(value, str) and len(value) == 64), key
    fingerprints = implementation_fingerprints(ROOT)
    assert len(fingerprints["providerSemanticsFingerprint"]) == 64
    assert len(fingerprints["evaluationImplementationFingerprint"]) == 64


def test_declared_but_absent_sources_are_tolerated() -> None:
    # Missing declared sources record MISSING rather than failing, so lanes
    # tolerate content that has not landed yet.
    assert qualification._material_digest(LANE / "does-not-exist.bin") == "MISSING"
    absent = missing_sources(ROOT)
    for group, sources in absent.items():
        assert sources, group


def test_evaluate_without_observations_is_not_run_and_never_promotes() -> None:
    summary, capabilities = qualification.evaluate([])
    assert summary["status"] == "NOT_RUN"
    assert summary["missingFixtures"]
    assert summary["declaredFixtureCount"] >= 3 * len(EXPECTED_LANES)
    assert capabilities["accepted"] == []
    assert capabilities["promotable"] is False


def test_load_runner_emits_schema_valid_evidence(tmp_path: Path) -> None:
    config = {"seed": 7, "fixtureCount": 24, "concurrency": 4, "baseLatencyMs": 100.0, "jitterMs": 50.0}
    evidence = load_runner.run(config)
    jsonschema.validate(evidence, SCHEMA)
    assert evidence["runnerRef"] == "evaluation/increment6/runners/load_runner.py"
    assert evidence["workload"] == {"fixtureCount": 24, "concurrency": 4, "durationSeconds": evidence["workload"]["durationSeconds"]}
    invocations = evidence["providerInvocations"]
    assert invocations == {"attempted": 24, "completed": 24, "cancelled": 0, "timedOut": 0, "failed": 0}
    assert evidence["metrics"]["errorRate"] == 0.0
    assert evidence["resultFingerprint"] == omitted_field_digest(evidence)


def test_soak_runner_emits_schema_valid_evidence() -> None:
    config = {"seed": 3, "durationSeconds": 120.0, "ratePerSecond": 2.0, "concurrency": 2}
    evidence = soak_runner.run(config)
    jsonschema.validate(evidence, SCHEMA)
    assert evidence["workload"]["fixtureCount"] == 240
    assert evidence["metrics"]["rssPeakBytes"] > int(config.get("baseRssBytes", 0)) or evidence["metrics"]["rssPeakBytes"] > 0


def test_chaos_runner_records_observed_vs_expected_taxonomy() -> None:
    config = {
        "seed": 11,
        "fixtureCount": 200,
        "concurrency": 4,
        "injection": {"PROVIDER_TIMEOUT": 0.1, "PROVIDER_CRASH": 0.05},
    }
    evidence = chaos_runner.run(config)
    jsonschema.validate(evidence, SCHEMA)
    taxonomy = evidence["failureTaxonomy"]
    assert taxonomy["expected"] == {"PROVIDER_TIMEOUT": 0.1, "PROVIDER_CRASH": 0.05}
    observed = taxonomy["observed"]
    assert set(observed) == {"PROVIDER_TIMEOUT", "PROVIDER_CRASH"}
    invocations = evidence["providerInvocations"]
    assert invocations["timedOut"] == observed["PROVIDER_TIMEOUT"]
    assert invocations["failed"] == observed["PROVIDER_CRASH"]
    assert observed["PROVIDER_TIMEOUT"] + observed["PROVIDER_CRASH"] == invocations["timedOut"] + invocations["failed"]
    assert invocations["attempted"] == 200
    assert 0.0 < evidence["metrics"]["errorRate"] < 1.0


def test_runners_are_deterministic_given_the_same_seed(tmp_path: Path) -> None:
    config = {"seed": 42, "fixtureCount": 16, "concurrency": 2}
    first = load_runner.run(config)
    second = load_runner.run(config)
    assert first == second
    assert first["resultFingerprint"] == second["resultFingerprint"]
    chaos_config = {"seed": 42, "fixtureCount": 50, "injection": {"PROVIDER_CRASH": 0.2}}
    assert chaos_runner.run(chaos_config)["resultFingerprint"] == chaos_runner.run(chaos_config)["resultFingerprint"]
    different = load_runner.run({**config, "seed": 43})
    assert different["resultFingerprint"] != first["resultFingerprint"]


def test_runner_cli_writes_evidence_file(tmp_path: Path) -> None:
    config_path = tmp_path / "load.yaml"
    config_path.write_text(yaml.safe_dump({"seed": 1, "fixtureCount": 8, "concurrency": 2}))
    output_dir = tmp_path / "out"
    assert load_runner.main(["--config", str(config_path), "--output", str(output_dir)]) == 0
    evidence = json.loads((output_dir / "performance-evidence.json").read_text())
    jsonschema.validate(evidence, SCHEMA)
