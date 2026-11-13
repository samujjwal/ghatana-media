#!/usr/bin/env python3
"""Increment-6 load runner (I6-36).

Simulates a bounded-concurrency load campaign over the declared workload and
emits ``document-intelligence.performance-evidence.v1`` evidence. Work is a
pluggable callable; the default is a seeded sleep+jitter latency model — no
real provider calls. Deterministic given the same config (including seed).
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

RUNNER_REF = "evaluation/increment6/runners/load_runner.py"


def run(config: dict, work: WorkCallable | None = None) -> dict:
    """Simulate ``fixtureCount`` invocations and return evidence."""
    seed = int(config.get("seed", 0))
    fixture_count = int(config.get("fixtureCount", 32))
    if fixture_count < 0:
        raise ValueError("fixtureCount must be >= 0")
    work = work or default_work(config)
    rng = random.Random(seed)
    invocations = [
        {"latencyMs": work(index, rng), "outcome": "completed"}
        for index in range(fixture_count)
    ]
    return build_evidence(RUNNER_REF, config, invocations)


def main(argv: list[str] | None = None) -> int:
    return run_cli(RUNNER_REF, run, argv)


if __name__ == "__main__":
    raise SystemExit(main())
