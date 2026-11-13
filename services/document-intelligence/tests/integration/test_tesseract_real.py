from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "evaluation"))

from document_intelligence.contracts import response, validate_provider_output  # noqa: E402
from document_intelligence.limits import Limits  # noqa: E402
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser  # noqa: E402
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402
from metrics import cer  # noqa: E402

CORPUS = ROOT / "evaluation" / "increment4a" / "corpus" / "qualification" / "ocr"


def _run(language: str) -> None:
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        pytest.skip("Tesseract qualification requires explicit opt-in")
    parser = TesseractOcrParser()
    if language not in parser.available_languages():
        pytest.skip(f"Tesseract {language} traineddata is not provisioned locally")
    truth = json.loads((CORPUS / language / "ground_truth.json").read_text())
    entry = truth[f"OCR-{language.upper()}-CLEAN"]
    result = parser.parse(
        (CORPUS / language / entry["file"]).read_bytes(), media_type="image/png", language=language,
        limits={"maxTextCharacters": 2_000_000}, deadline=Deadline(120_000),
        token=CancellationToken(),
    )
    validate_provider_output(response(f"tesseract-{language}-real", "ghatana.tesseractocr", result), Limits())
    assert result["providerProvenance"]["providerRef"] == "ghatana.tesseractocr"
    assert result["pages"][0]["languageTag"] == language
    actual = " ".join(line["text"] for page in result["pages"] for block in page["blocks"] for line in block["lines"])
    assert cer(entry["expectedText"], actual) <= 0.3
    assert all(
        0 <= line["boundingRegion"]["x"] <= 1
        for block in result["pages"][0]["blocks"]
        for line in block["lines"]
    )


@pytest.mark.integration
def test_tesseract_en_real() -> None:
    _run("en")


@pytest.mark.integration
def test_tesseract_ne_real() -> None:
    _run("ne")


@pytest.mark.integration
def test_tesseract_hi_real() -> None:
    _run("hi")


@pytest.mark.integration
def test_tesseract_mr_real() -> None:
    _run("mr")
