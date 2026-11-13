#!/usr/bin/env python3
"""Evaluate Increment-4A observations without widening or inventing evidence.

The worker harness owns provider execution. This module only consumes its
normalized observations, preserves a raw copy, and projects capability state
one provider/language dimension at a time.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
WORKER_ROOT = HERE.parents[1]
sys.path.insert(0, str(WORKER_ROOT))
from evaluation.increment4a.implementation_material import implementation_fingerprints  # noqa: E402
from evaluation.increment4a.metrics import aggregate  # noqa: E402

PASS = "PASS"
FAIL = "FAIL"
NOT_RUN = "NOT_RUN"
STALE = "STALE"
LEAF_STATUSES = {PASS, FAIL, NOT_RUN, STALE}
DISPOSITIONS = {"REQUIRED", "OPTIONAL", "UNSUPPORTED_BY_DESIGN", "DEFERRED_TO_FUTURE_RELEASE"}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _material_files() -> list[Path]:
    """Return reviewable frozen material, never prior result directories."""
    files = [HERE / name for name in ("qualification.yaml", "acceptance.yaml", "environment.yaml")]
    corpus = HERE / "corpus"
    if corpus.exists():
        files.extend(path for path in corpus.rglob("*") if path.is_file() and "__pycache__" not in path.parts and ".pytest_cache" not in path.parts)
    return sorted(path for path in files if path.exists())


def material_fingerprints() -> dict[str, str]:
    authorities = {
        "manifest": HERE / "manifest.yaml",
        "qualification": HERE / "qualification.yaml",
        "acceptance": HERE / "acceptance.yaml",
        "environment": HERE / "environment.yaml",
        "corpus": HERE / "corpus",
        "runtimeCalibration": HERE / "calibration/runtime-latency.json",
        "requiredTests": HERE / "required-tests.yaml",
        "implementationMaterial": HERE / "implementation-material.yaml",
        "modelManifest": WORKER_ROOT / "models/increment4a/model-manifest.yaml",
        "languageRegistry": WORKER_ROOT / "models/increment4a/language-registry.yaml",
        "hybridRouting": WORKER_ROOT / "routing/hybrid-pdf.v1.yaml",
        "parserRouting": WORKER_ROOT / "routing/parser-routing.v1.yaml",
        "workerProfile": WORKER_ROOT / "profiles/increment4a.yaml",
    }

    def material_digest(path: Path) -> str:
        if not path.exists():
            return "MISSING"
        hasher = hashlib.sha256()
        if path.is_file():
            hasher.update(path.name.encode())
            hasher.update(path.read_bytes())
        else:
            for child in sorted(item for item in path.rglob("*") if item.is_file() and "__pycache__" not in item.parts and ".pytest_cache" not in item.parts):
                hasher.update(str(child.relative_to(path)).encode())
                hasher.update(child.read_bytes())
        return hasher.hexdigest()

    return {
        **{f"{name}Fingerprint": material_digest(path) for name, path in authorities.items()},
        **implementation_fingerprints(WORKER_ROOT),
    }


DIRECT_CAMPAIGN_ATTESTATION_SCHEMA = "increment4a.provider-campaign-attestation.v1"


def build_direct_campaign_attestation(
    observations: list[dict],
    implementation_at_start: dict[str, str],
    implementation_at_end: dict[str, str],
    material_at_start: dict[str, str],
    material_at_end: dict[str, str],
) -> dict[str, Any]:
    """Create a receipt only after the campaign's measured inputs stay stable."""
    if implementation_at_start != implementation_at_end or material_at_start != material_at_end:
        raise ValueError("provider or evaluation material changed during the provider campaign")
    provider_fingerprint = implementation_at_start.get("providerSemanticsFingerprint")
    evaluation_fingerprint = implementation_at_start.get("evaluationImplementationFingerprint")
    if not isinstance(provider_fingerprint, str) or not isinstance(evaluation_fingerprint, str):
        raise ValueError("provider campaign is missing implementation fingerprints")
    raw_values = [item.get("rawObservation", item) for item in observations]
    return {
        "schemaVersion": DIRECT_CAMPAIGN_ATTESTATION_SCHEMA,
        "executionId": uuid.uuid4().hex,
        "runner": "evaluation/increment4a/run_campaign.py",
        "providerCampaignExecution": "EXECUTED",
        "providerExecutionReused": False,
        "providerSemanticsFingerprint": provider_fingerprint,
        "evaluationImplementationFingerprint": evaluation_fingerprint,
        "materialFingerprints": material_at_start,
        "materialFingerprint": digest(material_at_start),
        "observationCount": len(observations),
        "observationsFingerprint": digest(observations),
        "rawObservationFingerprints": [digest(value) for value in raw_values],
    }


