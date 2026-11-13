#!/usr/bin/env python3
"""Increment-6 soak runner (I6-37, I6-62).

Simulates a long-duration soak campaign and emits
``document-intelligence.performance-evidence.v1`` evidence. The seeded model
adds a deterministic memory-drift component so RSS growth is visible in the
evidence without real provider calls. I6-62 adds ``leakBaseline``: a
start-vs-end baseline comparison for every tracked resource (RSS, file
descriptors, temp files, threads, native processes, model instances, queue
entries, DB handles) with bounded deltas — not RSS alone. Deterministic given
the same config.

Config:

    durationSeconds / ratePerSecond / concurrency / seed / latency model
    rssGrowthBytesPerSecond          legacy RSS drift input (kept)
    leakBaselines.<resource>.start   modeled start-of-soak level
    leakBaselines.<resource>.growthPerSecond   modeled growth rate
    leakBaselines.<resource>.growthPerFixture  modeled growth rate (per work unit)
    leakBaselines.<resource>.ceiling           accepted bounded delta
    leakBaselines.<resource>.unit              evidence unit label
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

RUNNER_REF = "evaluation/increment6/runners/soak_runner.py"

# Every resource the soak baseline must report, in canonical order (I6-62).
LEAK_RESOURCES = (
    "rssBytes",
    "fileDescriptors",
    "tempFiles",
    "threads",
    "nativeProcesses",
    "modelInstances",
    "queueEntries",
    "dbHandles",
)


def _leak_baselines(config: dict, duration_seconds: float, fixture_count: int) -> list[dict]:
    """Model start-vs-end baselines for each tracked resource.

    ``end = start + growthPerSecond*duration + growthPerFixture*fixtures``;
    ``status`` is PASS when ``delta <= ceiling``. All inputs come from the
    declared config, so the section is deterministic.
    """
    declared = config.get("leakBaselines") or {}
    if not isinstance(declared, dict):
        raise ValueError("leakBaselines must be a mapping of resource -> bounds")
    entries: list[dict] = []
    for resource in LEAK_RESOURCES:
        spec = declared.get(resource) or {}
        if resource == "rssBytes":
            default_start = int(config.get("baseRssBytes", 512 * 1024 * 1024))
            default_growth = float(config.get("rssGrowthBytesPerSecond", 0))
        else:
            default_start = 0
            default_growth = 0.0
        start = float(spec.get("start", default_start))
        growth = float(spec.get("growthPerSecond", default_growth)) * duration_seconds
        growth += float(spec.get("growthPerFixture", 0)) * fixture_count
        end = start + growth
        delta = end - start
        ceiling = float(spec.get("ceiling", 0))
        entry = {
            "metric": resource,
            "start": int(start) if float(start).is_integer() else start,
            "end": int(end) if float(end).is_integer() else end,
            "delta": int(delta) if float(delta).is_integer() else delta,
            "ceiling": int(ceiling) if float(ceiling).is_integer() else ceiling,
            "status": "PASS" if delta <= ceiling else "FAIL",
        }
        if isinstance(spec.get("unit"), str):
            entry["unit"] = spec["unit"]
        entries.append(entry)
    return entries


def run(config: dict, work: WorkCallable | None = None) -> dict:
    """Simulate ``durationSeconds`` of sustained load and return evidence."""
    seed = int(config.get("seed", 0))
    duration_seconds = float(config.get("durationSeconds", 3600.0))
    if duration_seconds <= 0:
        raise ValueError("durationSeconds must be > 0")
    concurrency = max(int(config.get("concurrency", 1)), 1)
    rate = float(config.get("ratePerSecond", 1.0))
    if rate <= 0:
        raise ValueError("ratePerSecond must be > 0")
    fixture_count = int(config.get("fixtureCount") or int(duration_seconds * rate))
    work = work or default_work(config)
    rng = random.Random(seed)
    # Memory drift: a deterministic per-iteration RSS growth component models
    # the soak surface the campaign is meant to observe. Bound into a derived
    # config so the caller's mapping is never mutated.
    simulation_config = {
        **config,
        "rssGrowthBytesPerFixture": int(config.get("rssGrowthBytesPerFixture") or config.get("rssGrowthBytesPerSecond", 1024) / rate),
    }
    invocations = [
        {"latencyMs": work(index, rng), "outcome": "completed"}
        for index in range(fixture_count)
    ]
    return build_evidence(
        RUNNER_REF,
        simulation_config,
        invocations,
        extra={"leakBaseline": _leak_baselines(config, duration_seconds, fixture_count)},
    )


def main(argv: list[str] | None = None) -> int:
    return run_cli(RUNNER_REF, run, argv)


if __name__ == "__main__":
    raise SystemExit(main())
