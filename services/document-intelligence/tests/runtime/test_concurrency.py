import asyncio

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.concurrency import BoundedLane


@pytest.mark.asyncio
async def test_lane_is_bounded_and_returns_busy():
    lane = BoundedLane('provider', 1, 0)
    async with lane.acquire(100):
        with pytest.raises(WorkerError) as error:
            async with lane.acquire(1):
                pass
        assert error.value.code == 'PROVIDER_BUSY'


@pytest.mark.asyncio
async def test_lane_remains_occupied_until_cancelled_native_work_finishes():
    lane = BoundedLane('provider', 1, 0)
    native_done = asyncio.get_running_loop().create_future()
    async with lane.acquire(100) as lease:
        lease.hold_until(native_done)
    with pytest.raises(WorkerError) as error:
        async with lane.acquire(1):
            pass
    assert error.value.code == 'PROVIDER_BUSY'
    native_done.set_result(None)
    await asyncio.sleep(0)
    async with lane.acquire(100):
        pass


@pytest.mark.asyncio
async def test_cancelled_native_work_flood_never_exceeds_configured_concurrency():
    """Cancelling an operation must not free the permit while native work runs.

    A request cancelled at the HTTP layer can leave native inference running.
    The provider semaphore must stay owned until that computation finishes, so
    repeated cancel+flood cycles can never exceed configured concurrency.
    """
    lane = BoundedLane('provider', 1, 8)
    running = 0
    peak = 0
    native_done = asyncio.get_running_loop().create_future()
    entered = asyncio.Event()

    async def cancelled_operation() -> None:
        nonlocal running, peak
        async with lane.acquire(100) as lease:
            running += 1
            peak = max(peak, running)
            entered.set()
            try:
                await asyncio.sleep(3600)
            finally:
                running -= 1
                lease.hold_until(native_done)

    worker = asyncio.create_task(cancelled_operation())
    await entered.wait()
    worker.cancel()
    with pytest.raises(asyncio.CancelledError):
        await worker

    # Flood the lane while the native computation is still unfinished: every
    # attempt must fail busy and none may run concurrently with native work.
    for _ in range(8):
        with pytest.raises(WorkerError) as error:
            async with lane.acquire(1):
                pass
        assert error.value.code == 'PROVIDER_BUSY'
    assert peak == 1

    native_done.set_result(None)
    await asyncio.sleep(0)
    async with lane.acquire(100):
        pass
    assert peak == 1


@pytest.mark.asyncio
async def test_cancelled_acquire_returns_slot_when_token_is_already_cancelled():
    lane = BoundedLane("provider", 1, 0)
    token = CancellationToken()
    token.cancel()

    with pytest.raises(WorkerError) as error:
        async with lane.acquire(100, token):
            pass
    assert error.value.code == "CANCELLED"

    # The simultaneous successful `_slots.acquire()` must be returned when
    # cancellation wins, otherwise a zero-queue lane is permanently wedged.
    async with lane.acquire(100):
        pass


@pytest.mark.asyncio
async def test_cancelled_acquire_returns_provider_permit_when_release_races():
    second_acquire_started = asyncio.Event()

    class SignallingSemaphore(asyncio.Semaphore):
        calls = 0

        async def acquire(self):
            self.calls += 1
            if self.calls == 2:
                second_acquire_started.set()
            return await super().acquire()

    lane = BoundedLane("provider", 1, 1)
    lane._semaphore = SignallingSemaphore(1)
    token = CancellationToken()

    async with lane.acquire(100):
        async def cancelled_waiter():
            async with lane.acquire(100, token):
                pass

        waiter = asyncio.create_task(cancelled_waiter())
        await second_acquire_started.wait()
        # Both the cancellation waiter and semaphore acquire are made runnable
        # before the event loop resumes the lane's asyncio.wait().
        token.cancel()

    with pytest.raises(WorkerError) as error:
        await waiter
    assert error.value.code == "CANCELLED"

    # The provider semaphore as well as its queue slot must remain available.
    async with lane.acquire(100):
        pass
