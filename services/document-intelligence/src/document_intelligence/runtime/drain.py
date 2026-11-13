"""Increment-6 graceful drain coordinator (backlog I6-24).

``DrainCoordinator`` gates work admission through three states —
``ACCEPTING`` -> ``DRAINING`` -> ``DRAINED``.  ``begin_drain`` flips the gate
so new admissions fail fast with a ``DRAINING`` WorkerError, then blocks on a
``threading.Condition`` until in-flight work reaches zero or the deadline
(taken from the ``runtime/deadline.py`` monotonic-deadline pattern) expires.

``errors.py`` is sealed Increment-4A material, so ``DrainError`` overrides
``WorkerError.__post_init__`` to keep the increment-6 code verbatim.
"""

from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager
from typing import Iterator

from ..errors import WorkerError
from .deadline import Deadline

STATE_ACCEPTING = "ACCEPTING"
STATE_DRAINING = "DRAINING"
STATE_DRAINED = "DRAINED"


class DrainError(WorkerError):
    """WorkerError that preserves increment-6 drain codes verbatim."""

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code)


class DrainCoordinator:
    def __init__(self) -> None:
        self._state = STATE_ACCEPTING
        self._in_flight = 0
        self._condition = threading.Condition()

    @property
    def state(self) -> str:
        return self._state

    @property
    def in_flight(self) -> int:
        return self._in_flight

    @property
    def accepting(self) -> bool:
        return self._state == STATE_ACCEPTING

    def admit(self) -> None:
        """Register one unit of in-flight work or raise DRAINING."""
        with self._condition:
            if self._state != STATE_ACCEPTING:
                raise DrainError("DRAINING", retryable=True)
            self._in_flight += 1

    def release(self) -> None:
        """Mark one unit of in-flight work finished."""
        with self._condition:
            if self._in_flight <= 0:
                raise ValueError("release without admit")
            self._in_flight -= 1
            self._condition.notify_all()

    @contextmanager
    def track(self) -> Iterator[None]:
        """Context manager equivalent of admit()/release()."""
        self.admit()
        try:
            yield
        finally:
            self.release()

    def begin_drain(self, timeout_ms: int) -> bool:
        """Reject new admissions and wait for in-flight work to reach zero.

        Returns True when the coordinator reached DRAINED, False when the
        deadline expired first (state stays DRAINING so stragglers can still
        release, and a retry can complete the drain).
        """
        deadline = Deadline(timeout_ms, margin_ms=0)
        with self._condition:
            if self._state == STATE_ACCEPTING:
                self._state = STATE_DRAINING
            while self._in_flight > 0:
                remaining = deadline.remaining_ms()
                if remaining <= 0:
                    return False
                self._condition.wait(timeout=remaining / 1000)
            self._state = STATE_DRAINED
            self._condition.notify_all()
            return True

    async def begin_drain_async(self, timeout_ms: int, poll_ms: int = 10) -> bool:
        """Async variant of :meth:`begin_drain` that never blocks the loop."""
        deadline = Deadline(timeout_ms, margin_ms=0)
        with self._condition:
            if self._state == STATE_ACCEPTING:
                self._state = STATE_DRAINING
        while True:
            with self._condition:
                if self._in_flight == 0:
                    self._state = STATE_DRAINED
                    self._condition.notify_all()
                    return True
            if deadline.remaining_ms() <= 0:
                return False
            await asyncio.sleep(min(poll_ms, max(deadline.remaining_ms(), 1)) / 1000)