def validate_direct_campaign_attestation(observations: list[dict], attestation: Any) -> dict:
    """Fail closed unless a campaign-produced receipt binds these exact inputs."""
    if not isinstance(attestation, dict) or attestation.get("schemaVersion") != DIRECT_CAMPAIGN_ATTESTATION_SCHEMA:
        raise ValueError("direct observations require a valid provider-campaign attestation")
    execution_id = attestation.get("executionId")
    try:
        if not isinstance(execution_id, str) or uuid.UUID(hex=execution_id).hex != execution_id:
            raise ValueError("invalid campaign execution id")
    except (ValueError, AttributeError) as error:
        raise ValueError("direct campaign attestation has an invalid execution id") from error
    implementation = implementation_fingerprints(WORKER_ROOT)
    current_material = material_fingerprints()
    raw_values = [item.get("rawObservation", item) for item in observations]
    if (
        attestation.get("runner") != "evaluation/increment4a/run_campaign.py"
        or attestation.get("providerCampaignExecution") != "EXECUTED"
        or attestation.get("providerExecutionReused") is not False
        or attestation.get("providerSemanticsFingerprint") != implementation.get("providerSemanticsFingerprint")
        or attestation.get("evaluationImplementationFingerprint") != implementation.get("evaluationImplementationFingerprint")
        or attestation.get("materialFingerprints") != current_material
        or attestation.get("materialFingerprint") != digest(current_material)
        or attestation.get("observationCount") != len(observations)
        or attestation.get("observationsFingerprint") != digest(observations)
        or attestation.get("rawObservationFingerprints") != [digest(value) for value in raw_values]
    ):
        raise ValueError("direct campaign attestation is stale or does not bind the supplied observations")
    return attestation


def fingerprints() -> dict[str, str]:
    """Legacy three fingerprints retained for callers of the original slice."""
    return {f"{name}Fingerprint": sha256(HERE / filename) for name, filename in {
        "qualification": "qualification.yaml", "acceptance": "acceptance.yaml", "environment": "environment.yaml"
    }.items()}


def all_fingerprints() -> dict[str, str]:
    return {**fingerprints(), **material_fingerprints()}


def _status(value: Any) -> str | None:
    return value if isinstance(value, str) and value in LEAF_STATUSES else None


def _is_skipped(observation: dict) -> bool:
    return observation.get("skipped") is True or _status(observation.get("status")) == NOT_RUN


def _provider_ref(observation: dict) -> str | None:
    provenance = observation.get("providerProvenance")
    if isinstance(provenance, dict) and isinstance(provenance.get("providerRef"), str):
        return provenance["providerRef"]
    for key in ("providerRef", "provider", "providerId"):
        if isinstance(observation.get(key), str):
            return observation[key]
    return None


def _capability_id(observation: dict) -> str | None:
    value = observation.get("capability") or observation.get("capabilityId")
    if isinstance(value, str):
        value = value.lower()
        if "." in value:
            return value
        if "paddle" in value or value in {"ocr", "ocr-fallback"}:
            return "ocr"
        if "gliner" in value or value in {"field-extraction", "entity-extraction"}:
            return "gliner"
        return value
    provider = (_provider_ref(observation) or "").lower()
    language = _language(observation) or "und"
    if observation.get("fallbackActivated") is True or "fallback" in provider or "resilient" in provider:
        return f"fallback.image.paddle-to-tesseract.{language}"
    if "paddle" in provider:
        return f"ocr.paddle.{language}"
    if "tesseract" in provider:
        return f"ocr.tesseract.{language}"
    if "gliner" in provider:
        return f"extraction.schema-guided.{language}"
    if "xlsx" in provider:
        return "parser.xlsx.tables.und"
    if "docx" in provider:
        return f"parser.docx.text.{language}"
    if "pptx" in provider:
        return f"parser.pptx.text.{language}"
    if "hybrid" in provider:
        return f"parser.pdf.hybrid.text.{language}"
    return None


def _language(observation: dict) -> str | None:
    for key in ("language", "languageHint", "expectedLanguage", "actualLanguage"):
        if isinstance(observation.get(key), str):
            return observation[key].lower()
    return None


def _has_real_provider_evidence(observation: dict) -> bool:
    """Require explicit provider provenance before any result is promotable."""
    if observation.get("realProviderEvidence") is True:
        return True
    provenance = observation.get("providerProvenance")
    if not isinstance(provenance, dict):
        return False
    required = ("providerRef", "providerVersion", "modelRef", "modelVersion")
    return all(isinstance(provenance.get(key), str) and provenance[key] for key in required)


def _observation_error(observation: dict) -> str | None:
    error = observation.get("error")
    return error if isinstance(error, str) and error else None


def threshold_results(metrics: dict[str, float], policy: dict) -> dict[str, dict]:
    results: dict[str, dict] = {}
    for name, rule in policy.get("metrics", {}).items():
        if name not in metrics:
            results[name] = {"status": NOT_RUN, "reason": "required metric not measured"}
            continue
        value = metrics[name]
        passed = value <= rule["value"] if rule["operator"] == "lte" else value >= rule["value"]
        results[name] = {"status": PASS if passed else FAIL, "value": value, "operator": rule["operator"], "threshold": rule["value"]}
    return results


