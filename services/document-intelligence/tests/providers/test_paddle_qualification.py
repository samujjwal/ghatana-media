from pathlib import Path

import pytest

from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser


@pytest.mark.parametrize(
    ("language", "model_ref", "model_version"),
    [
        ("en", "PP-OCRv5-en", "PP-OCRv5-local-en"),
        ("ne", "PP-OCRv5-devanagari-shared", "PP-OCRv5-local-devanagari-shared"),
        ("hi", "PP-OCRv5-devanagari-shared", "PP-OCRv5-local-devanagari-shared"),
        ("mr", "PP-OCRv5-devanagari-shared", "PP-OCRv5-local-devanagari-shared"),
    ],
)
def test_paddle_language_binding_resolves_to_the_shared_artifact(language, model_ref, model_version):
    """ne/hi/mr share one physical PP-OCRv5 Devanagari artifact, not per-language copies."""
    path = PaddleOcrParser.model_path(language, Path("/qualification-cache"))
    assert path == Path("/qualification-cache") / f"ghatana.paddleocr__{model_ref}__{model_version}"


def test_paddle_devanagari_languages_share_one_physical_artifact(tmp_path):
    assert PaddleOcrParser.model_path("ne", tmp_path) == PaddleOcrParser.model_path("hi", tmp_path) == PaddleOcrParser.model_path("mr", tmp_path)
    assert PaddleOcrParser.model_path("en", tmp_path) != PaddleOcrParser.model_path("hi", tmp_path)


def test_paddle_artifact_models_deduplicates_shared_binding():
    parser = PaddleOcrParser(admitted_languages=("en", "ne", "hi", "mr"))
    models = parser.artifact_models()
    assert models == (("PP-OCRv5-devanagari-shared", "PP-OCRv5-local-devanagari-shared"), ("PP-OCRv5-en", "PP-OCRv5-local-en"))


@pytest.mark.parametrize("language", ["en", "ne", "hi", "mr"])
def test_paddle_missing_artifact_is_not_treated_as_provisioned(tmp_path, language):
    assert not PaddleOcrParser.model_is_provisioned(language, tmp_path)


def _assert_real_lane_is_explicitly_gated(language: str) -> None:
    import os

    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_LANGUAGE_QUALIFICATION") != "1":
        pytest.skip("language-provider qualification requires explicit opt-in")
    root = Path(__file__).resolve().parents[2]
    if not PaddleOcrParser.model_is_provisioned(language, root / ".models"):
        pytest.skip(f"PaddleOCR {language} artifact is not provisioned locally")


def test_paddle_hi_real() -> None:
    _assert_real_lane_is_explicitly_gated("hi")


def test_paddle_mr_real() -> None:
    _assert_real_lane_is_explicitly_gated("mr")
