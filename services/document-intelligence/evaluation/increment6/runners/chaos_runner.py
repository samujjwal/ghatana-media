#!/usr/bin/env python3
"""Increment-6 chaos runner (I6-38).

Simulates a failure-injection campaign and emits
``document-intelligence.performance-evidence.v1`` evidence. The config carries
an injection table mapping failure types to per-invocation rates; the runner
records the observed failure taxonomy next to the expected rates so reviewers
can reconcile injected vs observed failure classes. Deterministic given the
same config (including seed).
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))
from evaluation.increment6.runners.evidence_common import (  # noqa: E402
    WorkCallable,
    build_evidence,
    default_work,
    run_cli,
)

RUNNER_REF = "evaluation/increment6/runners/chaos_runner.py"

# Failure-type -> providerInvocations outcome bucket.
OUTCOME_BY_FAILURE_TYPE = {
    "PROVIDER_TIMEOUT": "timedOut",
    "CANCELLATION": "cancelled",
    "PROVIDER_CANCELLED": "cancelled",
}


def _outcome_for(failure_type: str) -> str:
    return OUTCOME_BY_FAILURE_TYPE.get(failure_type, "failed")


def run(config: dict, work: WorkCallable | None = None) -> dict:
    """Simulate ``fixtureCount`` invocations under the declared injection table."""
    seed = int(config.get("seed", 0))
    fixture_count = int(config.get("fixtureCount", 64))
    if fixture_count < 0:
        raise ValueError("fixtureCount must be >= 0")
    injection = config.get("injection", {})
    if not isinstance(injection, dict):
        raise ValueError("injection must be a mapping of failureType -> rate")
    table = {str(key): float(value) for key, value in injection.items()}
    if any(rate < 0.0 or rate > 1.0 for rate in table.values()):
        raise ValueError("injection rates must be within [0.0, 1.0]")
    if sum(table.values()) > 1.0:
        raise ValueError("injection rates must sum to <= 1.0")
    work = work or default_work(config)
    rng = random.Random(seed)
    ordered_types = sorted(table)
    invocations: list[dict] = []
    observed: dict[str, int] = {failure_type: 0 for failure_type in ordered_types}
    for index in range(fixture_count):
        draw = rng.random()
        cumulative = 0.0
        failure_type: str | None = None
        for candidate in ordered_types:
            cumulative += table[candidate]
            if draw < cumulative:
                failure_type = candidate
                break
        if failure_type is None:
            outcome = "completed"
        else:
            outcome = _outcome_for(failure_type)
            observed[failure_type] += 1
        invocations.append({
            "latencyMs": work(index, rng),
            "outcome": outcome,
            "failureType": failure_type,
        })
    return build_evidence(
        RUNNER_REF,
        config,
        invocations,
        extra={
            "failureTaxonomy": {
                "expected": {key: table[key] for key in ordered_types},
                "observed": {key: observed[key] for key in ordered_types},
            },
        },
    )


def main(argv: list[str] | None = None) -> int:
    return run_cli(RUNNER_REF, run, argv)


if __name__ == "__main__":
    raise SystemExit(main())