def _metric_value(observations: list[dict], metric: str) -> float | None:
    metrics = aggregate(observations)
    if metric in metrics:
        return metrics[metric]
    if metric == "fallback.successRate":
        attempted = [item for item in observations if item.get("fallbackAttempted") is True]
        if not attempted:
            return None
        succeeded = sum(1 for item in attempted if item.get("fallbackSucceeded") is True)
        return succeeded / len(attempted)
    aliases = {
        "gliner.entityF1": ("gliner.entityF1", "entityF1", "fieldF1", "f1", "entity_f1"),
        "gliner.evidenceAccuracy": ("gliner.evidenceAccuracy", "evidenceAccuracy", "evidence_accuracy"),
        "structureAccuracy": ("structureAccuracy", "structure_accuracy"),
        "text.cer": ("text.cer", "cer", "ocr.cer"),
        "language.accuracy": ("language.accuracy", "languageAccuracy"),
    }
    keys = aliases.get(metric, (metric,))
    values = [float(item[key]) for item in observations for key in keys if isinstance(item.get(key), (int, float))]
    return sum(values) / len(values) if values else None


def _dimension_leaf(dimension: dict, language: str, observations: list[dict], policy: dict) -> dict:
    required_metrics = dimension.get("requiredMetrics", [])
    if not observations or all(_is_skipped(item) for item in observations):
        return {"status": NOT_RUN, "reason": "dimension has no executed observation", "language": language}
    errors = [_observation_error(item) for item in observations if _observation_error(item)]
    if errors:
        return {"status": FAIL, "reason": "provider execution error", "errors": errors, "language": language}
    measured: dict[str, float] = {}
    missing: list[str] = []
    for metric in required_metrics:
        value = _metric_value(observations, metric)
        if value is None:
            missing.append(metric)
        else:
            measured[metric] = value
    if missing:
        return {"status": NOT_RUN, "reason": "required dimension metric not measured", "missingMetrics": missing, "language": language}
    metric_results: dict[str, dict] = {}
    failed = False
    if required_metrics:
        thresholds = policy.get("capabilityMetrics", {}).get(dimension["capabilityId"])
        if not isinstance(thresholds, dict) or not thresholds:
            return {
                "status": NOT_RUN,
                "reason": "capability has no declared threshold authority",
                "language": language,
                "capabilityId": dimension["capabilityId"],
                "configurationError": True,
            }
        for metric, value in measured.items():
            rule = thresholds.get(metric)
            if rule is None:
                metric_results[metric] = {"status": NOT_RUN, "value": value, "reason": "measured; no dimension threshold declared", "configurationError": True}
                continue
            passed = value <= rule["value"] if rule["operator"] == "lte" else value >= rule["value"]
            metric_results[metric] = {"status": PASS if passed else FAIL, "value": value, "operator": rule["operator"], "threshold": rule["value"]}
            failed |= not passed
        if any(result.get("configurationError") for result in metric_results.values()):
            return {
                "status": NOT_RUN,
                "reason": "required metric has no declared dimension threshold",
                "language": language,
                "capabilityId": dimension["capabilityId"],
                "metrics": metric_results,
                "configurationError": True,
            }
    real_evidence = all(_has_real_provider_evidence(item) for item in observations)
    measured_status = FAIL if failed else PASS
    return {
        # A numeric score without provider provenance is not a qualification
        # result. Keep the measured outcome for diagnostics, but leave the
        # authoritative leaf NOT_RUN until real evidence is attached.
        "status": measured_status if real_evidence else NOT_RUN,
        "measuredStatus": measured_status,
        "reason": None if real_evidence else "provider provenance unavailable",
        "language": language,
        "capabilityId": dimension["capabilityId"],
        "providerRef": dimension.get("providerRef"),
        "observationCount": len(observations),
        "metrics": metric_results,
        "realProviderEvidence": real_evidence,
        "rawObservationFingerprints": [digest(item.get("rawObservation", item)) for item in observations],
    }


