from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _verifier():
    spec = importlib.util.spec_from_file_location("verify_increment4a", ROOT / "scripts/verify_increment4a.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _script(relative_path: str, module_name: str):
    path = ROOT / relative_path
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _junit(tmp_path: Path, cases: list[tuple[str, str, str | None]]) -> Path:
    body = "".join(
        f'<testcase classname="{classname}" name="{name}">{f"<{outcome}/>" if outcome else ""}</testcase>'
        for classname, name, outcome in cases
    )
    path = tmp_path / "junit.xml"
    path.write_text(f'<testsuite>{body}</testsuite>')
    return path


def test_exact_node_mapping_never_matches_by_substring(tmp_path: Path) -> None:
    verifier = _verifier()
    # A similarly-named but wrong test must not satisfy the leaf.
    junit = _junit(tmp_path, [("tests.integration.test_hybrid_pdf_real", "test_hybrid_native_page_uses_docling_only_extra", None)])
    cases = verifier._junit_cases(junit)
    assert verifier.pytest_leaf_status(cases, "hybridPdfDigitalRegression") == "NOT_RUN"


def test_missing_junit_is_not_run(tmp_path: Path) -> None:
    verifier = _verifier()
    assert verifier.pytest_leaf_status(verifier._junit_cases(tmp_path / "absent.xml"), "docxReal") == "NOT_RUN"


def test_skipped_required_node_is_not_run(tmp_path: Path) -> None:
    verifier = _verifier()
    node = verifier.PYTEST_NODE_MAP["docxReal"][0]
    junit = _junit(tmp_path, [(verifier._canonical_node(node).split("::")[0], verifier._canonical_node(node).split("::")[1], "skipped")])
    assert verifier.pytest_leaf_status(verifier._junit_cases(junit), "docxReal") == "NOT_RUN"


def test_failing_required_node_is_fail(tmp_path: Path) -> None:
    verifier = _verifier()
    nodes = verifier.PYTEST_NODE_MAP["fallbackCycleSafety"]
    classname, name = verifier._canonical_node(nodes[0]).split("::")
    junit = _junit(tmp_path, [(classname, name, "failure")])
    assert verifier.pytest_leaf_status(verifier._junit_cases(junit), "fallbackCycleSafety") == "FAIL"


def test_all_mapped_nodes_passing_promotes_leaf(tmp_path: Path) -> None:
    verifier = _verifier()
    cases = []
    for node in verifier.PYTEST_NODE_MAP["fallbackDeadline"]:
        classname, name = verifier._canonical_node(node).split("::")
        cases.append((classname, name, None))
    junit = _junit(tmp_path, cases)
    assert verifier.pytest_leaf_status(verifier._junit_cases(junit), "fallbackDeadline") == "PASS"


def test_no_canonical_run_reports_not_run(verifier_tmp: Path | None = None) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = Path("/nonexistent-results")
        assert verifier.evaluation_checks() == ("NOT_RUN", "NOT_RUN", "NOT_RUN")
    finally:
        verifier.RESULTS = original


def _canonical_run(results: Path, verifier) -> None:
    run = results / "run-a"
    run.mkdir(parents=True)
    observations = [{"fixtureId": "HYBRID-001", "capabilityId": "parser.pdf.hybrid.text.en", "language": "en", "providerProvenance": {"providerRef": "ghatana.hybrid-pdf", "providerVersion": "0.1.0", "modelRef": "route", "modelVersion": "route"}}]
    (run / "observations.json").write_text(json.dumps(observations))
    raw = json.dumps(observations, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    element = json.dumps(observations[0], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    (run / "raw-observations.json").write_text(json.dumps(observations, ensure_ascii=False))
    (run / "raw-observation-artifacts.json").write_text(json.dumps([{"index": 0, "fixtureId": "HYBRID-001", "fingerprint": hashlib.sha256(element.encode()).hexdigest(), "observation": observations[0]}]))
    materials = verifier.material_fingerprints()
    material_fingerprint = verifier._digest_json(materials)
    raw_fingerprints = [verifier._digest_json(observations[0])]
    (run / "capabilities.json").write_text(json.dumps({
        "qualificationStatus": "PASS", "promotable": True, "materialFingerprint": material_fingerprint,
        "accepted": [{"capabilityId": "parser.pdf.hybrid.text.en", "providerRef": "ghatana.hybrid-pdf", "language": "en"}],
        "capabilities": [{"capabilityId": "parser.pdf.hybrid.text.en", "state": "QUALIFIED", "providerRef": "ghatana.hybrid-pdf"}],
        "dimensions": {"parser.pdf.hybrid.text.en": {"en": {"status": "PASS"}}},
    }))
    observations_fingerprint = hashlib.sha256(json.dumps(observations, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    summary = {
        "status": "PASS",
        "realProviderEvidence": True,
        "materialFingerprints": materials,
        **verifier.implementation_fingerprints(),
        "materialFingerprint": material_fingerprint,
        "requiredLeaves": {"fixture:HYBRID-001": {"status": "PASS"}},
        "capabilityDimensions": {"parser.pdf.hybrid.text.en": {"en": {"status": "PASS"}}},
        "observationsFingerprint": observations_fingerprint,
        "rawObservationsFingerprint": hashlib.sha256(raw.encode()).hexdigest(),
        "rawObservationFingerprints": raw_fingerprints,
    }
    summary_path = run / "summary.json"
    summary_path.write_text(json.dumps(summary))
    attestation = {
        "schemaVersion": "increment4a.provider-campaign-attestation.v1",
        "executionId": "0" * 32,
        "runner": "evaluation/increment4a/run_campaign.py",
        "providerCampaignExecution": "EXECUTED",
        "providerExecutionReused": False,
        "providerSemanticsFingerprint": summary["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": summary["evaluationImplementationFingerprint"],
        "materialFingerprints": materials,
        "materialFingerprint": material_fingerprint,
        "observationCount": len(observations),
        "observationsFingerprint": observations_fingerprint,
        "rawObservationFingerprints": raw_fingerprints,
    }
    attestation_bytes = json.dumps(attestation, sort_keys=True).encode()
    (run / "campaign-attestation.json").write_bytes(attestation_bytes)
    (run / "lineage.json").write_text(json.dumps({
        "providerCampaignExecution": "EXECUTED",
        "providerExecutionReused": False,
        "directCampaignAttestationFingerprint": hashlib.sha256(attestation_bytes).hexdigest(),
        "providerSemanticsFingerprint": summary["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": summary["evaluationImplementationFingerprint"],
        "materialFingerprints": materials,
        "observationsFingerprint": observations_fingerprint,
        "rawObservationFingerprints": raw_fingerprints,
    }))
    verifier.CANONICAL_POINTER = results.parent / "canonical-run.json"
    verifier.SUPERSEDED_RUNS_PATH = results.parent / "superseded-runs.json"
    verifier.SUPERSEDED_RUNS_PATH.write_text(json.dumps({"schemaVersion": "increment4a.superseded-runs.v1", "runs": []}))
    verifier.CANONICAL_POINTER.write_text(json.dumps({
        "schemaVersion": "increment4a.canonical-run.v1",
        "state": "ACTIVE",
        "runId": "run-a",
        "materialFingerprint": material_fingerprint,
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": summary["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": summary["evaluationImplementationFingerprint"],
        "capabilitiesFingerprint": verifier.sha256(run / "capabilities.json"),
        "summaryFingerprint": verifier.sha256(run / "summary.json"),
    }))


def _bind_reused_observations(
    verifier,
    summary_path: Path,
    source_provider_fingerprint: str | None,
    binding: str,
    *,
    source_reuse: dict | None = None,
) -> Path:
    active_summary = json.loads(summary_path.read_text())
    active_observations_path = summary_path.with_name("observations.json")
    active_observations = json.loads(active_observations_path.read_text())
    observations_fingerprint = verifier._digest_json(active_observations)
    source_run_id = "provider-semantics-source"
    source_dir = verifier.RESULTS / source_run_id
    source_dir.mkdir()
    (source_dir / "observations.json").write_text(json.dumps(active_observations))
    source_raw_values = [item.get("rawObservation", item) for item in active_observations]
    (source_dir / "raw-observations.json").write_text(json.dumps(source_raw_values))
    (source_dir / "raw-observation-artifacts.json").write_text(json.dumps([
        {"index": index, "fingerprint": verifier._digest_json(value)}
        for index, value in enumerate(source_raw_values)
    ]))
    materials = verifier.material_fingerprints()
    material_fingerprint = verifier._digest_json(materials)
    source_summary = {
        "observationsFingerprint": observations_fingerprint,
        "materialFingerprints": materials,
        "materialFingerprint": material_fingerprint,
        "evaluationImplementationFingerprint": verifier.implementation_fingerprints()["evaluationImplementationFingerprint"],
        "rawObservationFingerprints": [verifier._digest_json(value) for value in source_raw_values],
    }
    if source_provider_fingerprint is not None:
        source_summary["providerSemanticsFingerprint"] = source_provider_fingerprint
    if source_reuse is not None:
        source_summary["observationReuse"] = source_reuse
    source_summary_path = source_dir / "summary.json"
    source_summary_path.write_text(json.dumps(source_summary))
    source_lineage = {
        "runId": source_run_id,
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": source_provider_fingerprint,
        "evaluationImplementationFingerprint": source_summary["evaluationImplementationFingerprint"],
        "materialFingerprints": materials,
        "materialFingerprint": material_fingerprint,
        "rawObservationFingerprints": [verifier._digest_json(value) for value in source_raw_values],
        "providerExecutionReused": source_reuse is not None,
        **({"observationReuse": source_reuse} if source_reuse is not None else {}),
    }
    if source_reuse is None and source_provider_fingerprint is not None:
        source_attestation = {
            "schemaVersion": "increment4a.provider-campaign-attestation.v1",
            "executionId": "1" * 32,
            "runner": "evaluation/increment4a/run_campaign.py",
            "providerCampaignExecution": "EXECUTED",
            "providerExecutionReused": False,
            "providerSemanticsFingerprint": source_provider_fingerprint,
            "evaluationImplementationFingerprint": source_summary["evaluationImplementationFingerprint"],
            "materialFingerprints": materials,
            "materialFingerprint": material_fingerprint,
            "observationCount": len(active_observations),
            "observationsFingerprint": observations_fingerprint,
            "rawObservationFingerprints": source_lineage["rawObservationFingerprints"],
        }
        attestation_bytes = json.dumps(source_attestation, sort_keys=True).encode()
        (source_dir / "campaign-attestation.json").write_bytes(attestation_bytes)
        source_lineage.update({
            "providerCampaignExecution": "EXECUTED",
            "providerExecutionReused": False,
            "directCampaignAttestationFingerprint": hashlib.sha256(attestation_bytes).hexdigest(),
        })
    (source_dir / "lineage.json").write_text(json.dumps(source_lineage))
    current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
    reuse = {
        "observationSourceRunId": source_run_id,
        "observationReuseReason": "EXPLICIT_IMPLEMENTATION_FINGERPRINT_REPROJECTION",
        "sourceObservationsFingerprint": observations_fingerprint,
        "sourceSummaryFingerprint": verifier.sha256(source_summary_path),
        "sourceProviderSemanticsFingerprint": source_provider_fingerprint,
        "sourceEvaluationImplementationFingerprint": source_summary["evaluationImplementationFingerprint"],
        "historicalProviderSemanticsBinding": binding,
        "providerExecutionReused": True,
        # Deliberately assert PASS here: verifier reconciliation must derive
        # trust from source evidence instead of trusting the projected claim.
        "providerSemanticsBindingStatus": "PASS",
        "expectedProviderSemanticsFingerprint": current_provider_fingerprint,
    }
    archive = json.loads(verifier.SUPERSEDED_RUNS_PATH.read_text())
    archive["runs"].append({
        "runId": source_run_id,
        "state": "SUPERSEDED",
        "summaryFingerprint": verifier.sha256(source_summary_path),
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": source_provider_fingerprint,
    })
    verifier.SUPERSEDED_RUNS_PATH.write_text(json.dumps(archive))
    active_summary["observationReuse"] = reuse
    summary_path.write_text(json.dumps(active_summary))
    (summary_path.with_name("lineage.json")).write_text(json.dumps({
        "observationReuse": reuse,
        "observationsFingerprint": observations_fingerprint,
        "providerSemanticsFingerprint": active_summary["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": active_summary["evaluationImplementationFingerprint"],
        "materialFingerprints": active_summary["materialFingerprints"],
    }))
    pointer = json.loads(verifier.CANONICAL_POINTER.read_text())
    pointer["summaryFingerprint"] = verifier.sha256(summary_path)
    verifier.CANONICAL_POINTER.write_text(json.dumps(pointer))
    return source_summary_path


def _promotion_fixture(tmp_path: Path, monkeypatch):
    verifier = _verifier()
    lane = tmp_path / "evaluation" / "increment4a"
    results = lane / "results"
    verifier.ROOT = ROOT
    verifier.LANE = ROOT / "evaluation" / "increment4a"
    verifier.RESULTS = results
    verifier.CANONICAL_POINTER = lane / "canonical-run.json"
    verifier.SUPERSEDED_RUNS_PATH = lane / "superseded-runs.json"
    _canonical_run(results, verifier)
    run = results / "run-a"
    provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
    _bind_reused_observations(verifier, run / "summary.json", provider_fingerprint, "RECORDED")
    # Keep synthetic evidence isolated while exercising the real strict
    # reconciler and repository source fingerprints.
    monkeypatch.setattr(verifier, "material_lock_status", lambda: "PASS")
    promoter = _script("scripts/promote_increment4a_capabilities.py", "test_increment4a_capability_promoter")
    promoter.ROOT = ROOT
    promoter.LANE = lane
    monkeypatch.setattr(promoter, "_load_strict_verifier", lambda: verifier)
    return verifier, promoter, lane, run


def _make_candidate_r9_like_stale(verifier, run: Path) -> None:
    summary_path = run / "summary.json"
    summary = json.loads(summary_path.read_text())
    summary["observationReuse"].pop("sourceSummaryFingerprint")
    summary_path.write_text(json.dumps(summary))
    lineage_path = run / "lineage.json"
    lineage = json.loads(lineage_path.read_text())
    lineage["observationReuse"] = summary["observationReuse"]
    lineage_path.write_text(json.dumps(lineage))
    pointer = json.loads(verifier.CANONICAL_POINTER.read_text())
    pointer["summaryFingerprint"] = verifier.sha256(summary_path)
    verifier.CANONICAL_POINTER.write_text(json.dumps(pointer))


def _fake_provider():
    class Provider:
        def capabilities(self):
            return {"features": ["parser"]}

        def identity(self):
            return {"modelRef": "route", "modelVersion": "1", "providerVersion": "0.1.0"}

    return Provider()


def test_reconciler_passes_only_on_consistent_canonical_run(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        evaluation, promotion, evidence = verifier.evaluation_checks()
        assert evaluation == "PASS"
        assert promotion == "PASS"
        assert evidence == "PASS"
    finally:
        verifier.RESULTS = original


def test_reconciler_accepts_valid_direct_campaign_attestation(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        assert verifier.evaluation_checks() == ("PASS", "PASS", "PASS")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_missing_direct_campaign_attestation(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        (run / "campaign-attestation.json").unlink()
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_forged_direct_campaign_attestation(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        attestation_path = run / "campaign-attestation.json"
        attestation = json.loads(attestation_path.read_text())
        attestation["observationsFingerprint"] = "0" * 64
        attestation_bytes = json.dumps(attestation, sort_keys=True).encode()
        attestation_path.write_bytes(attestation_bytes)
        lineage_path = run / "lineage.json"
        lineage = json.loads(lineage_path.read_text())
        lineage["directCampaignAttestationFingerprint"] = hashlib.sha256(attestation_bytes).hexdigest()
        lineage_path.write_text(json.dumps(lineage))
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_evaluation_implementation_drift(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        summary_path = run / "summary.json"
        summary = json.loads(summary_path.read_text())
        summary["evaluationImplementationFingerprint"] = "0" * 64
        summary_path.write_text(json.dumps(summary))
        pointer = json.loads(verifier.CANONICAL_POINTER.read_text())
        pointer["summaryFingerprint"] = verifier.sha256(summary_path)
        verifier.CANONICAL_POINTER.write_text(json.dumps(pointer))
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_reused_observations_with_unrecorded_source_semantics(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        _bind_reused_observations(verifier, run / "summary.json", None, "UNRECORDED")
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_reused_observations_with_mismatched_source_semantics(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        _bind_reused_observations(verifier, run / "summary.json", "0" * 64, "RECORDED")
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_accepts_reuse_bound_to_the_current_provider_semantics(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
        _bind_reused_observations(verifier, run / "summary.json", current_provider_fingerprint, "RECORDED")
        assert verifier.evaluation_checks() == ("PASS", "PASS", "PASS")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_unpinned_source_run(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
        _bind_reused_observations(verifier, run / "summary.json", current_provider_fingerprint, "RECORDED")
        authority = json.loads(verifier.SUPERSEDED_RUNS_PATH.read_text())
        authority["runs"] = []
        verifier.SUPERSEDED_RUNS_PATH.write_text(json.dumps(authority))
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_source_summary_bytes_changed_after_projection(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
        source_summary_path = _bind_reused_observations(verifier, run / "summary.json", current_provider_fingerprint, "RECORDED")
        source_summary_path.write_text(source_summary_path.read_text() + " ")
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_missing_source_summary_fingerprint(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
        _bind_reused_observations(verifier, run / "summary.json", current_provider_fingerprint, "RECORDED")
        summary_path = run / "summary.json"
        summary = json.loads(summary_path.read_text())
        summary["observationReuse"].pop("sourceSummaryFingerprint")
        summary_path.write_text(json.dumps(summary))
        lineage_path = run / "lineage.json"
        lineage = json.loads(lineage_path.read_text())
        lineage["observationReuse"] = summary["observationReuse"]
        lineage_path.write_text(json.dumps(lineage))
        pointer = json.loads(verifier.CANONICAL_POINTER.read_text())
        pointer["summaryFingerprint"] = verifier.sha256(summary_path)
        verifier.CANONICAL_POINTER.write_text(json.dumps(pointer))
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_reused_source_with_missing_own_binding(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
        source_summary_path = _bind_reused_observations(
            verifier,
            run / "summary.json",
            current_provider_fingerprint,
            "RECORDED",
            source_reuse={"observationSourceRunId": "missing-child", "providerExecutionReused": True},
        )
        assert source_summary_path.is_file()
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_nested_reuse_without_source_summary_fingerprint(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
        nested_reuse = {
            "observationSourceRunId": "nested-source",
            "sourceObservationsFingerprint": verifier._digest_json(json.loads((run / "observations.json").read_text())),
            "sourceProviderSemanticsFingerprint": current_provider_fingerprint,
            "sourceEvaluationImplementationFingerprint": verifier.implementation_fingerprints()["evaluationImplementationFingerprint"],
            "historicalProviderSemanticsBinding": "RECORDED",
            "providerExecutionReused": True,
            "providerSemanticsBindingStatus": "PASS",
            "expectedProviderSemanticsFingerprint": current_provider_fingerprint,
            # sourceSummaryFingerprint is intentionally omitted.
        }
        _bind_reused_observations(
            verifier,
            run / "summary.json",
            current_provider_fingerprint,
            "RECORDED",
            source_reuse=nested_reuse,
        )
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_malformed_superseded_archive(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        current_provider_fingerprint = verifier.implementation_fingerprints()["providerSemanticsFingerprint"]
        _bind_reused_observations(verifier, run / "summary.json", current_provider_fingerprint, "RECORDED")
        verifier.SUPERSEDED_RUNS_PATH.write_text(json.dumps({"schemaVersion": "wrong", "runs": []}))
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_reconciler_rejects_qualified_projection_without_accepted(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        capabilities = json.loads((run / "capabilities.json").read_text())
        # The exact promotion bypass: QUALIFIED leaves + empty accepted.
        capabilities["accepted"] = []
        capabilities["promotable"] = False
        (run / "capabilities.json").write_text(json.dumps(capabilities))
        pointer = json.loads(verifier.CANONICAL_POINTER.read_text())
        pointer["capabilitiesFingerprint"] = verifier.sha256(run / "capabilities.json")
        verifier.CANONICAL_POINTER.write_text(json.dumps(pointer))
        evaluation, promotion, _ = verifier.evaluation_checks()
        assert evaluation == "PASS"
        assert promotion == "FAIL"
    finally:
        verifier.RESULTS = original


def test_stale_material_is_stale_not_fail(tmp_path: Path) -> None:
    verifier = _verifier()
    original = verifier.RESULTS
    try:
        verifier.RESULTS = tmp_path / "results"
        _canonical_run(verifier.RESULTS, verifier)
        run = next(verifier.RESULTS.iterdir())
        summary = json.loads((run / "summary.json").read_text())
        summary["materialFingerprints"]["manifestFingerprint"] = "tampered"
        (run / "summary.json").write_text(json.dumps(summary))
        pointer = json.loads(verifier.CANONICAL_POINTER.read_text())
        pointer["summaryFingerprint"] = verifier.sha256(run / "summary.json")
        verifier.CANONICAL_POINTER.write_text(json.dumps(pointer))
        assert verifier.evaluation_checks() == ("STALE", "STALE", "STALE")
    finally:
        verifier.RESULTS = original


def test_node_map_covers_every_declared_leaf() -> None:
    verifier = _verifier()
    assert set(verifier.REQUIRED_LEAVES) == set(verifier.PYTEST_NODE_MAP) | set(verifier.VITEST_NODE_MAP)
    for nodes in verifier.PYTEST_NODE_MAP.values():
        assert nodes and all("::" in node or node.endswith(".py") for node in nodes)


def test_required_tests_yaml_contains_pdf_region_fallback_real_nodes(tmp_path: Path) -> None:
    verifier = _verifier()
    assert "pdfRegionFallbackReal" in verifier.PYTEST_NODE_MAP
    nodes = verifier.PYTEST_NODE_MAP["pdfRegionFallbackReal"]
    assert all("HYBRID-00" in node for node in nodes)
    assert all(node.endswith("]") for node in nodes)
    assert len(nodes) == 4


def test_load_required_tests_strictly_validates_schema(tmp_path: Path) -> None:
    verifier = _verifier()
    bad_yaml = tmp_path / "required-tests.yaml"
    bad_yaml.write_text("schemaVersion: wrong.version\npytest: {}\nvitest: {}\n")
    original = verifier.REQUIRED_TESTS_YAML
    try:
        verifier.REQUIRED_TESTS_YAML = bad_yaml
        with __import__("pytest").raises(ValueError):
            verifier._load_required_tests()
    finally:
        verifier.REQUIRED_TESTS_YAML = original


def test_load_required_tests_rejects_missing_pytest_or_vitest(tmp_path: Path) -> None:
    verifier = _verifier()
    bad_yaml = tmp_path / "required-tests.yaml"
    bad_yaml.write_text("schemaVersion: increment4a.required-tests.v1\npytest: {}\n")
    original = verifier.REQUIRED_TESTS_YAML
    try:
        verifier.REQUIRED_TESTS_YAML = bad_yaml
        with __import__("pytest").raises(ValueError):
            verifier._load_required_tests()
    finally:
        verifier.REQUIRED_TESTS_YAML = original


def test_model_authority_leaf_rechecks_nested_authority_without_asset_scan(monkeypatch) -> None:
    import importlib.util

    verifier = _verifier()

    class StubLoader:
        def create_module(self, _spec):
            return None

        def exec_module(self, module) -> None:
            module.verify_authority_only = lambda manifest, environment: [
                f"MODEL_INTERNAL_FINGERPRINT_MISMATCH {manifest} {environment}"
            ]

    monkeypatch.setattr(
        importlib.util,
        "spec_from_file_location",
        lambda *_args, **_kwargs: importlib.util.spec_from_loader("stub_model_authority", StubLoader()),
    )
    assert verifier.model_authority_status() == "STALE"


def test_promotion_scripts_reject_r9_like_unbound_reused_candidate(tmp_path: Path, monkeypatch) -> None:
    verifier, promoter, lane, run = _promotion_fixture(tmp_path, monkeypatch)
    _make_candidate_r9_like_stale(verifier, run)

    promoted = tmp_path / "increment4a.accepted.json"
    monkeypatch.setattr(sys, "argv", ["promote_increment4a_capabilities.py", "--output", str(promoted)])
    with pytest.raises(ValueError, match="not promotable|lineage"):
        promoter.main()
    assert not promoted.exists()

    builder = _script("scripts/build_increment4a_runtime_authority.py", "test_increment4a_runtime_authority_builder")
    builder.ROOT = tmp_path
    builder.LANE = lane
    builder.INCREMENT3_AUTHORITY = tmp_path / "evaluation" / "increment3" / "capabilities.json"
    builder.INCREMENT3_AUTHORITY.parent.mkdir(parents=True)
    builder.INCREMENT3_AUTHORITY.write_text(json.dumps({"accepted": [], "declared": {"models": []}}))
    profile = tmp_path / "increment4a.yaml"
    profile.write_text("enabledProviders: []\n")
    monkeypatch.setattr(builder, "_load_verified_canonical_candidate", promoter.load_verified_canonical_candidate)
    monkeypatch.setattr(builder, "_providers", lambda: {"ghatana.hybrid-pdf": _fake_provider()})
    authority = tmp_path / "increment4a.runtime-authority.json"
    monkeypatch.setattr(sys, "argv", ["build_increment4a_runtime_authority.py", "--output", str(authority), "--profile", str(profile)])
    with pytest.raises(ValueError, match="not promotable|lineage"):
        builder.main()
    assert not authority.exists()


def test_promotion_scripts_accept_bound_candidate_and_retain_summary_provenance(tmp_path: Path, monkeypatch) -> None:
    verifier, promoter, lane, run = _promotion_fixture(tmp_path, monkeypatch)
    reuse = json.loads((run / "summary.json").read_text())["observationReuse"]
    source_lineage_path = lane / "results" / reuse["observationSourceRunId"] / "lineage.json"
    source_lineage = json.loads(source_lineage_path.read_text())
    # Qualification-created direct campaign lineages carry the attestation but
    # do not add the optional runId field used by the campaign runner.
    source_lineage.pop("runId", None)
    source_lineage_path.write_text(json.dumps(source_lineage))
    candidate = promoter.load_verified_canonical_candidate()
    assert candidate["summaryFingerprint"] == verifier.sha256(lane / "results" / "run-a" / "summary.json")

    promoted = tmp_path / "increment4a.accepted.json"
    monkeypatch.setattr(sys, "argv", ["promote_increment4a_capabilities.py", "--output", str(promoted)])
    assert promoter.main() == 0
    promoted_payload = json.loads(promoted.read_text())
    assert promoted_payload["sourceSummaryFingerprint"] == candidate["summaryFingerprint"]
    assert promoted_payload["sourceProviderSemanticsFingerprint"] == candidate["summary"]["providerSemanticsFingerprint"]
    assert promoted_payload["sourceEvaluationImplementationFingerprint"] == candidate["summary"]["evaluationImplementationFingerprint"]
    assert promoted_payload["sourceObservationReuse"] == candidate["summary"]["observationReuse"]

    builder = _script("scripts/build_increment4a_runtime_authority.py", "test_increment4a_runtime_authority_builder")
    builder.ROOT = tmp_path
    builder.LANE = lane
    builder.INCREMENT3_AUTHORITY = tmp_path / "evaluation" / "increment3" / "capabilities.json"
    builder.INCREMENT3_AUTHORITY.parent.mkdir(parents=True)
    builder.INCREMENT3_AUTHORITY.write_text(json.dumps({"accepted": [], "declared": {"models": []}}))
    profile = tmp_path / "increment4a.yaml"
    profile.write_text("enabledProviders: []\n")
    monkeypatch.setattr(builder, "_load_verified_canonical_candidate", promoter.load_verified_canonical_candidate)
    monkeypatch.setattr(builder, "_providers", lambda: {"ghatana.hybrid-pdf": _fake_provider()})
    authority = tmp_path / "increment4a.runtime-authority.json"
    monkeypatch.setattr(sys, "argv", ["build_increment4a_runtime_authority.py", "--output", str(authority), "--profile", str(profile)])
    assert builder.main() == 0
    authority_payload = json.loads(authority.read_text())
    assert authority_payload["increment4aAcceptedFingerprint"] == builder.digest(candidate["capabilities"]["accepted"])
