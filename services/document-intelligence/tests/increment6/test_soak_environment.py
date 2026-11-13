"""I6-61/I6-62/ENV-01: soak leak baselines, derived acceptance metrics,
semantic environment binding, and runner CLI failure classification."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

INCREMENT6 = ROOT / "evaluation/increment6"

from evaluation.increment6.runners import load_runner, soak_runner  # noqa: E402
from evaluation.increment6.runners.evidence_common import (  # noqa: E402
    load_config,
    run_cli,
    validate_evidence,
)
from evaluation.increment6.run_qualification import _derived_runtime_metrics  # noqa: E402


SOAK_CONFIG = INCREMENT6 / "runners/configs/soak.v1.yaml"


def test_soak_runner_emits_leak_baseline_for_every_resource():
    config = load_config(SOAK_CONFIG)
    evidence = soak_runner.run(config)
    validate_evidence(evidence)
    baselines = evidence["leakBaseline"]
    metrics = {entry["metric"] for entry in baselines}
    assert metrics == {
        "rssBytes",
        "fileDescriptors",
        "tempFiles",
        "threads",
        "nativeProcesses",
        "modelInstances",
        "queueEntries",
        "dbHandles",
    }
    for entry in baselines:
        assert entry["delta"] == entry["end"] - entry["start"]
        assert entry["status"] == ("PASS" if entry["delta"] <= entry["ceiling"] else "FAIL")
    # Deterministic: identical config reproduces identical evidence.
    assert soak_runner.run(config) == evidence


def test_soak_baseline_fails_when_growth_exceeds_ceiling():
    config = load_config(SOAK_CONFIG)
    config["leakBaselines"]["rssBytes"]["ceiling"] = 1
    evidence = soak_runner.run(config)
    rss = next(e for e in evidence["leakBaseline"] if e["metric"] == "rssBytes")
    assert rss["status"] == "FAIL"


def test_runner_cli_classifies_infrastructure_vs_semantic(tmp_path: Path, capsys):
    bad_config = tmp_path / "bad.yaml"
    bad_config.write_text("fixtureCount: -5\n", encoding="utf-8")
    code = run_cli(
        "evaluation/increment6/runners/load_runner.py",
        load_runner.run,
        ["--config", str(bad_config), "--output", str(tmp_path / "out")],
    )
    assert code == 2
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "NOT_RUN"
    assert out["failureClass"] == "TEST_FAIL"


def test_environment_declares_semantic_environment_ref():
    environment = yaml.safe_load((INCREMENT6 / "environment.yaml").read_text())
    assert environment["semanticEnvironmentRef"] == "evaluation/semantic-environment.v1.yaml"
    semantic = yaml.safe_load(
        (ROOT / "evaluation/semantic-environment.v1.yaml").read_text()
    )
    assert semantic["timezone"] == "UTC"
    assert semantic["locale"] == "C.UTF-8"
    assert semantic["unicodeNormalization"] == "NFC"
    assert semantic["clock"]["source"] == "FIXED_TEST_CLOCK"


def test_acceptance_declares_i661_metrics_and_placeholders():
    acceptance = yaml.safe_load((INCREMENT6 / "acceptance.yaml").read_text())
    assert acceptance["hardwareClass"]
    assert acceptance["workloadFingerprint"]
    metrics = acceptance["metrics"]
    for name, operator in (
        ("runtime.p99LatencyMs", "lte"),
        ("runtime.throughputPerSecond", "gte"),
        ("runtime.errorRate", "lte"),
        ("runtime.queueRejectionLatencyMs", "lte"),
        ("soak.peakRssDeltaMb", "lte"),
        ("soak.fdDelta", "lte"),
        ("soak.tempFileDelta", "lte"),
        ("soak.threadDelta", "lte"),
        ("soak.nativeProcessDelta", "lte"),
        ("soak.modelInstanceDelta", "lte"),
        ("soak.queueEntryDelta", "lte"),
        ("soak.dbHandleDelta", "lte"),
        ("recovery.restartSeconds", "lte"),
    ):
        assert metrics[name]["operator"] == operator
        assert isinstance(metrics[name]["value"], (int, float))


def test_derived_metrics_absent_without_observations():
    # New metrics must not silently pass: no observations -> nothing derived.
    assert _derived_runtime_metrics([]) == {}


def test_derived_metrics_from_observations():
    observations = [
        {"fixtureId": "a", "latencyMs": 100.0},
        {"fixtureId": "b", "latencyMs": 200.0, "error": "boom"},
        {
            "fixtureId": "c",
            "latencyMs": 300.0,
            "leakBaseline": [
                {"metric": "fileDescriptors", "delta": 4},
                {"metric": "rssBytes", "delta": 2 * 1024 * 1024},
            ],
            "restartSeconds": 12.0,
        },
    ]
    derived = _derived_runtime_metrics(observations)
    assert derived["runtime.p99LatencyMs"] == pytest.approx(298.0)
    assert derived["runtime.errorRate"] == pytest.approx(1 / 3)
    assert derived["runtime.throughputPerSecond"] == pytest.approx(3 / 0.6)
    assert derived["soak.fdDelta"] == 4.0
    assert derived["soak.peakRssDeltaMb"] == pytest.approx(2.0)
    assert derived["recovery.restartSeconds"] == 12.0
