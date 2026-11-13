from __future__ import annotations

import time

from ..errors import WorkerError


class Deadline:
    def __init__(self, timeout_ms: int, margin_ms: int = 25) -> None:
        now = time.monotonic()
        self._deadline = now + max(timeout_ms - margin_ms, 0) / 1000

    @classmethod
    def at(cls, deadline: float) -> "Deadline":
        instance = cls.__new__(cls)
        instance._deadline = deadline
        return instance

    @property
    def monotonic(self) -> float:
        return self._deadline

    def remaining_ms(self) -> int:
        return max(0, int((self._deadline - time.monotonic()) * 1000))

    def require_remaining(self) -> int:
        remaining = self.remaining_ms()
        if remaining <= 0:
            raise WorkerError("TIMEOUT", retryable=True)
        return remaining
