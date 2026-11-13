#!/usr/bin/env python3
"""Measure the Increment-4A language-provider lanes using local artifacts only."""
from __future__ import annotations

import io
import json
import os
import sys
import time
from pathlib import Path

import psutil
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "evaluation"))

from document_intelligence.errors import WorkerError  # noqa: E402
from document_intelligence.providers.gliner_extractor import GlinerExtractor  # noqa: E402
from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser  # noqa: E402
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser  # noqa: E402
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402
from metrics import evidence_accuracy, precision_recall_f1, wer, cer  # noqa: E402


QUALIFICATION = ROOT / "evaluation" / "increment4a" / "corpus" / "qualification"
ABSTENTION_FLOOR = 0.5


def _rss_mb() -> float:
    return psutil.Process().memory_info().rss / (1024 * 1024)


def _parsed(text: str) -> dict:
    return {"pages": [{"pageNumber": 1, "blocks": [{"blockId": "p1-b1", "lines": [{
        "lineId": "p1-b1-l1", "text": text, "boundingRegion": {"x": 0, "y": 0, "width": 1, "height": 1}
    }]}], "tables": []}]}


def _utf16_span(text: str, start: int, end: int) -> tuple[int, int]:
    return (len(text[:start].encode("utf-16-le")) // 2, len(text[:end].encode("utf-16-le")) // 2)


def measure_gliner() -> dict:
    result = {"provider": "ghatana.gliner", "modelArtifact": "local", "languages": {}}
    provider = GlinerExtractor()
    for language in ("hi", "mr"):
        fixture = json.loads((QUALIFICATION / "extraction" / language / "fixtures.json").read_text())
        values = {"entityPrecision": [], "entityRecall": [], "entityF1": [], "evidenceAccuracy": [], "abstentionRate": [], "negativeMaxConfidence": []}
        diagnostics = []
        before = _rss_mb()
        started = time.perf_counter()
        for case in fixture["cases"]:
            output = provider.extract(_parsed(case["text"]), case["fields"], deadline=Deadline(120_000), token=CancellationToken(), language=language)
            candidates = output.get("candidates", [])
            actual = [(item["fieldId"], item["value"]["value"]) for item in candidates]
            confidences = [float(item.get("confidence", 0.0)) for item in candidates]
            if case["entities"]:
                expected = [(item["fieldId"], item["value"]) for item in case["entities"]]
                scores = precision_recall_f1(expected, actual)
                values["entityPrecision"].append(scores["precision"])
                values["entityRecall"].append(scores["recall"])
                values["entityF1"].append(scores["f1"])
                expected_evidence = [(item["lineId"], *_utf16_span(case["text"], item["start"], item["end"])) for item in case["entities"]]
                actual_evidence = []
                for candidate in candidates:
                    for evidence in candidate.get("evidence", []):
                        span = evidence.get("textSpan", {})
                        actual_evidence.append((evidence.get("lineId"), span.get("start"), span.get("end")))
                values["evidenceAccuracy"].append(evidence_accuracy(expected_evidence, actual_evidence))
            else:
                maximum = max(confidences, default=0.0)
                values["abstentionRate"].append(float(maximum < ABSTENTION_FLOOR))
                values["negativeMaxConfidence"].append(maximum)
            diagnostics.append({"caseId": case["caseId"], "candidates": actual, "confidences": confidences})
        metrics = {key: sum(items) / len(items) if items else None for key, items in values.items()}
        passed = all(metrics[key] is not None and metrics[key] >= threshold for key, threshold in {
            "entityF1": 0.50, "evidenceAccuracy": 0.50, "abstentionRate": 1.0
        }.items()) and metrics["negativeMaxConfidence"] is not None and metrics["negativeMaxConfidence"] <= ABSTENTION_FLOOR
        result["languages"][language] = {
            # HI/MR thresholds are measured against the existing GLiNER
            # reference thresholds, but are not frozen Increment-4A authority.
            "status": "MEASURED",
            "thresholdAssessment": "INCONCLUSIVE" if passed else "FAIL",
            "qualificationStatus": "NOT_FROZEN",
            "metrics": metrics,
            "thresholds": {"entityF1": 0.50, "evidenceAccuracy": 0.50, "abstentionRate": 1.0, "negativeMaxConfidence": ABSTENTION_FLOOR},
            "diagnostics": diagnostics,
            "latencyMs": (time.perf_counter() - started) * 1000,
            "rssDeltaMb": max(0.0, _rss_mb() - before),
            "remediation": {"indic_ner": "not-enabled; no local pinned artifact"},
        }
    return result


def _text(parsed: dict) -> str:
    return "\n".join(line["text"] for page in parsed.get("pages", []) for block in page.get("blocks", []) for line in block.get("lines", []))


def _regions(parsed: dict) -> list[dict]:
    return [line["boundingRegion"] for page in parsed.get("pages", []) for block in page.get("blocks", []) for line in block.get("lines", []) if isinstance(line.get("boundingRegion"), dict)]


def measure_paddle() -> dict:
    result = {"provider": "ghatana.paddleocr", "languages": {}}
    for language in ("en", "ne", "hi", "mr"):
        directory = QUALIFICATION / "ocr" / language
        truth = json.loads((directory / "ground_truth.json").read_text())
        if not PaddleOcrParser.model_is_provisioned(language, ROOT / ".models"):
            result["languages"][language] = {"status": "NOT_RUN", "reason": "local PP-OCRv5 language artifact is not provisioned", "modelPath": str(PaddleOcrParser.model_path(language, ROOT / ".models"))}
            continue
        provider = PaddleOcrParser(admitted_languages=(language,))
        before = _rss_mb(); started = time.perf_counter()
        fixtures: dict[str, dict] = {}
        for fixture_id, entry in sorted(truth.items()):
            image = directory / entry["file"]
            try:
                parsed = provider.parse(image.read_bytes(), media_type="image/png", language=language, deadline=Deadline(120_000), token=CancellationToken())
                actual = _text(parsed)
                geometry = _regions(parsed)
                fixtures[fixture_id] = {
                    "status": "MEASURED",
                    "cer": cer(entry["expectedText"], actual),
                    "wer": wer(entry["expectedText"], actual),
                    "geometry": bool(geometry) and all(region["width"] > 0 and region["height"] > 0 for region in geometry),
                    "expectedText": entry["expectedText"],
                    "actualText": actual,
                }
            except WorkerError as error:
                fixtures[fixture_id] = {"status": "NOT_RUN", "reason": error.code}
        measured = [item["cer"] for item in fixtures.values() if item.get("status") == "MEASURED"]
        result["languages"][language] = {
            "status": "MEASURED",
            "model": provider.identity(),
            "fixtures": fixtures,
            "metrics": {
                "cer": sum(measured) / len(measured) if measured else None,
                "fixtureCount": len(fixtures),
                "measuredFixtures": len(measured),
            },
        }
        result["languages"][language].update({"latencyMs": (time.perf_counter() - started) * 1000, "rssDeltaMb": max(0.0, _rss_mb() - before)})
    return result


def _tesseract_truth(language: str) -> list[tuple[Path, dict]]:
    directory = QUALIFICATION / "ocr" / language
    truth = json.loads((directory / "ground_truth.json").read_text())
    return [(directory / entry["file"], entry) for key, entry in sorted(truth.items()) if key.endswith(("-CLEAN", "-NUMBERS"))]


def measure_tesseract() -> dict:
    provider = TesseractOcrParser()
    available = provider.available_languages()
    result = {"provider": "ghatana.tesseractocr", "availableLanguages": list(available), "languages": {}, "resourceSemantics": {
        "maxOutputBytes": min(2_000_000 * 4, 16 * 1024 * 1024), "cancellation": "pre-start and post-native completion checks"
    }}
    missing = sorted(set(("en", "ne", "hi", "mr")) - set(available))
    for language in ("en", "ne", "hi", "mr"):
        if missing:
            result["languages"][language] = {"status": "NOT_RUN", "reason": "Tesseract executable/traineddata set incomplete", "missingLanguages": missing}
            continue
        before = _rss_mb(); started = time.perf_counter()
        fixtures: dict[str, dict] = {}
        for image, entry in _tesseract_truth(language):
            try:
                parsed = provider.parse(image.read_bytes(), media_type="image/png", language=language, limits={"maxTextCharacters": 2_000_000}, deadline=Deadline(120_000), token=CancellationToken())
                fixtures[image.stem] = {"status": "MEASURED", "cer": cer(entry["expectedText"], _text(parsed)), "wer": wer(entry["expectedText"], _text(parsed))}
            except WorkerError as error:
                fixtures[image.stem] = {"status": "NOT_RUN", "reason": error.code}
        measured = [item["cer"] for item in fixtures.values() if item.get("status") == "MEASURED"]
        result["languages"][language] = {"status": "MEASURED", "fixtures": fixtures, "metrics": {"cer": sum(measured) / len(measured) if measured else None}}
        result["languages"][language].update({"latencyMs": (time.perf_counter() - started) * 1000, "rssDeltaMb": max(0.0, _rss_mb() - before)})
    return result


def main() -> int:
    report = {"schemaVersion": "increment4a.language-provider-qualification.v1", "artifacts": {
        "offline": os.getenv("HF_HUB_OFFLINE") == "1" and os.getenv("TRANSFORMERS_OFFLINE") == "1",
        "modelCache": str(ROOT / ".models")
    }, "gliner": measure_gliner(), "paddle": measure_paddle(), "tesseract": measure_tesseract()}
    output = os.getenv("DOCUMENT_INTELLIGENCE_QUALIFICATION_OUTPUT")
    if output:
        Path(output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
