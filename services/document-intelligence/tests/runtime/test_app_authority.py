from __future__ import annotations

import json
import asyncio
import threading

import pytest

from document_intelligence.app import create_app
from document_intelligence.config import WorkerSettings
from document_intelligence.lifecycle import WorkerRuntime


class _UnreadableUpload:
    filename = "fixture.png"

    def __init__(self):
        self.read_count = 0

    async def read(self, _limit):
        self.read_count += 1
        raise AssertionError("unready worker must reject before consuming upload bytes")


@pytest.mark.asyncio
async def test_unready_authority_is_not_discovered_or_routable(tmp_path, monkeypatch):
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path)
    runtime = WorkerRuntime.create(settings)
    runtime.health.ready = False
    runtime.health.reason = "runtime provider catalog does not match admitted authority"
    runtime.health.reason_code = "PROVIDER_AUTHORITY_MISMATCH"

    admission_calls = []
    monkeypatch.setattr(
        runtime.capability_admission,
        "require",
        lambda *args, **kwargs: admission_calls.append((args, kwargs)),
    )

    app = create_app(settings, runtime)
    endpoints = {
        route.path: route.endpoint
        for route in app.routes
        if isinstance(getattr(route, "path", None), str)
    }
    ready = await endpoints["/readyz"]()
    providers = await endpoints["/v1/providers"]()
    assets = await endpoints["/v1/runtime-assets"]()

    assert ready.status_code == 503
    assert json.loads(ready.body)["reasonCode"] == "PROVIDER_AUTHORITY_MISMATCH"
    assert providers.status_code == 503
    assert json.loads(providers.body) == {
        "status": "not_ready",
        "reasonCode": "PROVIDER_AUTHORITY_MISMATCH",
    }
    assert assets.status_code == 503

    upload = _UnreadableUpload()
    response = await endpoints["/v1/parse"](
        metadata=json.dumps({
            "protocolVersion": "document-intelligence.v1",
            "operationId": "authority-mismatch",
            "providerRef": "ghatana.paddleocr",
            "mediaType": "image/png",
            "languageHint": "ne",
            "timeoutMs": 1000,
            "limits": {},
        }),
        file=upload,
        operation_generation=None,
    )
    assert response.status_code == 503
    assert json.loads(response.body) == {
        "protocolVersion": "document-intelligence.v1",
        "operationId": "authority-mismatch",
        "code": "PROVIDER_UNAVAILABLE",
        "retryable": True,
        "providerRef": "ghatana.paddleocr",
    }
    assert upload.read_count == 0
    assert admission_calls == []


@pytest.mark.asyncio
async def test_health_and_readiness_are_available_while_startup_loading(tmp_path):
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path)
    runtime = WorkerRuntime.create(settings)
    loading = threading.Event()
    release = threading.Event()

    def blocked_startup():
        loading.set()
        release.wait(timeout=5)

    runtime._start_sync = blocked_startup  # type: ignore[method-assign]
    app = create_app(settings, runtime)
    endpoints = {
        route.path: route.endpoint
        for route in app.routes
        if isinstance(getattr(route, "path", None), str)
    }

    await app.router.on_startup[0]()
    try:
        for _ in range(200):
            if loading.is_set():
                break
            await asyncio.sleep(0.01)
        assert loading.is_set()
        assert not app.state.startup_task.done()

        live = await endpoints["/healthz"]()
        ready = await endpoints["/readyz"]()
        providers = await endpoints["/v1/providers"]()

        assert live["status"] == "ok"
        assert live["profileId"] == "default"
        assert ready.status_code == 503
        assert json.loads(ready.body)["status"] == "not_ready"
        assert providers.status_code == 503
    finally:
        release.set()
        for _ in range(200):
            if app.state.startup_task.done():
                break
            await asyncio.sleep(0.01)
        assert app.state.startup_task.done()
        await app.router.on_shutdown[0]()
