"""RUN-01..RUN-07: runner harness reliability mechanics."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from evaluation.runner_harness import (  # noqa: E402
    ABORTED_MARKER,
    INFRASTRUCTURE_ERROR,
    TEST_FAIL,
    InfrastructureError,
    RunContext,
    classify_failure,
    completed_fixture_ids,
    free_port,
    load_completed_run,
    run_with_infra_retries,
)


def test_free_port_returns_bindable_port():
    port = free_port()
    assert 1024 <= port <= 65535
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", port))  # still free after release


def test_classify_failure():
    assert classify_failure(InfrastructureError("spawn failed")) == INFRASTRUCTURE_ERROR
    assert classify_failure(OSError("connect refused")) == INFRASTRUCTURE_ERROR
    assert classify_failure(ValueError("bad fixture")) == TEST_FAIL
    assert classify_failure(AssertionError("mismatch")) == TEST_FAIL


def test_infra_retries_only_retries_infrastructure():
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise InfrastructureError("transient")
        return "ok"

    assert run_with_infra_retries(flaky, retries=2) == "ok"
    assert len(calls) == 3

    def semantic():
        raise ValueError("semantic")

    with pytest.raises(ValueError):
        run_with_infra_retries(semantic, retries=5)

    def always_infra():
        raise InfrastructureError("permanent")

    with pytest.raises(InfrastructureError):
        run_with_infra_retries(always_infra, retries=1)


def test_run_context_writes_running_then_aborted_on_error(tmp_path: Path):
    run_dir = tmp_path / "run-1"
    with pytest.raises(RuntimeError):
        with RunContext(run_dir, "run-1"):
            raise RuntimeError("boom")
    state = json.loads((run_dir / "RUNNING").read_text())
    assert state["status"] == "ABORTED"
    aborted = json.loads((run_dir / ABORTED_MARKER).read_text())
    assert aborted["status"] == "ABORTED"
    assert "boom" in aborted["reason"]
    # A leftover RUNNING/ABORTED state is never mistaken for COMPLETE.
    assert not (run_dir / "run-manifest.json").exists()


def test_run_context_cleanups_run_on_success_and_failure(tmp_path: Path):
    calls = []
    run_dir = tmp_path / "run-ok"
    with RunContext(run_dir, "run-ok") as ctx:
        ctx.register_cleanup(lambda: calls.append("cleaned"), name="cleanup")
    assert calls == ["cleaned"]

    calls.clear()
    with pytest.raises(ValueError):
        with RunContext(tmp_path / "run-bad", "run-bad") as ctx:
            ctx.register_cleanup(lambda: calls.append("cleaned"), name="cleanup")
            raise ValueError("fail")
    assert calls == ["cleaned"]


def test_teardown_proof_shape(tmp_path: Path):
    run_dir = tmp_path / "run-tp"
    ctx = RunContext(run_dir, "run-tp")
    with ctx:
        pass
    proof = ctx.teardown_proof()
    assert set(proof) == {
        "workerStopped",
        "nativeWorkDrained",
        "dbSessionsClosed",
        "tempFilesCleaned",
    }
    assert proof["dbSessionsClosed"]["status"] == "NOT_APPLICABLE"
    assert "FILE_AUTHORITY" in proof["dbSessionsClosed"]["reason"]
    assert proof["tempFilesCleaned"]["status"] == "PASS"


def test_teardown_proof_flags_unclosed_resource(tmp_path: Path):
    ctx = RunContext(tmp_path / "run-res", "run-res")
    with ctx:
        ctx.track_resource(object(), name="handle", is_closed=lambda: False)
    proof = ctx.teardown_proof()
    assert proof["workerStopped"]["status"] == "FAIL"
    assert "handle" in proof["workerStopped"]["unclosed"]


def test_load_completed_run_requires_complete_manifest(tmp_path: Path):
    run_dir = tmp_path / "prior"
    run_dir.mkdir()
    with pytest.raises(InfrastructureError, match="unpublished"):
        load_completed_run(run_dir)
    (run_dir / "RUNNING").write_text("{}")
    with pytest.raises(InfrastructureError, match="not a completed leaf"):
        load_completed_run(run_dir)
    (run_dir / "RUNNING").unlink()
    (run_dir / "run-manifest.json").write_text(json.dumps({"status": "RUNNING"}))
    with pytest.raises(InfrastructureError, match="not COMPLETE"):
        load_completed_run(run_dir)


def test_completed_fixture_ids_from_summary(tmp_path: Path):
    run_dir = tmp_path / "prior"
    run_dir.mkdir()
    (run_dir / "run-manifest.json").write_text(json.dumps({"status": "COMPLETE"}))
    (run_dir / "summary.json").write_text(
        json.dumps(
            {
                "fixtureLeaves": {
                    "fx-1": {"status": "PASS"},
                    "fx-2": {"status": "NOT_RUN"},
                    "fx-3": {"status": "FAIL"},
                }
            }
        )
    )
    prior = load_completed_run(run_dir)
    assert completed_fixture_ids(prior) == {"fx-1"}
