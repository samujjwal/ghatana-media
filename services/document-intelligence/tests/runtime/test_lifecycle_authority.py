from __future__ import annotations

import json

import pytest

from document_intelligence.app import create_app
from document_intelligence.config import WorkerSettings
from document_intelligence.lifecycle import WorkerRuntime
from document_intelligence.runtime.provider_authority import (
    FROZEN_INCREMENT3_PROVIDER_CATALOG_FINGERPRINT,
    FROZEN_INCREMENT3_PROVIDER_CATALOG_SEMANTIC_FINGERPRINT,
    read_authority,
)
import document_intelligence.lifecycle as lifecycle


class _UnreadableUpload:
    filename = "fixture.png"

    def __init__(self) -> None:
        self.read_count = 0

    async def read(self, _limit: int) -> bytes:
        self.read_count += 1
        raise AssertionError("unready worker must reject before consuming upload bytes")


def _fake_model_loading(runtime: WorkerRuntime, load_calls: list[list[str]]) -> None:
    def load_required(keys: list[str]) -> None:
        assert not runtime.health.ready
        load_calls.append(list(keys))
        for key in keys:
            entry = runtime.models.get(key)
            entry.instance = runtime.providers[entry.provider_ref]
            entry.loaded = True
            entry.ready = True

    runtime.models.load_required = load_required  # type: ignore[method-assign]


