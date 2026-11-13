from __future__ import annotations

import asyncio
import signal
import subprocess
import sys

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline
from document_intelligence.runtime import subprocess_runner
from document_intelligence.runtime.subprocess_runner import run_bounded_subprocess


@pytest.mark.asyncio
async def test_cancellation_escalates_and_does_not_return_late_child_output():
    token = CancellationToken()
    task = asyncio.create_task(asyncio.to_thread(
        run_bounded_subprocess,
        [sys.executable, "-c", "import time; time.sleep(30)"],
        deadline=Deadline(5_000, margin_ms=0),
        token=token,
    ))
    await asyncio.sleep(0.1)
    token.cancel()
    with pytest.raises(WorkerError, match="CANCELLED"):
        await asyncio.wait_for(task, timeout=2)


def test_kill_escalation_reaches_force_kill(monkeypatch):
    sent: list[signal.Signals] = []

    class Process:
        pid = 42

        def __init__(self) -> None:
            self.alive = True

        def poll(self):
            return None if self.alive else -signal.SIGKILL

        def wait(self, timeout=None):
            if sent and sent[-1] == signal.SIGTERM:
                raise subprocess.TimeoutExpired("provider", timeout)
            self.alive = False
            return -signal.SIGKILL

    process = Process()
    monkeypatch.setattr(subprocess_runner.os, "killpg", lambda _pid, value: sent.append(value))
    report = subprocess_runner._terminate_process_tree(process, grace_seconds=0, force_grace_seconds=0)
    assert sent == [signal.SIGTERM, signal.SIGKILL]
    assert report.forced and report.reaped


def test_child_stderr_is_bounded_and_sanitized():
    result = run_bounded_subprocess(
        [sys.executable, "-c", "import sys; sys.stderr.write('token=secret /tmp/secret.pdf\\n')"],
        deadline=Deadline(1_000, margin_ms=0),
        token=CancellationToken(),
    )
    diagnostic = result.stderr.decode("utf-8")
    assert "secret" not in diagnostic
    assert "[REDACTED]" in diagnostic
    assert "[PATH]" in diagnostic


def test_child_output_limit_terminates_before_collecting_unbounded_output():
    with pytest.raises(WorkerError, match="LIMIT_EXCEEDED"):
        run_bounded_subprocess(
            [sys.executable, "-c", "import sys; sys.stdout.write('x' * 10000000); sys.stdout.flush()"],
            deadline=Deadline(2_000, margin_ms=0),
            token=CancellationToken(),
            max_output_bytes=1024,
        )
