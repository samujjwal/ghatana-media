"""Campaign runner reliability harness (RUN-01..RUN-07).

Shared mechanics for post-seal campaign runners:

- RUN-01 ``free_port()`` — bind ``127.0.0.1:0``, read, close; the allocated
  port is recorded on the context as ``actualPort`` for manifests.
- RUN-02/RUN-03 ``RunContext`` — a run context that installs SIGINT/SIGTERM
  handlers and marks the run ABORTED on exception, interrupt, or timeout
  instead of leaving a bare RUNNING marker. ``register_cleanup`` hooks run on
  every exit path so worker/native handles are never orphaned.
- RUN-04 ``track_resource`` — closable resources are tracked and verified
  closed at teardown; file-authority campaigns record
  ``dbSessionsClosed: NOT_APPLICABLE_FILE_AUTHORITY``.
- RUN-05 ``classify_failure`` + ``run_with_infra_retries`` —
  INFRASTRUCTURE_ERROR (spawn/connect/environment setup) is distinct from
  TEST_FAIL (semantic); bounded retry applies only to infrastructure errors.
- RUN-06 ``load_completed_run``/``completed_fixture_ids`` — resume support:
  a prior run directory is reusable only when its run-manifest is COMPLETE;
  partially complete leaves are never resumed into.
- RUN-07 ``teardown_proof`` — every campaign manifest records
  {workerStopped, nativeWorkDrained, dbSessionsClosed, tempFilesCleaned} with
  real checks where resources exist and explicit NOT_APPLICABLE otherwise.
"""
from __future__ import annotations

import json
import os
import signal
import socket
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

INFRASTRUCTURE_ERROR = "INFRASTRUCTURE_ERROR"
TEST_FAIL = "TEST_FAIL"

RUNNING_MARKER = "RUNNING"
ABORTED_MARKER = "ABORTED"
MANIFEST_NAME = "run-manifest.json"
RUN_STATE_SCHEMA = "document-intelligence.run-publication.v1"
DB_SESSIONS_NOT_APPLICABLE = "NOT_APPLICABLE_FILE_AUTHORITY"


