"""Internal runtime dependencies join readiness without joining admission.

Composite providers delegate to other providers through the executor (the
qualified PaddleOCR→Tesseract image fallback, the hybrid PDF OCR route, the
rendered DOCX delegation).  Public admission intentionally omits those
internal providers, but readiness must still require them: a worker that
cannot warm a declared internal dependency must never report ready.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

from document_intelligence.config import WorkerSettings
from document_intelligence.health import HealthState
from document_intelligence.lifecycle import WorkerRuntime, runtime_dependency_closure
from document_intelligence.operations import OperationRegistry
from document_intelligence.runtime.capability_admission import CapabilityAdmission
from document_intelligence.runtime.model_registry import ModelEntry, ModelRegistry
from document_intelligence.runtime.provider_executor import ProviderExecutor
from document_intelligence.runtime.temporary_files import TemporaryFileManager


class _Strategy:
    """Admitted composite provider delegating to internal providers."""

    is_strategy = True
    provider_ref = "public.strategy"

    def __init__(self, dependencies: tuple[str, ...]) -> None:
        self._dependencies = dependencies

    def identity(self) -> dict[str, str]:
        return {"providerRef": self.provider_ref, "providerVersion": "0.1.0", "modelRef": "strategy-model", "modelVersion": "v1"}

    def capabilities(self) -> dict:
        return {"mediaTypes": ["image/png"]}

    def runtime_dependencies(self) -> tuple[str, ...]:
        return self._dependencies

    def warm(self) -> "_Strategy":
        return self


class _Leaf:
    """Internal provider whose warm-up can be made to fail."""

    provider_ref = "internal.dep"

    def __init__(self, available: bool = True, dependencies: tuple[str, ...] = ()) -> None:
        self._available = available
        self._dependencies = dependencies

    def identity(self) -> dict[str, str]:
        return {"providerRef": self.provider_ref, "providerVersion": "0.1.0", "modelRef": "dep-model", "modelVersion": "v1"}

    def capabilities(self) -> dict:
        return {}

    def runtime_dependencies(self) -> tuple[str, ...]:
        return self._dependencies

    def warm(self) -> "_Leaf":
        if not self._available:
            raise RuntimeError("internal provider is unavailable")
        return self


def _authority_artifact(provider_ref: str) -> dict:
    return {
        "accepted": [{
            "providerRef": provider_ref,
            "capabilities": {
                "mediaTypes": ["image/png"],
                "supportedLanguages": ["en"],
                "capabilityIds": ["parser.strategy.en"],
            },
        }],
        "declared": {
            "models": [{
                "providerRef": provider_ref,
                "providerVersion": "0.1.0",
                "modelRef": "strategy-model",
                "modelRevision": "v1",
                "language": "en",
            }],
        },
    }


def _runtime(tmp_path: Path, providers: dict, enabled: tuple[str, ...]) -> WorkerRuntime:
    models = ModelRegistry()
    for ref, provider in providers.items():
        models.register(ref, ModelEntry(ref, "0.1.0", provider.identity()["modelRef"], provider.identity()["modelVersion"], lambda provider=provider: provider.warm(), provider.capabilities()))
    artifact = _authority_artifact("public.strategy")
    authority_path = tmp_path / "authority.json"
    authority_path.write_text(json.dumps(artifact))
    authority_fingerprint = hashlib.sha256(authority_path.read_bytes()).hexdigest()
    settings = WorkerSettings(
        expected_provider_authority_path=authority_path,
        expected_provider_authority_sha256=authority_fingerprint,
        expected_provider_catalog_fingerprint=authority_fingerprint,
        temp_root=tmp_path,
        model_cache_root=tmp_path,
        enabled_providers=enabled,
    )
    health = HealthState(authority_evidence={
        "profileId": settings.selected_profile_id,
        "profileIdentityExplicit": settings.profile_identity_explicit,
        "developmentState": "BASELINE",
        "releaseActivationState": "CANONICAL_BASELINE",
        "expectedProviderCatalogFingerprint": authority_fingerprint,
        "observedProviderCatalogFingerprint": None,
        "expectedProviderCatalogSemanticFingerprint": None,
        "observedProviderCatalogSemanticFingerprint": None,
        "expectedModelManifestFingerprint": settings.expected_model_manifest_sha256,
        "observedModelManifestFingerprint": None,
    })
    return WorkerRuntime(
        settings,
        health,
        OperationRegistry(),
        models,
        TemporaryFileManager(tmp_path, 1024 ** 3, 60),
        providers,
        {},
        ProviderExecutor(providers, {}, enabled),
        CapabilityAdmission(models, True),
    )


def test_closure_collects_transitive_internal_dependencies() -> None:
    providers = {
        "public.strategy": _Strategy(("internal.b",)),
        "internal.b": _Leaf(dependencies=("internal.c",)),
        "internal.c": _Leaf(),
    }
    assert runtime_dependency_closure(providers, ["public.strategy"]) == ["internal.b", "internal.c"]


def test_closure_deduplicates_and_ignores_self_cycles() -> None:
    providers = {
        "a": _Strategy(("b",)),
        "b": _Leaf(dependencies=("a", "b")),
    }
    assert runtime_dependency_closure(providers, ["a"]) == ["b"]


def test_closure_reports_unregistered_route_targets() -> None:
    """A route target with no registered provider is still a dependency — the
    caller must turn it into a readiness failure, never skip it silently."""
    providers = {"public.strategy": _Strategy(("internal.missing",))}
    assert runtime_dependency_closure(providers, ["public.strategy"]) == ["internal.missing"]


def test_internal_dependency_loads_and_stays_out_of_the_catalog(tmp_path) -> None:
    providers = {"public.strategy": _Strategy(("internal.dep",)), "internal.dep": _Leaf()}
    runtime = _runtime(tmp_path, providers, ("public.strategy", "internal.dep"))
    asyncio.run(runtime.start())
    assert runtime.health.ready
    assert runtime.internal_dependencies == ("internal.dep",)
    assert runtime.models.ready("internal.dep")
    catalog = runtime.models.admitted_catalog(runtime.settings.enabled_providers)
    assert [item["providerRef"] for item in catalog] == ["public.strategy"]


def test_missing_internal_dependency_is_not_ready(tmp_path) -> None:
    providers = {"public.strategy": _Strategy(("internal.dep",)), "internal.dep": _Leaf(available=False)}
    runtime = _runtime(tmp_path, providers, ("public.strategy", "internal.dep"))
    asyncio.run(runtime.start())
    assert not runtime.health.ready
    assert runtime.health.reason_code == "MODEL_UNAVAILABLE"
    assert not runtime.models.ready("internal.dep")


def test_unregistered_internal_dependency_is_not_ready(tmp_path) -> None:
    providers = {"public.strategy": _Strategy(("internal.missing",))}
    runtime = _runtime(tmp_path, providers, ("public.strategy",))
    asyncio.run(runtime.start())
    assert not runtime.health.ready
    assert runtime.health.reason_code == "PROVIDER_UNAVAILABLE"


def test_disabled_internal_dependency_is_not_ready(tmp_path) -> None:
    """A dependency outside the enabled set cannot be invoked by the executor;
    readiness must not claim it."""
    providers = {"public.strategy": _Strategy(("internal.dep",)), "internal.dep": _Leaf()}
    runtime = _runtime(tmp_path, providers, ("public.strategy",))
    asyncio.run(runtime.start())
    assert not runtime.health.ready
    assert runtime.health.reason_code == "PROVIDER_UNAVAILABLE"
