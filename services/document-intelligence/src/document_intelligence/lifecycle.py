from __future__ import annotations

import asyncio
import gc
import hashlib
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from .config import WorkerSettings
from .health import HealthState
from .operations import FileOutcomeStore, OperationRegistry
from .providers import (DoclingParser, DoclingPptxParser, DoclingXlsxParser, DocxParser,
                        GlinerExtractor, HybridPdfParser, MiniLmEmbedder,
                        OfficeRenderedParser, PaddleOcrParser, PptxParser,
                        ResilientParser, TesseractOcrParser, XlsxParser)
from .runtime.capability_admission import CapabilityAdmission
from .runtime.concurrency import BoundedLane
from .runtime.model_registry import ModelEntry, ModelRegistry
from .runtime.provider_authority import compare_provider_authority, fingerprint_records, normalize_observed_catalog, public_authority_diagnostics, read_authority
from .runtime.provider_executor import ProviderExecutor
from .runtime.temporary_files import TemporaryFileManager
from .strategies.resilient_parser import load_parser_routing


def _artifact_key(provider_ref: str, model_ref: str, model_version: str) -> str:
    return f"{provider_ref}__{model_ref}__{model_version}".replace("/", "_")


def runtime_dependency_closure(providers: Mapping[str, Any], roots: list[str]) -> list[str]:
    """Internal providers an admitted provider needs at runtime.

    Composite providers delegate through the executor — for example the
    qualified PaddleOCR→Tesseract image route invokes Tesseract even though
    Tesseract is deliberately absent from the public admitted catalog. The
    transitive closure of those declared dependencies must load before the
    worker reports ready.
    """
    closure: list[str] = []
    seen = set(roots)
    queue = list(roots)
    while queue:
        provider = providers.get(queue.pop(0))
        dependencies = getattr(provider, "runtime_dependencies", None)
        for dependency in dependencies() if callable(dependencies) else ():
            if dependency not in seen:
                seen.add(dependency)
                closure.append(dependency)
                queue.append(dependency)
    return closure


