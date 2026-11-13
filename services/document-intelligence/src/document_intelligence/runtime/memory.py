"""Increment-6 memory pressure guard (backlog I6-23).

``MemoryPressureGuard`` reads the worker's resident set size from
``/proc/self/status`` (falling back to ``resource.getrusage``) and classifies
pressure against a byte limit: ``OK`` below 70%, ``WARN`` at 70-90%, and
``CRITICAL`` at 90%+.  ``admit`` refuses new work that would exceed the
limit or arrive while pressure is CRITICAL; ``require_admission`` turns the
refusal into a ``MEMORY_PRESSURE`` WorkerError.

``errors.py`` is sealed Increment-4A material, so the module-local
``MemoryPressureError`` overrides ``WorkerError.__post_init__`` to keep the
increment-6 code verbatim instead of being rewritten to PROVIDER_FAILED.
"""

from __future__ import annotations

import resource
from collections.abc import Callable
from pathlib import Path

from ..errors import WorkerError

WARN_FRACTION = 0.70
CRITICAL_FRACTION = 0.90

PRESSURE_OK = "OK"
PRESSURE_WARN = "WARN"
PRESSURE_CRITICAL = "CRITICAL"


class MemoryPressureError(WorkerError):
    """WorkerError that preserves increment-6 memory codes verbatim."""

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code)


def _read_proc_status_rss() -> int | None:
    try:
        for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                fields = line.split()
                return int(fields[1]) * 1024  # VmRSS is reported in kB
    except (OSError, ValueError, IndexError):
        return None
    return None


def _read_rusage_rss() -> int:
    # Linux reports ru_maxrss in kilobytes; macOS reports bytes.  The worker
    # targets Linux containers, but normalize defensively for portability.
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value * 1024 if value < 1 << 40 else value


class MemoryPressureGuard:
    def __init__(self, limit_bytes: int, rss_reader: Callable[[], int] | None = None) -> None:
        if limit_bytes <= 0:
            raise ValueError("limit_bytes must be positive")
        self.limit_bytes = limit_bytes
        self._rss_reader = rss_reader

    def current_rss(self) -> int:
        """Current resident set size in bytes."""
        if self._rss_reader is not None:
            return self._rss_reader()
        observed = _read_proc_status_rss()
        return observed if observed is not None else _read_rusage_rss()

    def check(self) -> str:
        """Pressure classification: OK | WARN | CRITICAL at 70% / 90%."""
        rss = self.current_rss()
        if rss >= self.limit_bytes * CRITICAL_FRACTION:
            return PRESSURE_CRITICAL
        if rss >= self.limit_bytes * WARN_FRACTION:
            return PRESSURE_WARN
        return PRESSURE_OK

    def admit(self, estimated_bytes: int) -> bool:
        """True when ``estimated_bytes`` of new work fits below the limit.

        Always False while pressure is CRITICAL, so new work is rejected
        before its estimate is even considered.
        """
        if self.check() == PRESSURE_CRITICAL:
            return False
        return self.current_rss() + max(estimated_bytes, 0) <= self.limit_bytes

    def require_admission(self, estimated_bytes: int) -> None:
        """Raise MEMORY_PRESSURE unless :meth:`admit` accepts the work."""
        if not self.admit(estimated_bytes):
            raise MemoryPressureError("MEMORY_PRESSURE", retryable=True)
