#!/usr/bin/env python3
"""Authoritative Increment-4A verifier. No leaf defaults to PASS.

Canonical rules enforced here:

- Every named leaf is evaluated from real evidence; missing, skipped, or
  stale evidence is NOT_RUN (or STALE for material drift), never PASS.
- Required real tests are mapped to exact pytest node IDs / vitest test
  names — never substring patterns that could match the wrong test.
- Capability promotion is verified against the canonical accepted[]
  authority only; projected/QUALIFIED dimensions never promote alone.
- Frozen material fingerprints must match the recorded run or every leaf
  derived from that run is STALE.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
LANE = ROOT / "evaluation/increment4a"
RESULTS = LANE / "results"
CANONICAL_POINTER = LANE / "canonical-run.json"

FROZEN_MATERIAL = {
    "manifest": LANE / "manifest.yaml",
    "acceptance": LANE / "acceptance.yaml",
    "environment": LANE / "environment.yaml",
    "corpus": LANE / "corpus",
    "runtimeCalibration": LANE / "calibration/runtime-latency.json",
    "requiredTests": LANE / "required-tests.yaml",
    "implementationMaterial": LANE / "implementation-material.yaml",
    "modelManifest": ROOT / "models/increment4a/model-manifest.yaml",
    "languageRegistry": ROOT / "models/increment4a/language-registry.yaml",
    "hybridRouting": ROOT / "routing/hybrid-pdf.v1.yaml",
    "parserRouting": ROOT / "routing/parser-routing.v1.yaml",
    "workerProfile": ROOT / "profiles/increment4a.yaml",
}

REQUIRED_TESTS_YAML = LANE / "required-tests.yaml"
TEST_RECEIPTS_PATH = LANE / "test-receipts.json"
# The required-node sweep executes real providers (paddle/tesseract/office
# qualification); 3600s proved too tight under qualified load — the suite was
# killed before producing junit and every leaf fell back to NOT_RUN.
REQUIRED_PYTEST_TIMEOUT_SECONDS = 7200
VERIFIER_SOURCE_PATH = Path(__file__).resolve()
MODEL_VERIFIER_SOURCE_PATH = ROOT / "scripts/verify_models.py"
SUPERSEDED_RUNS_PATH = LANE / "superseded-runs.json"


def _load_required_tests() -> tuple[dict[str, tuple[str, ...]], dict[str, dict[str, tuple[str, ...]]]]:
    """Load and strictly validate the authoritative required-test map."""
    try:
        data = yaml.safe_load(REQUIRED_TESTS_YAML.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError(f"required-tests.yaml is missing or invalid: {exc}") from exc

    if not isinstance(data, dict) or data.get("schemaVersion") != "increment4a.required-tests.v1":
        raise ValueError("required-tests.yaml must declare schemaVersion: increment4a.required-tests.v1")

    pytest_map = data.get("pytest")
    vitest_map = data.get("vitest")
    if not isinstance(pytest_map, dict) or not isinstance(vitest_map, dict):
        raise ValueError("required-tests.yaml must contain 'pytest' and 'vitest' mappings")

    pytest_node_map: dict[str, tuple[str, ...]] = {}
    for leaf, nodes in pytest_map.items():
        if not isinstance(leaf, str) or not leaf:
            raise ValueError("pytest leaf names must be non-empty strings")
        if not isinstance(nodes, list) or not nodes:
            raise ValueError(f"pytest leaf '{leaf}' must list at least one node")
        validated: list[str] = []
        for node in nodes:
            if not isinstance(node, str) or not node:
                raise ValueError(f"pytest leaf '{leaf}' contains an invalid node entry")
            if "::" not in node and not node.endswith(".py"):
                raise ValueError(f"pytest leaf '{leaf}' node '{node}' must be a file path or pytest node id")
            validated.append(node)
        pytest_node_map[leaf] = tuple(validated)

    vitest_node_map: dict[str, dict[str, tuple[str, ...]]] = {}
    for leaf, files in vitest_map.items():
        if not isinstance(leaf, str) or not leaf:
            raise ValueError("vitest leaf names must be non-empty strings")
        if not isinstance(files, dict):
            raise ValueError(f"vitest leaf '{leaf}' must map test files to name lists")
        file_map: dict[str, tuple[str, ...]] = {}
        for file_key, names in files.items():
            if not isinstance(file_key, str) or not file_key:
                raise ValueError(f"vitest leaf '{leaf}' contains an invalid file key")
            if not isinstance(names, list):
                raise ValueError(f"vitest leaf '{leaf}' file '{file_key}' names must be a list")
            if any(not isinstance(name, str) for name in names):
                raise ValueError(f"vitest leaf '{leaf}' file '{file_key}' contains a non-string name")
            file_map[file_key] = tuple(names)
        vitest_node_map[leaf] = file_map

    return pytest_node_map, vitest_node_map


PYTEST_NODE_MAP, VITEST_NODE_MAP = _load_required_tests()
REQUIRED_LEAVES = tuple(PYTEST_NODE_MAP) + tuple(VITEST_NODE_MAP)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def material_sha256(path: Path) -> str:
    if not path.exists():
        return "MISSING"
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    elif path.is_dir():
        for child in sorted(item for item in path.rglob("*") if item.is_file() and "__pycache__" not in item.parts and ".pytest_cache" not in item.parts):
            digest.update(str(child.relative_to(path)).encode())
            digest.update(child.read_bytes())
    return digest.hexdigest()


def implementation_fingerprints() -> dict[str, str]:
    import importlib.util
    helper_path = LANE / "implementation_material.py"
    spec = importlib.util.spec_from_file_location("increment4a_implementation_material", helper_path)
    if spec is None or spec.loader is None:
        raise ValueError("implementation material fingerprint helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.implementation_fingerprints(ROOT)


def material_fingerprints() -> dict[str, str]:
    return {
        **{f"{name}Fingerprint": material_sha256(path) for name, path in FROZEN_MATERIAL.items()},
        **implementation_fingerprints(),
    }


def material_lock_status() -> str:
    """Reconcile the recorded material-lock against current on-disk material."""
    lock_path = LANE / "material-lock.json"
    if not lock_path.is_file():
        return "MISSING"
    try:
        lock = json.loads(lock_path.read_text())
    except (OSError, json.JSONDecodeError):
        return "FAIL"
    if lock.get("schemaVersion") not in {"increment4a.material-lock.v2", "increment4a.material-lock.v3", "increment4a.material-lock.v4"} or lock.get("state") != "FROZEN":
        return "FAIL"
    recorded = lock.get("materialFingerprints")
    if not isinstance(recorded, dict) or not recorded:
        return "FAIL"
    current = {name: material_sha256(path) for name, path in FROZEN_MATERIAL.items()}
    if recorded != current:
        return "STALE"
    current_implementation = implementation_fingerprints()
    return "PASS" if all(lock.get(key) == value for key, value in current_implementation.items()) else "STALE"


def _recorded_model_assets_status() -> str:
    """Check the recorded report's schema, manifest identity, and item results."""
    report_path = ROOT / "models/increment4a/model-verification.json"
    if not report_path.is_file():
        return "NOT_RUN"
    try:
        report = json.loads(report_path.read_text())
    except (OSError, json.JSONDecodeError):
        return "FAIL"
    if not isinstance(report, dict):
        return "FAIL"
    if report.get("schemaVersion") == "document-intelligence.model-verification.v1":
        return "STALE"
    if report.get("schemaVersion") != "document-intelligence.model-verification.v2":
        return "FAIL"
    manifest_path = ROOT / "models/increment4a/model-manifest.yaml"
    if not manifest_path.is_file() or report.get("manifestSha256") != sha256(manifest_path):
        return "STALE"
    if report.get("status") != "PASS" or report.get("issues"):
        return "FAIL"
    artifacts = report.get("artifacts") or []
    models = report.get("models") or []
    if not isinstance(artifacts, list) or not isinstance(models, list):
        return "FAIL"
    entries = [item for item in artifacts + models if isinstance(item, dict)]
    if not entries or any(item.get("status") != "VERIFIED" for item in entries):
        return "FAIL"
    return "PASS"


