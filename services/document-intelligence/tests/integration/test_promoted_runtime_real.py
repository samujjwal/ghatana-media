from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import pytest

from document_intelligence.config import WorkerSettings
from document_intelligence.errors import WorkerError
from document_intelligence.lifecycle import WorkerRuntime
from document_intelligence.runtime.provider_authority import FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256

ROOT = Path(__file__).resolve().parents[2]
INCREMENT3_AUTHORITY = ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"
INCREMENT4A_AUTHORITY = ROOT / "capabilities/increment4a.runtime-authority.json"
INCREMENT4A_PROFILE = ROOT / "profiles/increment4a.yaml"


def _settings(profile: Path | None) -> WorkerSettings:
    previous = os.environ.get("DOCUMENT_INTELLIGENCE_PROFILE_PATH")
    if profile is None:
        os.environ.pop("DOCUMENT_INTELLIGENCE_PROFILE_PATH", None)
    else:
        os.environ["DOCUMENT_INTELLIGENCE_PROFILE_PATH"] = str(profile)
    try:
        return WorkerSettings.from_env()
    finally:
        if previous is None:
            os.environ.pop("DOCUMENT_INTELLIGENCE_PROFILE_PATH", None)
        else:
            os.environ["DOCUMENT_INTELLIGENCE_PROFILE_PATH"] = previous


def _runtime(profile: Path | None) -> WorkerRuntime:
    return WorkerRuntime.create(_settings(profile))


def _require_real_providers() -> None:
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        pytest.skip("promoted runtime startup requires explicitly provisioned real providers")


def test_default_runtime_targets_frozen_increment3_authority() -> None:
    """No profile selects exactly the frozen Increment-3 provider authority."""
    settings = _settings(None)
    assert settings.profile is None
    assert settings.expected_provider_authority_path == INCREMENT3_AUTHORITY
    assert settings.expected_provider_authority_sha256 == FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256


def test_increment4a_profile_targets_cumulative_runtime_authority() -> None:
    """The increment4a profile loads the composed Increment-3 + Increment-4A authority."""
    settings = _settings(INCREMENT4A_PROFILE)
    assert settings.profile is not None and settings.profile.profile_id == "increment4a"
    assert settings.expected_provider_authority_path == INCREMENT4A_AUTHORITY
    assert settings.expected_provider_authority_sha256 == hashlib.sha256(INCREMENT4A_AUTHORITY.read_bytes()).hexdigest()


@pytest.mark.integration
def test_default_runtime_starts_under_frozen_increment3_authority_real() -> None:
    """The no-profile runtime remains bound to the Increment-3 surface only."""
    _require_real_providers()
    runtime = _runtime(None)
    asyncio.run(runtime.start())
    try:
        assert runtime.health.ready
        catalog = {item["providerRef"]: item for item in runtime.models.admitted_catalog(runtime.settings.enabled_providers)}
        assert set(catalog) == {"ghatana.docling", "ghatana.paddleocr", "ghatana.gliner", "ghatana.minilm"}
        assert catalog["ghatana.paddleocr"]["languages"] == ["en", "ne"]
        assert "ghatana.hybrid-pdf" not in catalog
        assert "ghatana.docling-docx" not in catalog
        with pytest.raises(WorkerError):
            runtime.capability_admission.require("ghatana.paddleocr", "parse", "image/png", "hi")
        with pytest.raises(WorkerError):
            runtime.capability_admission.require("ghatana.docling-docx", "parse", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "en")
    finally:
        asyncio.run(runtime.shutdown())


