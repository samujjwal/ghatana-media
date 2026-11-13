from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator


class LaneLease:
    def __init__(self) -> None:
        self._pending: asyncio.Future[object] | None = None

    def hold_until(self, pending: asyncio.Future[object]) -> None:
        self._pending = pending

    @property
    def pending(self) -> asyncio.Future[object] | None:
        return self._pending

from ..errors import WorkerError


class BoundedLane:
    def __init__(self, name: str, capacity: int, queue_limit: int) -> None:
        if capacity < 1 or queue_limit < 0:
            raise ValueError("invalid lane capacity")
        self.name = name
        self.capacity = capacity
        self.queue_limit = queue_limit
        self._semaphore = asyncio.Semaphore(capacity)
        self._slots = asyncio.BoundedSemaphore(capacity + queue_limit)

    @asynccontextmanager
    async def acquire(self, timeout_ms: int = 0, token: object | None = None) -> AsyncIterator[LaneLease]:
        async def acquire_one(semaphore: asyncio.Semaphore | asyncio.BoundedSemaphore) -> None:
            acquire_task = asyncio.create_task(semaphore.acquire())
            cancel_task = asyncio.create_task(token.wait()) if token is not None and hasattr(token, "wait") else None
            tasks = {acquire_task} | ({cancel_task} if cancel_task is not None else set())
            transferred = False
            try:
                done, _ = await asyncio.wait(tasks, timeout=max(timeout_ms, 1) / 1000, return_when=asyncio.FIRST_COMPLETED)
                if cancel_task is not None and cancel_task in done:
                    raise WorkerError("CANCELLED")
                if acquire_task not in done:
                    raise WorkerError("PROVIDER_BUSY", retryable=True)
                transferred = bool(acquire_task.result())
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                # Cancellation or timeout may win the wait just as acquire()
                # consumes a permit. Return that permit unless ownership was
                # transferred to the caller on the successful path.
                if not transferred and acquire_task.done() and not acquire_task.cancelled():
                    if acquire_task.exception() is None and acquire_task.result():
                        semaphore.release()
        try:
            await acquire_one(self._slots)
        except (TimeoutError, asyncio.TimeoutError) as exc:
            raise WorkerError("PROVIDER_BUSY", retryable=True) from exc
        try:
            await acquire_one(self._semaphore)
        except (TimeoutError, asyncio.TimeoutError) as exc:
            self._slots.release()
            raise WorkerError("PROVIDER_BUSY", retryable=True) from exc
        except WorkerError:
            self._slots.release()
            raise
        lease = LaneLease()
        try:
            yield lease
        finally:
            def release(_: object = None) -> None:
                self._semaphore.release()
                self._slots.release()

            pending = lease.pending
            if pending is not None and not pending.done():
                pending.add_done_callback(release)
            else:
                release()
