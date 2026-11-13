"""Increment-3 strict-gate portability contract.

The strict gate must be safe to run against a read-only source checkout: every
build/test byproduct it produces lands in an ephemeral directory or an explicit
evidence receipt, never in the source tree. These tests pin the command and
environment contract that guarantees that property, plus the fingerprint-keyed
receipt semantics that make re-runs cheap without weakening the gate.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import verify_increment3 as gate  # noqa: E402


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def test_pytest_outputs_leave_the_source_tree(tmp_path):
    junit = tmp_path / "pytest.xml"
    command = gate.pytest_command(junit)
    assert f"--junitxml={junit}" in command
    # The cacheprovider plugin writes .pytest_cache/ into the source tree when
    # enabled; the gate must disable it.
    assert "no:cacheprovider" in command
    assert not _inside(junit, ROOT)


def test_typescript_build_outputs_leave_the_source_tree(tmp_path):
    out_dir = tmp_path / "tsbuild"
    command = gate.typescript_build_command(out_dir)
    assert "--outDir" in command
    assert command[command.index("--outDir") + 1] == str(out_dir)
    assert not _inside(out_dir, ROOT)
    assert "tsconfig.build.json" in command


def test_typescript_build_is_read_only_and_portable(tmp_path):
    before = gate._tree_fingerprint(
        gate.TS_CLIENT,
        ["src", "tests", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"],
    )
    result = subprocess.run(
        gate.typescript_build_command(tmp_path / "tsbuild"),
        cwd=gate.TS_CLIENT,
        env=gate.strict_environment(),
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    after = gate._tree_fingerprint(
        gate.TS_CLIENT,
        ["src", "tests", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"],
    )
    assert before == after


def test_vitest_report_leaves_the_source_tree(tmp_path):
    report = tmp_path / "vitest.json"
    command = gate.vitest_command(report)
    assert f"--outputFile={report}" in command
    assert not _inside(report, ROOT)


def test_strict_environment_is_read_only_and_canonical():
    env = gate.strict_environment()
    assert env["PYTHONDONTWRITEBYTECODE"] == "1"
    assert env["DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS"] == "1"
    assert env["DOCUMENT_INTELLIGENCE_OFFLINE"] == "true"
    assert env["DOCUMENT_INTELLIGENCE_ENABLED_PROVIDERS"] == "ghatana.docling,ghatana.paddleocr,ghatana.gliner,ghatana.minilm"
    assert env["DOCUMENT_INTELLIGENCE_ENABLED_LANGUAGES"] == "en,ne"
    # Prior Increment-4A profile selection must not leak into the I3 gate; the
    # canonical default is selected explicitly for profile-bound evidence.
    assert "DOCUMENT_INTELLIGENCE_PROFILE_PATH" not in env
    assert env["DOCUMENT_INTELLIGENCE_PROFILE_ID"] == "default"
    assert "DOCUMENT_INTELLIGENCE_CAPABILITIES" not in env


def test_strict_receipt_reuse_requires_identical_inputs():
    inputs = {"providerSemanticsFingerprint": "a", "uvLockSha256": "b"}
    executed = {name: "PASS" for name in gate.EXECUTED_LEAVES}
    receipt = {
        "schemaVersion": gate.STRICT_RECEIPT_SCHEMA,
        "status": "PASS",
        "inputFingerprints": inputs,
        "executedLeaves": executed,
    }
    assert gate.strict_receipt_usable(receipt, dict(inputs))
    # Any declared-input drift invalidates the receipt.
    assert not gate.strict_receipt_usable(receipt, {**inputs, "providerSemanticsFingerprint": "changed"})
    assert not gate.strict_receipt_usable(receipt, {**inputs, "uvLockSha256": "changed"})
    assert not gate.strict_receipt_usable(receipt, {**inputs, "extraInput": "new"})
    # A non-PASS or partial receipt can never be reused.
    assert not gate.strict_receipt_usable({**receipt, "status": "FAIL"}, dict(inputs))
    partial = {**receipt, "executedLeaves": {name: "PASS" for name in gate.EXECUTED_LEAVES[:-1]}}
    assert not gate.strict_receipt_usable(partial, dict(inputs))


def test_strict_receipt_round_trip(tmp_path, monkeypatch):
    receipt_path = tmp_path / "increment3-strict-receipt.json"
    monkeypatch.setattr(gate, "STRICT_RECEIPT_PATH", receipt_path)
    inputs = {"providerSemanticsFingerprint": "a"}
    executed = {name: "PASS" for name in gate.EXECUTED_LEAVES}
    gate.write_strict_receipt(inputs, executed)
    receipt = gate.load_strict_receipt()
    assert gate.strict_receipt_usable(receipt, inputs)
    assert receipt["runId"]
    assert receipt["completedAt"]
    # Rewriting identical content is a no-op (keeps steady-state runs clean).
    mtime = receipt_path.stat().st_mtime_ns
    gate.write_strict_receipt(inputs, executed)
    assert receipt_path.stat().st_mtime_ns == mtime


def test_evaluation_summary_must_bind_provider_semantics():
    """The eval leaf rejects evidence that predates the provider-semantics binding."""
    frozen = gate.frozen_fingerprints()
    assert frozen.get("providerSemanticsFingerprint")
    assert frozen.get("evaluationImplementationFingerprint")


def test_vitest_failures_are_staged_at_the_first_actionable_boundary(tmp_path):
    report = tmp_path / "vitest.json"
    report.write_text(json.dumps({
        "testResults": [{
            "assertionResults": [
                {"title": "worker startup readiness", "status": "failed", "failureMessages": ["/readyz timeout"]},
                {"title": "provider invocation", "status": "failed", "failureMessages": ["provider unavailable"]},
                {"title": "ambiguous route assertion", "status": "failed", "failureMessages": ["expected review"]},
            ],
        }],
    }), encoding="utf-8")
    failures = gate.load_vitest_failures(report)
    assert [failure["stage"] for failure in failures] == ["startup", "providerInvocation", "routing"]