class InfrastructureError(RuntimeError):
    """Spawn/connect/environment-setup failure — eligible for bounded retry."""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def free_port(host: str = "127.0.0.1") -> int:
    """RUN-01: allocate an OS-chosen free port; the caller records actualPort."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def classify_failure(exc: BaseException) -> str:
    """RUN-05: INFRASTRUCTURE_ERROR vs TEST_FAIL."""
    if isinstance(exc, (InfrastructureError, OSError)):
        return INFRASTRUCTURE_ERROR
    return TEST_FAIL


def run_with_infra_retries(
    fn: Callable[[], Any],
    *,
    retries: int = 0,
    on_retry: Callable[[int, BaseException], None] | None = None,
) -> Any:
    """RUN-05: bounded retry only for INFRASTRUCTURE_ERROR failures."""
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as exc:
            if classify_failure(exc) != INFRASTRUCTURE_ERROR or attempt >= retries:
                raise
            attempt += 1
            if on_retry is not None:
                on_retry(attempt, exc)


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
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


def _write_json(path: Path, value: Any) -> None:
    _atomic_write(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


class RunContext:
    """RUN-02/03/04/07: crash-safe run lifecycle + teardown proof.

    ``begin`` may inject the run-publication begin hook
    (``build_run_publication.begin_run``); without it the context writes the
    RUNNING marker itself. On any exceptional exit — including SIGINT/SIGTERM
    — the run state is rewritten to ABORTED and registered cleanups run, so a
    leftover marker is never mistaken for COMPLETE.
    """

    def __init__(
        self,
        run_dir: Path,
        run_id: str,
        *,
        begin: Callable[[Path, str], Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self.run_dir = Path(run_dir)
        self.run_id = run_id
        self._begin = begin
        self._timeout_seconds = timeout_seconds
        self._cleanups: list[tuple[str, Callable[[], Any]]] = []
        self._resources: list[tuple[str, Callable[[], bool]]] = []
        self._drains: list[tuple[str, Callable[[], bool]]] = []
        self._previous_handlers: dict[int, Any] = {}
        self._cleanups_ran = False
        self.actual_port: int | None = None
        self.aborted_reason: str | None = None

    # -- registration -----------------------------------------------------

    def register_cleanup(self, fn: Callable[[], Any], *, name: str | None = None) -> None:
        """RUN-02: teardown hook for worker/native/DB handles."""
        self._cleanups.append((name or getattr(fn, "__name__", "cleanup"), fn))

    def track_resource(
        self,
        resource: Any,
        *,
        name: str | None = None,
        is_closed: Callable[[], bool] | None = None,
    ) -> None:
        """RUN-04: track a closable resource; teardown verifies it closed."""
        if is_closed is None:
            closed_attr = getattr(resource, "closed", None)
            if callable(closed_attr):
                is_closed = closed_attr
            elif closed_attr is not None:
                is_closed = lambda: bool(closed_attr)  # noqa: E731
            else:
                def _default() -> bool:
                    getattr(resource, "close")()
                    return True

                is_closed = _default
        self._resources.append((name or getattr(resource, "name", "resource"), is_closed))

    def register_drain(self, check: Callable[[], bool], *, name: str | None = None) -> None:
        """RUN-04/07: register a native-work drain check."""
        self._drains.append((name or getattr(check, "__name__", "drain"), check))

    def allocate_port(self, host: str = "127.0.0.1") -> int:
        """RUN-01: allocate and record the run's actual port."""
        self.actual_port = free_port(host)
        return self.actual_port

    # -- state markers ------------------------------------------------------

    def _state_path(self) -> Path:
        return self.run_dir / RUNNING_MARKER

    def _write_state(self, status: str, extra: dict | None = None) -> None:
        state = {
            "schemaVersion": RUN_STATE_SCHEMA,
            "runId": self.run_id,
            "status": status,
            "pid": os.getpid(),
            "recordedAt": _utcnow(),
            **(extra or {}),
        }
        _write_json(self._state_path(), state)

    def mark_aborted(self, reason: str) -> None:
        """RUN-03: record ABORTED alongside (and inside) the run state."""
        self.aborted_reason = reason
        aborted = {
            "schemaVersion": RUN_STATE_SCHEMA,
            "runId": self.run_id,
            "status": "ABORTED",
            "pid": os.getpid(),
            "abortedAt": _utcnow(),
            "reason": reason,
        }
        _write_json(self.run_dir / ABORTED_MARKER, aborted)
        self._write_state("ABORTED", {"reason": reason})

    # -- context manager ----------------------------------------------------

    def __enter__(self) -> "RunContext":
        manifest = self.run_dir / MANIFEST_NAME
        if manifest.exists():
            raise ValueError(f"run already published: {self.run_dir}")
        marker = self._state_path()
        if marker.exists():
            try:
                existing = json.loads(marker.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                existing = {}
            if existing.get("runId") not in (None, self.run_id):
                raise InfrastructureError(
                    f"run dir {self.run_dir} holds a RUNNING marker for "
                    f"{existing.get('runId')!r} — refusing to write into a "
                    "partially complete leaf"
                )
        if self._begin is not None:
            self._begin(self.run_dir, self.run_id)
        else:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            if not marker.exists():
                self._write_state("RUNNING")
        self._install_signal_handlers()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self._restore_signal_handlers()
        try:
            if exc_type is not None:
                self.mark_aborted(f"{getattr(exc_type, '__name__', exc_type)}: {exc}")
        finally:
            self._run_cleanups()
        return False

    # -- signals ------------------------------------------------------------

    def _install_signal_handlers(self) -> None:
        if threading.current_thread() is not threading.main_thread():
            return
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous = signal.getsignal(signum)
            self._previous_handlers[signum] = previous

            def handler(received: int, _frame, _previous=previous) -> None:
                try:
                    self.mark_aborted(f"signal {received}")
                    self._run_cleanups()
                finally:
                    signal.signal(received, signal.SIG_DFL)
                    os.kill(os.getpid(), received)

            signal.signal(signum, handler)
        if self._timeout_seconds is not None:
            previous = signal.getsignal(signal.SIGALRM)
            self._previous_handlers[signal.SIGALRM] = previous

            def _timeout(_received: int, _frame) -> None:
                self.mark_aborted(f"timeout after {self._timeout_seconds}s")
                self._run_cleanups()
                raise TimeoutError(
                    f"run {self.run_id} exceeded timeout of {self._timeout_seconds}s"
                )

            signal.signal(signal.SIGALRM, _timeout)
            signal.setitimer(signal.ITIMER_REAL, self._timeout_seconds)

    def _restore_signal_handlers(self) -> None:
        if threading.current_thread() is not threading.main_thread():
            return
        if self._timeout_seconds is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
        for signum, previous in self._previous_handlers.items():
            signal.signal(signum, previous)
        self._previous_handlers = {}

    # -- teardown -------------------------------------------------------------

    def _run_cleanups(self) -> list[str]:
        if self._cleanups_ran:
            return []
        self._cleanups_ran = True
        errors: list[str] = []
        for name, fn in reversed(self._cleanups):
            try:
                fn()
            except Exception as exc:  # teardown must not mask the run result
                errors.append(f"{name}: {exc}")
        self._cleanup_errors = errors
        return errors

    def teardown_proof(self) -> dict:
        """RUN-07: honest teardown evidence for the campaign manifest."""
        if self._resources:
            unclosed = [name for name, check in self._resources if not _safe(check)]
            worker = (
                {"status": "PASS", "checkedResources": len(self._resources)}
                if not unclosed
                else {"status": "FAIL", "unclosed": unclosed}
            )
        else:
            worker = {
                "status": "NOT_APPLICABLE",
                "reason": "no worker subprocess or closable resource registered",
            }
        if self._drains:
            undrained = [name for name, check in self._drains if not _safe(check)]
            drain = (
                {"status": "PASS", "checkedDrains": len(self._drains)}
                if not undrained
                else {"status": "FAIL", "undrained": undrained}
            )
        else:
            drain = {
                "status": "NOT_APPLICABLE",
                "reason": "no native work queue registered for this run",
            }
        leftovers = (
            sorted(str(p.relative_to(self.run_dir)) for p in self.run_dir.rglob("*.tmp"))
            if self.run_dir.is_dir()
            else []
        )
        temp = (
            {"status": "PASS"}
            if not leftovers
            else {"status": "FAIL", "leftovers": leftovers}
        )
        return {
            "workerStopped": worker,
            "nativeWorkDrained": drain,
            "dbSessionsClosed": {
                "status": "NOT_APPLICABLE",
                "reason": (
                    f"{DB_SESSIONS_NOT_APPLICABLE}: learning and evaluation "
                    "authority is file-backed; the campaign owns no DB sessions"
                ),
            },
            "tempFilesCleaned": temp,
        }


def _safe(check: Callable[[], bool]) -> bool:
    try:
        return bool(check())
    except Exception:
        return False


# --------------------------------------------------------------------------
# RUN-06 resume support
# --------------------------------------------------------------------------


def load_completed_run(prior_run_dir: Path) -> dict:
    """RUN-06: load a prior run only when it is a COMPLETE published leaf.

    Raises for unpublished, running, or partial run directories — a half-
    completed leaf is never resumed into.
    """
    prior_run_dir = Path(prior_run_dir)
    manifest_path = prior_run_dir / MANIFEST_NAME
    if (prior_run_dir / RUNNING_MARKER).exists() or (prior_run_dir / ABORTED_MARKER).exists():
        raise InfrastructureError(f"prior run {prior_run_dir} is not a completed leaf")
    if not manifest_path.exists():
        raise InfrastructureError(f"prior run {prior_run_dir} has no run manifest — unpublished")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("status") != "COMPLETE":
        raise InfrastructureError(
            f"prior run {prior_run_dir} manifest status is {manifest.get('status')!r}, not COMPLETE"
        )
    out: dict[str, Any] = {"manifest": manifest}
    for name, key in (("summary.json", "summary"), ("observations.json", "observations")):
        path = prior_run_dir / name
        if path.exists():
            out[key] = json.loads(path.read_text(encoding="utf-8"))
    return out


def completed_fixture_ids(prior_run: dict) -> set[str]:
    """Fixture leaves recorded PASS (COMPLETE) inside a prior run summary."""
    summary = prior_run.get("summary") or {}
    leaves = summary.get("fixtureLeaves") or {}
    return {
        fixture_id
        for fixture_id, leaf in leaves.items()
        if leaf.get("status") == "PASS"
    }
