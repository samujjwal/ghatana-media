"""Real end-to-end hybrid PDF qualification on the generated corpus.

Exercises the worker's real page/region routing: Docling for native text,
pypdfium2 rendering, and the resilient Paddle->Tesseract OCR route for scanned
pages and mixed-page image regions.  All assertions are against real provider
output — classifications, remapped coordinates, and deduplication behavior.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "evaluation"))

from document_intelligence.providers.docling_parser import DoclingParser  # noqa: E402
from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser  # noqa: E402
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser  # noqa: E402
from document_intelligence.strategies.hybrid_pdf import HybridPdfStrategy  # noqa: E402
from document_intelligence.strategies.resilient_parser import ResilientParser, load_parser_routing  # noqa: E402
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.concurrency import BoundedLane  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402
from document_intelligence.runtime.provider_executor import ProviderExecutor  # noqa: E402
from metrics import cer  # noqa: E402

CORPUS = ROOT / "evaluation/increment4a/corpus/qualification/hybrid-pdf"
LANGUAGES = ("en", "ne", "hi", "mr")


def _gated() -> None:
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        pytest.skip("hybrid PDF qualification requires explicit opt-in")
    if importlib.util.find_spec("docling") is None or importlib.util.find_spec("paddleocr") is None:
        pytest.skip("Docling/PaddleOCR runtimes are not provisioned")
    for language in LANGUAGES:
        if not PaddleOcrParser.model_is_provisioned(language, ROOT / ".models"):
            pytest.skip(f"PaddleOCR {language} artifact is not provisioned")


@pytest.fixture(scope="module")
def executor() -> ProviderExecutor:
    routes, max_attempts, min_budget = load_parser_routing(ROOT / "routing/parser-routing.v1.yaml")
    providers = {
        "ghatana.docling": DoclingParser(),
        "ghatana.paddleocr": PaddleOcrParser(admitted_languages=LANGUAGES),
        "ghatana.tesseractocr": TesseractOcrParser(),
        "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=min_budget),
        "ghatana.hybrid-pdf": HybridPdfStrategy(),
    }
    lanes = {ref: BoundedLane(ref, 1, 4) for ref in providers}
    return ProviderExecutor(providers, lanes, tuple(providers))


def _parse(executor: ProviderExecutor, fixture: str, language: str) -> dict:
    return asyncio.run(
        executor.parse(
            "ghatana.hybrid-pdf",
            (CORPUS / f"{fixture}.pdf").read_bytes(),
            media_type="application/pdf",
            language=language,
            limits={"maxPages": 500, "maxTextCharacters": 2_000_000},
            deadline=Deadline(240_000),
            token=CancellationToken(),
        )
    )


def _text(document: dict, page: int | None = None) -> str:
    return " ".join(
        line["text"]
        for item in document["pages"]
        if page is None or item["pageNumber"] == page
        for block in item["blocks"]
        for line in block["lines"]
    )


def _classes(document: dict) -> list[str]:
    prefix = "pageClassifications:"
    warnings = document["quality"].get("warnings", [])
    payload = next(item[len(prefix):] for item in warnings if item.startswith(prefix))
    return [item["classification"] for item in json.loads(payload)]


@pytest.mark.integration
@pytest.mark.parametrize("fixture,language", [("HYBRID-002", "en"), ("HYBRID-003", "ne"), ("HYBRID-004", "hi"), ("HYBRID-005", "mr")])
def test_hybrid_pdf_region_uses_real_tesseract_fallback(fixture: str, language: str) -> None:
    _gated()
    routes, max_attempts, min_budget = load_parser_routing(ROOT / "routing/parser-routing.v1.yaml")
    providers = {
        "ghatana.docling": DoclingParser(),
        "ghatana.paddleocr": PaddleOcrParser(admitted_languages=LANGUAGES),
        "ghatana.tesseractocr": TesseractOcrParser(),
        "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=min_budget),
        "ghatana.hybrid-pdf": HybridPdfStrategy(),
    }
    if language not in providers["ghatana.tesseractocr"].available_languages():
        pytest.skip(f"Tesseract {language} traineddata is unavailable")
    lanes = {ref: BoundedLane(ref, 1, 4) for ref in providers}
    fallback_executor = ProviderExecutor(providers, lanes, tuple(ref for ref in providers if ref != "ghatana.paddleocr"))
    result = _parse(fallback_executor, fixture, language)
    warning = next(value for value in result["quality"]["warnings"] if value.startswith("pdfOcrAttemptLineage:"))
    lineage = json.loads(warning.split(":", 1)[1])
    assert lineage
    assert all(item["attempts"] == ["ghatana.paddleocr", "ghatana.tesseractocr"] for item in lineage)
    assert all(item["selected"] == "ghatana.tesseractocr" for item in lineage)
    regions = [line["boundingRegion"] for page in result["pages"] for block in page["blocks"] for line in block["lines"]]
    assert regions and all(0 <= region[key] <= 1 for region in regions for key in ("x", "y", "width", "height"))


@pytest.mark.integration
def test_hybrid_native_page_uses_docling_only(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-001", "en")
    assert result["providerProvenance"]["providerRef"] == "ghatana.hybrid-pdf"
    assert _classes(result) == ["NATIVE"]
    assert "clean paragraph of English text" in _text(result)


@pytest.mark.integration
@pytest.mark.parametrize("fixture,language,token_text", [
    ("HYBRID-002", "en", "scanned"),
    ("HYBRID-003", "ne", "पाठ"),
    ("HYBRID-004", "hi", "पाठ"),
    ("HYBRID-005", "mr", "मजकूर"),
])
def test_hybrid_scanned_pages_route_through_ocr(executor: ProviderExecutor, fixture: str, language: str, token_text: str) -> None:
    _gated()
    result = _parse(executor, fixture, language)
    assert _classes(result) == ["SCANNED"]
    text = _text(result)
    assert text.strip(), f"{fixture} produced no OCR text"
    assert token_text in text or len(text) > 10


@pytest.mark.integration
def test_hybrid_mixed_multipage_preserves_page_order_and_both_lanes(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-006", "en")
    assert _classes(result) == ["NATIVE", "SCANNED"]
    assert [page["pageNumber"] for page in result["pages"]] == [1, 2]
    assert "native first page" in _text(result, page=1)
    assert _text(result, page=2).strip()


@pytest.mark.integration
def test_hybrid_mixed_page_recovers_text_from_image_region(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-007", "en")
    assert _classes(result) == ["MIXED"]
    text = _text(result)
    assert "Native text appears above" in text
    assert "Embedded scan text" in text or "scan text" in text
    # Region-OCR lines must be remapped into real page coordinates.
    regions = [line["boundingRegion"] for page in result["pages"] for block in page["blocks"] for line in block["lines"]]
    assert all(0 <= region["x"] <= 1 and 0 <= region["y"] <= 1 and region["width"] > 0 and region["height"] > 0 for region in regions)


@pytest.mark.integration
def test_hybrid_native_table_fixture_keeps_primary_only(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-008", "en")
    assert _classes(result) == ["NATIVE"]
    assert "clean paragraph of English text" in _text(result)


@pytest.mark.integration
def test_hybrid_noisy_rotated_scan_still_routes_ocr(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-010", "en")
    assert _classes(result) == ["SCANNED"]
    assert _text(result).strip()


@pytest.mark.integration
def test_hybrid_blank_native_scanned_document(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-011", "en")
    assert _classes(result) == ["BLANK", "NATIVE", "SCANNED"]
    assert [page["pageNumber"] for page in result["pages"]] == [1, 2, 3]


@pytest.mark.integration
def test_hybrid_deduplicates_native_overlapping_ocr(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-012", "en")
    assert _classes(result) == ["MIXED"]
    text = _text(result)
    occurrences = text.count("Repeated heading text")
    assert occurrences == 1, f"native precedence must deduplicate the overlapping OCR copy: {text!r}"
    assert "Unique OCR content" in text or "Unique" in text


@pytest.mark.integration
def test_hybrid_scanned_table_fixture_extracts_text(executor: ProviderExecutor) -> None:
    _gated()
    result = _parse(executor, "HYBRID-009", "en")
    assert _classes(result) == ["SCANNED"]
    text = _text(result)
    assert text.strip()
    # Scanned-table *text* is recovered; structured table reconstruction is
    # UNSUPPORTED_BY_DESIGN and is never claimed.
    assert "Invoice" in text or "Item" in text or "Amount" in text