@dataclass
class WorkerRuntime:
    settings: WorkerSettings
    health: HealthState
    operations: OperationRegistry
    models: ModelRegistry
    temporary_files: TemporaryFileManager
    providers: Mapping[str, Any]
    lanes: Mapping[str, BoundedLane]
    provider_executor: ProviderExecutor
    capability_admission: CapabilityAdmission
    internal_dependencies: tuple[str, ...] = ()
    _material_locked: bool = False

    def __setattr__(self, name: str, value: Any) -> None:
        protected = {"settings", "models", "providers", "lanes", "provider_executor", "capability_admission", "internal_dependencies"}
        if getattr(self, "_material_locked", False) and name in protected:
            raise RuntimeError("runtime provider material is immutable after startup readiness")
        object.__setattr__(self, name, value)

    @classmethod
    def create(cls, settings: WorkerSettings) -> "WorkerRuntime":
        temporary_files = TemporaryFileManager(
            settings.temp_root,
            settings.limits.max_upload_bytes,
            settings.temp_retention_seconds,
        )
        temporary_files.scavenge()
        models = ModelRegistry()
        routing_path = settings.profile.routing_policy_path if settings.profile is not None else None
        routes, max_attempts, minimum_budget = load_parser_routing(routing_path)
        providers = {
            "ghatana.docling": DoclingParser(),
            "ghatana.paddleocr": PaddleOcrParser(admitted_languages=settings.request_languages),
            "ghatana.gliner": GlinerExtractor(),
            "ghatana.minilm": MiniLmEmbedder(),
            "ghatana.docling-docx": OfficeRenderedParser(),
            "ghatana.docling-pptx": DoclingPptxParser(),
            "ghatana.docling-xlsx": DoclingXlsxParser(),
            # The dependency-free OOXML readers remain registered under their
            # truthful identity for diagnostics; they are not routed and are
            # never promoted as Docling.
            "ghatana.ooxml-docx": DocxParser(),
            "ghatana.ooxml-pptx": PptxParser(),
            "ghatana.ooxml-xlsx": XlsxParser(),
            "ghatana.tesseractocr": TesseractOcrParser(),
            "ghatana.hybrid-pdf": HybridPdfParser(),
            "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=minimum_budget),
        }
        for provider_ref, provider in providers.items():
            model_ref = provider.identity().get("modelRef", provider_ref) if hasattr(provider, "identity") else provider_ref
            model_version = provider.identity().get("modelVersion", "0.1.0") if hasattr(provider, "identity") else "0.1.0"
            # Model-artifact requirements are declared by the provider, never
            # inferred from its identity.  Strategies and package/runtime-backed
            # providers (Docling Office, Tesseract) declare no cache artifact;
            # their readiness comes from warm() and the pinned runtime instead.
            if getattr(provider, "is_strategy", False):
                artifact_models: tuple[tuple[str, str], ...] = ()
            elif hasattr(provider, "artifact_models"):
                artifact_models = provider.artifact_models()
            else:
                artifact_models = ((model_ref, model_version),)
            # Providers may declare their artifact cache keys directly when the
            # provisioned tree name differs from the derived artifact key —
            # e.g. the pinned Tesseract runtime lives at `tesseract-runtime`.
            keys = provider.artifact_cache_keys() if hasattr(provider, "artifact_cache_keys") else tuple(
                _artifact_key(provider_ref, ref, version) for ref, version in artifact_models)
            language_model_identities = provider.language_model_identities() if hasattr(provider, "language_model_identities") else ()
            models.register(provider_ref, ModelEntry(provider_ref, "0.1.0", model_ref, model_version, lambda provider=provider: provider.warm() if hasattr(provider, "warm") else provider, provider.capabilities(), artifact_root=settings.model_cache_root, artifact_keys=keys, language_model_identities=language_model_identities))
        lanes = {provider_ref: BoundedLane(provider_ref, 1, settings.limits.max_queue) for provider_ref in providers}
        provider_executor = ProviderExecutor(providers, lanes, settings.enabled_providers)
        capability_admission = CapabilityAdmission(models, True)
        health = HealthState(authority_evidence={
            "profileId": settings.selected_profile_id,
            "profileIdentityExplicit": settings.profile_identity_explicit,
            "developmentState": (
                "DEVELOPMENT_COMPLETE" if settings.selected_profile_id == "increment4a"
                else "EXPERIMENTAL" if settings.selected_profile_id == "increment4a-candidate"
                else "BASELINE" if settings.selected_profile_id == "default"
                else "NON_CANONICAL_PROFILE"
            ),
            "releaseActivationState": (
                "NOT_ACTIVATED" if settings.selected_profile_id in {"increment4a", "increment4a-candidate"}
                else "CANONICAL_BASELINE" if settings.selected_profile_id == "default"
                else "NOT_ACTIVATED"
            ),
            "expectedProviderCatalogFingerprint": settings.expected_provider_catalog_fingerprint,
            "observedProviderCatalogFingerprint": None,
            "expectedProviderCatalogSemanticFingerprint": None,
            "observedProviderCatalogSemanticFingerprint": None,
            "expectedModelManifestFingerprint": settings.expected_model_manifest_sha256,
            "observedModelManifestFingerprint": None,
        })
        outcome_store = FileOutcomeStore(settings.temp_root / ".operation-outcomes")
        return cls(settings, health, OperationRegistry(outcome_store=outcome_store), models, temporary_files, providers, lanes, provider_executor, capability_admission)

    async def start(self) -> None:
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="document-intelligence-startup")
        try:
            future = pool.submit(self._start_sync)
            # Poll the one-shot concurrent future so fast cold starts and slow
            # model loads take the same path without occupying asyncio's
            # shared default executor.
            while not future.done():
                await asyncio.sleep(0.01)
            future.result()
        finally:
            pool.shutdown(wait=True)

    def _start_sync(self) -> None:
        evidence = self.health.authority_evidence
        assert evidence is not None
        try:
            manifest_fingerprint = hashlib.sha256(self.settings.model_manifest_path.read_bytes()).hexdigest()
        except OSError:
            self.health.ready = False
            self.health.reason = "model manifest is unavailable"
            self.health.reason_code = "MODEL_MANIFEST_UNAVAILABLE"
            self.health.details = None
            return
        evidence["observedModelManifestFingerprint"] = manifest_fingerprint
        if evidence["expectedModelManifestFingerprint"] is None:
            # Experimental profiles do not yet carry a separately frozen
            # manifest digest. Record their selected manifest identity, while
            # campaign admission separately requires profileId=default.
            evidence["expectedModelManifestFingerprint"] = manifest_fingerprint
        if self.settings.expected_model_manifest_sha256 is not None and manifest_fingerprint != self.settings.expected_model_manifest_sha256:
            self.health.ready = False
            self.health.reason = "runtime model manifest does not match frozen authority"
            self.health.reason_code = "MODEL_MANIFEST_MISMATCH"
            self.health.details = {
                "expectedModelManifestFingerprint": self.settings.expected_model_manifest_sha256,
                "observedModelManifestFingerprint": manifest_fingerprint,
            }
            return
        try:
            expected, source_fingerprint = read_authority(
                self.settings.expected_provider_authority_path,
                self.settings.expected_provider_authority_sha256,
            )
        except Exception:
            self.health.ready = False
            self.health.reason = "provider authority is unavailable"
            self.health.reason_code = "PROVIDER_AUTHORITY_UNAVAILABLE"
            self.health.details = None
            return
        expected_fingerprint_pin = self.settings.expected_provider_catalog_fingerprint
        if expected_fingerprint_pin is None:
            evidence["expectedProviderCatalogFingerprint"] = source_fingerprint
        if expected_fingerprint_pin is not None and source_fingerprint != expected_fingerprint_pin:
            self.health.ready = False
            self.health.reason = "provider catalog source does not match frozen authority"
            self.health.reason_code = "PROVIDER_AUTHORITY_MISMATCH"
            self.health.details = {
                "expectedProviderCatalogFingerprint": expected_fingerprint_pin,
                "observedProviderCatalogFingerprint": source_fingerprint,
            }
            return
        evidence["expectedProviderCatalogSemanticFingerprint"] = fingerprint_records(expected)
        try:
            # The no-profile runtime keeps routing only the frozen Increment-3
            # admitted provider material.  A worker profile may name its own
            # pinned authority — the increment4a profile loads the cumulative
            # Increment-3 + Increment-4A authority composed from the canonical
            # qualification run, excluding deferred or unqualified leaves.
            self.models.accept_authority_records(expected)
            registered = {entry.provider_ref for entry in self.models.entries()}
            enabled = set(self.settings.enabled_providers)
            admitted = [
                provider
                for provider in self.models.admitted_provider_refs(self.settings.enabled_providers)
                if provider in registered
            ]
            # Public admission is not the whole runtime contract: composite
            # providers delegate to internal providers through the executor
            # (e.g. the qualified PaddleOCR→Tesseract image fallback).  The
            # transitive dependency closure must load and be invocable before
            # ready, even though internal providers never enter the public
            # catalog.
            dependencies = runtime_dependency_closure(self.providers, admitted)
            self.internal_dependencies = tuple(provider for provider in dependencies if provider not in admitted)
            unavailable = sorted(provider for provider in dependencies if provider not in registered or provider not in enabled)
            required = admitted + [provider for provider in dependencies if provider in registered and provider not in admitted]
            self.models.load_required(required)
            observed = normalize_observed_catalog(self.models.admitted_catalog(self.settings.enabled_providers))
            diff = compare_provider_authority(expected, observed)
            evidence["observedProviderCatalogSemanticFingerprint"] = diff["observedFingerprint"]
            if diff["missing"] or diff["unexpected"] or diff["mismatched"]:
                self.health.ready = False
                self.health.reason = "runtime provider catalog does not match admitted authority"
                self.health.reason_code = "PROVIDER_AUTHORITY_MISMATCH"
                self.health.details = public_authority_diagnostics(diff)
                return
            # Provider catalog identity is the frozen source artifact digest.
            # The semantic live-catalog comparison above must pass before the
            # runtime binds its observation to that source identity.
            evidence["observedProviderCatalogFingerprint"] = source_fingerprint
            ready = not unavailable and all(self.models.ready(provider) for provider in required)
            if ready:
                # Publish readiness only after the exact registry material that
                # was validated above has been frozen and made immutable.
                self.models.freeze()
                self.providers = MappingProxyType(dict(self.providers))
                self.lanes = MappingProxyType(dict(self.lanes))
                self.provider_executor.freeze_material()
                self._material_locked = True
                self.health.reason = None
                self.health.reason_code = None
            elif unavailable:
                self.health.reason = "internal runtime provider dependencies are unavailable"
                self.health.reason_code = "PROVIDER_UNAVAILABLE"
            else:
                self.health.reason = "required local model assets are not initialized"
                self.health.reason_code = "MODEL_UNAVAILABLE"
            self.health.details = None
            self.health.ready = ready
        except Exception:
            self.health.ready = False
            self.health.reason = "required local model assets are not initialized"
            self.health.reason_code = "MODEL_UNAVAILABLE"
            self.health.details = None

    async def shutdown(self) -> None:
        self.health.shutting_down = True
        self.health.ready = False
        loop = asyncio.get_running_loop()
        started = loop.time()
        operations_drained = await self.operations.shutdown(self.settings.shutdown_timeout_seconds)
        remaining = max(0.0, self.settings.shutdown_timeout_seconds - (loop.time() - started))
        native_drained = await self.provider_executor.drain_native(remaining)
        if not operations_drained or not native_drained:
            self.health.reason = "shutdown drain timed out while provider work was still active"
            self.health.reason_code = "SHUTDOWN_DRAIN_TIMEOUT"
            self.health.details = {"activeNativeCalls": self.provider_executor.active_native_calls}
            # Keep providers, models, executor material, and temporary assets
            # alive. A later shutdown retry can release them after native work
            # actually completes.
            return
        self.health.reason = None
        self.health.reason_code = None
        self.health.details = None
        # Native OCR/ML runtimes may own thread pools outside asyncio. Drop
        # provider/model instances only after every native call has completed.
        for entry in self.models.entries():
            instance = entry.instance
            close = getattr(instance, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
            if hasattr(instance, "_models") and isinstance(getattr(instance, "_models"), dict):
                getattr(instance, "_models").clear()
        self.temporary_files.cleanup_all()
        self.provider_executor._release_after_shutdown()
        self.models._release_after_shutdown()
        object.__setattr__(self, "providers", MappingProxyType({}))
        object.__setattr__(self, "lanes", MappingProxyType({}))
        gc.collect()
        self.health.ready = False
