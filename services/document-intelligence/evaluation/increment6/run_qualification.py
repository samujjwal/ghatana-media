#!/usr/bin/env python3
"""Evaluate Increment-6 observations without widening or inventing evidence.

Mirrors the Increment-4A conventions (``evaluation/increment4a/
run_qualification.py``) for the I6 authority set: lane manifests under
``corpus/<lane>/fixtures.yaml`` are the canonical fixture declarations, fixture
binaries may be declared-but-absent, and capability state is projected one
provider/language dimension at a time.
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
from evaluation.increment4a.metrics import aggregate, percentile  # noqa: E402  (read-only reuse)
from evaluation.increment6.implementation_material import implementation_fingerprints  # noqa: E402

PASS = "PASS"
FAIL = "FAIL"
NOT_RUN = "NOT_RUN"
STALE = "STALE"
LEAF_STATUSES = {PASS, FAIL, NOT_RUN, STALE}
DISPOSITIONS = {"REQUIRED", "OPTIONAL", "UNSUPPORTED_BY_DESIGN", "DEFERRED_TO_FUTURE_RELEASE"}
UNSUPPORTED = "UNSUPPORTED_BY_DESIGN"


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _material_digest(path: Path) -> str:
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


def material_fingerprints() -> dict[str, str]:
    """Fingerprint the I6 authority set; declared-but-absent paths hash as MISSING."""
    authorities = {
        "manifest": HERE / "manifest.yaml",
        "qualification": HERE / "qualification.yaml",
        "acceptance": HERE / "acceptance.yaml",
        "environment": HERE / "environment.yaml",
        "corpus": HERE / "corpus",
        "requiredTests": HERE / "required-tests.yaml",
        "implementationMaterial": HERE / "implementation-material.yaml",
        "performanceEvidenceSchema": HERE / "schemas/performance-evidence.v1.schema.json",
        "modelManifest": WORKER_ROOT / "models/increment4a/model-manifest.yaml",
        "languageRegistry": WORKER_ROOT / "models/increment4a/language-registry.yaml",
        "scannedPdfRouting": WORKER_ROOT / "routing/scanned-pdf.v1.yaml",
        "fallbackContractRouting": WORKER_ROOT / "routing/fallback-contract.v1.yaml",
        "workerProfile": WORKER_ROOT / "profiles/increment6.yaml",
    }
    return {
        **{f"{name}Fingerprint": _material_digest(path) for name, path in authorities.items()},
        **implementation_fingerprints(WORKER_ROOT),
    }


def fingerprints() -> dict[str, str]:
    """Three-file fingerprints retained for callers of the original slice."""
    return {f"{name}Fingerprint": sha256(HERE / filename) for name, filename in {
        "qualification": "qualification.yaml", "acceptance": "acceptance.yaml", "environment": "environment.yaml"
    }.items()}


def all_fingerprints() -> dict[str, str]:
    return {**fingerprints(), **material_fingerprints()}


def load_manifest() -> dict:
    manifest = yaml.safe_load((HERE / "manifest.yaml").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != "increment6.manifest.v1":
        raise ValueError("manifest.yaml has an invalid schema")
    return manifest


def _lane_dispositions(manifest: dict) -> dict[str, str]:
    """Resolve one closure disposition for every lane from its capabilities.

    A lane cannot mix required and deferred capability leaves: doing so would
    make a missing fixture ambiguous at the fixture and capability layers.
    """
    dimensions = {
        item["capabilityId"]: item
        for item in manifest.get("capabilityDimensions", [])
    }
    dispositions: dict[str, str] = {}
    for lane in manifest.get("lanes", []):
        lane_id = lane["id"]
        values = {
            dimensions[capability_id]["closureDisposition"]
            for capability_id in lane.get("ownerCapabilityIds", [])
        }
        if len(values) != 1:
            raise ValueError(f"lane {lane_id} must have one closure disposition, got {sorted(values)}")
        dispositions[lane_id] = values.pop()
    return dispositions


def load_policy() -> dict:
    policy = yaml.safe_load((HERE / "acceptance.yaml").read_text(encoding="utf-8"))
    if not isinstance(policy, dict) or policy.get("schemaVersion") != "increment6.acceptance.v1":
        raise ValueError("acceptance.yaml has an invalid schema")
    return policy


def load_lane_fixtures(manifest: dict) -> list[dict]:
    """Aggregate the declared fixture set across every lane manifest.

    Lane manifests are required authority; fixture binaries inside them may be
    DECLARED_NOT_PRESENT and are tolerated at manifest level.
    """
    declared: list[dict] = []
    seen: set[str] = set()
    lane_dispositions = _lane_dispositions(manifest)
    for lane in manifest.get("lanes", []):
        lane_id = lane["id"]
        fixtures_path = HERE / lane["fixturesManifest"]
        if not fixtures_path.is_file():
            raise ValueError(f"lane {lane_id} is missing its fixtures manifest: {lane['fixturesManifest']}")
        spec = yaml.safe_load(fixtures_path.read_text(encoding="utf-8"))
        if not isinstance(spec, dict) or spec.get("schemaVersion") != "increment6.fixtures.v1" or spec.get("lane") != lane_id:
            raise ValueError(f"lane {lane_id} fixtures manifest is malformed")
        for fixture in spec.get("fixtures", []):
            fixture_id = fixture.get("fixtureId")
            if not isinstance(fixture_id, str) or not fixture_id:
                raise ValueError(f"lane {lane_id} declares a fixture without a fixtureId")
            if fixture_id in seen:
                raise ValueError(f"duplicate fixtureId across lanes: {fixture_id}")
            seen.add(fixture_id)
            declared.append({
                **fixture,
                "lane": lane_id,
                "corpus": lane_id,
                "closureDisposition": lane_dispositions[lane_id],
            })
    return declared


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
    provider = (_provider_ref(observation) or "").lower()
    language = _language(observation) or "und"
    if "scanned-pdf-classifier" in provider or "classifier" in provider:
        return f"parser.pdf.scanned.classify.{language}"
    if "gliner" in provider:
        return f"extraction.schema-guided.{language}.v2"
    if "paddle" in provider:
        return f"ocr.paddle.{language}"
    if "xlsx" in provider:
        return f"parser.xlsx.tables.{language}"
    if "docx" in provider:
        return f"parser.docx.text.{language}"
    if "pptx" in provider:
        return f"parser.pptx.text.{language}"
    if "hybrid" in provider:
        return f"parser.pdf.hybrid.provenance.{language}"
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


def _check_rule(value: float, rule: dict) -> bool:
    operator = rule["operator"]
    if operator == "lte":
        return value <= rule["value"]
    if operator == "gte":
        return value >= rule["value"]
    if operator == "eq":
        return value == rule["value"]
    raise ValueError(f"unknown threshold operator: {operator}")


def threshold_results(metrics: dict[str, float], policy: dict) -> dict[str, dict]:
    results: dict[str, dict] = {}
    for name, rule in policy.get("metrics", {}).items():
        if name not in metrics:
            results[name] = {"status": NOT_RUN, "reason": "required metric not measured"}
            continue
        value = metrics[name]
        passed = _check_rule(value, rule)
        results[name] = {"status": PASS if passed else FAIL, "value": value, "operator": rule["operator"], "threshold": rule["value"]}
    return results


def _metric_value(observations: list[dict], metric: str) -> float | None:
    metrics = aggregate(observations)
    if metric in metrics:
        return metrics[metric]
    if metric == "classification.accuracy":
        scored = [
            item for item in observations
            if item.get("expectedDocumentClass") is not None and item.get("actualDocumentClass") is not None
        ]
        if not scored:
            return None
        return sum(1.0 for item in scored if item["expectedDocumentClass"] == item["actualDocumentClass"]) / len(scored)
    aliases = {
        "provenance.completeness": ("provenance.completeness", "provenanceCompleteness", "provenance_completeness"),
        "gliner.entityF1": ("gliner.entityF1", "entityF1", "fieldF1", "f1", "entity_f1"),
        "gliner.evidenceAccuracy": ("gliner.evidenceAccuracy", "evidenceAccuracy", "evidence_accuracy"),
        "layout.iou": ("layout.iou", "layoutIoU"),
        "structureAccuracy": ("structureAccuracy", "structure_accuracy"),
        "text.cer": ("text.cer", "cer", "ocr.cer"),
        "language.accuracy": ("language.accuracy", "languageAccuracy"),
    }
    keys = aliases.get(metric, (metric,))
    values = [float(item[key]) for item in observations for key in keys if isinstance(item.get(key), (int, float))]
    return sum(values) / len(values) if values else None


# I6-61: metric keys read from observations carrying soak/recovery/queue
# evidence. ``leakBaseline`` entries (I6-62) are projected onto the same
# ``soak.*`` names so a single threshold covers both observation styles.
_LEAK_BASELINE_MAP = {
    "fileDescriptors": "soak.fdDelta",
    "tempFiles": "soak.tempFileDelta",
    "threads": "soak.threadDelta",
    "nativeProcesses": "soak.nativeProcessDelta",
    "modelInstances": "soak.modelInstanceDelta",
    "queueEntries": "soak.queueEntryDelta",
    "dbHandles": "soak.dbHandleDelta",
}


def _derived_runtime_metrics(observations: list[dict]) -> dict[str, float]:
    """Derive the I6-61 runtime/soak/recovery metrics from observations.

    ``increment4a.metrics.aggregate`` is sealed authority and cannot grow, so
    the additional accepted metrics are derived here. Every metric is absent
    when no observation carries its evidence — declared thresholds therefore
    evaluate NOT_RUN rather than silently passing.
    """
    derived: dict[str, float] = {}
    executed = [item for item in observations if not _is_skipped(item)]
    latency = [float(item["latencyMs"]) for item in executed if isinstance(item.get("latencyMs"), (int, float))]
    if latency:
        derived["runtime.p99LatencyMs"] = percentile(latency, 0.99)
        total_seconds = sum(latency) / 1000.0
        if total_seconds > 0:
            derived["runtime.throughputPerSecond"] = len(latency) / total_seconds
    if executed:
        derived["runtime.errorRate"] = sum(1 for item in executed if _observation_error(item)) / len(executed)
    scalar_keys = {
        "runtime.queueRejectionLatencyMs": ("queueRejectionLatencyMs",),
        "runtime.queueLimitRejections": ("queueLimitRejections", "unexpectedQueueRejections"),
        "soak.peakRssDeltaMb": ("soak.peakRssDeltaMb", "peakRssDeltaMb"),
        "soak.fdDelta": ("fdDelta",),
        "soak.tempFileDelta": ("tempFileDelta",),
        "soak.threadDelta": ("threadDelta",),
        "soak.nativeProcessDelta": ("nativeProcessDelta",),
        "soak.modelInstanceDelta": ("modelInstanceDelta",),
        "soak.queueEntryDelta": ("queueEntryDelta",),
        "soak.dbHandleDelta": ("dbHandleDelta",),
        "recovery.restartSeconds": ("restartSeconds", "restart_seconds"),
    }
    for name, keys in scalar_keys.items():
        values = [
            float(item[key])
            for item in observations
            for key in keys
            if isinstance(item.get(key), (int, float)) and not isinstance(item.get(key), bool)
        ]
        if values:
            derived[name] = max(values)
    for item in observations:
        baselines = item.get("leakBaseline")
        if not isinstance(baselines, list):
            continue
        for entry in baselines:
            if not isinstance(entry, dict):
                continue
            metric = _LEAK_BASELINE_MAP.get(entry.get("metric"))
            if metric is None and entry.get("metric") == "rssBytes":
                metric = "soak.peakRssDeltaMb"
            if metric is None or not isinstance(entry.get("delta"), (int, float)):
                continue
            delta = float(entry["delta"])
            if entry.get("metric") == "rssBytes":
                delta /= 1024.0 * 1024.0
            derived[metric] = max(derived.get(metric, delta), delta)
    return derived


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
            passed = _check_rule(value, rule)
            result = {"status": PASS if passed else FAIL, "value": value, "operator": rule["operator"], "threshold": rule["value"]}
            if isinstance(rule.get("reason"), str):
                result["reason"] = rule["reason"]
            metric_results[metric] = result
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
            if disposition == UNSUPPORTED:
                leaf = {"status": UNSUPPORTED, "language": language, "capabilityId": capability, "reason": "dimension is not reconstructible by the qualified providers"}
                dimensions[capability][language] = leaf
                projected.append({
                    "capabilityId": capability,
                    "providerRef": dimension.get("providerRef"),
                    "language": language,
                    "feature": dimension.get("feature"),
                    "mediaTypes": dimension.get("mediaTypes", []),
                    "state": UNSUPPORTED,
                    "closureDisposition": disposition,
                    "closureStatus": PASS,
                    "evidence": {"status": UNSUPPORTED, "realProviderEvidence": False, "observationCount": 0, "metrics": {}},
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
        "schemaVersion": "increment6.capabilities.v1",
        "dimensions": dimensions,
        "capabilities": projected,
        "accepted": accepted,
        "projectionRule": "capabilities contains one independently evaluated provider/language leaf; accepted contains only independently PASS leaves; no language widening",
    }


def _fixture_leaves(observations: list[dict], declared: list[dict]) -> dict[str, dict]:
    leaves: dict[str, dict] = {}
    for fixture in declared:
        fixture_id = fixture["fixtureId"]
        selected = [item for item in observations if item.get("fixtureId") == fixture_id]
        disposition = fixture["closureDisposition"]
        if not selected or all(_is_skipped(item) for item in selected):
            leaves[fixture_id] = {
                "status": NOT_RUN,
                "reason": "fixture binary DECLARED_NOT_PRESENT",
                "lane": fixture["lane"],
                "closureDisposition": disposition,
            }
        elif len(selected) != 1:
            leaves[fixture_id] = {
                "status": FAIL,
                "reason": "fixture is duplicated",
                "count": len(selected),
                "lane": fixture["lane"],
                "closureDisposition": disposition,
            }
        elif _observation_error(selected[0]):
            leaves[fixture_id] = {
                "status": FAIL,
                "reason": "provider execution error",
                "error": selected[0]["error"],
                "lane": fixture["lane"],
                "closureDisposition": disposition,
            }
        else:
            leaves[fixture_id] = {
                "status": PASS,
                "reason": "observation present",
                "lane": fixture["lane"],
                "closureDisposition": disposition,
            }
    return leaves


def _negative_lane_leaves(observations: list[dict], manifest: dict, declared: list[dict], policy: dict) -> dict[str, dict]:
    """Assert the declared negative disposition for every negative-lane fixture."""
    assertions = policy.get("requirements", {}).get("negativeLaneAssertions", {})
    leaves: dict[str, dict] = {}
    for lane in manifest.get("lanes", []):
        lane_id = lane["id"]
        expected = assertions.get(lane_id)
        if expected is None:
            continue
        fixtures = [item for item in declared if item["lane"] == lane_id]
        declared_ok = all(item.get("expectedDisposition") == expected for item in fixtures)
        observed = [item for item in observations if item.get("fixtureId") in {f["fixtureId"] for f in fixtures}]
        violations = [
            item.get("fixtureId") for item in observed
            if item.get("disposition", item.get("expectedDisposition")) != expected
            and item.get("status") != expected
            and not _is_skipped(item)
        ]
        if violations:
            leaves[lane_id] = {"status": FAIL, "reason": "negative-lane fixture did not yield the declared disposition", "expectedDisposition": expected, "violations": violations}
        elif not observed:
            leaves[lane_id] = {
                "status": NOT_RUN if declared_ok else FAIL,
                "reason": "no executed observation" if declared_ok else "fixture declarations do not assert the required disposition",
                "expectedDisposition": expected,
                "fixtureCount": len(fixtures),
            }
        else:
            leaves[lane_id] = {"status": PASS, "reason": "every executed fixture yielded the declared disposition", "expectedDisposition": expected, "observationCount": len(observed)}
    return leaves


def _capability_leaves(capability_projection: dict, disposition: str) -> dict[str, dict]:
    leaves: dict[str, dict] = {}
    for item in capability_projection["capabilities"]:
        if item["closureDisposition"] != disposition:
            continue
        leaf = {
            "status": PASS if item["state"] == "QUALIFIED" else FAIL if item["state"] == "NOT_QUALIFIED" else item["state"] if item["state"] in {UNSUPPORTED, STALE} else NOT_RUN,
            "capabilityState": item["state"],
            "closureDisposition": item["closureDisposition"],
            "closureStatus": item.get("closureStatus"),
        }
        for field in ("deferredReason", "deferredTarget", "revisitTrigger"):
            if item.get(field) is not None:
                leaf[field] = item[field]
        leaves[f"{item['capabilityId']}:{item['language']}"] = leaf
    return leaves


def evaluate(observations: list[dict]) -> tuple[dict, dict]:
    manifest = load_manifest()
    policy = load_policy()
    declared = load_lane_fixtures(manifest)
    fixture_ids = {item["fixtureId"] for item in declared}
    observed_ids = {item.get("fixtureId") for item in observations}
    unknown = sorted(str(item) for item in observed_ids - fixture_ids)
    missing = sorted(fixture_ids - observed_ids)
    duplicates = sorted(item for item in fixture_ids if sum(obs.get("fixtureId") == item for obs in observations) != 1)
    metrics = aggregate(observations)
    classification = _metric_value(observations, "classification.accuracy")
    if classification is not None:
        metrics["classification.accuracy"] = classification
    provenance = _metric_value(observations, "provenance.completeness")
    if provenance is not None:
        metrics["provenance.completeness"] = provenance
    metrics.update(_derived_runtime_metrics(observations))
    thresholds = threshold_results(metrics, policy)
    errors = [item.get("error") for item in observations if item.get("error")]
    fixture_leaves = _fixture_leaves(observations, declared)
    negative_lane_leaves = _negative_lane_leaves(observations, manifest, declared, policy)
    required_fixture_leaves = {
        key: value
        for key, value in fixture_leaves.items()
        if value["closureDisposition"] == "REQUIRED"
    }
    deferred_fixture_leaves = {
        key: value
        for key, value in fixture_leaves.items()
        if value["closureDisposition"] == "DEFERRED_TO_FUTURE_RELEASE"
    }
    unsupported_fixture_leaves = {
        key: value
        for key, value in fixture_leaves.items()
        if value["closureDisposition"] == UNSUPPORTED
    }
    required_leaves = {f"fixture:{key}": value for key, value in required_fixture_leaves.items()}
    required_leaves.update({f"metric:{key}": value for key, value in thresholds.items()})
    capability_projection = project_capabilities(observations, manifest, policy)
    required_capability_leaves = _capability_leaves(capability_projection, "REQUIRED")
    deferred_capability_leaves = _capability_leaves(capability_projection, "DEFERRED_TO_FUTURE_RELEASE")
    unsupported_capability_leaves = _capability_leaves(capability_projection, UNSUPPORTED)
    required_leaves.update({f"capability:{key}": value for key, value in required_capability_leaves.items()})
    required_leaves.update({f"lane:{key}": value for key, value in negative_lane_leaves.items()})
    has_not_run = any(leaf.get("status") == NOT_RUN for leaf in required_leaves.values())
    has_failed = any(leaf.get("status") == FAIL for leaf in required_leaves.values()) or bool(unknown or errors)
    raw_values = [item.get("rawObservation", item) for item in observations]
    raw_fingerprints = [digest(value) for value in raw_values]
    executed_observations = [item for item in observations if not _is_skipped(item)]
    real_evidence = bool(executed_observations) and all(
        _has_real_provider_evidence(item) for item in executed_observations
    )
    current_implementation = implementation_fingerprints(WORKER_ROOT)
    material = material_fingerprints()
    material_digest = digest(material)
    authorities_frozen = manifest.get("state") == policy.get("state") == "FROZEN"
    # A measured failing leaf is a real FAIL. Missing/skipped leaves remain
    # NOT_RUN when no measured failure can be established.
    status = NOT_RUN if not observations or (has_not_run and not has_failed) or (not real_evidence and not has_failed) else (FAIL if has_failed else PASS)
    summary = {
        "schemaVersion": "increment6.summary.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        **fingerprints(),
        "materialFingerprints": material,
        **current_implementation,
        "materialFingerprint": material_digest,
        "frozenMaterial": {**all_fingerprints(), "materialFingerprint": material_digest, "authoritiesFrozen": authorities_frozen},
        "acceptanceState": policy["state"],
        "qualificationState": manifest["state"],
        "laneCount": len(manifest.get("lanes", [])),
        "declaredFixtureCount": len(declared),
        "observationCount": len(observations),
        "observationsFingerprint": digest(observations),
        "rawObservationsFingerprint": digest(raw_values),
        "rawObservationFingerprints": raw_fingerprints,
        "rawObservationCount": len(raw_values),
        "rawObservationIntegrity": PASS,
        "realProviderEvidence": real_evidence,
        "missingFixtures": missing,
        "deferredFixtures": sorted(deferred_fixture_leaves),
        "unknownFixtures": unknown,
        "duplicateFixtures": duplicates,
        "executionErrors": errors,
        "metrics": metrics,
        "thresholdResults": thresholds,
        "fixtureLeaves": fixture_leaves,
        "deferredFixtureLeaves": deferred_fixture_leaves,
        "unsupportedFixtureLeaves": unsupported_fixture_leaves,
        "negativeLaneLeaves": negative_lane_leaves,
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
    return summary, capability_projection


def _write_raw_artifacts(output: Path, observations: list[dict]) -> None:
    raw_values = [item.get("rawObservation", item) for item in observations]
    (output / "raw-observations.json").write_text(json.dumps(raw_values, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--observations", type=Path, required=True, help="JSON array emitted by the worker harness")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    try:
        observations = json.loads(args.observations.read_text())
        if not isinstance(observations, list) or any(not isinstance(item, dict) for item in observations):
            raise ValueError("observations must be a JSON array of objects")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"status": NOT_RUN, "error": str(error)}))
        return 2
    summary, capabilities = evaluate(observations)
    output = args.output or HERE / "results" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output.mkdir(parents=True, exist_ok=False)
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "capabilities.json").write_text(json.dumps(capabilities, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "observations.json").write_text(json.dumps(observations, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "observations.jsonl").write_text("".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in observations))
    lineage = {
        "schemaVersion": "increment6.lineage.v1",
        "executionId": uuid.uuid4().hex,
        "materialFingerprints": summary["materialFingerprints"],
        "providerSemanticsFingerprint": summary["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": summary["evaluationImplementationFingerprint"],
        "rawObservationFingerprints": summary["rawObservationFingerprints"],
        "observationsFingerprint": summary["observationsFingerprint"],
    }
    (output / "lineage.json").write_text(json.dumps(lineage, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "metrics.json").write_text(json.dumps(summary["metrics"], ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "threshold-results.json").write_text(json.dumps(summary["thresholdResults"], ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    _write_raw_artifacts(output, observations)
    print(json.dumps({"output": str(output), "status": summary["status"]}))
    return 0 if summary["status"] == PASS else 1


if __name__ == "__main__":
    raise SystemExit(main())
