from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from ..errors import WorkerError
from .cancellation import CancellationToken
from .core_dumps import apply_core_dump_policy
from .deadline import Deadline
from .sanitization import sanitize_diagnostic_bytes


@dataclass(frozen=True)
class CompletedSubprocess:
    stdout: bytes
    stderr: bytes
    returncode: int


@dataclass(frozen=True)
class TerminationReport:
    """Bounded process-tree termination receipt (OCR-RUN-23)."""

    signals: tuple[str, ...]
    forced: bool
    reaped: bool


def _wait_for_exit(process: subprocess.Popen[bytes], timeout: float) -> bool:
    try:
        process.wait(timeout=max(0.0, timeout))
        return True
    except (OSError, ProcessLookupError, subprocess.TimeoutExpired):
        return process.poll() is not None


def _terminate_process_tree(
    process: subprocess.Popen[bytes],
    grace_seconds: float = 0.2,
    force_grace_seconds: float = 0.2,
) -> TerminationReport:
    """Escalate cancellation through group termination and force kill.

    The process group is created by :func:`run_bounded_subprocess`; signaling
    the group prevents office/OCR grandchildren from surviving the request.
    Every stage has a bounded wait and the final wait reaps the wrapper when
    possible.  Late output is drained and discarded by the caller.
    """

    signals: list[str] = []
    if process.poll() is not None:
        return TerminationReport((), False, True)

    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
            signals.append("SIGTERM")
        else:  # pragma: no cover - exercised on Windows workers
            process.terminate()
            signals.append("TERMINATE")
    except (OSError, ProcessLookupError):
        pass
    if _wait_for_exit(process, grace_seconds):
        return TerminationReport(tuple(signals), False, True)

    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
            signals.append("SIGKILL")
        else:  # pragma: no cover
            process.kill()
            signals.append("KILL")
    except (OSError, ProcessLookupError):
        pass
    reaped = _wait_for_exit(process, force_grace_seconds)
    return TerminationReport(tuple(signals), True, reaped)


def _capture_pipe(
    pipe: object,
    output: bytearray,
    limit: int,
    state: dict[str, object],
) -> None:
    reader = getattr(pipe, "read", None)
    if not callable(reader):
        return
    while True:
        try:
            chunk = reader(64 * 1024)
        except (OSError, ValueError):
            return
        if not chunk:
            return
        with state["lock"]:  # type: ignore[index]
            used = int(state["used"])
            remaining = max(0, limit - used)
            if remaining:
                output.extend(chunk[:remaining])
                state["used"] = used + min(len(chunk), remaining)
            if len(chunk) > remaining:
                state["overflow"] = True


def _communicate_bounded(
    process: subprocess.Popen[bytes],
    input_data: bytes | None,
    deadline: Deadline,
    token: CancellationToken,
    max_output_bytes: int,
    threads: list[threading.Thread],
) -> tuple[bytes, bytes]:
    """Drain both child pipes concurrently and stop collecting at the cap."""

    stdout_pipe = getattr(process, "stdout", None)
    stderr_pipe = getattr(process, "stderr", None)
    if stdout_pipe is None or stderr_pipe is None:
        raise AttributeError("bounded pipe capture requires stdout and stderr")
    state: dict[str, object] = {"lock": threading.Lock(), "used": 0, "overflow": False}
    stdout = bytearray()
    stderr = bytearray()
    for pipe, output, name in ((stdout_pipe, stdout, "document-provider-stdout"), (stderr_pipe, stderr, "document-provider-stderr")):
        thread = threading.Thread(target=_capture_pipe, args=(pipe, output, max_output_bytes, state), name=name, daemon=True)
        thread.start()
        threads.append(thread)

    if input_data is not None and getattr(process, "stdin", None) is not None:
        def write_input() -> None:
            try:
                process.stdin.write(input_data)  # type: ignore[union-attr]
                process.stdin.close()  # type: ignore[union-attr]
            except (BrokenPipeError, OSError, ValueError):
                pass

        writer = threading.Thread(target=write_input, name="document-provider-stdin", daemon=True)
        writer.start()
        threads.append(writer)

    while process.poll() is None:
        if bool(state["overflow"]):
            raise WorkerError("LIMIT_EXCEEDED")
        token.raise_if_cancelled()
        remaining = deadline.remaining_ms() / 1000
        if remaining <= 0:
            token.cancel()
            raise WorkerError("TIMEOUT", retryable=True)
        time.sleep(min(remaining, 0.01))
    token.raise_if_cancelled()
    for thread in threads:
        thread.join(timeout=0.5)
    if any(thread.is_alive() for thread in threads):
        raise WorkerError("PROVIDER_FAILED", retryable=True)
    if bool(state["overflow"]):
        raise WorkerError("LIMIT_EXCEEDED")
    return bytes(stdout), bytes(stderr)


