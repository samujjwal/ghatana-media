"""Resilient fallback authority: semantics and real per-language lanes.

The semantic tests exercise the real ProviderExecutor + ResilientParser route
machinery with controlled leaf providers — eligibility, deadline budgeting,
cancellation, cycle safety, and lineage are real executor behavior, not
re-implementations.  The gated per-language tests run the real
Paddle -> Tesseract chain on the generated corpus.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "evaluation"))

from document_intelligence.errors import WorkerError  # noqa: E402
from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser  # noqa: E402
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser  # noqa: E402
from document_intelligence.strategies.resilient_parser import ResilientParser, load_parser_routing  # noqa: E402
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.concurrency import BoundedLane  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402
from document_intelligence.runtime.provider_executor import ProviderExecutor  # noqa: E402
from metrics import cer  # noqa: E402

CORPUS = ROOT / "evaluation/increment4a/corpus/qualification/ocr"
LANGUAGES = ("en", "ne", "hi", "mr")


class _Leaf:
    """Controlled leaf provider producing a deterministic outcome."""

    def __init__(self, provider_ref: str, outcome: str | None, result: dict | None = None, delay_seconds: float = 0.0) -> None:
        self.provider_ref = provider_ref
        self.outcome = outcome
        self.delay_seconds = delay_seconds
        self.result = result or {"pages": [{"pageNumber": 1, "blocks": [{"blockId": "p1-b1", "kind": "TEXT", "boundingRegion": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.1}, "lines": [{"lineId": "p1-b1-l1", "text": "ok", "boundingRegion": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.1}}]}], "tables": []}], "providerProvenance": {"providerRef": provider_ref, "providerVersion": "0.1.0", "modelRef": "fake", "modelVersion": "fake"}, "quality": {}}
        self.calls = 0

    def identity(self) -> dict[str, str]:
        return {"providerRef": self.provider_ref, "providerVersion": "0.1.0", "modelRef": "fake", "modelVersion": "fake"}

    def parse(self, data: bytes, *, media_type: str | None, language: str | None, limits: dict, deadline: Deadline, token: CancellationToken) -> dict:
        self.calls += 1
        token.raise_if_cancelled()
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        if self.outcome is not None:
            retryable = self.outcome in {"PROVIDER_BUSY", "PROVIDER_UNAVAILABLE", "PROVIDER_FAILED", "TIMEOUT"}
            raise WorkerError(self.outcome, retryable=retryable, provider_ref=self.provider_ref)
        return dict(self.result, providerProvenance=self.identity())


def _executor(primary: _Leaf, secondary: _Leaf, *, minimum_budget: int = 1000, max_attempts: int = 3) -> ProviderExecutor:
    routes = {"image/png": (primary.provider_ref, secondary.provider_ref)}
    providers = {
        primary.provider_ref: primary,
        secondary.provider_ref: secondary,
        "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=minimum_budget),
    }
    lanes = {ref: BoundedLane(ref, 1, 4) for ref in providers}
    return ProviderExecutor(providers, lanes, tuple(providers))


def _parse(executor: ProviderExecutor, deadline: Deadline, token: CancellationToken | None = None) -> dict:
    return asyncio.run(
        executor.parse(
            "ghatana.resilient-parser",
            b"png",
            media_type="image/png",
            language="en",
            limits={},
            deadline=deadline,
            token=token or CancellationToken(),
        )
    )


def test_retryable_error_falls_back_to_next_provider() -> None:
    primary, secondary = _Leaf("p.primary", "PROVIDER_BUSY"), _Leaf("p.secondary", None)
    result = _parse(_executor(primary, secondary), Deadline(10_000))
    assert primary.calls == 1 and secondary.calls == 1
    assert result["providerProvenance"]["providerRef"] == "ghatana.resilient-parser"


def test_terminal_error_never_reaches_next_provider() -> None:
    primary, secondary = _Leaf("p.primary", "UNSUPPORTED_LANGUAGE"), _Leaf("p.secondary", None)
    with pytest.raises(WorkerError) as raised:
        _parse(_executor(primary, secondary), Deadline(10_000))
    assert raised.value.code == "UNSUPPORTED_LANGUAGE"
    assert secondary.calls == 0


def test_timeout_is_terminal_and_never_falls_back() -> None:
    """TIMEOUT consumes the request budget; the expired budget is never re-spent."""
    primary, secondary = _Leaf("p.primary", "TIMEOUT"), _Leaf("p.secondary", None)
    with pytest.raises(WorkerError) as raised:
        _parse(_executor(primary, secondary), Deadline(10_000))
    assert raised.value.code in {"TIMEOUT", "CANCELLED"}
    assert secondary.calls == 0


def test_remaining_budget_below_minimum_blocks_fallback() -> None:
    """Primary consumes budget, fails retryably; too little remains to try the next provider."""
    primary, secondary = _Leaf("p.primary", "PROVIDER_FAILED", delay_seconds=7), _Leaf("p.secondary", None)
    executor = _executor(primary, secondary, minimum_budget=4_000)
    with pytest.raises(WorkerError) as raised:
        _parse(executor, Deadline(10_000))
    assert secondary.calls == 0
    assert raised.value.code == "PROVIDER_FAILED"


def test_zero_budget_blocks_all_attempts() -> None:
    primary, secondary = _Leaf("p.primary", None), _Leaf("p.secondary", None)
    executor = _executor(primary, secondary, minimum_budget=60_000)
    with pytest.raises(WorkerError) as raised:
        _parse(executor, Deadline(5_000))
    assert primary.calls == 0 and secondary.calls == 0
    assert raised.value.code == "TIMEOUT"


def test_cancellation_propagates_without_fallback() -> None:
    primary, secondary = _Leaf("p.primary", "PROVIDER_BUSY"), _Leaf("p.secondary", None)
    token = CancellationToken()
    token.cancel()
    with pytest.raises(WorkerError) as raised:
        _parse(_executor(primary, secondary), Deadline(10_000), token=token)
    assert raised.value.code == "CANCELLED"
    assert secondary.calls == 0


def test_route_cycle_is_rejected() -> None:
    leaf = _Leaf("p.leaf", None)
    providers = {
        "p.leaf": leaf,
        "ghatana.resilient-parser": ResilientParser({"image/png": ("ghatana.resilient-parser", "p.leaf")}),
    }
    lanes = {ref: BoundedLane(ref, 1, 4) for ref in providers}
    executor = ProviderExecutor(providers, lanes, tuple(providers))
    with pytest.raises(WorkerError) as raised:
        _parse(executor, Deadline(10_000))
    assert raised.value.code == "INVALID_REQUEST"


def test_fallback_lineage_records_ordered_attempts() -> None:
    primary, secondary = _Leaf("p.primary", "PROVIDER_FAILED"), _Leaf("p.secondary", None)
    executor = _executor(primary, secondary)
    _parse(executor, Deadline(10_000))
    attempts = executor.last_trace.attempts
    assert [attempt.provider_ref for attempt in attempts] == ["p.primary", "p.secondary"]
    assert attempts[0].failure == "PROVIDER_FAILED"
    assert attempts[1].outcome == "success"


def test_resilient_routing_loads_worker_authority() -> None:
    routes, max_attempts, minimum_budget = load_parser_routing(ROOT / "routing/parser-routing.v1.yaml")
    assert routes["image/png"] == ("ghatana.paddleocr", "ghatana.tesseractocr")
    assert max_attempts >= 2 and minimum_budget >= 0


def _real_gated() -> None:
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        pytest.skip("real provider qualification requires explicit opt-in")
    if importlib.util.find_spec("paddleocr") is None:
        pytest.skip("PaddleOCR runtime is not provisioned")


@pytest.mark.integration
@pytest.mark.parametrize("language", LANGUAGES)
def test_real_fallback_lane_executes_tesseract_when_primary_unavailable(language: str) -> None:
    """Real fallback: Paddle is disabled, so the worker route must reach Tesseract."""
    _real_gated()
    tesseract = TesseractOcrParser()
    if language not in tesseract.available_languages():
        pytest.skip(f"Tesseract {language} traineddata is not provisioned")
    routes, max_attempts, minimum_budget = load_parser_routing(ROOT / "routing/parser-routing.v1.yaml")
    providers = {
        "ghatana.paddleocr": PaddleOcrParser(admitted_languages=(language,)),
        "ghatana.tesseractocr": tesseract,
        "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=minimum_budget),
    }
    lanes = {ref: BoundedLane(ref, 1, 4) for ref in providers}
    # Paddle is registered but not enabled — the real route must fall back.
    executor = ProviderExecutor(providers, lanes, ("ghatana.tesseractocr", "ghatana.resilient-parser"))
    truth = json.loads((CORPUS / language / "ground_truth.json").read_text())
    entry = truth[f"OCR-{language.upper()}-CLEAN"]
    image = (CORPUS / language / entry["file"]).read_bytes()
    result = asyncio.run(
        executor.parse("ghatana.resilient-parser", image, media_type="image/png", language=language, limits={}, deadline=Deadline(120_000), token=CancellationToken())
    )
    assert result["providerProvenance"]["providerRef"] == "ghatana.resilient-parser"
    attempts = [attempt.provider_ref for attempt in executor.last_trace.attempts]
    assert "ghatana.tesseractocr" in attempts
    actual = " ".join(line["text"] for page in result["pages"] for block in page["blocks"] for line in block["lines"])
    assert cer(entry["expectedText"], actual) <= 0.3


@pytest.mark.integration
@pytest.mark.parametrize("language", LANGUAGES)
def test_real_fallback_lane_uses_paddle_when_available(language: str) -> None:
    """The primary route is real too: enabled Paddle must serve before any fallback."""
    _real_gated()
    if not PaddleOcrParser.model_is_provisioned(language, ROOT / ".models"):
        pytest.skip(f"PaddleOCR {language} artifact is not provisioned")
    routes, max_attempts, minimum_budget = load_parser_routing(ROOT / "routing/parser-routing.v1.yaml")
    providers = {
        "ghatana.paddleocr": PaddleOcrParser(admitted_languages=(language,)),
        "ghatana.tesseractocr": TesseractOcrParser(),
        "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=minimum_budget),
    }
    lanes = {ref: BoundedLane(ref, 1, 4) for ref in providers}
    executor = ProviderExecutor(providers, lanes, tuple(providers))
    truth = json.loads((CORPUS / language / "ground_truth.json").read_text())
    entry = truth[f"OCR-{language.upper()}-CLEAN"]
    image = (CORPUS / language / entry["file"]).read_bytes()
    result = asyncio.run(
        executor.parse("ghatana.resilient-parser", image, media_type="image/png", language=language, limits={}, deadline=Deadline(120_000), token=CancellationToken())
    )
    attempts = [attempt.provider_ref for attempt in executor.last_trace.attempts]
    assert attempts == ["ghatana.paddleocr"]
    actual = " ".join(line["text"] for page in result["pages"] for block in page["blocks"] for line in block["lines"])
    assert cer(entry["expectedText"], actual) <= 0.2