def project_capabilities(observations: list[dict], manifest: dict, policy: dict) -> dict:
    dimensions: dict[str, dict[str, dict]] = {}
    accepted: list[dict] = []
    projected: list[dict] = []
    for dimension in manifest.get("capabilityDimensions", []):
        capability = dimension["capabilityId"]
        dimensions[capability] = {}
        disposition = dimension.get("closureDisposition", dimension.get("disposition", "REQUIRED"))
        if disposition not in DISPOSITIONS:
            raise ValueError(f"invalid closure disposition for {capability}")
        for language in dimension.get("languages", []):
            if disposition == "UNSUPPORTED_BY_DESIGN":
                leaf = {"status": "UNSUPPORTED_BY_DESIGN", "language": language, "capabilityId": capability, "reason": "dimension is not reconstructible by the qualified providers"}
                dimensions[capability][language] = leaf
                projected.append({
                    "capabilityId": capability,
                    "providerRef": dimension.get("providerRef"),
                    "language": language,
                    "feature": dimension.get("feature"),
                    "mediaTypes": dimension.get("mediaTypes", []),
                    "state": "UNSUPPORTED_BY_DESIGN",
                    "closureDisposition": disposition,
                    "closureStatus": PASS,
                    "evidence": {"status": "UNSUPPORTED_BY_DESIGN", "realProviderEvidence": False, "observationCount": 0, "metrics": {}},
                })
                continue
            selected = [item for item in observations if _capability_id(item) == capability and _language(item) == language]
            leaf = _dimension_leaf(dimension, language, selected, policy)
            dimensions[capability][language] = leaf
            if leaf["status"] == PASS and leaf.get("realProviderEvidence") is True:
                state = "QUALIFIED"
            elif leaf["status"] == FAIL:
                state = "NOT_QUALIFIED"
            else:
                state = "NOT_EVALUATED"
            # Closure is separate from measurement quality.  A deferred leaf
            # keeps its measured state but stops blocking the increment only
            # when a measured result is actually on record.
            if disposition == "DEFERRED_TO_FUTURE_RELEASE":
                closure_status = PASS if leaf["status"] in {PASS, FAIL} and leaf.get("realProviderEvidence") is True else NOT_RUN
            elif disposition == "OPTIONAL":
                closure_status = PASS
            else:
                closure_status = PASS if state == "QUALIFIED" else (FAIL if state == "NOT_QUALIFIED" else NOT_RUN)
            entry = {
                "capabilityId": capability,
                "providerRef": dimension.get("providerRef"),
                "language": language,
                "feature": dimension.get("feature"),
                "mediaTypes": dimension.get("mediaTypes", []),
                "state": state,
                "closureDisposition": disposition,
                "closureStatus": closure_status,
                "evidence": {
                    "status": leaf["status"],
                    "realProviderEvidence": leaf.get("realProviderEvidence", False),
                    "observationCount": leaf.get("observationCount", 0),
                    "metrics": leaf.get("metrics", {}),
                },
            }
            for deferred_field in ("deferredReason", "deferredTarget", "revisitTrigger"):
                if dimension.get(deferred_field) is not None:
                    entry[deferred_field] = dimension[deferred_field]
            projected.append(entry)
            # A PASS dimension is evidence-derived, but it is only promotable
            # when its evidence is real, both frozen authorities agree, and
            # the dimension is not deferred or unsupported by design.
            if leaf["status"] == PASS and leaf.get("realProviderEvidence") is True and disposition in {"REQUIRED", "OPTIONAL"}:
                accepted.append({
                    "capability": capability,
                    "capabilityId": capability,
                    "providerRef": dimension.get("providerRef"),
                    "language": language,
                    "feature": dimension.get("feature"),
                    "mediaTypes": dimension.get("mediaTypes", []),
                    "evidence": "raw-provider-observation",
                })
    return {
        "schemaVersion": "increment4a.capabilities.v2",
        "dimensions": dimensions,
        "capabilities": projected,
        "accepted": accepted,
        "projectionRule": "capabilities contains one independently evaluated provider/language leaf; accepted contains only independently PASS leaves; no language widening",
    }


def _fixture_leaves(observations: list[dict], manifest: dict) -> dict[str, dict]:
    leaves: dict[str, dict] = {}
    for fixture in manifest.get("fixtures", []):
        fixture_id = fixture["fixtureId"]
        selected = [item for item in observations if item.get("fixtureId") == fixture_id]
        if not selected or all(_is_skipped(item) for item in selected):
            leaves[fixture_id] = {"status": NOT_RUN, "reason": "required fixture missing or skipped"}
        elif len(selected) != 1:
            leaves[fixture_id] = {"status": FAIL, "reason": "required fixture is duplicated", "count": len(selected)}
        elif _observation_error(selected[0]):
            leaves[fixture_id] = {"status": FAIL, "reason": "provider execution error", "error": selected[0]["error"]}
        else:
            leaves[fixture_id] = {"status": PASS, "reason": "observation present"}
    return leaves


def _capability_leaves(capability_projection: dict, disposition: str) -> dict[str, dict]:
    leaves: dict[str, dict] = {}
    for item in capability_projection["capabilities"]:
        if item["closureDisposition"] != disposition:
            continue
        leaf = {
            "status": PASS if item["state"] == "QUALIFIED" else FAIL if item["state"] == "NOT_QUALIFIED" else item["state"] if item["state"] in {"UNSUPPORTED_BY_DESIGN", STALE} else NOT_RUN,
            "capabilityState": item["state"],
            "closureDisposition": item["closureDisposition"],
            "closureStatus": item.get("closureStatus"),
        }
        for field in ("deferredReason", "deferredTarget", "revisitTrigger"):
            if item.get(field) is not None:
                leaf[field] = item[field]
        leaves[f"{item['capabilityId']}:{item['language']}"] = leaf
    return leaves


def _mark_provider_evidence_stale(value: Any, reason: str) -> None:
    """Mark decisions derived from stale provider observations without hiding raw measurements."""
    if isinstance(value, dict):
        if value.get("state") == "UNSUPPORTED_BY_DESIGN":
            return
        if value.get("status") in {PASS, FAIL, NOT_RUN}:
            value["status"] = STALE
            value["reason"] = reason
        if value.get("state") in {"QUALIFIED", "NOT_QUALIFIED", "NOT_EVALUATED"}:
            value["state"] = STALE
        if value.get("closureStatus") in {PASS, FAIL, NOT_RUN}:
            value["closureStatus"] = STALE
        for item in value.values():
            _mark_provider_evidence_stale(item, reason)
    elif isinstance(value, list):
        for item in value:
            _mark_provider_evidence_stale(item, reason)