def run_bounded_subprocess(
    argv: Sequence[str], *, deadline: Deadline, token: CancellationToken,
    input_data: bytes | None = None, cwd: Path | None = None,
    max_output_bytes: int = 16 * 1024 * 1024, env: Mapping[str, str] | None = None,
) -> CompletedSubprocess:
    """Run an argument-vector command without a shell, bounded by deadline and output size."""
    if not argv or any(not isinstance(value, str) or not value or "\x00" in value for value in argv):
        raise WorkerError("INVALID_REQUEST")
    if max_output_bytes <= 0 or (cwd is not None and not cwd.is_dir()):
        raise WorkerError("INVALID_REQUEST")
    token.raise_if_cancelled()
    try:
        # Apply again at the child boundary so direct provider use is safe even
        # when a caller did not construct the HTTP app first.
        apply_core_dump_policy(strict=True)
    except RuntimeError as exc:
        raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True) from exc
    timeout = deadline.require_remaining() / 1000
    safe_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    if env:
        safe_env.update({str(key): str(value) for key, value in env.items()})
    process: subprocess.Popen[bytes] | None = None
    capture_threads: list[threading.Thread] = []
    try:
        process_kwargs: dict[str, object] = {
            "stdin": subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "cwd": cwd,
            "env": safe_env,
            "shell": False,
        }
        # A new session gives the provider and any grandchildren one killable
        # process group. Without this, timeout/cancellation only kills the
        # wrapper and native office/OCR descendants can survive the request.
        if os.name == "posix":
            process_kwargs["start_new_session"] = True
        else:  # pragma: no cover - exercised on Windows workers
            process_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        process = subprocess.Popen(list(argv), **process_kwargs)  # type: ignore[arg-type]
        if hasattr(process, "stdout") and hasattr(process, "stderr"):
            stdout, stderr = _communicate_bounded(process, input_data, deadline, token, max_output_bytes, capture_threads)
        else:
            # Minimal fallback retained for process fakes used by contract
            # tests; real Popen instances always take the bounded pipe path.
            started = time.monotonic()
            sent_input = False
            while True:
                token.raise_if_cancelled()
                remaining = deadline.remaining_ms() / 1000
                if remaining <= 0:
                    token.cancel()
                    raise WorkerError("TIMEOUT", retryable=True)
                try:
                    stdout, stderr = process.communicate(
                        input=input_data if not sent_input else None,
                        timeout=min(remaining, 0.05),
                    )
                    sent_input = True
                    if len(stdout) + len(stderr) > max_output_bytes:
                        raise WorkerError("LIMIT_EXCEEDED")
                    break
                except subprocess.TimeoutExpired:
                    sent_input = True
                    if time.monotonic() - started >= timeout:
                        token.cancel()
                        raise WorkerError("TIMEOUT", retryable=True)
        # stdout is provider data; stderr is diagnostics and must not carry
        # secrets or machine-specific paths into evidence/logs.
        safe_stderr = sanitize_diagnostic_bytes(stderr, limit=min(max_output_bytes, 4096))
        return CompletedSubprocess(stdout, safe_stderr, process.returncode)
    except WorkerError:
        if process is not None and process.poll() is None:
            _terminate_process_tree(process)
        if process is not None and not capture_threads:
            try:
                process.communicate(timeout=0.5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        for thread in capture_threads:
            thread.join(timeout=0.5)
        raise
    except (OSError, ValueError) as exc:
        if process is not None and process.poll() is None:
            _terminate_process_tree(process)
        raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True) from exc