@pytest.mark.asyncio
async def test_cold_start_validates_authority_before_ready_then_freezes_material(tmp_path, monkeypatch):
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path)
    runtime = WorkerRuntime.create(settings)
    expected, _ = read_authority(settings.expected_provider_authority_path, settings.expected_provider_authority_sha256)
    load_calls: list[list[str]] = []
    _fake_model_loading(runtime, load_calls)
    monkeypatch.setattr(lifecycle, "normalize_observed_catalog", lambda _catalog: expected)

    try:
        assert runtime.health.healthz()["status"] == "ok"
        assert runtime.health.readyz()["status"] == "not_ready"
        await runtime.start()

        assert load_calls and set(settings.enabled_providers).issubset(set(load_calls[0]))
        assert runtime.health.ready
        evidence = runtime.health.healthz()
        assert evidence["profileId"] == "default"
        assert evidence["profileIdentityExplicit"] is False
        assert evidence["expectedProviderCatalogFingerprint"] == evidence["observedProviderCatalogFingerprint"]
        assert evidence["expectedProviderCatalogFingerprint"] == settings.expected_provider_authority_sha256
        assert evidence["expectedProviderCatalogFingerprint"] == FROZEN_INCREMENT3_PROVIDER_CATALOG_FINGERPRINT
        assert evidence["expectedProviderCatalogSemanticFingerprint"] == evidence["observedProviderCatalogSemanticFingerprint"]
        assert evidence["expectedProviderCatalogSemanticFingerprint"] == FROZEN_INCREMENT3_PROVIDER_CATALOG_SEMANTIC_FINGERPRINT
        assert evidence["expectedModelManifestFingerprint"] == evidence["observedModelManifestFingerprint"]
        assert runtime.health.readyz()["status"] == "ready"
        published_catalog = runtime.models.admitted_catalog(settings.enabled_providers)
        assert published_catalog
        published_catalog[0]["languages"].append("forged")
        assert "forged" not in runtime.models.accepted_capabilities(published_catalog[0]["providerRef"])["languages"]

        with pytest.raises(RuntimeError, match="immutable after startup readiness"):
            runtime.models.register("late", runtime.models.entries()[0])
        with pytest.raises(RuntimeError, match="immutable after startup readiness"):
            runtime.models.accept_authority_records(expected)
        with pytest.raises(RuntimeError, match="immutable after startup readiness"):
            runtime.models.entries()[0].instance = object()
        with pytest.raises(TypeError):
            runtime.models.get("ghatana.paddleocr").capabilities["lateCapability"] = True
        with pytest.raises(TypeError):
            runtime.models.get("ghatana.paddleocr").language_model_identities[0]["language"] = "hi"
        with pytest.raises(TypeError):
            runtime.providers["ghatana.docling"] = object()  # type: ignore[index]
        with pytest.raises(TypeError):
            runtime.lanes["ghatana.docling"] = object()  # type: ignore[index]
        with pytest.raises(TypeError):
            runtime.provider_executor._providers["ghatana.docling"] = object()  # type: ignore[index]
        with pytest.raises(RuntimeError, match="immutable after startup readiness"):
            runtime.providers = {}  # type: ignore[assignment]
        with pytest.raises(RuntimeError, match="immutable after startup readiness"):
            runtime.provider_executor._providers = {}
        with pytest.raises(RuntimeError, match="immutable after startup readiness"):
            runtime.models._entries = {}
        with pytest.raises(RuntimeError, match="immutable after startup readiness"):
            runtime.models._accepted = {}
        with pytest.raises(TypeError):
            runtime.models._entries["late"] = runtime.models.entries()[0]
        with pytest.raises(TypeError):
            runtime.models._accepted["late"] = {}
        with pytest.raises(TypeError):
            runtime.models._accepted["ghatana.paddleocr"]["languages"] = []
        with pytest.raises(AttributeError):
            runtime.models._accepted["ghatana.paddleocr"]["languages"].append("hi")
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_cold_start_catalog_mismatch_stays_live_but_blocks_provider_operations(tmp_path, monkeypatch):
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path)
    runtime = WorkerRuntime.create(settings)
    load_calls: list[list[str]] = []
    _fake_model_loading(runtime, load_calls)
    monkeypatch.setattr(lifecycle, "normalize_observed_catalog", lambda _catalog: [])
    app = create_app(settings, runtime)
    endpoints = {
        route.path: route.endpoint
        for route in app.routes
        if isinstance(getattr(route, "path", None), str)
    }

    try:
        await runtime.start()
        assert load_calls, "the internal loader must be able to initialize before readiness"
        assert runtime.health.healthz()["status"] == "ok"
        assert runtime.health.readyz()["status"] == "not_ready"
        evidence = runtime.health.healthz()
        assert evidence["expectedProviderCatalogFingerprint"] != evidence["observedProviderCatalogFingerprint"]
        assert evidence["observedProviderCatalogFingerprint"] is None
        assert evidence["expectedProviderCatalogSemanticFingerprint"] != evidence["observedProviderCatalogSemanticFingerprint"]

        providers = await endpoints["/v1/providers"]()
        assert providers.status_code == 503
        upload = _UnreadableUpload()
        parsed = await endpoints["/v1/parse"](
            metadata=json.dumps({
                "protocolVersion": "document-intelligence.v1",
                "operationId": "cold-start",
                "providerRef": "ghatana.paddleocr",
                "mediaType": "image/png",
                "languageHint": "ne",
                "timeoutMs": 1000,
                "limits": {},
            }),
            file=upload,
            operation_generation=None,
        )
        assert parsed.status_code == 503
        assert json.loads(parsed.body)["code"] == "PROVIDER_UNAVAILABLE"
        assert upload.read_count == 0
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_cold_start_model_manifest_mismatch_never_loads_providers(tmp_path):
    settings = WorkerSettings(
        temp_root=tmp_path,
        model_cache_root=tmp_path,
        expected_model_manifest_sha256="0" * 64,
    )
    runtime = WorkerRuntime.create(settings)
    runtime.models.load_required = lambda _keys: pytest.fail("manifest mismatch must be rejected before provider loading")  # type: ignore[method-assign]

    try:
        await runtime.start()
        evidence = runtime.health.healthz()
        assert runtime.health.reason_code == "MODEL_MANIFEST_MISMATCH"
        assert evidence["expectedModelManifestFingerprint"] != evidence["observedModelManifestFingerprint"]
        assert runtime.health.readyz()["status"] == "not_ready"
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_cold_start_provider_source_fingerprint_mismatch_never_loads_providers(tmp_path):
    settings = WorkerSettings(
        temp_root=tmp_path,
        model_cache_root=tmp_path,
        expected_provider_catalog_fingerprint="0" * 64,
    )
    runtime = WorkerRuntime.create(settings)
    runtime.models.load_required = lambda _keys: pytest.fail("provider authority mismatch must be rejected before provider loading")  # type: ignore[method-assign]

    try:
        await runtime.start()
        evidence = runtime.health.healthz()
        assert runtime.health.reason_code == "PROVIDER_AUTHORITY_MISMATCH"
        assert evidence["expectedProviderCatalogFingerprint"] == "0" * 64
        assert evidence["observedProviderCatalogFingerprint"] is None
        assert runtime.health.details["observedProviderCatalogFingerprint"] != "0" * 64
        assert runtime.health.readyz()["status"] == "not_ready"
    finally:
        await runtime.shutdown()


@pytest.mark.parametrize("profile_id", ["increment4a", "increment4a-candidate"])
def test_increment4a_profile_status_separates_development_and_activation(tmp_path, profile_id):
    runtime = WorkerRuntime.create(WorkerSettings(
        temp_root=tmp_path / profile_id,
        model_cache_root=tmp_path,
        selected_profile_id=profile_id,
        profile_identity_explicit=True,
    ))
    evidence = runtime.health.healthz()
    assert "campaignAdmissibility" not in evidence
    assert evidence["developmentState"] == ("DEVELOPMENT_COMPLETE" if profile_id == "increment4a" else "EXPERIMENTAL")
    assert evidence["releaseActivationState"] == "NOT_ACTIVATED"
    candidate = WorkerRuntime.create(WorkerSettings(temp_root=tmp_path, selected_profile_id="increment4a-candidate"))
    assert candidate.health.healthz()["developmentState"] == "EXPERIMENTAL"
    assert candidate.health.healthz()["releaseActivationState"] == "NOT_ACTIVATED"
