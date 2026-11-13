"""Offline candidate evaluation (I5-23).

``evaluate_candidate_offline`` compares a candidate result against the
baseline result over the same evaluation set and produces the ``evaluation``
block of candidate-manifest.v1. Evaluation is read-only with respect to
active authority: it never mutates or overwrites baseline artifacts — the
only write path is ``record_evaluation`` updating the candidate's own
manifest.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..util import atomic_write_json, digest, load_json
from . import registry
from .budget import check_regression_budget

MANIFEST_SCHEMA = registry.MANIFEST_SCHEMA


def evaluate_candidate_offline(
    candidate_manifest: dict,
    candidate_result: dict,
    baseline_result: dict,
    budget: dict | None = None,
    *,
    at: str | None = None,
) -> dict:
    """Build the manifest ``evaluation`` record for one candidate.

    Results expose per-case correctness as ``{"cases": {caseId: bool}}`` or
    ``{"cases": [{"caseId": ..., "correct": bool}]}`` plus an optional
    ``{"metrics": {...}}`` block consumed by the regression budget
    (``latencyMs``, ``memoryBytes``, ``reviewRate``, ``perLanguage``; an
    explicit ``metrics.quality`` overrides the case-derived accuracy).

    ``budget=None`` means no declared bounds, so ``regressionResult`` is
    "PASS". The returned record is pure — nothing is written here.
    """
    baseline_cases = _case_map(baseline_result)
    candidate_cases = _case_map(candidate_result)
    case_ids = sorted(set(baseline_cases) | set(candidate_cases))

    evaluation_set_fingerprint = candidate_manifest.get("dependencies", {}).get(
        "datasetFingerprint"
    )
    if evaluation_set_fingerprint is None:
        evaluation_set_fingerprint = digest(
            {"domain": "learning.evaluation-set.v1", "caseIds": case_ids}
        )

    record: dict[str, Any] = {
        "evaluationSetFingerprint": evaluation_set_fingerprint,
        "baselineResultFingerprint": digest(baseline_result),
        "candidateResultFingerprint": digest(candidate_result),
    }
    # I5-41: bind the evaluation to the artifact actually evaluated, so
    # promotion can prove evaluated == promoted (not merely same name).
    artifact_ref = candidate_manifest.get("artifactRef") or {}
    if artifact_ref.get("artifactFingerprint"):
        record["evaluatedArtifactFingerprint"] = artifact_ref["artifactFingerprint"]
    if budget is not None:
        record["regressionBudgetRef"] = budget["budgetRef"]
        # Quality delta = fraction of union cases answered correctly; a case
        # absent from a result counts as incorrect.
        baseline_metrics = {
            "quality": _quality(baseline_cases, case_ids),
            **baseline_result.get("metrics", {}),
        }
        candidate_metrics = {
            "quality": _quality(candidate_cases, case_ids),
            **candidate_result.get("metrics", {}),
        }
        record["regressionResult"] = check_regression_budget(
            budget, baseline_metrics, candidate_metrics
        )["result"]
    else:
        record["regressionResult"] = "PASS"
    if at is not None:
        record["evaluatedAt"] = at
    return record


def record_evaluation(root: Path, candidate_id: str, record: dict) -> dict:
    """Persist ``record`` as ``manifest.evaluation``; re-validates the
    manifest before the atomic write. Does not change candidate state —
    CANDIDATE -> EVALUATED goes through ``registry.transition``."""
    manifest_path = (
        root / "candidates" / registry._safe(candidate_id) / "manifest.json"
    )
    if not manifest_path.exists():
        raise ValueError(f"unknown candidate {candidate_id}")
    manifest = load_json(manifest_path)
    manifest["evaluation"] = record
    registry.validate_manifest(manifest)
    atomic_write_json(manifest_path, manifest)
    return manifest


def _case_map(result: dict) -> dict[str, bool]:
    cases = result.get("cases", result.get("caseResults", {}))
    if isinstance(cases, dict):
        return {str(k): bool(v) for k, v in cases.items()}
    out: dict[str, bool] = {}
    for case in cases:
        out[case["caseId"]] = bool(case.get("correct", case.get("agrees", False)))
    return out


def _quality(cases: dict[str, bool], case_ids: list[str]) -> float:
    if not case_ids:
        return 0.0
    return sum(1.0 for case_id in case_ids if cases.get(case_id, False)) / len(case_ids)