def evaluate(observations: list[dict], observation_reuse: dict | None = None) -> tuple[dict, dict]:
    manifest_path = HERE / "manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())
    policy = yaml.safe_load((HERE / "acceptance.yaml").read_text())
    fixture_ids = {item["fixtureId"] for item in manifest["fixtures"]}
    observed_ids = {item.get("fixtureId") for item in observations}
    unknown = sorted(str(item) for item in observed_ids - fixture_ids)
    missing = sorted(fixture_ids - observed_ids)
    duplicates = sorted(item for item in fixture_ids if sum(obs.get("fixtureId") == item for obs in observations) != 1)
    metrics = aggregate(observations)
    thresholds = threshold_results(metrics, policy)
    errors = [item.get("error") for item in observations if item.get("error")]
    # manifest.yaml is the sole canonical fixture authority.  The legacy
    # qualification.yaml inventory is SUPERSEDED and never contributes leaves.
    fixture_leaves = _fixture_leaves(observations, manifest)
    required_leaves = {f"fixture:{key}": value for key, value in fixture_leaves.items()}
    required_leaves.update({f"metric:{key}": value for key, value in thresholds.items()})
    capability_projection = project_capabilities(observations, manifest, policy)
    required_capability_leaves = _capability_leaves(capability_projection, "REQUIRED")
    deferred_capability_leaves = _capability_leaves(capability_projection, "DEFERRED_TO_FUTURE_RELEASE")
    unsupported_capability_leaves = _capability_leaves(capability_projection, "UNSUPPORTED_BY_DESIGN")
    required_leaves.update({f"capability:{key}": value for key, value in required_capability_leaves.items()})
    has_not_run = any(leaf.get("status") == NOT_RUN for leaf in required_leaves.values())
    has_failed = any(leaf.get("status") == FAIL for leaf in required_leaves.values()) or bool(unknown or errors)
    raw_values = [item.get("rawObservation", item) for item in observations]
    raw_fingerprints = [digest(value) for value in raw_values]
    real_evidence = bool(observations) and all(_has_real_provider_evidence(item) for item in observations)
    current_implementation = implementation_fingerprints(WORKER_ROOT)
    material = material_fingerprints()
    material_digest = digest(material)
    authorities_frozen = manifest.get("state") == policy.get("state") == "FROZEN"
    # A measured failing leaf is a real FAIL. Missing/skipped leaves remain
    # NOT_RUN when no measured failure can be established.
    status = NOT_RUN if not observations or (has_not_run and not has_failed) or (not real_evidence and not has_failed) else (FAIL if has_failed else PASS)
    reuse_stale_reason: str | None = None
    if observation_reuse is not None:
        source_fingerprint = observation_reuse.get("sourceProviderSemanticsFingerprint")
        current_provider_fingerprint = current_implementation["providerSemanticsFingerprint"]
        if not isinstance(source_fingerprint, str):
            reuse_stale_reason = "source provider semantics fingerprint is unrecorded"
        elif not isinstance(observation_reuse.get("sourceSummaryFingerprint"), str):
            reuse_stale_reason = "source run summary fingerprint is unrecorded"
        elif source_fingerprint != current_provider_fingerprint:
            reuse_stale_reason = "source provider semantics fingerprint does not match current provider implementation"
        elif observation_reuse.get("historicalProviderSemanticsBinding") != "RECORDED":
            reuse_stale_reason = "source provider semantics binding is not recorded"
        elif observation_reuse.get("providerExecutionReused") is not True:
            reuse_stale_reason = "observation reuse lineage does not record reused provider execution"
        elif observation_reuse.get("sourceObservationsFingerprint") != digest(observations):
            reuse_stale_reason = "source observation fingerprint does not match the projected observations"
        if reuse_stale_reason is not None:
            status = STALE
            _mark_provider_evidence_stale(fixture_leaves, reuse_stale_reason)
            _mark_provider_evidence_stale(thresholds, reuse_stale_reason)
            _mark_provider_evidence_stale(capability_projection["dimensions"], reuse_stale_reason)
            _mark_provider_evidence_stale(capability_projection["capabilities"], reuse_stale_reason)
            required_capability_leaves = _capability_leaves(capability_projection, "REQUIRED")
            deferred_capability_leaves = _capability_leaves(capability_projection, "DEFERRED_TO_FUTURE_RELEASE")
            unsupported_capability_leaves = _capability_leaves(capability_projection, "UNSUPPORTED_BY_DESIGN")
            required_leaves = {f"fixture:{key}": value for key, value in fixture_leaves.items()}
            required_leaves.update({f"metric:{key}": value for key, value in thresholds.items()})
            required_leaves.update({f"capability:{key}": value for key, value in required_capability_leaves.items()})
            observation_reuse["providerSemanticsBindingStatus"] = STALE
            observation_reuse["providerSemanticsBindingReason"] = reuse_stale_reason
        else:
            observation_reuse["providerSemanticsBindingStatus"] = PASS
        observation_reuse["expectedProviderSemanticsFingerprint"] = current_provider_fingerprint
    summary = {
        "schemaVersion": "increment4a.summary.v2",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        **fingerprints(),
        "materialFingerprints": material,
        **current_implementation,
        "materialFingerprint": material_digest,
        "frozenMaterial": {**all_fingerprints(), "materialFingerprint": material_digest, "authoritiesFrozen": authorities_frozen},
        "acceptanceState": policy["state"],
        "qualificationState": manifest["state"],
        "observationCount": len(observations),
        "observationsFingerprint": digest(observations),
        "rawObservationsFingerprint": digest(raw_values),
        "rawObservationFingerprints": raw_fingerprints,
        "rawObservationCount": len(raw_values),
        "rawObservationIntegrity": PASS,
        "realProviderEvidence": real_evidence,
        "missingFixtures": missing,
        "unknownFixtures": unknown,
        "duplicateFixtures": duplicates,
        "executionErrors": errors,
        "metrics": metrics,
        "thresholdResults": thresholds,
        "fixtureLeaves": fixture_leaves,
        "requiredLeaves": required_leaves,
        "requiredCapabilityLeaves": required_capability_leaves,
        "deferredCapabilityLeaves": deferred_capability_leaves,
        "unsupportedCapabilityLeaves": unsupported_capability_leaves,
        "capabilityDimensions": capability_projection["dimensions"],
        "status": status,
        "environmentCapture": {
            "platform": platform.system(), "platformRelease": platform.release(),
            "machine": platform.machine(), "pythonVersion": platform.python_version(),
        },
    }
    if observation_reuse is not None:
        summary["observationReuse"] = observation_reuse
    capability_projection.update({
        "qualificationStatus": status,
        "materialFingerprint": material_digest,
        "promotable": bool(authorities_frozen and status == PASS and real_evidence),
        "requiredCapabilityLeaves": required_capability_leaves,
        "deferredCapabilityLeaves": deferred_capability_leaves,
        "unsupportedCapabilityLeaves": unsupported_capability_leaves,
    })
    # Preserve the dimensional projection for review, but never expose
    # pre-frozen or unavailable evidence as an accepted qualification.
    capability_projection["projected"] = list(capability_projection["accepted"])
    if not capability_projection["promotable"]:
        capability_projection["accepted"] = []
    if observation_reuse is not None:
        capability_projection["providerSemanticsBindingStatus"] = observation_reuse["providerSemanticsBindingStatus"]
    if reuse_stale_reason is not None:
        summary["status"] = STALE
        capability_projection["qualificationStatus"] = STALE
        capability_projection["promotable"] = False
        capability_projection["accepted"] = []
        capability_projection["projected"] = []
    return summary, capability_projection


