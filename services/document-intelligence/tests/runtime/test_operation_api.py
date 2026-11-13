from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from document_intelligence.app import create_app
from document_intelligence.config import WorkerSettings
from document_intelligence.lifecycle import WorkerRuntime


GENERATION_A = "a" * 32
GENERATION_B = "b" * 32


@pytest.mark.asyncio
async def test_cancel_endpoint_requires_and_honors_the_operation_generation(tmp_path):
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path)
    runtime = WorkerRuntime.create(settings)
    app = create_app(settings, runtime)
    delete_operation = app.openapi()["paths"]["/v1/operations/{operation_id}"]["delete"]
    generation_parameter = next(
        parameter
        for parameter in delete_operation["parameters"]
        if parameter["name"] == "X-Operation-Generation"
    )
    assert generation_parameter["required"] is True

    previous = await runtime.operations.begin("reused-id", "provider", 1000, GENERATION_A)
    await runtime.operations.finish(previous)
    current = await runtime.operations.begin("reused-id", "provider", 1000, GENERATION_B)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://worker") as client:
        stale = await client.delete(
            "/v1/operations/reused-id",
            headers={"X-Operation-Generation": GENERATION_A},
        )
        assert stale.status_code == 200
        assert stale.json()["cancelled"] is False
        assert current.state.value == "ACTIVE"
        assert not current.token.cancelled

        matched = await client.delete(
            "/v1/operations/reused-id",
            headers={"X-Operation-Generation": GENERATION_B},
        )
        assert matched.status_code == 200
        assert matched.json()["cancelled"] is True
        assert matched.json()["operationGeneration"] == GENERATION_B

        missing = await client.delete("/v1/operations/reused-id")
        assert missing.status_code == 422
    assert current.token.cancelled
