import pytest

from document_intelligence.config import WorkerSettings
from document_intelligence.lifecycle import WorkerRuntime


@pytest.mark.asyncio
async def test_shutdown_marks_runtime_not_ready(tmp_path):
    runtime = WorkerRuntime.create(WorkerSettings(temp_root=tmp_path))
    await runtime.shutdown()
    assert runtime.health.shutting_down and not runtime.health.ready


# A public request can return on cancellation while its native provider call
# continues. Shutdown must retain provider/model material until that call ends.
import asyncio
import threading

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.concurrency import BoundedLane
from document_intelligence.runtime.model_registry import ModelEntry
from document_intelligence.runtime.provider_executor import ProviderExecutor


@pytest.mark.asyncio
async def test_shutdown_keeps_provider_material_until_late_native_call_finishes(tmp_path):
    entered = threading.Event()
    release = threading.Event()

    class BlockingProvider:
        closed = False

        def parse(self, data, **kwargs):
            entered.set()
            release.wait(timeout=5)
            return {"value": data.decode()}

        def close(self):
            self.closed = True

    provider = BlockingProvider()
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path, shutdown_timeout_seconds=0.05)
    runtime = WorkerRuntime.create(settings)
    runtime.models.register("ghatana.test-blocking", ModelEntry(
        "ghatana.test-blocking", "1", "blocking-model", "1", lambda: provider, {}
    ))
    runtime.models.get("ghatana.test-blocking").load()
    executor = ProviderExecutor(
        {"ghatana.test-blocking": provider},
        {"ghatana.test-blocking": BoundedLane("ghatana.test-blocking", 1, 0)},
        ("ghatana.test-blocking",),
    )
    runtime.provider_executor = executor

    async def request():
        operation = await runtime.operations.begin("shutdown-race", "ghatana.test-blocking", 10_000)
        try:
            return await executor.parse(
                "ghatana.test-blocking", b"payload", media_type="application/pdf", language="en",
                limits={}, deadline=operation.deadline, token=operation.token,
            )
        finally:
            await runtime.operations.finish(operation)

    request_task = asyncio.create_task(request())
    try:
        for _ in range(200):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()

        await runtime.shutdown()

        with pytest.raises(WorkerError) as cancelled:
            await request_task
        assert cancelled.value.code == "CANCELLED"
        assert runtime.health.reason_code == "SHUTDOWN_DRAIN_TIMEOUT"
        assert executor.active_native_calls == 1
        assert not provider.closed
        assert "ghatana.test-blocking" in executor._providers
        assert runtime.models.get("ghatana.test-blocking").instance is provider

        release.set()
        assert await executor.drain_native(2.0)
        await runtime.shutdown()

        assert provider.closed
        assert executor.active_native_calls == 0
        assert not executor._providers
        assert runtime.health.reason is None
    finally:
        release.set()
        if not request_task.done():
            await asyncio.gather(request_task, return_exceptions=True)
        if runtime.models.entries():
            await runtime.shutdown()
