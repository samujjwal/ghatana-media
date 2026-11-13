"""Legacy Increment-3 authority records admit only the operations their
declared fields imply — never the whole operation surface.

The frozen Increment-3 baseline predates per-operation ``capabilityIds``.
Its accepted records declare provider/language/media capabilities only, so the
operation surface is inferred from the declared fields: media types admit
``parse``, value-type declarations admit ``extract``, and a dimension bound
admits ``embed``.  The composed Increment-4A authority always declares ids and
is enforced by capability prefix instead.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.capability_admission import CapabilityAdmission
from document_intelligence.runtime.model_registry import ModelRegistry
from document_intelligence.runtime.provider_authority import FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256, read_authority

ROOT = Path(__file__).resolve().parents[2]
FROZEN_INCREMENT3_AUTHORITY = ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"


def _frozen_increment3_admission() -> CapabilityAdmission:
    models = ModelRegistry()
    records, _ = read_authority(FROZEN_INCREMENT3_AUTHORITY, FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256)
    models.accept_authority_records(records)
    return CapabilityAdmission(models, True)


@pytest.mark.parametrize(
    ("provider_ref", "operation", "media_type", "language"),
    [
        ("ghatana.docling", "parse", "application/pdf", "en"),
        ("ghatana.docling", "parse", "application/pdf", "ne"),
        ("ghatana.paddleocr", "parse", "image/png", "en"),
        ("ghatana.paddleocr", "parse", "image/png", "ne"),
        ("ghatana.paddleocr", "parse", "image/jpeg", "en"),
        ("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "en"),
        ("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "ne"),
        ("ghatana.minilm", "embed", None, None),
    ],
)
def test_frozen_increment3_records_admit_their_declared_operation(provider_ref, operation, media_type, language) -> None:
    _frozen_increment3_admission().require(provider_ref, operation, media_type, language)


@pytest.mark.parametrize(
    ("provider_ref", "operation", "media_type", "language"),
    [
        # A parser record declares media types only — it never admits extract/embed.
        ("ghatana.docling", "extract", "application/pdf", "en"),
        ("ghatana.docling", "embed", "application/pdf", "en"),
        ("ghatana.paddleocr", "extract", "image/png", "en"),
        ("ghatana.paddleocr", "embed", "image/png", "en"),
        # An extractor record declares value types only — never parse/embed.
        ("ghatana.gliner", "parse", "image/png", "en"),
        ("ghatana.gliner", "embed", None, "en"),
        # An embedder record declares a dimension bound only — never parse/extract.
        ("ghatana.minilm", "parse", "application/pdf", None),
        ("ghatana.minilm", "extract", None, None),
    ],
)
def test_frozen_increment3_records_reject_undeclared_operations(provider_ref, operation, media_type, language) -> None:
    with pytest.raises(WorkerError, match="PROVIDER_UNAVAILABLE"):
        _frozen_increment3_admission().require(provider_ref, operation, media_type, language)


def test_capability_id_authority_still_enforces_operation_prefixes() -> None:
    """Increment-4A records always declare capability ids; the prefix gate is
    unchanged and a parser id never admits extraction."""
    models = ModelRegistry()
    models.accept_authority_records([{
        "providerRef": "ghatana.resilient-parser",
        "languages": ["en"],
        "mediaTypes": ["image/png"],
        "valueTypes": [],
        "capabilityIds": ["fallback.image.paddle-to-tesseract.en"],
        "features": [],
    }])
    admission = CapabilityAdmission(models, True)
    admission.require("ghatana.resilient-parser", "parse", "image/png", "en")
    with pytest.raises(WorkerError, match="PROVIDER_UNAVAILABLE"):
        admission.require("ghatana.resilient-parser", "extract", "image/png", "en")
    with pytest.raises(WorkerError, match="PROVIDER_UNAVAILABLE"):
        admission.require("ghatana.resilient-parser", "embed", "image/png", "en")


def test_deferred_capability_leaves_are_never_admitted() -> None:
    """A provider whose accepted record lacks the extraction id rejects the
    operation even when other dimensions were qualified."""
    models = ModelRegistry()
    models.accept_authority_records([{
        "providerRef": "ghatana.gliner",
        "languages": ["en", "ne"],
        "mediaTypes": [],
        "valueTypes": ["TEXT", "IDENTIFIER"],
        "capabilityIds": ["extraction.schema-guided.en", "extraction.schema-guided.ne"],
        "features": [],
    }])
    admission = CapabilityAdmission(models, True)
    admission.require("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "en")
    with pytest.raises(WorkerError, match="UNSUPPORTED_LANGUAGE"):
        admission.require("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "hi")
    with pytest.raises(WorkerError, match="UNSUPPORTED_LANGUAGE"):
        admission.require("ghatana.gliner", "extract", "application/vnd.ghatana.parsed-document+json", "mr")