def _write_raw_artifacts(output: Path, observations: list[dict]) -> None:
    raw_values = [item.get("rawObservation", item) for item in observations]
    (output / "raw-observations.json").write_text(json.dumps(raw_values, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    shutil.copyfile(output / "raw-observations.json", output / "raw_observations.json")
    (output / "raw-observation-artifacts.json").write_text(json.dumps([
        {
            "index": index,
            "fixtureId": observation.get("fixtureId"),
            "fingerprint": digest(value),
            "observation": value,
        }
        for index, (observation, value) in enumerate(zip(observations, raw_values))
    ], ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    raw_dir = output / "raw-observations"
    raw_dir.mkdir()
    for index, value in enumerate(raw_values):
        fixture = observations[index].get("fixtureId", f"observation-{index}")
        safe_fixture = "".join(char if char.isalnum() or char in "-_" else "_" for char in str(fixture))
        (raw_dir / f"{index:04d}-{safe_fixture}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def _load_source_observations(run_id: str) -> tuple[list[dict], dict]:
    """Reuse an immutable prior run's provider observations.

    The returned reuse record makes the lineage explicit: provider execution
    was reused, never re-measured, and the observation fingerprint must match
    the source run's recorded summary.
    """
    if not isinstance(run_id, str) or not run_id or run_id in {".", ".."} or Path(run_id).name != run_id:
        raise ValueError("source run id must be a plain results directory name")
    observations, source_summary, source_summary_fingerprint = _validated_source_run(run_id, set())
    recorded = source_summary["observationsFingerprint"]
    return observations, {
        "observationSourceRunId": run_id,
        "observationReuseReason": "EXPLICIT_IMPLEMENTATION_FINGERPRINT_REPROJECTION",
        "sourceObservationsFingerprint": recorded,
        "sourceSummaryFingerprint": source_summary_fingerprint,
        "sourceProviderSemanticsFingerprint": source_summary.get("providerSemanticsFingerprint"),
        "sourceEvaluationImplementationFingerprint": source_summary.get("evaluationImplementationFingerprint"),
        "historicalProviderSemanticsBinding": "UNRECORDED" if source_summary.get("providerSemanticsFingerprint") is None else "RECORDED",
        "providerExecutionReused": True,
    }


def _validated_source_run(run_id: str, visited: set[str]) -> tuple[list[dict], dict, str]:
    """Load a source run only when its summary is anchored and its lineage is intact."""
    if not isinstance(run_id, str) or not run_id or run_id in {".", ".."} or Path(run_id).name != run_id or run_id in visited:
        raise ValueError("source run id is invalid or its reuse lineage contains a cycle")
    visited.add(run_id)
    source = HERE / "results" / run_id
    summary_path = source / "summary.json"
    observations_path = source / "observations.json"
    try:
        summary_bytes = summary_path.read_bytes()
        summary = json.loads(summary_bytes)
        observations = json.loads(observations_path.read_text(encoding="utf-8"))
        lineage = json.loads((source / "lineage.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"source run {run_id} is missing readable summary, observations, or lineage") from exc
    if (
        not isinstance(summary, dict)
        or not isinstance(observations, list)
        or any(not isinstance(item, dict) for item in observations)
        or not isinstance(lineage, dict)
    ):
        raise ValueError("source observations, summary, and lineage have invalid structures")
    summary_fingerprint = hashlib.sha256(summary_bytes).hexdigest()
    observations_fingerprint = digest(observations)
    current_provider_fingerprint = implementation_fingerprints(WORKER_ROOT)["providerSemanticsFingerprint"]
    if (
        summary.get("observationsFingerprint") != observations_fingerprint
        or summary.get("providerSemanticsFingerprint") != current_provider_fingerprint
        or lineage.get("observationsFingerprint") != observations_fingerprint
        or lineage.get("providerSemanticsFingerprint") != current_provider_fingerprint
    ):
        raise ValueError(f"source run {run_id} has stale or inconsistent observation semantics")

    # A source is usable only if a current authority or supersession record
    # pins these exact summary bytes and their provider-semantics fingerprint.
    anchored = False
    anchored_by_superseded = False
    try:
        pointer = json.loads((HERE / "canonical-run.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pointer = {}
    if (
        isinstance(pointer, dict)
        and pointer.get("schemaVersion") == "increment4a.canonical-run.v1"
        and pointer.get("state") == "ACTIVE"
        and pointer.get("runId") == run_id
        and pointer.get("summaryFingerprint") == summary_fingerprint
        and pointer.get("observationsFingerprint") == observations_fingerprint
        and pointer.get("providerSemanticsFingerprint") == current_provider_fingerprint
    ):
        anchored = True
    if not anchored:
        try:
            superseded = json.loads((HERE / "superseded-runs.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            superseded = {}
        if (
            not isinstance(superseded, dict)
            or superseded.get("schemaVersion") != "increment4a.superseded-runs.v1"
            or not isinstance(superseded.get("runs"), list)
        ):
            raise ValueError("superseded-run authority is missing or malformed")
        superseded_runs = superseded["runs"]
        anchored_by_superseded = any(
            isinstance(item, dict)
            and item.get("runId") == run_id
            and item.get("state") == "SUPERSEDED"
            and item.get("summaryFingerprint") == summary_fingerprint
            and item.get("observationsFingerprint") == observations_fingerprint
            and item.get("providerSemanticsFingerprint") == current_provider_fingerprint
            for item in superseded_runs
        )
        anchored = anchored_by_superseded
    if not anchored:
        raise ValueError(f"source run {run_id} summary is not pinned by the active canonical pointer or superseded-run authority")

    reuse = summary.get("observationReuse")
    if reuse is None:
        if lineage.get("providerExecutionReused") is not False or lineage.get("observationReuse") is not None:
            raise ValueError(f"source run {run_id} does not have a valid direct-provider lineage")
        attestation_path = source / "campaign-attestation.json"
        if attestation_path.is_file():
            try:
                attestation_bytes = attestation_path.read_bytes()
                attestation = json.loads(attestation_bytes)
            except (OSError, json.JSONDecodeError, ValueError) as exc:
                raise ValueError(f"source run {run_id} has an invalid direct-campaign attestation") from exc
            try:
                execution_id_valid = (
                    isinstance(attestation, dict)
                    and isinstance(attestation.get("executionId"), str)
                    and uuid.UUID(hex=attestation["executionId"]).hex == attestation["executionId"]
                )
            except (ValueError, AttributeError):
                execution_id_valid = False
            if (
                not isinstance(attestation, dict)
                or attestation.get("schemaVersion") != DIRECT_CAMPAIGN_ATTESTATION_SCHEMA
                or not execution_id_valid
                or attestation.get("runner") != "evaluation/increment4a/run_campaign.py"
                or attestation.get("providerExecutionReused") is not False
                or attestation.get("providerCampaignExecution") != "EXECUTED"
                or lineage.get("providerCampaignExecution") != "EXECUTED"
                or lineage.get("directCampaignAttestationFingerprint") != hashlib.sha256(attestation_bytes).hexdigest()
                or lineage.get("providerSemanticsFingerprint") != current_provider_fingerprint
                or lineage.get("evaluationImplementationFingerprint") != summary.get("evaluationImplementationFingerprint")
                or lineage.get("materialFingerprints") != summary.get("materialFingerprints")
                or attestation.get("providerSemanticsFingerprint") != current_provider_fingerprint
                or attestation.get("evaluationImplementationFingerprint") != summary.get("evaluationImplementationFingerprint")
                or attestation.get("materialFingerprints") != summary.get("materialFingerprints")
                or attestation.get("materialFingerprint") != summary.get("materialFingerprint")
                or attestation.get("materialFingerprint") != digest(summary.get("materialFingerprints"))
                or attestation.get("observationsFingerprint") != observations_fingerprint
                or attestation.get("rawObservationFingerprints") != summary.get("rawObservationFingerprints")
                or lineage.get("rawObservationFingerprints") != summary.get("rawObservationFingerprints")
            ):
                raise ValueError(f"source run {run_id} direct-campaign lineage does not match its attestation")
        elif not anchored_by_superseded or lineage.get("providerCampaignExecution") != "EXECUTED":
            raise ValueError(f"source run {run_id} has no direct-campaign attestation")
    else:
        if not isinstance(reuse, dict) or reuse.get("providerExecutionReused") is not True:
            raise ValueError(f"source run {run_id} has an invalid observation reuse binding")
        source_run_id = reuse.get("observationSourceRunId")
        if not isinstance(source_run_id, str) or not source_run_id:
            raise ValueError(f"source run {run_id} is missing its prior source run id")
        child_observations, child_summary, child_summary_fingerprint = _validated_source_run(source_run_id, visited)
        child_observations_fingerprint = digest(child_observations)
        if (
            lineage.get("observationReuse") != reuse
            or reuse.get("sourceSummaryFingerprint") != child_summary_fingerprint
            or reuse.get("sourceObservationsFingerprint") != child_observations_fingerprint
            or observations_fingerprint != child_observations_fingerprint
            or reuse.get("sourceProviderSemanticsFingerprint") != current_provider_fingerprint
            or reuse.get("historicalProviderSemanticsBinding") != "RECORDED"
            or reuse.get("providerSemanticsBindingStatus") != PASS
            or reuse.get("expectedProviderSemanticsFingerprint") != current_provider_fingerprint
            or reuse.get("sourceEvaluationImplementationFingerprint") != child_summary.get("evaluationImplementationFingerprint")
        ):
            raise ValueError(f"source run {run_id} has stale or incomplete observation reuse lineage")
    return observations, summary, summary_fingerprint


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--observations", type=Path, help="JSON array emitted by the real-provider harness")
    parser.add_argument("--source-run-id", type=str, default=None, help="reuse observations from results/<run-id> instead of a new provider campaign")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    observation_reuse: dict | None = None
    direct_campaign_attestation: dict | None = None
    direct_attestation_bytes: bytes | None = None
    try:
        if args.source_run_id is not None:
            if args.observations is not None:
                raise ValueError("--observations and --source-run-id are mutually exclusive")
            observations, observation_reuse = _load_source_observations(args.source_run_id)
        elif args.observations is not None:
            observations = json.loads(args.observations.read_text())
            if not isinstance(observations, list) or any(not isinstance(item, dict) for item in observations):
                raise ValueError("observations must be a JSON array of objects")
            attestation_path = args.observations.with_suffix(".attestation.json")
            direct_attestation_bytes = attestation_path.read_bytes()
            direct_campaign_attestation = validate_direct_campaign_attestation(
                observations,
                json.loads(direct_attestation_bytes),
            )
        else:
            raise ValueError("either --observations or --source-run-id is required")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"status": NOT_RUN, "error": str(error)}))
        return 2
    summary, capabilities = evaluate(observations, observation_reuse)
    output = args.output or HERE / "results" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output.mkdir(parents=True, exist_ok=False)
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "capabilities.json").write_text(json.dumps(capabilities, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "observations.json").write_text(json.dumps(observations, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "observations.jsonl").write_text("".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in observations))
    lineage = {
        "schemaVersion": "increment4a.lineage.v1",
        "materialFingerprints": summary["materialFingerprints"],
        "providerSemanticsFingerprint": summary["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": summary["evaluationImplementationFingerprint"],
        "rawObservationFingerprints": summary["rawObservationFingerprints"],
        "observationsFingerprint": summary["observationsFingerprint"],
        **({"observationReuse": observation_reuse} if observation_reuse is not None else {}),
    }
    if direct_campaign_attestation is not None and direct_attestation_bytes is not None:
        (output / "campaign-attestation.json").write_bytes(direct_attestation_bytes)
        lineage.update({
            "providerCampaignExecution": "EXECUTED",
            "providerExecutionReused": False,
            "directCampaignAttestationFingerprint": hashlib.sha256(direct_attestation_bytes).hexdigest(),
        })
    elif observation_reuse is not None:
        lineage["providerExecutionReused"] = True
    (output / "lineage.json").write_text(json.dumps(lineage, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "metrics.json").write_text(json.dumps(summary["metrics"], ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "threshold-results.json").write_text(json.dumps(summary["thresholdResults"], ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    _write_raw_artifacts(output, observations)
    print(json.dumps({"output": str(output), "status": summary["status"]}))
    return 0 if summary["status"] == PASS else 1


if __name__ == "__main__":
    raise SystemExit(main())
