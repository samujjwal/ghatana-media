"""Shared deterministic simulation and evidence assembly for I6 runners.

Every runner produces ``document-intelligence.performance-evidence.v1``
evidence. Simulated work is a pluggable callable; the default is a
sleep+jitter latency model drawn from a seeded RNG — no real provider calls.
Given the same config mapping (including ``seed``), all fields of the emitted
evidence are byte-for-byte deterministic.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import yaml

HERE = Path(__file__).resolve().parent
INCREMENT_ROOT = HERE.parent
WORKER_ROOT = HERE.parents[2]
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))
from evaluation.runner_harness import (  # noqa: E402
    classify_failure,
    run_with_infra_retries,
)
from evaluation.increment6.runners.continuity import validate_operational_run  # noqa: E402
SCHEMA_PATH = INCREMENT_ROOT / "schemas" / "performance-evidence.v1.schema.json"
EVIDENCE_SCHEMA_VERSION = "document-intelligence.performance-evidence.v1"
EVIDENCE_PRODUCER_VERSION = "document-intelligence.increment6-evidence/1"
# Fixed epoch keeps startedAt/completedAt deterministic given a seed; the
# simulated duration is encoded in completedAt - startedAt.
DEFAULT_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)

WorkCallable = Callable[[int, random.Random], float]


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def omitted_field_digest(evidence: dict) -> str:
    """SHA-256 over canonical JSON with ``resultFingerprint`` omitted."""
    return digest({key: value for key, value in evidence.items() if key != "resultFingerprint"})


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    return ordered[lower] if lower == upper else ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def load_config(path: Path) -> dict:
    config = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("runner config must be a YAML mapping")
    return config


def default_work(config: dict) -> WorkCallable:
    """Sleep+jitter latency model (virtual clock — no real sleeping)."""
    base_ms = float(config.get("baseLatencyMs", 120.0))
    jitter_ms = float(config.get("jitterMs", 60.0))

    def work(fixture_index: int, rng: random.Random) -> float:
        return base_ms + rng.uniform(0.0, jitter_ms)

    return work


def build_evidence(
    runner_ref: str,
    config: dict,
    invocations: list[dict],
    *,
    extra: dict | None = None,
) -> dict:
    """Assemble schema-conformant evidence from per-invocation records.

    Each invocation record carries ``latencyMs`` (float) and ``outcome``
    (one of completed/cancelled/timedOut/failed).
    """
    seed = int(config.get("seed", 0))
    concurrency = max(int(config.get("concurrency", 1)), 1)
    fixture_count = len(invocations)
    latencies = [float(item["latencyMs"]) for item in invocations]
    total_ms = sum(latencies)
    simulated_seconds = float(config.get("durationSeconds") or (total_ms / 1000.0 / concurrency))
    epoch = config.get("epoch")
    started = datetime.fromisoformat(epoch) if isinstance(epoch, str) else DEFAULT_EPOCH
    completed = started + timedelta(seconds=simulated_seconds)
    counts = {"completed": 0, "cancelled": 0, "timedOut": 0, "failed": 0}
    for item in invocations:
        outcome = item.get("outcome", "completed")
        counts[outcome if outcome in counts else "failed"] += 1
    attempted = fixture_count
    failed_total = counts["cancelled"] + counts["timedOut"] + counts["failed"]
    base_rss = int(config.get("baseRssBytes", 512 * 1024 * 1024))
    rss_growth = int(config.get("rssGrowthBytesPerFixture", 0))
    run_id = digest({"runnerRef": runner_ref, "config": config, "seed": seed})[:32]
    configured_run = config.get("operationalRun")
    if configured_run is None:
        operational_run = {
            "runId": run_id,
            "startedAt": started.isoformat(),
            "completedAt": completed.isoformat(),
            "workerGeneration": str(config.get("workerGeneration", "simulated-worker-generation-1")),
            "materialFingerprint": str(config.get("materialFingerprint", digest(config))),
            "interruptions": [],
            "measurementContinuity": True,
            "continuationPolicy": "SINGLE_INTERVAL",
        }
    elif isinstance(configured_run, dict):
        operational_run = {**configured_run, "runId": configured_run.get("runId", run_id)}
    else:
        raise ValueError("operationalRun must be a mapping")
    operational_run = validate_operational_run(operational_run, expected_run_id=run_id)

    evidence = {
        "schemaVersion": EVIDENCE_SCHEMA_VERSION,
        "producerVersion": EVIDENCE_PRODUCER_VERSION,
        "runnerRef": runner_ref,
        "runId": run_id,
        "startedAt": started.isoformat(),
        "completedAt": completed.isoformat(),
        "configFingerprint": digest(config),
        "seed": seed,
        "workload": {
            "fixtureCount": fixture_count,
            "concurrency": concurrency,
            "durationSeconds": simulated_seconds,
        },
        "metrics": {
            "throughputPerSecond": (fixture_count / simulated_seconds) if simulated_seconds else 0.0,
            "p50Ms": percentile(latencies, 0.50),
            "p95Ms": percentile(latencies, 0.95),
            "p99Ms": percentile(latencies, 0.99),
            "errorRate": (failed_total / attempted) if attempted else 0.0,
            "rssPeakBytes": base_rss + rss_growth * fixture_count,
        },
        "providerInvocations": {
            "attempted": attempted,
            "completed": counts["completed"],
            "cancelled": counts["cancelled"],
            "timedOut": counts["timedOut"],
            "failed": counts["failed"],
        },
        "operationalRun": operational_run,
    }
    if extra:
        evidence.update(extra)
    evidence["resultFingerprint"] = omitted_field_digest(evidence)
    return evidence


def validate_evidence(evidence: dict, schema_path: Path = SCHEMA_PATH) -> dict:
    """Fail closed when the emitted evidence does not satisfy the schema."""
    import jsonschema

    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    jsonschema.validate(evidence, schema)
    if evidence["resultFingerprint"] != omitted_field_digest(evidence):
        raise ValueError("resultFingerprint does not match the omitted-field digest")
    return evidence


def write_evidence(output_dir: Path, evidence: dict) -> Path:
    """Leaf-atomic write: temp file + rename so a crash never publishes a
    partial evidence artifact (RUN-06)."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "performance-evidence.json"
    text = json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    fd, tmp = tempfile.mkstemp(dir=output_dir, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def run_cli(runner_ref: str, run: Callable[[dict, WorkCallable | None], dict], argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"I6 runner {runner_ref}")
    parser.add_argument("--config", type=Path, required=True, help="YAML runner config")
    parser.add_argument("--output", type=Path, required=True, help="evidence output directory")
    parser.add_argument(
        "--infra-retries",
        type=int,
        default=0,
        help="bounded retry for INFRASTRUCTURE_ERROR runner failures (RUN-05)",
    )
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        evidence = run_with_infra_retries(
            lambda: run(config, None), retries=args.infra_retries
        )
        validate_evidence(evidence)
        path = write_evidence(args.output, evidence)
    except Exception as error:  # noqa: BLE001 — failures classify, never crash
        print(
            json.dumps(
                {
                    "status": "NOT_RUN",
                    "failureClass": classify_failure(error),
                    "error": str(error),
                }
            )
        )
        return 2
    print(json.dumps({"output": str(path), "runId": evidence["runId"], "resultFingerprint": evidence["resultFingerprint"]}))
    return 0