@pytest.mark.integration
def test_increment4a_profile_admits_cumulative_authority_real() -> None:
    """The increment4a profile starts on the cumulative authority and enforces
    admission itself — no test-side capability injection."""
    _require_real_providers()
    runtime = _runtime(INCREMENT4A_PROFILE)
    asyncio.run(runtime.start())
    try:
        assert runtime.health.ready
        catalog = {item["providerRef"]: item for item in runtime.models.admitted_catalog(runtime.settings.enabled_providers)}

        # Increment-3 baseline is preserved.
        assert catalog["ghatana.docling"]["languages"] == ["en", "ne"]
        assert catalog["ghatana.gliner"]["languages"] == ["en", "ne"]
        assert catalog["ghatana.minilm"]["promotionStatus"] == "ACCEPTED"

        # Increment-4A additions are admitted.
        assert catalog["ghatana.paddleocr"]["languages"] == ["en", "hi", "mr", "ne"]
        assert catalog["ghatana.paddleocr"]["languageModelIdentities"] == [
            {"language": "en", "modelRef": "PP-OCRv5-en", "modelVersion": "PP-OCRv5-local-en"},
            {"language": "hi", "modelRef": "PP-OCRv5-devanagari-shared", "modelVersion": "PP-OCRv5-local-devanagari-shared"},
            {"language": "mr", "modelRef": "PP-OCRv5-devanagari-shared", "modelVersion": "PP-OCRv5-local-devanagari-shared"},
            {"language": "ne", "modelRef": "PP-OCRv5-devanagari-shared", "modelVersion": "PP-OCRv5-local-devanagari-shared"},
        ]
        for provider_ref in ("ghatana.docling-docx", "ghatana.docling-pptx", "ghatana.docling-xlsx", "ghatana.hybrid-pdf", "ghatana.resilient-parser"):
            assert catalog[provider_ref]["promotionStatus"] == "ACCEPTED"
            assert catalog[provider_ref]["languages"] == ["en", "hi", "mr", "ne"]

        # The scanned-table structure leaf is unsupported by design and the
        # deferred GLiNER hi/mr extraction leaves are never admitted.
        assert "parser.pdf.hybrid.tables.scanned.en" not in catalog["ghatana.hybrid-pdf"]["capabilityIds"]
        assert not set(catalog["ghatana.gliner"]["capabilityIds"]) & {"extraction.schema-guided.hi", "extraction.schema-guided.mr"}
        # Tesseract is an internal fallback dependency: loaded and ready, but
        # never present in the public admitted catalog.
        assert "ghatana.tesseractocr" not in catalog
        assert "ghatana.tesseractocr" in runtime.internal_dependencies
        assert runtime.models.get("ghatana.tesseractocr").loaded
        assert runtime.models.ready("ghatana.tesseractocr")

        runtime.capability_admission.require("ghatana.paddleocr", "parse", "image/png", "hi")
        runtime.capability_admission.require("ghatana.paddleocr", "parse", "image/png", "mr")
        runtime.capability_admission.require("ghatana.hybrid-pdf", "parse", "application/pdf", "hi")
        runtime.capability_admission.require("ghatana.hybrid-pdf", "parse", "application/pdf", "mr")
        runtime.capability_admission.require("ghatana.docling-docx", "parse", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "hi")
        runtime.capability_admission.require("ghatana.docling-pptx", "parse", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "mr")
        runtime.capability_admission.require("ghatana.docling-xlsx", "parse", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "ne")
        runtime.capability_admission.require("ghatana.resilient-parser", "parse", "image/png", "mr")
        runtime.capability_admission.require("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "en")

        with pytest.raises(WorkerError, match="UNSUPPORTED_LANGUAGE"):
            runtime.capability_admission.require("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "hi")
        with pytest.raises(WorkerError, match="UNSUPPORTED_LANGUAGE"):
            runtime.capability_admission.require("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "mr")
        with pytest.raises(WorkerError, match="UNSUPPORTED_LANGUAGE"):
            runtime.capability_admission.require("ghatana.paddleocr", "parse", "image/png", "xx")
        with pytest.raises(WorkerError, match="PROVIDER_UNAVAILABLE"):
            runtime.capability_admission.require("ghatana.tesseractocr", "parse", "image/png", "en")
    finally:
        asyncio.run(runtime.shutdown())


@pytest.mark.integration
def test_increment4a_missing_fallback_dependency_is_not_ready(tmp_path, monkeypatch) -> None:
    """The admitted PNG/PDF fallback lane internally requires Tesseract.

    When the pinned Tesseract runtime tree is absent from the provisioned
    model cache, the worker must report NOT_READY — an internal dependency
    failure is never hidden by Tesseract's absence from the public catalog.
    """
    _require_real_providers()
    cache = tmp_path / "models"
    cache.mkdir()
    for entry in (ROOT / ".models").iterdir():
        if entry.name != "tesseract-runtime":
            (cache / entry.name).symlink_to(entry, target_is_directory=True)
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(cache))
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_TESSERACT_RUNTIME", str(tmp_path / "absent-tesseract"))
    runtime = _runtime(INCREMENT4A_PROFILE)
    asyncio.run(runtime.start())
    try:
        assert not runtime.health.ready
        assert runtime.health.readyz()["status"] == "not_ready"
        assert not runtime.models.ready("ghatana.tesseractocr")
    finally:
        asyncio.run(runtime.shutdown())