def _load_model_verifier():
    import importlib.util

    verifier_path = ROOT / "scripts/verify_models.py"
    spec = importlib.util.spec_from_file_location("increment4a_receipt_model_verifier", verifier_path)
    if spec is None or spec.loader is None:
        raise ValueError("model verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = ROOT
    return module


def _model_report_cache_root(report: dict) -> Path | None:
    """Resolve only a cache root whose identity still matches the report."""
    recorded = report.get("cacheRoot")
    if not isinstance(recorded, str) or not recorded:
        return None
    override = os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE")
    if recorded.startswith("<external>/"):
        if not override or Path(override).name != recorded.removeprefix("<external>/"):
            return None
        return Path(override).resolve()
    path = Path(recorded)
    resolved = (ROOT / path).resolve() if not path.is_absolute() else path.resolve()
    if override and Path(override).resolve() != resolved:
        return None
    return resolved


def _live_model_evidence_status() -> str:
    """Revalidate live assets and runtime against the report and frozen pins.

    The report's PASS bit is historical. Receipts can be reused only while
    current cache bytes and the installed package/platform state still match
    the exact manifest/environment that produced that report.
    """
    recorded_status = _recorded_model_assets_status()
    if recorded_status != "PASS":
        return recorded_status
    report_path = ROOT / "models/increment4a/model-verification.json"
    manifest_path = ROOT / "models/increment4a/model-manifest.yaml"
    environment_path = LANE / "environment.yaml"
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        environment = yaml.safe_load(environment_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, yaml.YAMLError):
        return "FAIL"
    if not isinstance(manifest, dict) or not isinstance(environment, dict):
        return "FAIL"
    cache_root = _model_report_cache_root(report)
    if cache_root is None:
        return "STALE"
    try:
        verifier = _load_model_verifier()
        expected_assets = verifier.declared_asset_fingerprints(manifest)
        if report.get("assetFingerprints") != expected_assets:
            return "STALE"
        frozen_runtime = environment.get("runtime")
        manifest_runtime = manifest.get("runtime")
        if not isinstance(frozen_runtime, dict) or not isinstance(manifest_runtime, dict):
            return "FAIL"
        current_runtime = verifier.runtime_evidence_snapshot(frozen_runtime)
        environment_runtime_fields = {
            "pythonVersion": "python",
            "uvVersion": "uv",
            "packagesFingerprint": "packagesFingerprint",
            "platformFingerprint": "platformFingerprint",
            "hardwareFingerprint": "hardwareFingerprint",
        }
        if any(
            not isinstance(frozen_runtime.get(environment_key), str)
            or not frozen_runtime[environment_key].strip()
            or frozen_runtime[environment_key] != current_runtime.get(evidence_key)
            for evidence_key, environment_key in environment_runtime_fields.items()
        ):
            return "STALE"
        frozen_packages = frozen_runtime.get("packages")
        if not isinstance(frozen_packages, dict) or frozen_packages != current_runtime.get("packages"):
            return "STALE"
        if report.get("runtimeEvidence") != current_runtime:
            return "STALE"
        # The manifest and environment are independent frozen authorities;
        # require their runtime pins to describe the same execution.
        manifest_runtime_evidence = verifier.runtime_evidence_snapshot(manifest_runtime)
        if manifest_runtime_evidence != current_runtime:
            return "STALE"
        issues = verifier.verify_manifest(manifest_path, cache_root, environment_path)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return "STALE"
    return "PASS" if not issues else "STALE"


def model_assets_status() -> str:
    """Require both a current report and matching live model/runtime evidence."""
    recorded = _recorded_model_assets_status()
    if recorded != "PASS":
        return recorded
    return _live_model_evidence_status()


def model_authority_status() -> str:
    """Recheck nested manifest/environment pins without rescanning model assets."""
    import importlib.util

    verifier_path = ROOT / "scripts/verify_models.py"
    spec = importlib.util.spec_from_file_location("increment4a_model_authority", verifier_path)
    if spec is None or spec.loader is None:
        return "FAIL"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Keep the lightweight helper rooted at the same checkout as this gate,
    # which also makes its authority-only result straightforward to test.
    module.ROOT = ROOT
    try:
        issues = module.verify_authority_only(
            ROOT / "models/increment4a/model-manifest.yaml",
            LANE / "environment.yaml",
        )
    except (OSError, ValueError):
        return "FAIL"
    return "PASS" if not issues else "STALE"


def material_review_status() -> str:
    try:
        manifest = yaml.safe_load((LANE / "manifest.yaml").read_text())
    except (OSError, yaml.YAMLError):
        return "FAIL"
    ground_truth = manifest.get("groundTruth", {})
    if manifest.get("state") != "FROZEN" or ground_truth.get("reviewed") is not True or not ground_truth.get("reviewVersion"):
        return "FAIL"
    truth_ids: set[str] = set()
    for path in (LANE / "corpus").rglob("*.json"):
        try:
            value = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return "FAIL"
        if path.name in {"ground_truth.json", "office-ground-truth.json"} and isinstance(value, dict):
            for key, record in value.items():
                if isinstance(record, dict) and ("expectedText" in record or "expectedRegions" in record or "expectedCells" in record):
                    truth_ids.add(key)
                elif isinstance(record, dict):
                    truth_ids.update(record)
        if path.name == "fixtures.json" and isinstance(value, dict) and isinstance(value.get("fixtureId"), str) and isinstance(value.get("cases"), list):
            truth_ids.add(value["fixtureId"])
    for fixture in manifest.get("fixtures", []):
        source = LANE / fixture.get("file", "")
        if not source.is_file() or "superseded" in {part.lower() for part in source.parts}:
            return "FAIL"
        if fixture.get("fixtureId") not in truth_ids and not fixture.get("structuralOnlyRationale"):
            return "FAIL"
    return "PASS" if material_lock_status() == "PASS" else "STALE"


def canonical_summary() -> tuple[Path | None, dict | None]:
    try:
        pointer = json.loads(CANONICAL_POINTER.read_text())
        run_id = pointer["runId"]
        if pointer.get("schemaVersion") != "increment4a.canonical-run.v1" or pointer.get("state") != "ACTIVE":
            return None, None
        if not isinstance(run_id, str) or not run_id or Path(run_id).name != run_id:
            return None, None
        run = RESULTS / run_id
        summary_path = run / "summary.json"
        observations_path = run / "observations.json"
        capabilities_path = run / "capabilities.json"
        summary = json.loads(summary_path.read_text())
        if pointer.get("materialFingerprint") != summary.get("materialFingerprint"):
            return summary_path, None
        if pointer.get("observationsFingerprint") != summary.get("observationsFingerprint"):
            return summary_path, None
        if pointer.get("capabilitiesFingerprint") != sha256(capabilities_path) or pointer.get("summaryFingerprint") != sha256(summary_path):
            return summary_path, None
        json.loads(observations_path.read_text())
        return summary_path, summary
    except (KeyError, OSError, json.JSONDecodeError):
        return None, None


def _source_run_authority_status(
    run_id: str,
    summary_fingerprint: str,
    observations_fingerprint: str,
    provider_semantics_fingerprint: str,
) -> str:
    """Require a reused source run to be named by the active or superseded authority."""
    try:
        pointer = json.loads(CANONICAL_POINTER.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pointer = {}
    if (
        isinstance(pointer, dict)
        and pointer.get("schemaVersion") == "increment4a.canonical-run.v1"
        and pointer.get("state") == "ACTIVE"
        and pointer.get("runId") == run_id
        and pointer.get("summaryFingerprint") == summary_fingerprint
        and pointer.get("observationsFingerprint") == observations_fingerprint
        and pointer.get("providerSemanticsFingerprint") == provider_semantics_fingerprint
    ):
        return "PASS"
    return _superseded_run_authority_status(run_id, summary_fingerprint, observations_fingerprint, provider_semantics_fingerprint)


def _superseded_run_authority_status(
    run_id: str,
    summary_fingerprint: str,
    observations_fingerprint: str,
    provider_semantics_fingerprint: str,
) -> str:
    try:
        superseded = json.loads(SUPERSEDED_RUNS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "STALE"
    if not isinstance(superseded, dict) or superseded.get("schemaVersion") != "increment4a.superseded-runs.v1" or not isinstance(superseded.get("runs"), list):
        return "STALE"
    runs = superseded["runs"]
    return "PASS" if any(
        isinstance(item, dict)
        and item.get("runId") == run_id
        and item.get("state") == "SUPERSEDED"
        and item.get("summaryFingerprint") == summary_fingerprint
        and item.get("observationsFingerprint") == observations_fingerprint
        and item.get("providerSemanticsFingerprint") == provider_semantics_fingerprint
        for item in runs
    ) else "STALE"


def _direct_campaign_attestation_status(
    summary_path: Path,
    summary: dict,
    observations: list,
    lineage: dict,
    current_provider_fingerprint: str,
    *,
    allow_pinned_legacy: bool,
) -> str:
    """Validate an explicit campaign receipt, or the pinned legacy r8 lineage."""
    observation_fingerprint = _digest_json(observations)
    if summary.get("observationsFingerprint") != observation_fingerprint:
        return "STALE"
    attestation_path = summary_path.with_name("campaign-attestation.json")
    if not attestation_path.is_file():
        if not allow_pinned_legacy:
            return "STALE"
        summary_fingerprint = sha256(summary_path)
        if _superseded_run_authority_status(
            summary_path.parent.name,
            summary_fingerprint,
            observation_fingerprint,
            current_provider_fingerprint,
        ) != "PASS":
            return "STALE"
        return _legacy_direct_campaign_lineage_status(summary_path, summary, observations, lineage, current_provider_fingerprint)
    try:
        attestation_bytes = attestation_path.read_bytes()
        attestation = json.loads(attestation_bytes)
        raw_path = summary_path.with_name("raw-observations.json")
        raw_values = json.loads(raw_path.read_text(encoding="utf-8"))
        artifacts = json.loads(summary_path.with_name("raw-observation-artifacts.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "STALE"
    if not isinstance(attestation, dict) or not isinstance(raw_values, list) or not isinstance(artifacts, list):
        return "STALE"
    raw_fingerprints = [_digest_json(value) for value in raw_values]
    execution_id = attestation.get("executionId")
    try:
        valid_execution_id = isinstance(execution_id, str) and uuid.UUID(hex=execution_id).hex == execution_id
    except (ValueError, AttributeError):
        valid_execution_id = False
    artifact_fingerprints_match = len(artifacts) == len(raw_values) and all(
        isinstance(item, dict)
        and item.get("index") == index
        and item.get("fingerprint") == raw_fingerprints[index]
        for index, item in enumerate(artifacts)
    )
    materials = summary.get("materialFingerprints")
    if (
        attestation.get("schemaVersion") != "increment4a.provider-campaign-attestation.v1"
        or not valid_execution_id
        or attestation.get("runner") != "evaluation/increment4a/run_campaign.py"
        or attestation.get("providerCampaignExecution") != "EXECUTED"
        or attestation.get("providerExecutionReused") is not False
        or attestation.get("providerSemanticsFingerprint") != current_provider_fingerprint
        or attestation.get("evaluationImplementationFingerprint") != summary.get("evaluationImplementationFingerprint")
        or attestation.get("materialFingerprints") != materials
        or attestation.get("materialFingerprint") != summary.get("materialFingerprint")
        or attestation.get("materialFingerprint") != _digest_json(materials)
        or attestation.get("observationCount") != len(observations)
        or attestation.get("observationsFingerprint") != observation_fingerprint
        or attestation.get("rawObservationFingerprints") != raw_fingerprints
        or summary.get("rawObservationFingerprints") != raw_fingerprints
        or lineage.get("rawObservationFingerprints") != raw_fingerprints
        or not artifact_fingerprints_match
        or lineage.get("providerCampaignExecution") != "EXECUTED"
        or lineage.get("providerExecutionReused") is not False
        or lineage.get("directCampaignAttestationFingerprint") != hashlib.sha256(attestation_bytes).hexdigest()
        or lineage.get("providerSemanticsFingerprint") != current_provider_fingerprint
        or lineage.get("evaluationImplementationFingerprint") != summary.get("evaluationImplementationFingerprint")
        or lineage.get("materialFingerprints") != materials
        or lineage.get("observationsFingerprint") != observation_fingerprint
        or lineage.get("observationReuse") is not None
    ):
        return "STALE"
    return "PASS"


def _legacy_direct_campaign_lineage_status(
    summary_path: Path,
    summary: dict,
    observations: list,
    lineage: dict,
    current_provider_fingerprint: str,
) -> str:
    """Accept only pre-receipt direct campaigns pinned in superseded authority."""
    try:
        raw_values = json.loads(summary_path.with_name("raw-observations.json").read_text(encoding="utf-8"))
        artifacts = json.loads(summary_path.with_name("raw-observation-artifacts.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "STALE"
    if not isinstance(raw_values, list) or not isinstance(artifacts, list):
        return "STALE"
    raw_fingerprints = [_digest_json(value) for value in raw_values]
    observation_fingerprint = _digest_json(observations)
    artifacts_match = len(artifacts) == len(raw_values) and all(
        isinstance(item, dict)
        and item.get("index") == index
        and item.get("fingerprint") == raw_fingerprints[index]
        for index, item in enumerate(artifacts)
    )
    if (
        lineage.get("providerCampaignExecution") != "EXECUTED"
        or lineage.get("providerExecutionReused") is not False
        or lineage.get("observationReuse") is not None
        or summary.get("providerSemanticsFingerprint") != current_provider_fingerprint
        or summary.get("rawObservationFingerprints") != raw_fingerprints
        or lineage.get("rawObservationFingerprints") != raw_fingerprints
        or summary.get("observationsFingerprint") != observation_fingerprint
        or lineage.get("observationsFingerprint") != observation_fingerprint
        or lineage.get("providerSemanticsFingerprint") != current_provider_fingerprint
        or lineage.get("evaluationImplementationFingerprint") != summary.get("evaluationImplementationFingerprint")
        or lineage.get("materialFingerprints") != summary.get("materialFingerprints")
        or not artifacts_match
    ):
        return "STALE"
    return "PASS"


def _source_run_observation_binding_status(
    summary_path: Path,
    current_provider_fingerprint: str,
    expected_summary_fingerprint: str | None = None,
    visited: set[Path] | None = None,
) -> str:
    """Check one archived run and recursively validate any reuse it claims."""
    resolved_summary_path = summary_path.resolve()
    if visited is None:
        visited = set()
    if resolved_summary_path in visited:
        return "STALE"
    visited.add(resolved_summary_path)
    try:
        summary_bytes = summary_path.read_bytes()
        summary = json.loads(summary_bytes)
        observations = json.loads(summary_path.with_name("observations.json").read_text(encoding="utf-8"))
        lineage = json.loads(summary_path.with_name("lineage.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "STALE"
    if not isinstance(summary, dict) or not isinstance(observations, list) or not isinstance(lineage, dict):
        return "STALE"
    summary_fingerprint = hashlib.sha256(summary_bytes).hexdigest()
    observations_fingerprint = _digest_json(observations)
    if (
        (expected_summary_fingerprint is not None and summary_fingerprint != expected_summary_fingerprint)
        or summary.get("observationsFingerprint") != observations_fingerprint
        or summary.get("providerSemanticsFingerprint") != current_provider_fingerprint
        or lineage.get("observationsFingerprint") != observations_fingerprint
        or lineage.get("providerSemanticsFingerprint") != current_provider_fingerprint
        or _source_run_authority_status(
            summary_path.parent.name,
            summary_fingerprint,
            observations_fingerprint,
            current_provider_fingerprint,
        ) != "PASS"
    ):
        return "STALE"

    reuse = summary.get("observationReuse")
    if reuse is None:
        return _direct_campaign_attestation_status(
            summary_path,
            summary,
            observations,
            lineage,
            current_provider_fingerprint,
            allow_pinned_legacy=True,
        )
    if not isinstance(reuse, dict) or reuse.get("providerExecutionReused") is not True:
        return "STALE"
    source_run_id = reuse.get("observationSourceRunId")
    if not isinstance(source_run_id, str) or not source_run_id or source_run_id in {".", ".."} or Path(source_run_id).name != source_run_id:
        return "STALE"
    source_summary_fingerprint = reuse.get("sourceSummaryFingerprint")
    if not isinstance(source_summary_fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", source_summary_fingerprint):
        return "STALE"
    child_summary_path = RESULTS / source_run_id / "summary.json"
    child_status = _source_run_observation_binding_status(
        child_summary_path,
        current_provider_fingerprint,
        expected_summary_fingerprint=source_summary_fingerprint,
        visited=visited,
    )
    try:
        child_summary = json.loads(child_summary_path.read_text(encoding="utf-8"))
        child_observations = json.loads(child_summary_path.with_name("observations.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "STALE"
    child_observations_fingerprint = _digest_json(child_observations)
    if (
        child_status != "PASS"
        or lineage.get("observationReuse") != reuse
        or reuse.get("sourceObservationsFingerprint") != child_observations_fingerprint
        or observations_fingerprint != child_observations_fingerprint
        or reuse.get("sourceProviderSemanticsFingerprint") != current_provider_fingerprint
        or reuse.get("historicalProviderSemanticsBinding") != "RECORDED"
        or reuse.get("sourceEvaluationImplementationFingerprint") != child_summary.get("evaluationImplementationFingerprint")
        or reuse.get("providerSemanticsBindingStatus") != "PASS"
        or reuse.get("expectedProviderSemanticsFingerprint") != current_provider_fingerprint
    ):
        return "STALE"
    return "PASS"


def observation_reuse_status(summary_path: Path, summary: dict, current_provider_fingerprint: str) -> str:
    """Verify reused provider observations and each archived summary in their lineage."""
    reuse = summary.get("observationReuse")
    if reuse is None:
        try:
            observations = json.loads(summary_path.with_name("observations.json").read_text(encoding="utf-8"))
            lineage = json.loads(summary_path.with_name("lineage.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return "STALE"
        if not isinstance(observations, list) or not isinstance(lineage, dict):
            return "STALE"
        return _direct_campaign_attestation_status(
            summary_path,
            summary,
            observations,
            lineage,
            current_provider_fingerprint,
            allow_pinned_legacy=False,
        )
    if not isinstance(reuse, dict) or reuse.get("providerExecutionReused") is not True:
        return "STALE"
    source_run_id = reuse.get("observationSourceRunId")
    if not isinstance(source_run_id, str) or not source_run_id or source_run_id in {".", ".."} or Path(source_run_id).name != source_run_id:
        return "STALE"
    source_summary_path = RESULTS / source_run_id / "summary.json"
    try:
        active_observations = json.loads(summary_path.with_name("observations.json").read_text(encoding="utf-8"))
        lineage = json.loads(summary_path.with_name("lineage.json").read_text(encoding="utf-8"))
        source_summary = json.loads(source_summary_path.read_text(encoding="utf-8"))
        source_observations = json.loads(source_summary_path.with_name("observations.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "STALE"
    source_observations_fingerprint = _digest_json(source_observations)
    active_observations_fingerprint = _digest_json(active_observations)
    source_summary_fingerprint = sha256(source_summary_path)
    source_provider_fingerprint = source_summary.get("providerSemanticsFingerprint")
    if (
        _source_run_observation_binding_status(
            source_summary_path,
            current_provider_fingerprint,
            expected_summary_fingerprint=reuse.get("sourceSummaryFingerprint"),
        ) != "PASS"
        or not isinstance(source_provider_fingerprint, str)
        or source_provider_fingerprint != current_provider_fingerprint
        or reuse.get("sourceSummaryFingerprint") != source_summary_fingerprint
        or reuse.get("sourceProviderSemanticsFingerprint") != source_provider_fingerprint
        or reuse.get("historicalProviderSemanticsBinding") != "RECORDED"
        or reuse.get("sourceObservationsFingerprint") != source_observations_fingerprint
        or source_summary.get("observationsFingerprint") != source_observations_fingerprint
        or summary.get("observationsFingerprint") != active_observations_fingerprint
        or active_observations_fingerprint != source_observations_fingerprint
        or summary.get("providerSemanticsFingerprint") != source_provider_fingerprint
        or reuse.get("sourceEvaluationImplementationFingerprint") != source_summary.get("evaluationImplementationFingerprint")
        or reuse.get("providerSemanticsBindingStatus") != "PASS"
        or reuse.get("expectedProviderSemanticsFingerprint") != current_provider_fingerprint
        or lineage.get("observationReuse") != reuse
        or lineage.get("observationsFingerprint") != active_observations_fingerprint
        or lineage.get("providerSemanticsFingerprint") != summary.get("providerSemanticsFingerprint")
    ):
        return "STALE"
    return "PASS"


def evaluation_checks() -> tuple[str, str, str]:
    """(evaluation, capabilityPromotion, evidenceIntegrity) from the canonical run."""
    path, summary = canonical_summary()
    if path is None or summary is None:
        return "NOT_RUN", "NOT_RUN", "NOT_RUN"
    recorded_material = summary.get("materialFingerprints")
    expected_material = material_fingerprints()
    if not isinstance(recorded_material, dict) or any(recorded_material.get(name) != value for name, value in expected_material.items()):
        return "STALE", "STALE", "STALE"
    expected_implementation = implementation_fingerprints()
    if any(summary.get(name) != value for name, value in expected_implementation.items()):
        return "STALE", "STALE", "STALE"
    if observation_reuse_status(path, summary, expected_implementation["providerSemanticsFingerprint"]) != "PASS":
        return "STALE", "STALE", "STALE"
    required = summary.get("requiredLeaves")
    if isinstance(required, dict) and required:
        if any(isinstance(value, dict) and value.get("status") == "FAIL" for value in required.values()):
            evaluation = "FAIL"
        elif any(isinstance(value, dict) and value.get("status") in {"NOT_RUN", "STALE"} for value in required.values()):
            evaluation = "NOT_RUN"
        else:
            evaluation = summary.get("status", "FAIL") if summary.get("status") in {"PASS", "FAIL", "NOT_RUN"} else "FAIL"
    else:
        evaluation = summary.get("status", "FAIL") if summary.get("status") in {"PASS", "FAIL", "NOT_RUN"} else "FAIL"
    capabilities_path = path.with_name("capabilities.json")
    try:
        capabilities = json.loads(capabilities_path.read_text())
        projected = capabilities.get("capabilities")
        dimensions = capabilities.get("dimensions")
        accepted = capabilities.get("accepted")
        valid_states = {"QUALIFIED", "NOT_QUALIFIED", "NOT_EVALUATED", "UNSUPPORTED_BY_DESIGN", "PASS", "FAIL", "NOT_RUN", "STALE"}
        precise = isinstance(projected, list) and all(
            isinstance(item, dict) and isinstance(item.get("capabilityId"), str) and item.get("state") in valid_states
            for item in projected
        )
        dimensional = isinstance(dimensions, dict) and all(
            isinstance(leaf, dict) and leaf.get("status") in valid_states
            for group in dimensions.values() if isinstance(group, dict)
            for leaf in group.values()
        )
        projection_matches_summary = not dimensional or dimensions == summary.get("capabilityDimensions")
        capability_material_ok = not dimensional or capabilities.get("materialFingerprint") == summary.get("materialFingerprint")
        # accepted[] is the only promotion authority: every accepted record
        # must correspond to a PASS dimension leaf with real provider evidence.
        accepted_is_precise = isinstance(accepted, list) and all(
            isinstance(item, dict)
            and isinstance(item.get("capabilityId"), str)
            and not item.get("capabilityId", "").startswith("language.")
            and isinstance(item.get("providerRef"), str)
            and isinstance(item.get("language"), str)
            for item in accepted
        )
        broad_language = not accepted_is_precise or any(
            item.get("capabilityId", "").startswith("language.") for item in (projected or []) if isinstance(item, dict)
        )
        promotion = "PASS" if (
            evaluation == "PASS"
            and capabilities.get("qualificationStatus") == "PASS"
            and capabilities.get("promotable") is True
            and isinstance(accepted, list)
            and accepted_is_precise
            and not broad_language
            and ((precise and dimensional and projection_matches_summary and capability_material_ok) or (precise and not dimensional))
        ) else ("NOT_RUN" if evaluation == "NOT_RUN" else "FAIL")
    except (OSError, json.JSONDecodeError):
        promotion = "NOT_RUN" if evaluation == "NOT_RUN" else "FAIL"
    observations_path = path.with_name("observations.json")
    try:
        observations = json.loads(observations_path.read_text())
        observed_fingerprint = hashlib.sha256(
            json.dumps(observations, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        raw_path = path.with_name("raw-observations.json")
        if not raw_path.exists():
            raw_path = path.with_name("raw_observations.json")
        raw_values = json.loads(raw_path.read_text()) if raw_path.exists() else None
        raw_fingerprint = hashlib.sha256(json.dumps(raw_values, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if raw_values is not None else None
        artifact_path = path.with_name("raw-observation-artifacts.json")
        artifacts = json.loads(artifact_path.read_text()) if artifact_path.exists() else None
        artifact_ok = isinstance(artifacts, list) and isinstance(raw_values, list) and len(artifacts) == len(raw_values) and all(
            isinstance(item, dict) and item.get("fingerprint") == hashlib.sha256(json.dumps(raw_values[index], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            for index, item in enumerate(artifacts)
        )
        normalized_ok = observed_fingerprint == summary.get("observationsFingerprint")
        raw_ok = raw_values is not None and raw_fingerprint == summary.get("rawObservationsFingerprint")
        evidence = "PASS" if normalized_ok and raw_ok and artifact_ok else ("NOT_RUN" if evaluation == "NOT_RUN" and raw_values is None else "FAIL")
    except (OSError, json.JSONDecodeError):
        evidence = "NOT_RUN" if evaluation == "NOT_RUN" else "FAIL"
    return evaluation, promotion, evidence


DEFERRED_CAPABILITY_IDS = ("extraction.schema-guided.hi", "extraction.schema-guided.mr")
PROMOTED_ARTIFACT = ROOT / "capabilities/increment4a.accepted.json"
RUNTIME_AUTHORITY = ROOT / "capabilities/increment4a.runtime-authority.json"


def deferred_capability_checks() -> tuple[str, str]:
    """(deferredCapabilitiesRecorded, deferredCapabilitiesNotPromoted).

    A deferral is only valid when the canonical run still records the measured
    NOT_QUALIFIED result with an explicit future-release disposition, and the
    capability is admitted nowhere: not in the canonical accepted[] projection,
    not in the promoted Increment-4A delta, and not in the composed runtime
    authority.
    """
    path, summary = canonical_summary()
    if path is None or summary is None:
        return "NOT_RUN", "NOT_RUN"
    try:
        capabilities = json.loads(path.with_name("capabilities.json").read_text())
    except (OSError, json.JSONDecodeError):
        return "FAIL", "FAIL"
    projected = {
        item.get("capabilityId"): item
        for item in capabilities.get("capabilities", [])
        if isinstance(item, dict)
    }
    deferred_leaves = capabilities.get("deferredCapabilityLeaves")
    recorded = all(
        isinstance(projected.get(capability_id), dict)
        and projected[capability_id].get("state") == "NOT_QUALIFIED"
        and projected[capability_id].get("closureDisposition") == "DEFERRED_TO_FUTURE_RELEASE"
        and projected[capability_id].get("closureStatus") == "PASS"
        for capability_id in DEFERRED_CAPABILITY_IDS
    ) and isinstance(deferred_leaves, dict) and all(
        f"{capability_id}:{language}" in deferred_leaves
        for capability_id, language in zip(DEFERRED_CAPABILITY_IDS, ("hi", "mr"))
    )
    if any(
        leaf.get("capabilityState") != "NOT_QUALIFIED" or leaf.get("closureDisposition") != "DEFERRED_TO_FUTURE_RELEASE"
        for key, leaf in (deferred_leaves or {}).items()
        if isinstance(leaf, dict) and key.rsplit(":", 1)[0] in DEFERRED_CAPABILITY_IDS
    ):
        recorded = False

    def accepted_ids(payload: object) -> set[str]:
        accepted = payload.get("accepted") if isinstance(payload, dict) else None
        if not isinstance(accepted, list):
            return set()
        return {
            item.get("capabilityId") or item.get("capability")
            for item in accepted
            if isinstance(item, dict) and isinstance(item.get("capabilityId") or item.get("capability"), str)
        }

    promoted = accepted_ids(capabilities)
    for artifact_path in (PROMOTED_ARTIFACT, RUNTIME_AUTHORITY):
        if not artifact_path.is_file():
            return recorded_status(recorded), "FAIL"
        try:
            promoted |= accepted_ids(json.loads(artifact_path.read_text()))
        except (OSError, json.JSONDecodeError):
            return recorded_status(recorded), "FAIL"
    try:
        authority = json.loads(RUNTIME_AUTHORITY.read_text())
        for entry in authority.get("accepted", []):
            if not isinstance(entry, dict):
                return recorded_status(recorded), "FAIL"
            provider_capabilities = entry.get("capabilities", {})
            ids = set(provider_capabilities.get("capabilityIds") or [])
            promoted |= {capability_id for capability_id in ids if capability_id in DEFERRED_CAPABILITY_IDS}
            if entry.get("providerRef") == "ghatana.gliner":
                languages = provider_capabilities.get("supportedLanguages") or provider_capabilities.get("languages") or []
                if set(languages) & {"hi", "mr"}:
                    return recorded_status(recorded), "FAIL"
    except (OSError, json.JSONDecodeError):
        return recorded_status(recorded), "FAIL"
    return recorded_status(recorded), "PASS" if not (set(DEFERRED_CAPABILITY_IDS) & promoted) else "FAIL"


def recorded_status(recorded: bool) -> str:
    return "PASS" if recorded else "FAIL"


def generated_authority_status() -> str:
    """Regenerate the derived authority artifacts and byte-compare them with
    the committed outputs.

    ``capabilities/increment4a.accepted.json`` and
    ``capabilities/increment4a.runtime-authority.json`` are generated from the
    canonical run plus the frozen Increment-3 baseline. A stale or manually
    edited artifact is STALE; a generation failure is FAIL; missing canonical
    evidence is NOT_RUN.
    """
    path, summary = canonical_summary()
    if path is None or summary is None:
        return "NOT_RUN"
    if not PROMOTED_ARTIFACT.is_file() or not RUNTIME_AUTHORITY.is_file():
        return "FAIL"
    with tempfile.TemporaryDirectory(prefix="increment4a-authority-") as temp:
        promoted = Path(temp) / PROMOTED_ARTIFACT.name
        authority = Path(temp) / RUNTIME_AUTHORITY.name
        for script, output in (
            (ROOT / "scripts/promote_increment4a_capabilities.py", promoted),
            (ROOT / "scripts/build_increment4a_runtime_authority.py", authority),
        ):
            result = subprocess.run(
                [sys.executable, str(script), "--output", str(output)],
                cwd=ROOT, text=True, capture_output=True, check=False, timeout=600,
            )
            if result.returncode != 0 or not output.is_file():
                return "FAIL"
        if sha256(promoted) != sha256(PROMOTED_ARTIFACT) or sha256(authority) != sha256(RUNTIME_AUTHORITY):
            return "STALE"
    return "PASS"


def model_manifest_pin_status() -> str:
    """The qualified profile must pin the exact frozen Increment-4A manifest."""
    try:
        profile = yaml.safe_load((ROOT / "profiles/increment4a.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return "FAIL"
    if not isinstance(profile, dict) or profile.get("modelManifest") != "models/increment4a/model-manifest.yaml":
        return "FAIL"
    manifest_path = ROOT / profile["modelManifest"]
    expected = profile.get("modelManifestSha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        return "FAIL"
    return "PASS" if expected == sha256(manifest_path) else "STALE"


def implementation_evidence_status(field: str) -> str:
    path, summary = canonical_summary()
    if path is None or summary is None:
        return "NOT_RUN"
    expected = implementation_fingerprints().get(field)
    if expected is None:
        return "FAIL"
    return "PASS" if summary.get(field) == expected else "STALE"


def profile_authority_pin_status() -> str:
    """The increment4a profile must pin exactly the committed runtime authority."""
    try:
        profile = yaml.safe_load((ROOT / "profiles/increment4a.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return "FAIL"
    if not isinstance(profile, dict) or profile.get("providerAuthority") != "capabilities/increment4a.runtime-authority.json":
        return "FAIL"
    return "PASS" if profile.get("providerAuthoritySha256") == sha256(RUNTIME_AUTHORITY) else "STALE"


def reconciliation_leaves() -> dict[str, str]:
    """Independently reconcile the canonical run; disagreement is never PASS."""
    path, summary = canonical_summary()
    if path is None or summary is None:
        return {"requiredLeaves": "NOT_RUN", "frozenMaterial": "NOT_RUN", "rawObservations": "NOT_RUN", "capabilityProjection": "NOT_RUN", "promotion": "NOT_RUN"}
    evaluation, promotion, evidence = evaluation_checks()
    required = summary.get("requiredLeaves")
    required_status = (
        "PASS" if isinstance(required, dict) and required and all(isinstance(value, dict) and value.get("status") == "PASS" for value in required.values())
        else "FAIL" if isinstance(required, dict) and any(isinstance(value, dict) and value.get("status") == "FAIL" for value in required.values())
        else "NOT_RUN"
    )
    capability_path = path.with_name("capabilities.json")
    try:
        capabilities = json.loads(capability_path.read_text())
        dimensions = capabilities.get("dimensions")
        states = [leaf.get("status") for group in dimensions.values() for leaf in group.values()] if isinstance(dimensions, dict) else []
        projection = "PASS" if states and any(state == "PASS" for state in states) else ("FAIL" if "FAIL" in states else "NOT_RUN")
    except (OSError, json.JSONDecodeError):
        projection = "NOT_RUN" if evaluation == "NOT_RUN" else "FAIL"
    return {"requiredLeaves": required_status, "frozenMaterial": "STALE" if evaluation == "STALE" else "PASS", "rawObservations": evidence, "capabilityProjection": projection, "promotion": promotion}


def _node_id(case: ET.Element) -> str:
    return f"{case.get('classname', '')}::{case.get('name', '')}"


def _canonical_node(node: str) -> str:
    """Convert `tests/integration/test_x.py::test_y[p]` to the JUnit
    `tests.integration.test_x::test_y[p]` representation for exact matching."""
    file_part, separator, test = node.partition("::")
    if not file_part.endswith(".py"):
        return node
    file_key = file_part[:-3].replace("/", ".")
    return f"{file_key}::{test}" if separator else file_key


def _decode_pytest_escapes(text: str) -> str:
    """pytest renders non-ASCII param ids as literal ``\\uXXXX`` sequences in
    node ids; decode them so declared unicode node names match JUnit output."""
    return re.sub(r"\\u([0-9a-fA-F]{4})", lambda match: chr(int(match.group(1), 16)), text)


def _junit_cases(junit: Path | None) -> dict[str, ET.Element] | None:
    if junit is None or not junit.is_file():
        return None
    try:
        cases = list(ET.parse(junit).getroot().iter("testcase"))
    except (OSError, ET.ParseError):
        return {}
    result: dict[str, ET.Element] = {}
    for case in cases:
        result.setdefault(_decode_pytest_escapes(_node_id(case)), case)
    return result


def pytest_leaf_status(cases: dict[str, ET.Element] | None, leaf: str) -> str:
    """Exact node-ID matching only — never substring inference."""
    if cases is None:
        return "NOT_RUN"
    if not cases:
        return "FAIL"
    matched: list[ET.Element] = []
    for node in PYTEST_NODE_MAP[leaf]:
        canonical = _canonical_node(node)
        if "::" in canonical:
            case = cases.get(canonical)
            if case is None:
                return "NOT_RUN"
            matched.append(case)
            continue
        # File-level node: every testcase under the file's classname, and at
        # least one must exist — an absent file is NOT_RUN, never implied pass.
        file_cases = [case for node_id, case in cases.items() if node_id.partition("::")[0] == canonical]
        if not file_cases:
            return "NOT_RUN"
        matched.extend(file_cases)
    if any(case.find("skipped") is not None for case in matched if case is not None):
        return "NOT_RUN"
    if any(case.find("failure") is not None or case.find("error") is not None for case in matched if case is not None):
        return "FAIL"
    return "PASS"


def junit_status(path: Path | None) -> str:
    cases = _junit_cases(path)
    if cases is None:
        return "NOT_RUN"
    if not cases:
        return "FAIL"
    if any(case.find("skipped") is not None for case in cases.values()):
        return "NOT_RUN"
    return "FAIL" if any(case.find("failure") is not None or case.find("error") is not None for case in cases.values()) else "PASS"


def vitest_leaf_status(report: dict | None, leaf: str) -> str:
    """Map vitest JSON results to a leaf.  Files with () accept every test in the file."""
    if report is None:
        return "NOT_RUN"
    files = VITEST_NODE_MAP[leaf]
    suites = {suite.get("name", ""): suite for suite in report.get("testResults", []) if isinstance(suite, dict)}
    leaf_failed = leaf_missing = leaf_skipped = 0
    for file_key, names in files.items():
        suite = next((suite for name, suite in suites.items() if name.endswith(file_key)), None)
        if suite is None:
            return "NOT_RUN"
        assertions = suite.get("assertionResults", [])
        selected = [item for item in assertions if not names or item.get("title") in names or item.get("fullName") in names]
        if not selected:
            return "NOT_RUN"
        for item in selected:
            status = item.get("status")
            if status == "failed":
                leaf_failed += 1
            elif status in {"pending", "skipped", "todo"}:
                leaf_skipped += 1
    if leaf_failed:
        return "FAIL"
    if leaf_skipped:
        return "NOT_RUN"
    if leaf_missing:
        return "NOT_RUN"
    return "PASS"


def run_vitest(root: Path, files: tuple[str, ...], live: bool) -> dict | None:
    package_root = root / "clients/typescript"
    if not (package_root / "package.json").is_file():
        return None
    env = os.environ.copy()
    env["DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS"] = "1"
    # The mixed suite includes Increment-3 tests that launch their own worker
    # after blanking PROFILE_PATH. Do not let an Increment-4A profile ID leak
    # into that child environment and contradict the cleared path.
    env.pop("DOCUMENT_INTELLIGENCE_PROFILE_PATH", None)
    env.pop("DOCUMENT_INTELLIGENCE_PROFILE_ID", None)
    if not live:
        env.pop("DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL", None)
    result = subprocess.run(
        ["pnpm", "exec", "vitest", "run", *files, "--reporter=json"],
        cwd=package_root, env=env, text=True, capture_output=True, check=False, timeout=600,
    )
    try:
        payload = result.stdout[result.stdout.find("{"):]
        return json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return {"testResults": [], "forced": "FAIL"}


def _pytest_node_arg(node: str) -> str:
    """pytest ids escape non-ASCII param text as literal ``\\uXXXX`` — encode
    declared unicode node names so pytest can select them."""
    return "".join(char if ord(char) < 128 else f"\\u{ord(char):04x}" for char in node)


def run_required_pytest(root: Path, junit: Path, leaves: tuple[str, ...] | None = None) -> None:
    """Run exactly the mapped node IDs, with real-provider lanes opted in."""
    selected = PYTEST_NODE_MAP.values() if leaves is None else (PYTEST_NODE_MAP[leaf] for leaf in leaves)
    nodes = sorted({_pytest_node_arg(node) for node_list in selected for node in node_list})
    env = os.environ.copy()
    env.update({
        "DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS": "1",
        "DOCUMENT_INTELLIGENCE_RUN_LANGUAGE_QUALIFICATION": "1",
    })
    try:
        subprocess.run(
            [sys.executable, "-m", "pytest", *nodes, f"--junitxml={junit}", "-q"],
            cwd=root, env=env, check=False, timeout=REQUIRED_PYTEST_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        junit.unlink(missing_ok=True)


def _digest_json(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def required_test_spec_fingerprint(root: Path, leaf: str) -> str:
    """Hash the test mapping, test/config sources, and the execution protocol."""
    test_files: dict[str, str] = {}
    config_names = ("conftest.py", "pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg")
    for node in PYTEST_NODE_MAP[leaf]:
        relative = node.split("::", 1)[0]
        path = root / relative
        test_files[relative] = sha256(path) if path.is_file() else "MISSING"
        directory = path.parent
        root_resolved = root.resolve()
        while True:
            for name in config_names:
                config = directory / name
                if config.is_file():
                    test_files[str(config.relative_to(root))] = sha256(config)
            if directory.resolve() == root_resolved or directory.parent == directory:
                break
            try:
                directory.relative_to(root_resolved)
            except ValueError:
                break
            directory = directory.parent

    try:
        pytest_version = importlib.metadata.version("pytest")
    except importlib.metadata.PackageNotFoundError:
        pytest_version = "MISSING"
    execution_environment = os.environ.copy()
    execution_environment.update({
        "DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS": "1",
        "DOCUMENT_INTELLIGENCE_RUN_LANGUAGE_QUALIFICATION": "1",
    })
    # This URL is consumed by the Vitest live-engine suite only. It does not
    # affect the Python pytest leaves, so changing it must not invalidate all
    # cached pytest receipts when strict mode enables live conformance.
    relevant_environment = {
        name: value
        for name, value in sorted(execution_environment.items())
        if (name.startswith("DOCUMENT_INTELLIGENCE_") and name != "DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL")
        or name in {
            "HF_HUB_OFFLINE",
            "TRANSFORMERS_OFFLINE",
            "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK",
            "TESSDATA_PREFIX",
            "PYTEST_ADDOPTS",
            "PYTEST_PLUGINS",
        }
    }
    execution = {
        "verifierSourceSha256": sha256(VERIFIER_SOURCE_PATH) if VERIFIER_SOURCE_PATH.is_file() else "MISSING",
        "modelVerifierSourceSha256": sha256(MODEL_VERIFIER_SOURCE_PATH) if MODEL_VERIFIER_SOURCE_PATH.is_file() else "MISSING",
        "pythonVersion": sys.version,
        "pytestVersion": pytest_version,
        "command": [sys.executable, "-m", "pytest", "<mapped-node-ids>", "--junitxml=<temporary-file>", "-q"],
        "environment": relevant_environment,
        "timeoutSeconds": REQUIRED_PYTEST_TIMEOUT_SECONDS,
        "junitInterpretation": "exact-node-id-v1",
    }
    mapping = {
        "schemaVersion": "increment4a.required-tests.v2",
        "pytest": {leaf: list(PYTEST_NODE_MAP[leaf])},
        "testFilesAndConfig": test_files,
        "execution": execution,
    }
    return _digest_json(mapping)


def _load_test_receipts() -> dict[str, dict]:
    try:
        payload = json.loads(TEST_RECEIPTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict) or payload.get("schemaVersion") != "increment4a.test-receipts.v1" or not isinstance(payload.get("receipts"), dict):
        return {}
    return {name: value for name, value in payload["receipts"].items() if isinstance(name, str) and isinstance(value, dict)}


def _write_test_receipts(receipts: dict[str, dict]) -> None:
    TEST_RECEIPTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schemaVersion": "increment4a.test-receipts.v1", "receipts": receipts}
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=TEST_RECEIPTS_PATH.parent, prefix=".test-receipts-", suffix=".tmp", delete=False) as handle:
        temp_path = Path(handle.name)
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    temp_path.replace(TEST_RECEIPTS_PATH)


def _current_receipt_context() -> tuple[str | None, str | None]:
    # A passing historical receipt cannot outlive the model verification
    # state. Revalidate the model report, live assets, and frozen runtime
    # before trusting any cached pytest leaf.
    if model_assets_status() != "PASS":
        return None, None
    _, summary = canonical_summary()
    if summary is None:
        return None, None
    current = material_fingerprints()
    recorded = summary.get("materialFingerprints")
    if not isinstance(recorded, dict) or any(recorded.get(key) != value for key, value in current.items()):
        return None, None
    provider_fingerprint = implementation_fingerprints().get("providerSemanticsFingerprint")
    if summary.get("providerSemanticsFingerprint") != provider_fingerprint:
        return None, None
    return summary.get("materialFingerprint"), provider_fingerprint


def run_required_pytest_cached(root: Path, junit: Path) -> dict[str, str]:
    """Reuse only passing per-leaf results with exact material/source/spec keys."""
    material_fingerprint, provider_fingerprint = _current_receipt_context()
    initial_context = (material_fingerprint, provider_fingerprint)
    receipts = _load_test_receipts()
    statuses: dict[str, str] = {}
    stale: list[str] = []
    initial_specs: dict[str, str] = {}
    for leaf in PYTEST_NODE_MAP:
        spec_fingerprint = required_test_spec_fingerprint(root, leaf)
        initial_specs[leaf] = spec_fingerprint
        receipt = receipts.get(leaf, {})
        if material_fingerprint and provider_fingerprint and (
            receipt.get("status") == "PASS"
            and receipt.get("materialFingerprint") == material_fingerprint
            and receipt.get("providerSemanticsFingerprint") == provider_fingerprint
            and receipt.get("requiredTestSpecFingerprint") == spec_fingerprint
        ):
            statuses[leaf] = "PASS"
        else:
            stale.append(leaf)
    if stale:
        run_required_pytest(root, junit, tuple(stale))
        cases = _junit_cases(junit)
        for leaf in stale:
            status = pytest_leaf_status(cases, leaf)
            statuses[leaf] = status
            receipts.pop(leaf, None)
    # Re-read every input after the tests. A test or source file changing
    # during a long real-provider run must not produce a receipt claiming the
    # post-run bytes were what pytest executed.
    final_context = _current_receipt_context()
    final_specs = {leaf: required_test_spec_fingerprint(root, leaf) for leaf in PYTEST_NODE_MAP}
    context_stable = initial_context == final_context
    receipts_changed = False
    for leaf in PYTEST_NODE_MAP:
        stable = context_stable and initial_specs[leaf] == final_specs[leaf]
        if not stable:
            statuses[leaf] = "NOT_RUN"
            if leaf in receipts:
                receipts.pop(leaf, None)
                receipts_changed = True
            continue
        if leaf in stale and statuses[leaf] == "PASS" and material_fingerprint and provider_fingerprint:
            receipts[leaf] = {
                "status": "PASS",
                "materialFingerprint": material_fingerprint,
                "providerSemanticsFingerprint": provider_fingerprint,
                "requiredTestSpecFingerprint": initial_specs[leaf],
                "nodeIds": list(PYTEST_NODE_MAP[leaf]),
                "verifiedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            receipts_changed = True
    if stale or receipts_changed:
        _write_test_receipts(receipts)
    return statuses


def increment3_status(report: Path | None, run_gate: bool) -> str:
    payload = None
    if report:
        try:
            payload = json.loads(report.read_text())
        except (OSError, json.JSONDecodeError):
            return "FAIL"
    elif run_gate:
        try:
            # The increment-3 gate owns its own live-lane selection; a caller's
            # Increment-4A live worker URL must not leak into its vitest run.
            gate_env = os.environ.copy()
            gate_env.pop("DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL", None)
            result = subprocess.run([sys.executable, "scripts/verify_increment3.py", "--strict"], cwd=ROOT, env=gate_env, text=True, capture_output=True, timeout=600)
        except subprocess.TimeoutExpired:
            return "NOT_RUN"
        try:
            payload = json.loads(result.stdout[result.stdout.find("{"):])
        except (json.JSONDecodeError, ValueError):
            return "FAIL"
    return "PASS" if payload and payload.get("status") == "PASS" and payload.get("checks", {}).get("increment3") == "PASS" else ("NOT_RUN" if payload is None else "FAIL")


def shared_drift_status() -> str:
    """Shared contract drift, measured independently of the I3 aggregate.

    The lock test asserts the worker mirrors the frozen Shared extraction
    contract byte-for-byte; drift detection must not be inferred from the
    increment-3 regression outcome.
    """
    capture = ROOT / "clients/typescript/tests/shared-contract-lock.test.ts"
    package_root = ROOT / "clients/typescript"
    if not (package_root / "package.json").is_file() or not capture.is_file():
        return "NOT_RUN"
    result = subprocess.run(
        ["pnpm", "exec", "vitest", "run", "tests/shared-contract-lock.test.ts", "--reporter=json"],
        cwd=package_root, env=os.environ.copy(), text=True, capture_output=True, check=False, timeout=300,
    )
    try:
        report = json.loads(result.stdout[result.stdout.find("{"):])
    except (json.JSONDecodeError, ValueError):
        return "FAIL"
    assertions = [item for suite in report.get("testResults", []) for item in suite.get("assertionResults", [])]
    if not assertions or any(item.get("status") in {"pending", "skipped", "todo"} for item in assertions):
        return "NOT_RUN"
    return "FAIL" if any(item.get("status") == "failed" for item in assertions) else "PASS"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="run required test nodes and regression gates")
    parser.add_argument("--junit", type=Path, help="authoritative pytest JUnit XML (avoids rerunning tests)")
    parser.add_argument("--vitest-report", type=Path, help="authoritative vitest JSON report (avoids rerunning tests)")
    parser.add_argument("--increment3-report", type=Path, help="JSON output from scripts/verify_increment3.py --strict")
    args = parser.parse_args()

    if args.strict and (args.junit is not None or args.vitest_report is not None or args.increment3_report is not None):
        parser.error("--junit, --vitest-report, and --increment3-report are unbound external evidence and cannot satisfy --strict; use the keyed pytest receipt cache and let strict mode run its regression gates")

    junit = args.junit
    cached_pytest_leaves: dict[str, str] | None = None
    if args.strict and junit is None:
        temp = tempfile.NamedTemporaryFile(prefix="increment4a-", suffix=".xml", delete=False)
        temp.close()
        junit = Path(temp.name)
        cached_pytest_leaves = run_required_pytest_cached(ROOT, junit)

    cases = _junit_cases(junit)
    leaves = {
        leaf: cached_pytest_leaves.get(leaf, "NOT_RUN") if cached_pytest_leaves is not None else pytest_leaf_status(cases, leaf)
        for leaf in PYTEST_NODE_MAP
    }

    vitest_report = None
    if args.vitest_report and args.vitest_report.is_file():
        try:
            vitest_report = json.loads(args.vitest_report.read_text())
        except (OSError, json.JSONDecodeError):
            vitest_report = {"testResults": [], "forced": "FAIL"}
    elif args.strict:
        files = tuple({file for mapping in VITEST_NODE_MAP.values() for file in mapping})
        vitest_report = run_vitest(ROOT, files, live=bool(os.getenv("DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL")))
    for leaf in VITEST_NODE_MAP:
        leaves[leaf] = vitest_leaf_status(vitest_report, leaf)

    evaluation, capabilities, evidence = evaluation_checks()
    deferred_recorded, deferred_not_promoted = deferred_capability_checks()
    policy = yaml.safe_load((LANE / "acceptance.yaml").read_text())
    environment = yaml.safe_load((LANE / "environment.yaml").read_text())
    frozen = "PASS" if policy.get("state") == environment.get("state") == "FROZEN" else "NOT_FROZEN"
    increment3 = increment3_status(args.increment3_report, args.strict)
    drift = shared_drift_status() if args.strict else "NOT_RUN"
    environment_requirements = environment.get("requiredEnvironment", {})
    offline_runtime = "PASS" if environment.get("network") == "offline" and all(
        environment_requirements.get(name) in {"true", "1"} for name in ("DOCUMENT_INTELLIGENCE_OFFLINE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
    ) else "FAIL"
    calibration = ROOT / "evaluation/increment4a/calibration/hybrid-pdf-calibration.json"
    calibration_status = "NOT_RUN"
    if calibration.is_file():
        try:
            calibration_status = "PASS" if json.loads(calibration.read_text()).get("status") == "COMPLETE" else "NOT_RUN"
        except (OSError, json.JSONDecodeError):
            calibration_status = "FAIL"
    checks = {
        "sharedContractDrift": 0 if drift == "PASS" else ("UNKNOWN" if drift == "NOT_RUN" else 1),
        "increment3Regression": increment3,
        "evaluationTests": (
            "FAIL" if any(value == "FAIL" for value in leaves.values())
            else "NOT_RUN" if any(value != "PASS" for value in leaves.values())
            else "PASS"
        ) if cached_pytest_leaves is not None else junit_status(junit),
        "qualificationEvaluation": evaluation,
        "evidenceIntegrity": evidence,
        "capabilityPromotion": capabilities,
        "deferredCapabilitiesRecorded": deferred_recorded,
        "deferredCapabilitiesNotPromoted": deferred_not_promoted,
        "calibrationComplete": calibration_status,
        "routingFrozen": "PASS" if yaml.safe_load((ROOT / "routing/hybrid-pdf.v1.yaml").read_text()).get("status") == "FROZEN" else "NOT_RUN",
        "acceptanceFrozen": "PASS" if policy.get("state") == "FROZEN" else "NOT_RUN",
        "environmentFrozen": "PASS" if environment.get("state") == "FROZEN" else "NOT_RUN",
        "modelAssetsVerified": model_assets_status(),
        "modelAuthority": model_authority_status(),
        "fingerprintsFrozen": frozen,
        "sharedContract": drift,
        "materialLock": material_lock_status(),
        "materialReviewed": material_review_status(),
        "generatedAuthoritiesCurrent": generated_authority_status(),
        "profileAuthorityPin": profile_authority_pin_status(),
        "modelManifestPin": model_manifest_pin_status(),
        "providerSemantics": implementation_evidence_status("providerSemanticsFingerprint"),
        "evaluationImplementation": implementation_evidence_status("evaluationImplementationFingerprint"),
        "offlineRuntime": offline_runtime,
        **{name: leaves.get(name, "NOT_RUN") for name in REQUIRED_LEAVES},
    }
    checks.update({f"reconciler.{name}": value for name, value in reconciliation_leaves().items()})
    required = checks["sharedContractDrift"] == 0 and all(
        value == "PASS" for name, value in checks.items() if name != "sharedContractDrift"
    )
    checks["increment4a"] = "PASS" if required else "FAIL"
    payload = {
        "checks": checks,
        "status": checks["increment4a"],
        "requiredLeaves": {name: checks[name] for name in REQUIRED_LEAVES},
        "materialFingerprints": material_fingerprints(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if required else 1


if __name__ == "__main__":
    raise SystemExit(main())
