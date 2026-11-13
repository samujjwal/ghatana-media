import json
import os
import sys
from pathlib import Path

import pytest

from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser

ROOT = Path(__file__).resolve().parents[2]
QUALIFICATION = ROOT / "evaluation" / "increment4a" / "corpus" / "qualification"
sys.path.insert(0, str(Path(__file__).parent))


def test_hi_mr_qualification_corpora_are_independent_and_grounded():
    hi_ocr = json.loads((QUALIFICATION / "ocr" / "hi" / "ground_truth.json").read_text())
    mr_ocr = json.loads((QUALIFICATION / "ocr" / "mr" / "ground_truth.json").read_text())
    hi_extract = json.loads((QUALIFICATION / "extraction" / "hi" / "fixtures.json").read_text())
    mr_extract = json.loads((QUALIFICATION / "extraction" / "mr" / "fixtures.json").read_text())
    assert len(hi_ocr) == len(mr_ocr) == 6
    assert all(entry["language"] == "hi" for entry in hi_ocr.values())
    assert all(entry["language"] == "mr" for entry in mr_ocr.values())
    assert hi_ocr["OCR-HI-CLEAN"]["expectedText"] != mr_ocr["OCR-MR-CLEAN"]["expectedText"]
    assert hi_extract["language"] == "hi" and mr_extract["language"] == "mr"
    assert hi_extract["cases"][0]["text"] != mr_extract["cases"][0]["text"]
    negatives = [case for case in hi_extract["cases"] + mr_extract["cases"] if not case["entities"]]
    assert len(negatives) >= 4
    for language in ("hi", "mr"):
        for entry in (QUALIFICATION / "ocr" / language).glob("*.png"):
            pass
        assert all((QUALIFICATION / "ocr" / language / entry["file"]).is_file() for entry in (hi_ocr if language == "hi" else mr_ocr).values())


@pytest.mark.integration
@pytest.mark.parametrize("language", ["hi", "mr"])
def test_real_paddle_language_lane_measures_cer(language):
    """Real Paddle measurement over the generated corpus — never a no-op."""
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_LANGUAGE_QUALIFICATION") != "1":
        pytest.skip("language-provider qualification requires explicit opt-in")
    if not PaddleOcrParser.model_is_provisioned(language, ROOT / ".models"):
        pytest.skip(f"PaddleOCR {language} artifact is not provisioned locally")
    from run_language_provider_qualification import measure_paddle

    report = measure_paddle()
    lane = report["languages"][language]
    assert lane["status"] == "MEASURED"
    assert lane["metrics"]["cer"] is not None and lane["metrics"]["cer"] <= 0.2
    assert lane["metrics"]["measuredFixtures"] == lane["metrics"]["fixtureCount"]


@pytest.mark.integration
def test_real_gliner_hi_mr_lane_records_metrics_without_promoting_failures():
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_LANGUAGE_QUALIFICATION") != "1":
        pytest.skip("language-provider qualification requires explicit opt-in")
    from run_language_provider_qualification import measure_gliner

    report = measure_gliner()
    assert set(report["languages"]) == {"hi", "mr"}
    for language in ("hi", "mr"):
        metrics = report["languages"][language]["metrics"]
        assert metrics["entityF1"] is not None and metrics["evidenceAccuracy"] is not None
        assert metrics["abstentionRate"] is not None and metrics["negativeMaxConfidence"] is not None
        assert report["languages"][language]["status"] == "MEASURED"
        assert report["languages"][language]["qualificationStatus"] == "NOT_FROZEN"
