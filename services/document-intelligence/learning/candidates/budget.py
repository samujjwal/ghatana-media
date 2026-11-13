"""Promotion regression budgets (I5-24).

A regression budget bounds how far a candidate may move quality, latency,
memory, and review rate relative to the active baseline.
``check_regression_budget`` is pure: it returns PASS/FAIL plus the violated
bounds and never mutates its inputs. A declared bound whose input metric is
missing is a violation — budgets fail closed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from ..util import load_json, validate

BUDGET_SCHEMA = "regression-budget.v1.schema.json"


def check_regression_budget(budget: dict, baseline: dict, candidate: dict) -> dict:
    """Evaluate every declared bound; returns::

        {"result": "PASS"|"FAIL",
         "violations": [{"bound": name, "observed": ..., "allowed": ...}, ...]}

    ``baseline`` / ``candidate`` metric dicts::

        {"quality": float, "latencyMs": float, "memoryBytes": int,
         "reviewRate": float,
         "perLanguage": {lang: {"quality": float}}}
    """
    bounds = budget.get("bounds", {})
    violations: list[dict] = []

    def add(bound: str, observed: Any, allowed: Any, detail: str | None = None) -> None:
        violation = {"bound": bound, "observed": observed, "allowed": allowed}
        if detail is not None:
            violation["detail"] = detail
        violations.append(violation)

    def both(key: str) -> tuple[Any, Any]:
        return baseline.get(key), candidate.get(key)

    if "maxQualityRegression" in bounds:
        allowed = bounds["maxQualityRegression"]
        base_q, cand_q = both("quality")
        if base_q is None or cand_q is None:
            add("maxQualityRegression", None, allowed, "quality metric missing")
        else:
            observed = base_q - cand_q
            if observed > allowed:
                add("maxQualityRegression", observed, allowed)

    if "minQualityImprovement" in bounds:
        allowed = bounds["minQualityImprovement"]
        base_q, cand_q = both("quality")
        if base_q is None or cand_q is None:
            add("minQualityImprovement", None, allowed, "quality metric missing")
        else:
            observed = cand_q - base_q
            if observed < allowed:
                add("minQualityImprovement", observed, allowed)

    if "maxLatencyRegressionRatio" in bounds:
        allowed = bounds["maxLatencyRegressionRatio"]
        base_ms, cand_ms = both("latencyMs")
        if base_ms is None or cand_ms is None:
            add("maxLatencyRegressionRatio", None, allowed, "latencyMs metric missing")
        elif base_ms <= 0:
            if cand_ms > 0:
                add(
                    "maxLatencyRegressionRatio",
                    cand_ms,
                    allowed,
                    "baseline latencyMs is zero; ratio undefined",
                )
        else:
            observed = cand_ms / base_ms
            if observed > allowed:
                add("maxLatencyRegressionRatio", observed, allowed)

    if "maxMemoryRegressionBytes" in bounds:
        allowed = bounds["maxMemoryRegressionBytes"]
        base_b, cand_b = both("memoryBytes")
        if base_b is None or cand_b is None:
            add("maxMemoryRegressionBytes", None, allowed, "memoryBytes metric missing")
        else:
            observed = cand_b - base_b
            if observed > allowed:
                add("maxMemoryRegressionBytes", observed, allowed)

    if "maxReviewRateIncrease" in bounds:
        allowed = bounds["maxReviewRateIncrease"]
        base_r, cand_r = both("reviewRate")
        if base_r is None or cand_r is None:
            add("maxReviewRateIncrease", None, allowed, "reviewRate metric missing")
        else:
            observed = cand_r - base_r
            if observed > allowed:
                add("maxReviewRateIncrease", observed, allowed)

    base_per_lang = baseline.get("perLanguage", {})
    cand_per_lang = candidate.get("perLanguage", {})
    for lang, lang_bounds in sorted(bounds.get("perLanguage", {}).items()):
        if "maxQualityRegression" not in lang_bounds:
            continue
        allowed = lang_bounds["maxQualityRegression"]
        bound = f"perLanguage.{lang}.maxQualityRegression"
        base_q = base_per_lang.get(lang, {}).get("quality")
        if base_q is None:
            continue  # no baseline for this language — nothing to regress from
        # A language the candidate fails to cover counts as quality 0.
        cand_q = cand_per_lang.get(lang, {}).get("quality", 0.0)
        observed = base_q - cand_q
        if observed > allowed:
            add(bound, observed, allowed)

    return {"result": "FAIL" if violations else "PASS", "violations": violations}


def load_budget(path: Path) -> dict:
    """Load a regression budget from YAML or JSON and validate it."""
    path = Path(path)
    if path.suffix.lower() == ".json":
        budget = load_json(path)
    else:
        budget = yaml.safe_load(path.read_text(encoding="utf-8"))
    return validate(budget, BUDGET_SCHEMA)
