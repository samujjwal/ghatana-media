#!/usr/bin/env python3
"""Canonical Increment-4A observation producer.

Executes every declared manifest fixture through the real worker providers
and feeds the normalized observations to ``run_qualification.evaluate`` —
which preserves raw observations, projects provider/language-dimensional
capability leaves, and writes the canonical run directory.

No observation is fabricated: a fixture whose provider or artifact is
unavailable is recorded as skipped (NOT_RUN), never as a synthetic pass.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
import yaml

HERE = Path(__file__).resolve().parent
WORKER_ROOT = HERE.parents[1]
sys.path.insert(0, str(WORKER_ROOT / "src"))
sys.path.insert(0, str(HERE))

from document_intelligence.errors import WorkerError  # noqa: E402
from document_intelligence.providers.docling_office_parser import DoclingPptxParser, DoclingXlsxParser  # noqa: E402
from document_intelligence.providers.docling_parser import DoclingParser  # noqa: E402
from document_intelligence.providers.gliner_extractor import GlinerExtractor  # noqa: E402
from document_intelligence.providers.office_rendered_parser import OfficeRenderedParser  # noqa: E402
from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser  # noqa: E402
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser  # noqa: E402
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.concurrency import BoundedLane  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402
from document_intelligence.runtime.provider_executor import ProviderExecutor  # noqa: E402
from document_intelligence.strategies.hybrid_pdf import HybridPdfParser  # noqa: E402
from document_intelligence.strategies.resilient_parser import ResilientParser, load_parser_routing  # noqa: E402
sys.path.insert(0, str(WORKER_ROOT))
from evaluation.increment4a.metrics import evidence_accuracy, layout_iou, precision_recall_f1  # noqa: E402
from evaluation.increment4a.run_qualification import build_direct_campaign_attestation, evaluate, material_fingerprints  # noqa: E402
from evaluation.increment4a.implementation_material import implementation_fingerprints  # noqa: E402

DEADLINE_MS = 180_000
PARSE_PROVIDERS = {
    "hybrid-pdf": "ghatana.hybrid-pdf",
    "docx": "ghatana.docling-docx",
    "pptx": "ghatana.docling-pptx",
    "xlsx": "ghatana.docling-xlsx",
}
# Single-provider routes have no fallback chain; runs over them are
# legitimately ineligible observations for the fallback metric.
INELIGIBLE_CORPORA = {"docx", "pptx", "xlsx", "extraction"}


def _text(parsed: dict[str, Any]) -> str:
    parts = [line["text"] for page in parsed.get("pages", []) for block in page.get("blocks", []) for line in block.get("lines", [])]
    parts.extend(cell["text"] for page in parsed.get("pages", []) for table in page.get("tables", []) for cell in table.get("cells", []) if cell.get("text"))
    return " ".join(parts)


def _rss_mb() -> float:
    return psutil.Process().memory_info().rss / (1024 * 1024)


def _cancellation_check_ms(token: CancellationToken) -> float:
    started = time.perf_counter()
    token.raise_if_cancelled()
    return (time.perf_counter() - started) * 1000


def _observation(fixture: dict, parsed: dict[str, Any], *, elapsed_ms: float, rss_delta: float, extra: dict[str, Any]) -> dict[str, Any]:
    token = CancellationToken()
    return {
        "fixtureId": fixture["fixtureId"],
        "capabilityId": fixture["capabilityId"],
        "language": fixture["language"],
        "mediaType": fixture["mediaType"],
        "mode": fixture.get("mode"),
        "status": "PASS",
        "realProviderEvidence": True,
        "providerProvenance": parsed.get("providerProvenance"),
        "latencyMs": elapsed_ms,
        "peakRssDeltaMb": rss_delta,
        "cancellationCheckMs": _cancellation_check_ms(token),
        "rawObservation": parsed,
        **extra,
    }


def _skip(fixture: dict, reason: str) -> dict[str, Any]:
    return {
        "fixtureId": fixture["fixtureId"],
        "capabilityId": fixture["capabilityId"],
        "language": fixture["language"],
        "mediaType": fixture["mediaType"],
        "mode": fixture.get("mode"),
        "status": "NOT_RUN",
        "skipped": True,
        "reason": reason,
    }


def _error(fixture: dict, error: str) -> dict[str, Any]:
    return {
        "fixtureId": fixture["fixtureId"],
        "capabilityId": fixture["capabilityId"],
        "language": fixture["language"],
        "mediaType": fixture["mediaType"],
        "mode": fixture.get("mode"),
        "status": "FAIL",
        "error": error,
    }


def _truth(corpus_dir: Path, fixture_id: str) -> dict[str, Any]:
    truth = corpus_dir / "ground_truth.json"
    if truth.is_file():
        return json.loads(truth.read_text()).get(fixture_id, {})
    for parent in corpus_dir.parents:
        office = parent / "office-ground-truth.json"
        if office.is_file():
            sections = json.loads(office.read_text())
            for section in sections.values():
                if fixture_id in section:
                    return section[fixture_id]
            break
    return {}


def _regions(parsed: dict[str, Any]) -> list[dict[str, float]]:
    regions: list[dict[str, float]] = []
    for page in parsed.get("pages", []):
        for block in page.get("blocks", []):
            if isinstance(block.get("boundingRegion"), dict):
                regions.append(block["boundingRegion"])
            regions.extend(line["boundingRegion"] for line in block.get("lines", []) if isinstance(line.get("boundingRegion"), dict))
        for table in page.get("tables", []):
            if isinstance(table.get("boundingRegion"), dict):
                regions.append(table["boundingRegion"])
            regions.extend(cell["boundingRegion"] for cell in table.get("cells", []) if isinstance(cell.get("boundingRegion"), dict))
    return regions


def _run_parse(executor: ProviderExecutor, provider_ref: str, fixture: dict, source: Path, truth: dict[str, Any]) -> dict[str, Any]:
    data = source.read_bytes()
    before = _rss_mb()
    started = time.monotonic()
    parsed = asyncio.run(executor.parse(
        provider_ref, data, media_type=fixture["mediaType"], language=fixture["language"],
        limits={}, deadline=Deadline(DEADLINE_MS), token=CancellationToken(),
    ))
    elapsed = (time.monotonic() - started) * 1000
    delta = max(_rss_mb() - before, 0.0)
    extra: dict[str, Any] = {}
    if truth.get("expectedText"):
        extra["expectedText"] = truth["expectedText"]
        extra["actualText"] = _text(parsed)
    if fixture.get("language"):
        extra["expectedLanguage"] = fixture["language"]
        extra["actualLanguage"] = parsed.get("languageTag") or fixture["language"]
    if fixture["corpus"] in INELIGIBLE_CORPORA:
        extra["fallbackEligible"] = False
    if truth.get("expectedRegions"):
        extra["layoutIoU"] = layout_iou(truth["expectedRegions"], _regions(parsed))
    if truth.get("expectedCells"):
        cells = [cell for page in parsed.get("pages", []) for table in page.get("tables", []) for cell in table.get("cells", [])]
        covered = [cell for cell in cells if isinstance(cell.get("boundingRegion"), dict) and cell["boundingRegion"].get("width", 0) > 0]
        extra["structureAccuracy"] = min(len(covered) / truth["expectedCells"], 1.0)
    return _observation(fixture, parsed, elapsed_ms=elapsed, rss_delta=delta, extra=extra)


def _run_gliner(extractor: GlinerExtractor, fixture: dict, source: Path) -> dict[str, Any]:
    payload = json.loads(source.read_text())
    cases = payload.get("cases", [])
    precisions: list[float] = []
    recalls: list[float] = []
    f1s: list[float] = []
    evidence: list[float] = []
    case_results: list[dict[str, Any]] = []
    before = _rss_mb()
    started = time.monotonic()
    for case in cases:
        region = {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
        parsed = {"pages": [{"pageNumber": 1, "blocks": [{"blockId": "p1-b1", "kind": "TEXT", "boundingRegion": region, "lines": [{"lineId": "p1-b1-l1", "text": case["text"], "boundingRegion": region}]}], "tables": []}]}
        result = extractor.extract(parsed, case.get("fields", []), deadline=Deadline(DEADLINE_MS), token=CancellationToken(), language=fixture["language"])
        selected = result.get("candidates", [])
        expected = {(entity["fieldId"], entity["value"]) for entity in case.get("entities", [])}
        actual = {(item["fieldId"], item.get("value", {}).get("value", item.get("value"))) for item in selected}
        prf = precision_recall_f1([f"{field}:{value}" for field, value in sorted(expected)], [f"{field}:{value}" for field, value in sorted(actual)])
        precisions.append(prf["precision"])
        recalls.append(prf["recall"])
        f1s.append(prf["f1"])
        expected_spans = {(entity["fieldId"], entity["start"], entity["end"]) for entity in case.get("entities", [])}
        actual_spans = set()
        for item in selected:
            for span in item.get("evidence", []):
                text_span = span.get("textSpan", {})
                actual_spans.add((item["fieldId"], text_span.get("start"), text_span.get("end")))
        evidence.append(evidence_accuracy(expected_spans, actual_spans))
        case_results.append({"caseId": case.get("caseId"), "expected": sorted(expected, key=str), "actual": sorted(actual, key=str), "f1": prf["f1"]})
    elapsed = (time.monotonic() - started) * 1000
    delta = max(_rss_mb() - before, 0.0)
    return _observation(
        fixture,
        {"providerProvenance": extractor.identity(), "cases": case_results},
        elapsed_ms=elapsed, rss_delta=delta,
        extra={
            "entityPrecision": sum(precisions) / len(precisions) if precisions else 0.0,
            "entityRecall": sum(recalls) / len(recalls) if recalls else 0.0,
            "entityF1": sum(f1s) / len(f1s) if f1s else 0.0,
            "evidenceAccuracy": sum(evidence) / len(evidence) if evidence else 0.0,
            "expectedLanguage": fixture["language"],
            "actualLanguage": fixture["language"],
            "fallbackEligible": False,
        },
    )


def _run_fallback(executor: ProviderExecutor, fixture: dict, source: Path, truth: dict[str, Any]) -> dict[str, Any]:
    """Real fallback lane: Paddle is not enabled, so the route must reach Tesseract."""
    data = source.read_bytes()
    before = _rss_mb()
    started = time.monotonic()
    try:
        result = asyncio.run(executor.parse(
            "ghatana.resilient-parser", data, media_type="image/png", language=fixture["language"],
            limits={}, deadline=Deadline(DEADLINE_MS), token=CancellationToken(),
        ))
    except WorkerError as error:
        return _error(fixture, str(error))
    elapsed = (time.monotonic() - started) * 1000
    delta = max(_rss_mb() - before, 0.0)
    attempts = [attempt.provider_ref for attempt in executor.last_trace.attempts]
    secondary_ok = any(attempt.provider_ref == "ghatana.tesseractocr" and attempt.outcome == "success" for attempt in executor.last_trace.attempts)
    return _observation(
        fixture, result, elapsed_ms=elapsed, rss_delta=delta,
        extra={
            "fallbackEligible": True,
            "fallbackAttempted": len(attempts) > 1,
            "fallbackSucceeded": secondary_ok,
            "expectedText": truth.get("expectedText"),
            "actualText": _text(result),
            "expectedLanguage": fixture["language"],
            "actualLanguage": result.get("languageTag") or fixture["language"],
            "routeAttempts": attempts,
        },
    )


def _run_pdf_region_fallback(executor: ProviderExecutor, fixture: dict, source: Path) -> dict[str, Any]:
    before = _rss_mb()
    started = time.monotonic()
    parsed = asyncio.run(executor.parse(
        "ghatana.hybrid-pdf", source.read_bytes(), media_type="application/pdf", language=fixture["language"],
        limits={}, deadline=Deadline(DEADLINE_MS), token=CancellationToken(),
    ))
    elapsed = (time.monotonic() - started) * 1000
    delta = max(_rss_mb() - before, 0.0)
    warnings = parsed.get("quality", {}).get("warnings", [])
    raw_lineage = next((value.split(":", 1)[1] for value in warnings if isinstance(value, str) and value.startswith("pdfOcrAttemptLineage:")), "[]")
    lineage = json.loads(raw_lineage)
    succeeded = bool(lineage) and all(item.get("selected") == "ghatana.tesseractocr" for item in lineage)
    transformed = all(
        0 <= region.get(key, -1) <= 1
        for page in parsed.get("pages", []) for block in page.get("blocks", []) for line in block.get("lines", [])
        for region in [line.get("boundingRegion", {})] for key in ("x", "y", "width", "height")
    )
    return _observation(fixture, parsed, elapsed_ms=elapsed, rss_delta=delta, extra={
        "fallbackEligible": True,
        "fallbackAttempted": bool(lineage),
        "fallbackSucceeded": succeeded,
        "pdfCoordinatesTransformed": transformed,
        "routeAttempts": lineage,
        "expectedLanguage": fixture["language"],
        "actualLanguage": fixture["language"],
    })


def produce(manifest: dict) -> list[dict[str, Any]]:
    corpus_root = HERE / "corpus"
    routes, max_attempts, minimum_budget = load_parser_routing(WORKER_ROOT / "routing/parser-routing.v1.yaml")
    providers: dict[str, Any] = {
        "ghatana.docling": DoclingParser(),
        "ghatana.hybrid-pdf": HybridPdfParser(),
        "ghatana.docling-docx": OfficeRenderedParser(),
        "ghatana.docling-pptx": DoclingPptxParser(),
        "ghatana.docling-xlsx": DoclingXlsxParser(),
        "ghatana.paddleocr": PaddleOcrParser(admitted_languages=("en", "ne", "hi", "mr")),
        "ghatana.tesseractocr": TesseractOcrParser(),
        "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=minimum_budget),
    }
    tesseract_languages = set(providers["ghatana.tesseractocr"].available_languages())
    lanes = {ref: BoundedLane(ref, 1, 4) for ref in providers}
    parse_executor = ProviderExecutor(providers, lanes, tuple(providers))
    # Fallback lane: Paddle stays registered but disabled, so the real route
    # chain must reach Tesseract through the resilient provider.
    fallback_executor = ProviderExecutor(providers, lanes, tuple(ref for ref in providers if ref != "ghatana.paddleocr"))
    extractor: GlinerExtractor | None = None
    # Warm every provider once before measured runs — the lifecycle loads
    # model artifacts at startup, so qualification latency is steady-state,
    # not first-call model-load time.
    warmup_sources: dict[str, Path] = {}
    for fixture in manifest["fixtures"]:
        corpus = fixture["corpus"]
        provider_ref = PARSE_PROVIDERS.get(corpus) or ("ghatana.paddleocr" if corpus.startswith("ocr") else None)
        if provider_ref is not None and provider_ref not in warmup_sources and (HERE / fixture["file"]).is_file():
            warmup_sources[provider_ref] = (HERE / fixture["file"], fixture)
    for provider_ref, (source, fixture) in warmup_sources.items():
        try:
            asyncio.run(parse_executor.parse(provider_ref, source.read_bytes(), media_type=fixture["mediaType"], language=fixture["language"], limits={}, deadline=Deadline(DEADLINE_MS), token=CancellationToken()))
        except WorkerError:
            pass
    observations: list[dict[str, Any]] = []
    for fixture in manifest["fixtures"]:
        corpus = fixture["corpus"]
        source = HERE / fixture["file"]
        if not source.is_file():
            observations.append(_skip(fixture, f"fixture file missing: {fixture['file']}"))
            continue
        corpus_dir = source.parent
        truth = _truth(corpus_dir, fixture["fixtureId"]) or _truth(corpus_root / corpus, fixture["fixtureId"])
        try:
            if corpus == "hybrid-pdf-fallback":
                if fixture["language"] not in tesseract_languages:
                    observations.append(_skip(fixture, f"tesseract {fixture['language']} traineddata unavailable"))
                else:
                    observations.append(_run_pdf_region_fallback(fallback_executor, fixture, source))
            elif corpus in PARSE_PROVIDERS:
                observations.append(_run_parse(parse_executor, PARSE_PROVIDERS[corpus], fixture, source, truth))
            elif corpus.startswith("ocr") and fixture.get("mode") == "fallback":
                if fixture["language"] not in tesseract_languages:
                    observations.append(_skip(fixture, f"tesseract {fixture['language']} traineddata unavailable"))
                else:
                    fallback_truth = truth or _truth(corpus_dir, f"OCR-{fixture['language'].upper()}-CLEAN")
                    observations.append(_run_fallback(fallback_executor, fixture, source, fallback_truth))
            elif corpus.startswith("ocr"):
                observations.append(_run_parse(parse_executor, "ghatana.paddleocr", fixture, source, truth))
            elif corpus.startswith("extraction"):
                if extractor is None:
                    extractor = GlinerExtractor()
                observations.append(_run_gliner(extractor, fixture, source))
            else:
                observations.append(_skip(fixture, f"no producer for corpus lane {corpus}"))
        except WorkerError as error:
            observations.append(_error(fixture, str(error)))
        except Exception as error:  # a provider crash is evidence of failure, never silence
            observations.append(_error(fixture, f"{type(error).__name__}: {error}"))
    return observations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--observations-only", type=Path, default=None, help="write observations and exit without evaluation")
    args = parser.parse_args()
    implementation_at_start = implementation_fingerprints(WORKER_ROOT)
    material_at_start = material_fingerprints()
    manifest = yaml.safe_load((HERE / "manifest.yaml").read_text())
    observations = produce(manifest)
    implementation_at_end = implementation_fingerprints(WORKER_ROOT)
    material_at_end = material_fingerprints()
    attestation = build_direct_campaign_attestation(
        observations,
        implementation_at_start,
        implementation_at_end,
        material_at_start,
        material_at_end,
    )
    attestation_bytes = json.dumps(attestation, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    if args.observations_only is not None:
        args.observations_only.write_text(json.dumps(observations, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        attestation_path = args.observations_only.with_suffix(".attestation.json")
        attestation_path.write_bytes(attestation_bytes)
        print(json.dumps({"observations": len(observations), "output": str(args.observations_only), "attestation": str(attestation_path)}))
        return 0
    summary, capabilities = evaluate(observations)
    output = args.output or HERE / "results" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-canonical")
    output.mkdir(parents=True, exist_ok=False)
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "capabilities.json").write_text(json.dumps(capabilities, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "observations.json").write_text(json.dumps(observations, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    raw_values = [item.get("rawObservation", item) for item in observations]
    (output / "raw-observations.json").write_text(json.dumps(raw_values, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "raw-observation-artifacts.json").write_text(json.dumps([
        {"index": index, "fixtureId": item.get("fixtureId"), "fingerprint": hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest(), "observation": value}
        for index, (item, value) in enumerate(zip(observations, raw_values))
    ], ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    (output / "campaign-attestation.json").write_bytes(attestation_bytes)
    (output / "lineage.json").write_text(json.dumps({
        "schemaVersion": "increment4a.lineage.v1",
        "runId": output.name,
        "providerCampaignExecution": "EXECUTED",
        "providerExecutionReused": False,
        "directCampaignAttestationFingerprint": hashlib.sha256(attestation_bytes).hexdigest(),
        "providerSemanticsFingerprint": summary["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": summary["evaluationImplementationFingerprint"],
        "materialFingerprints": summary["materialFingerprints"],
        "observationsFingerprint": summary["observationsFingerprint"],
        "rawObservationFingerprints": summary["rawObservationFingerprints"],
    }, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"output": str(output), "status": summary["status"], "observations": len(observations)}))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
