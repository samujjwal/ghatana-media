from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import sys
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import yaml

# Ensure project source and sibling evaluation scripts are importable.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "evaluation"))

from generate_corpus import main as generate_corpus  # noqa: E402
from metrics import (  # noqa: E402
    cer,
    cosine,
    embedding_stability,
    entity_f1,
    evidence_accuracy,
    iou,
    layout_iou,
    layout_metrics,
    precision_recall_f1,
    recall_at_k,
    table_cell_metrics,
    table_structure_accuracy,
    wer,
)


def fingerprint(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_corpus_integrity(manifest_data: dict, corpus_dir: Path) -> list[str]:
    """Verify every fixture in ``evaluation/manifest.yaml`` is present and unmodified."""
    suffixes = {
        "application/pdf": ".pdf",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "application/octet-stream": ".bin",
    }
    failures: list[str] = []
    for fixture in manifest_data.get("fixtures", []):
        fixture_id = fixture.get("fixtureId")
        media_type = fixture.get("mediaType")
        if not fixture_id or media_type not in suffixes:
            failures.append(f"{fixture_id or '?' }: unknown media type {media_type}")
            continue
        path = corpus_dir / f"{fixture_id}{suffixes[media_type]}"
        if not path.exists():
            failures.append(f"{fixture_id}: missing fixture file")
            continue
        actual = _sha256_file(path)
        expected = fixture.get("sha256")
        if expected and actual != expected:
            failures.append(f"{fixture_id}: SHA-256 mismatch (expected {expected}, got {actual})")
    return failures


def _collect_layout_regions(parsed: dict) -> list[dict[str, float]]:
    # Expected regions in the frozen ground truth mark logical layout regions
    # (paragraphs, table extents), not physical text lines. Provider output is
    # therefore compared at block granularity — identical to the pre-split
    # measurement where each emitted line covered a whole item, and identical
    # for providers whose block and line boxes coincide (Paddle, Tesseract).
    regions: list[dict[str, float]] = []
    for page in parsed.get("pages", []):
        for block in page.get("blocks", []):
            box = block.get("boundingRegion")
            if isinstance(box, dict) and {"x", "y", "width", "height"}.issubset(box):
                regions.append({k: float(box[k]) for k in ("x", "y", "width", "height")})
        for table in page.get("tables", []):
            box = table.get("boundingRegion")
            if isinstance(box, dict) and {"x", "y", "width", "height"}.issubset(box):
                regions.append({k: float(box[k]) for k in ("x", "y", "width", "height")})
    return regions


def _extract_text(parsed: dict) -> str:
    lines: list[str] = []
    for page in parsed.get("pages", []):
        for block in page.get("blocks", []):
            for line in block.get("lines", []):
                if isinstance(line.get("text"), str):
                    lines.append(line["text"])
        for table in page.get("tables", []):
            rows: dict[int, list[dict]] = defaultdict(list)
            for cell in table.get("cells", []):
                if isinstance(cell.get("rowIndex"), int) and isinstance(cell.get("columnIndex"), int) and isinstance(cell.get("text"), str):
                    rows[cell["rowIndex"]].append(cell)
            lines.extend(" ".join(cell["text"] for cell in sorted(row, key=lambda value: value["columnIndex"])) for _, row in sorted(rows.items()))
    return "\n".join(lines)


def _extract_tables(parsed: dict) -> list[dict[str, int]]:
    tables: list[dict[str, int]] = []
    for page in parsed.get("pages", []):
        for table in page.get("tables", []):
            if isinstance(table.get("rowCount"), int) and isinstance(table.get("columnCount"), int):
                tables.append({"rows": table["rowCount"], "columns": table["columnCount"]})
    return tables


def _extract_table_cells(parsed: dict) -> list[dict]:
    cells: list[dict] = []
    for page in parsed.get("pages", []):
        for table in page.get("tables", []):
            for cell in table.get("cells", []):
                if isinstance(cell.get("rowIndex"), int) and isinstance(cell.get("columnIndex"), int) and isinstance(cell.get("text"), str):
                    cells.append({"rowIndex": cell["rowIndex"], "columnIndex": cell["columnIndex"], "text": cell["text"], "boundingRegion": cell.get("boundingRegion")})
    return cells


def _page_count(parsed: dict) -> int:
    return len(parsed.get("pages", []))


def _rss_bytes() -> int:
    try:
        import psutil

        return int(psutil.Process().memory_info().rss)
    except Exception:
        return 0


def _percentile(samples: list[float], fraction: float) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    rank = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return ordered[rank]


def _provider_identity(parsed: dict) -> dict[str, str] | None:
    identity = parsed.get("providerProvenance")
    if isinstance(identity, dict) and "providerRef" in identity:
        return {"providerRef": identity["providerRef"], "modelRef": identity.get("modelRef"), "modelVersion": identity.get("modelVersion")}
    return None


class ProviderRun:
    def __init__(self, settings, runtime) -> None:
        self.settings = settings
        self.runtime = runtime

    @staticmethod
    def _timed(operation) -> tuple[dict, float, float, float, float]:
        started = time.perf_counter()
        rss_before = _rss_bytes()
        peak_rss = rss_before
        stop = threading.Event()

        def sample() -> None:
            nonlocal peak_rss
            while not stop.wait(0.01):
                peak_rss = max(peak_rss, _rss_bytes())

        monitor = threading.Thread(target=sample, daemon=True)
        monitor.start()
        try:
            output = operation()
        finally:
            peak_rss = max(peak_rss, _rss_bytes())
            stop.set()
            monitor.join()
        rss_after = _rss_bytes()
        elapsed = (time.perf_counter() - started) * 1000
        scale = 1024 * 1024
        return output, elapsed, max(0.0, (rss_after - rss_before) / scale), peak_rss / scale, max(0.0, (peak_rss - rss_before) / scale)

    def parse_docling(self, path: Path, media_type: str) -> tuple[dict, float, float, float, float]:
        from document_intelligence.runtime.cancellation import CancellationToken
        from document_intelligence.runtime.deadline import Deadline

        provider = self.runtime.providers["ghatana.docling"]
        return self._timed(lambda: provider.parse(
            path.read_bytes(),
            media_type=media_type,
            limits={"maxPages": self.settings.limits.max_pages},
            deadline=Deadline(120_000),
            token=CancellationToken(),
        ))

    def parse_paddle(self, path: Path, media_type: str, language: str) -> tuple[dict, float, float, float, float]:
        from document_intelligence.runtime.cancellation import CancellationToken
        from document_intelligence.runtime.deadline import Deadline

        provider = self.runtime.providers["ghatana.paddleocr"]
        return self._timed(lambda: provider.parse(
            path.read_bytes(),
            media_type=media_type,
            language=language,
            deadline=Deadline(120_000),
            token=CancellationToken(),
        ))

    def extract_gliner(self, parsed: dict, fields: list[dict], language: str) -> tuple[dict, float, float, float, float]:
        from document_intelligence.runtime.cancellation import CancellationToken
        from document_intelligence.runtime.deadline import Deadline

        provider = self.runtime.providers["ghatana.gliner"]
        return self._timed(lambda: provider.extract(parsed, fields, deadline=Deadline(120_000), token=CancellationToken(), language=language))

    def embed_minilm(self, projection: dict) -> tuple[dict, float, float, float, float]:
        from document_intelligence.runtime.cancellation import CancellationToken
        from document_intelligence.runtime.deadline import Deadline

        provider = self.runtime.providers["ghatana.minilm"]
        return self._timed(lambda: provider.embed(projection, deadline=Deadline(120_000), token=CancellationToken()))

    def cancellation_check_ms(self, provider_ref: str, *, parsed: dict | None = None, image: bytes | None = None) -> float:
        """Measure cooperative cancellation detection latency for a provider call."""
        from document_intelligence.errors import WorkerError
        from document_intelligence.runtime.cancellation import CancellationToken
        from document_intelligence.runtime.deadline import Deadline

        provider = self.runtime.providers[provider_ref]
        token = CancellationToken()
        token.cancel()
        started = time.perf_counter()
        try:
            if provider_ref == "ghatana.docling":
                provider.parse(b"%PDF-1.4\ncancelled", media_type="application/pdf", limits={"maxPages": 1}, deadline=Deadline(120_000), token=token)
            elif provider_ref == "ghatana.paddleocr":
                provider.parse(image or b"", media_type="image/png", language="en", deadline=Deadline(120_000), token=token)
            elif provider_ref == "ghatana.gliner":
                provider.extract(parsed or {"pages": []}, [], deadline=Deadline(120_000), token=token)
            else:
                provider.embed({"version": "document-structure-embedding.v1", "pageCount": 1, "blockKindCounts": {"TEXT": 1}, "tableShapes": [], "normalizedBlockGeometry": [], "semanticTextBasis": "cancel", "structuralFingerprint": "cancel"}, deadline=Deadline(120_000), token=token)
        except WorkerError as exc:
            if exc.code != "CANCELLED":
                raise
        return (time.perf_counter() - started) * 1000


def run_real_provider_evaluation(manifest_data: dict, corpus_dir: Path, ground_truth: dict, acceptance_data: dict) -> tuple[dict[str, float], dict[str, list], dict[str, int]]:
    """Execute all provisioned local providers against the safe corpus.

    Returns measured scalar metrics, per-fixture diagnostic records, and hard-metric counters.
    """
    from document_intelligence.config import WorkerSettings
    from document_intelligence.lifecycle import WorkerRuntime

    suffixes = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg"}
    settings = WorkerSettings.from_env()
    runtime = WorkerRuntime.create(settings)

    diagnostics: dict[str, list] = defaultdict(list)
    hard_failures: dict[str, int] = {
        "contractAdmissionFailures": 0,
        "sensitiveDiagnosticLeaks": 0,
        "temporaryFileResidue": 0,
        "wrongProviderIdentities": 0,
        "invalidEmbeddingValues": 0,
        "undeclaredFallbacks": 0,
    }

    measurements: dict[str, list[float]] = defaultdict(list)
    latency_samples: dict[str, list[float]] = defaultdict(list)
    abstention_floor = float(acceptance_data.get("reporting", {}).get("gliner", {}).get("abstentionFloor", 0.5))
    abstention_cases: dict[str, list[dict]] = defaultdict(list)

    async def _start() -> None:
        await runtime.start()

    async def _shutdown() -> None:
        await runtime.shutdown()

    asyncio = __import__("asyncio")
    asyncio.run(_start())

    try:
        if not runtime.health.ready:
            raise RuntimeError(runtime.health.reason or "worker is not ready")

        runner = ProviderRun(settings, runtime)

        pdf_truth = ground_truth["pdf"]
        image_truth = ground_truth["image"]
        gliner_truth = ground_truth["gliner"]
        minilm_truth = ground_truth["minilm"]

        # OCR / layout / table evaluation.
        for fixture in manifest_data.get("fixtures", []):
            fixture_id = fixture.get("fixtureId")
            media_type = fixture.get("mediaType")
            language = fixture.get("language")
            document_class = fixture.get("documentClass", "")
            if media_type not in suffixes or fixture.get("documentClass") in {"malformed", "unsupported"}:
                continue
            path = corpus_dir / f"{fixture_id}{suffixes[media_type]}"
            if not path.exists():
                continue

            if media_type == "application/pdf":
                truth = pdf_truth.get(fixture_id, {})
                provider_ref = "ghatana.docling"
                key = f"docling.{language}"
                try:
                    parsed, elapsed, rss_delta, peak_rss, peak_rss_delta = runner.parse_docling(path, media_type)
                except Exception as exc:
                    hard_failures["contractAdmissionFailures"] += 1
                    diagnostics[key].append({"fixture": fixture_id, "error": type(exc).__name__})
                    continue
            else:
                truth = image_truth.get(fixture_id, {})
                provider_ref = "ghatana.paddleocr"
                key = f"paddle.{language}"
                try:
                    parsed, elapsed, rss_delta, peak_rss, peak_rss_delta = runner.parse_paddle(path, media_type, language)
                except Exception as exc:
                    hard_failures["contractAdmissionFailures"] += 1
                    diagnostics[key].append({"fixture": fixture_id, "error": type(exc).__name__})
                    continue

            identity = _provider_identity(parsed)
            expected_identity = _expected_identity(provider_ref, language, settings)
            if identity is None or identity != expected_identity:
                hard_failures["wrongProviderIdentities"] += 1
                diagnostics[key].append({"fixture": fixture_id, "identity": identity, "expected": expected_identity})

            expected_text = truth.get("expectedText")
            actual_text = _extract_text(parsed)
            if isinstance(expected_text, str) and document_class not in {"no-text", "no-text-image"}:
                measurements[f"{key}.cer"].append(cer(expected_text, actual_text))
                measurements[f"{key}.wer"].append(wer(expected_text, actual_text))
            elif document_class in {"no-text", "no-text-image"}:
                # No-text fixtures should produce empty text; CER/WER would be undefined, so record completeness.
                if actual_text.strip():
                    measurements[f"{key}.cer"].append(cer("", actual_text))
                    measurements[f"{key}.wer"].append(wer("", actual_text))

            expected_regions = truth.get("expectedRegions", [])
            actual_regions = _collect_layout_regions(parsed)
            measurements[f"{key}.layoutIoU"].append(layout_iou(expected_regions, actual_regions))
            for metric_name, value in layout_metrics(expected_regions, actual_regions).items():
                measurements[f"{key}.{metric_name}"].append(value)

            expected_tables = truth.get("expectedTables", [])
            actual_tables = _extract_tables(parsed)
            if expected_tables:
                measurements[f"{key}.tableStructureAccuracy"].append(table_structure_accuracy(expected_tables, actual_tables))
            expected_cells = truth.get("expectedCells", [])
            if expected_cells:
                for metric_name, value in table_cell_metrics(expected_cells, _extract_table_cells(parsed)).items():
                    measurements[f"{key}.{metric_name}"].append(value)

            page_count = _page_count(parsed)
            input_bytes = path.stat().st_size
            latency_samples[key].append(elapsed)
            measurements[f"{key}.p50LatencyMs"].append(elapsed)
            measurements[f"{key}.latencyPerPageMs"].append(elapsed / max(page_count, 1))
            measurements[f"{key}.pageCount"].append(float(page_count))
            measurements[f"{key}.inputBytes"].append(float(input_bytes))
            measurements[f"{key}.rssDeltaMb"].append(rss_delta)
            measurements[f"{key}.peakRssMb"].append(peak_rss)
            measurements[f"{key}.peakRssDeltaMb"].append(peak_rss_delta)
            diagnostics[key].append({"fixture": fixture_id, "text": actual_text[:200], "regions": len(actual_regions), "inputBytes": input_bytes, "pageCount": page_count, "elapsedMs": round(elapsed, 3)})

        # GLiNER entity extraction evaluation on the simple PDFs for each language.
        for fixture_id, gliner_fixture in gliner_truth.items():
            language = "en" if "-en-" in fixture_id else "ne"
            pdf_path = corpus_dir / f"{fixture_id}.pdf"
            if not pdf_path.exists():
                continue
            key = f"gliner.{language}"
            try:
                parsed, _, _, _, _ = runner.parse_docling(pdf_path, "application/pdf")
                fields = gliner_fixture.get("fields", [])
                extracted, elapsed, rss_delta, peak_rss, peak_rss_delta = runner.extract_gliner(parsed, fields, language)
                measurements[f"{key}.rssDeltaMb"].append(rss_delta)
                measurements[f"{key}.peakRssMb"].append(peak_rss)
                measurements[f"{key}.peakRssDeltaMb"].append(peak_rss_delta)
                latency_samples[key].append(elapsed)
            except Exception as exc:
                hard_failures["contractAdmissionFailures"] += 1
                diagnostics[key].append({"fixture": fixture_id, "error": type(exc).__name__})
                continue

            expected_entities = [(e["fieldId"], e["value"]) for e in gliner_fixture.get("entities", [])]
            actual_entities = [(c["fieldId"], c["value"]["value"]) for c in extracted.get("candidates", []) if c.get("value", {}).get("value")]
            emitted_confidences = [float(c.get("confidence", 0.0)) for c in extracted.get("candidates", [])]

            if not expected_entities:
                # Negative/abstention fixture: correct behavior is no admissible
                # candidate at or above the frozen reporting floor.
                abstained = all(confidence < abstention_floor for confidence in emitted_confidences)
                abstention_cases[key].append({
                    "fixture": fixture_id,
                    "emitted": len(emitted_confidences),
                    "maxConfidence": max(emitted_confidences, default=0.0),
                    "abstained": abstained,
                })
                measurements[f"{key}.abstentionRate"].append(1.0 if abstained else 0.0)
                measurements[f"{key}.negativeMaxConfidence"].append(max(emitted_confidences, default=0.0))
                diagnostics[key].append({"fixture": fixture_id, "abstentionCase": True, "emittedConfidences": emitted_confidences})
                continue

            prf = precision_recall_f1(expected_entities, actual_entities)
            measurements[f"{key}.entityPrecision"].append(prf["precision"])
            measurements[f"{key}.entityRecall"].append(prf["recall"])
            measurements[f"{key}.entityF1"].append(entity_f1(expected_entities, actual_entities))
            measurements[f"{key}.exactMatch"].append(1.0 if sorted(map(str, expected_entities)) == sorted(map(str, actual_entities)) else 0.0)

            def _evidence_tuple(entity: dict) -> tuple:
                return (entity.get("lineId"), entity.get("start"), entity.get("end"))

            expected_evidence = [_evidence_tuple(e) for e in gliner_fixture.get("entities", [])]
            actual_evidence: list[tuple] = []
            for candidate in extracted.get("candidates", []):
                for ev in candidate.get("evidence", []):
                    span = ev.get("textSpan") or {}
                    actual_evidence.append((ev.get("lineId"), span.get("start"), span.get("end")))
            measurements[f"{key}.evidenceAccuracy"].append(evidence_accuracy(expected_evidence, actual_evidence))
            diagnostics[key].append({
                "fixture": fixture_id,
                "candidates": len(extracted.get("candidates", [])),
                "expectedEntities": expected_entities,
                "actualEntities": actual_entities,
            })

        # MiniLM embedding retrieval evaluation.
        try:
            phrases = minilm_truth.get("phrases", [])
            vectors: list[list[float]] = []
            for phrase in phrases:
                projection = {
                    "version": "document-structure-embedding.v1",
                    "pageCount": 1,
                    "blockKindCounts": {"TEXT": 1},
                    "tableShapes": [],
                    "normalizedBlockGeometry": [{"pageNumber": 1, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.1}],
                    "semanticTextBasis": phrase,
                    "structuralFingerprint": f"eval-{phrase}",
                }
                embedding, elapsed, rss_delta, peak_rss, peak_rss_delta = runner.embed_minilm(projection)
                measurements["minilm.und.rssDeltaMb"].append(rss_delta)
                measurements["minilm.und.peakRssMb"].append(peak_rss)
                measurements["minilm.und.peakRssDeltaMb"].append(peak_rss_delta)
                latency_samples["minilm.und"].append(elapsed)
                vector = embedding.get("values", [])
                if len(vector) != 384 or any(not isinstance(v, (int, float)) or not __import__("math").isfinite(v) for v in vector):
                    hard_failures["invalidEmbeddingValues"] += 1
                else:
                    vectors.append([float(v) for v in vector])

            if len(vectors) == len(phrases):
                sims = {}
                for i, a in enumerate(phrases):
                    for j, b in enumerate(phrases):
                        if i >= j:
                            continue
                        sims[tuple(sorted((a, b)))] = cosine(vectors[i], vectors[j])
                same_pairs = [tuple(sorted(pair)) for pair in minilm_truth.get("same", []) if len(pair) == 2]
                diff_pairs = [tuple(sorted(pair)) for pair in minilm_truth.get("different", []) if len(pair) == 2]
                same_sims = [sims[pair] for pair in same_pairs if pair in sims]
                diff_sims = [sims[pair] for pair in diff_pairs if pair in sims]
                same_sim = same_sims[0] if same_sims else None
                diff_sim = diff_sims[0] if diff_sims else None
                if same_sims:
                    measurements["minilm.und.sameTemplateCosineMean"].append(sum(same_sims) / len(same_sims))
                    measurements["minilm.und.sameTemplateCosineMin"].append(min(same_sims))
                if diff_sims:
                    measurements["minilm.und.differentTemplateCosineMean"].append(sum(diff_sims) / len(diff_sims))
                    measurements["minilm.und.differentTemplateCosineMax"].append(max(diff_sims))

                # k=1 / k=5 retrieval: query template-a, expected template-a-variant.
                query = minilm_truth.get("retrieval", {}).get("queries", ["template-a"])[0]
                expected = minilm_truth.get("retrieval", {}).get("expected", [[]])[0]
                query_index = phrases.index(query)
                query_vector = vectors[query_index]
                # Rank candidate phrases excluding the query itself.
                candidates = [p for i, p in enumerate(phrases) if i != query_index]
                ranked = sorted(candidates, key=lambda p: -cosine(query_vector, vectors[phrases.index(p)]))
                rankings = [ranked]
                measurements["minilm.und.recallAt1"].append(recall_at_k(rankings, expected, 1))
                measurements["minilm.und.recallAt5"].append(recall_at_k(rankings, expected, 5))

                # Stability is measured by embedding the same query phrase multiple times.
                repeated_vectors: list[list[float]] = []
                for _ in range(3):
                    projection = {
                        "version": "document-structure-embedding.v1",
                        "pageCount": 1,
                        "blockKindCounts": {"TEXT": 1},
                        "tableShapes": [],
                        "normalizedBlockGeometry": [{"pageNumber": 1, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.1}],
                        "semanticTextBasis": query,
                        "structuralFingerprint": "eval-stability",
                    }
                    emb, _, _, _, _ = runner.embed_minilm(projection)
                    vec = emb.get("values", [])
                    if len(vec) == 384 and all(isinstance(v, (int, float)) and __import__("math").isfinite(v) for v in vec):
                        repeated_vectors.append([float(v) for v in vec])
                    else:
                        hard_failures["invalidEmbeddingValues"] += 1
                if repeated_vectors:
                    measurements["minilm.und.stability"].append(embedding_stability(repeated_vectors))

                diagnostics["minilm.und"].append({
                    "phrasesEmbedded": len(vectors),
                    "repeatedEmbeddings": len(repeated_vectors),
                    "samePairSimilarity": same_sim,
                    "differentPairSimilarity": diff_sim,
                })

                # Diagnostic/informational similarity values (not thresholded).
                if same_sim is not None:
                    measurements["minilm.und.samePairSimilarity"].append(same_sim)
                if diff_sim is not None:
                    measurements["minilm.und.differentPairSimilarity"].append(diff_sim)
                if same_sim is not None and diff_sim is not None:
                    measurements["minilm.und.retrievalAccuracy"].append(1.0 if same_sim > diff_sim else 0.0)
        except Exception as exc:
            diagnostics["minilm.und"].append({"error": type(exc).__name__})
            hard_failures["invalidEmbeddingValues"] += 1

        # Per-provider cooperative cancellation detection latency.
        cancel_image = next(iter(sorted(corpus_dir.glob("image-en-clean.*"))), None)
        for provider_ref, metric_key in (
            ("ghatana.docling", "docling.en"),
            ("ghatana.paddleocr", "paddle.en"),
            ("ghatana.gliner", "gliner.en"),
            ("ghatana.minilm", "minilm.und"),
        ):
            try:
                check_ms = runner.cancellation_check_ms(provider_ref, image=cancel_image.read_bytes() if cancel_image else None)
                measurements[f"{metric_key}.cancellationCheckMs"].append(check_ms)
            except Exception as exc:
                diagnostics["worker"].append({"provider": provider_ref, "cancellationCheckError": type(exc).__name__})

        # Hard checks: temporary file residue after a normal shutdown cycle.
        if settings.temp_root.exists():
            leftovers = [p for p in settings.temp_root.rglob("*") if p.is_file()]
            if leftovers:
                hard_failures["temporaryFileResidue"] = len(leftovers)
                measurements["worker.tempResidueBytes"].append(float(sum(p.stat().st_size for p in leftovers)))

        metrics: dict[str, float] = {}
        for key, values in measurements.items():
            if values:
                metrics[key] = sum(values) / len(values)
        for key, samples in latency_samples.items():
            metrics[f"{key}.p50LatencyMs"] = _percentile(samples, 0.50)
            metrics[f"{key}.p95LatencyMs"] = _percentile(samples, 0.95)
        diagnostics["abstention"] = dict(abstention_cases)
        return metrics, dict(diagnostics), hard_failures
    finally:
        asyncio.run(_shutdown())


def _expected_identity(provider_ref: str, language: str | None, settings) -> dict[str, str | None]:
    if provider_ref == "ghatana.docling":
        return {"providerRef": "ghatana.docling", "modelRef": "docling-standard-pdf-pipeline", "modelVersion": "pinned-docling-runtime"}
    if provider_ref == "ghatana.paddleocr":
        if language == "ne":
            model = "PP-OCRv5-devanagari-shared"
            version = "PP-OCRv5-local-devanagari-shared"
        else:
            model = f"PP-OCRv5-{language}"
            version = f"PP-OCRv5-local-{language}"
        return {"providerRef": "ghatana.paddleocr", "modelRef": model, "modelVersion": version}
    return {"providerRef": provider_ref, "modelRef": None, "modelVersion": None}


def _scan_source_for_hard_failures(root: Path) -> dict[str, int]:
    """Static safety scan: hardcoded secrets and undeclared remote fallbacks."""
    findings = {"sensitiveDiagnosticLeaks": 0, "undeclaredFallbacks": 0}
    secret_patterns = [
        re.compile(r"(password|passwd|pwd)\s*=\s*[\"'][^\"']{4,}[\"']", re.I),
        re.compile(r"(api_key|apikey|secret|token)\s*=\s*[\"'][^\"']{8,}[\"']", re.I),
        re.compile(r"[\"']https?://[^\"']*token[^\"']*[\"']", re.I),
    ]
    fallback_patterns = [
        re.compile(r"allow_remote\s*=\s*True", re.I),
        re.compile(r"HF_HUB_OFFLINE\s*=\s*[\"']0[\"']", re.I),
        re.compile(r"TRANSFORMERS_OFFLINE\s*=\s*[\"']0[\"']", re.I),
        re.compile(r"local_files_only\s*=\s*False", re.I),
    ]
    for path in (root / "src").rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for pattern in secret_patterns:
            findings["sensitiveDiagnosticLeaks"] += len(pattern.findall(text))
        for pattern in fallback_patterns:
            findings["undeclaredFallbacks"] += len(pattern.findall(text))
    return findings


def _check_model_provisioning(root: Path, cache_root: Path) -> list[str]:
    manifest = yaml.safe_load((root / "models/model-manifest.yaml").read_text())
    missing: list[str] = []
    for entry in manifest.get("models", []):
        key = f"{entry['providerRef']}__{entry['modelRef']}__{entry['modelRevision']}".replace("/", "_")
        target = cache_root / key
        if not target.exists() or (target / "PROVISIONING_REQUIRED").exists():
            missing.append(key)
    return missing


GROUND_TRUTH_FILES = ("pdf-ground-truth.json", "image-ground-truth.json", "gliner-ground-truth.json", "minilm-templates.json")


def load_ground_truth(corpus_dir: Path) -> dict:
    return {
        "pdf": json.loads((corpus_dir / "pdf-ground-truth.json").read_text(encoding="utf-8")),
        "image": json.loads((corpus_dir / "image-ground-truth.json").read_text(encoding="utf-8")),
        "gliner": json.loads((corpus_dir / "gliner-ground-truth.json").read_text(encoding="utf-8")),
        "minilm": json.loads((corpus_dir / "minilm-templates.json").read_text(encoding="utf-8")),
    }


def corpus_fingerprint(manifest_data: dict, corpus_dir: Path) -> str:
    """Fingerprint the full scored corpus: fixture hashes plus ground-truth files."""
    digest = hashlib.sha256()
    for fixture in sorted(manifest_data.get("fixtures", []), key=lambda item: str(item.get("fixtureId"))):
        digest.update(str(fixture.get("fixtureId")).encode("utf-8"))
        digest.update(str(fixture.get("sha256")).encode("utf-8"))
    for name in GROUND_TRUTH_FILES:
        path = corpus_dir / name
        digest.update(name.encode("utf-8"))
        digest.update(path.read_bytes() if path.exists() else b"")
    return digest.hexdigest()


def provider_semantics_fingerprint() -> str:
    """Fingerprint the provider/runtime source set this evidence measured.

    The canonical definition lives with the Increment-4A implementation
    material; Increment-3 measured-provider evidence binds the same authority
    so provider source edits invalidate stale summaries instead of silently
    inheriting them.
    """
    import importlib.util

    helper = ROOT / "evaluation/increment4a/implementation_material.py"
    spec = importlib.util.spec_from_file_location("increment4a_implementation_material", helper)
    if spec is None or spec.loader is None:
        raise ValueError("implementation material fingerprint helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.implementation_fingerprints(ROOT)["providerSemanticsFingerprint"]


def evaluation_implementation_fingerprint() -> str:
    """Fingerprint the Increment-3 evaluator that produced this evidence."""
    digest = hashlib.sha256()
    for name in ("run_evaluation.py", "metrics.py", "generate_corpus.py"):
        path = ROOT / "evaluation" / name
        digest.update(name.encode("utf-8"))
        digest.update(path.read_bytes() if path.is_file() else b"")
    return digest.hexdigest()


def evaluate_thresholds(metrics: dict[str, float], acceptance: dict) -> tuple[dict, bool, list[str]]:
    """Return per-threshold results, overall pass flag, and list of required-metric gaps."""
    threshold_results: dict = {}
    overall_pass = True
    missing: list[str] = []
    direction = {
        "cer": "lower",
        "wer": "lower",
        "layoutIoU": "higher",
        "regionPrecision": "higher",
        "regionRecall": "higher",
        "boundingBoxAgreement": "higher",
        "readingOrderCorrectness": "higher",
        "tableStructureAccuracy": "higher",
        "cellTextAccuracy": "higher",
        "cellCoordinateAgreement": "higher",
        "cellStructureAccuracy": "higher",
        "entityF1": "higher",
        "entityPrecision": "higher",
        "entityRecall": "higher",
        "exactMatch": "higher",
        "abstentionRate": "higher",
        "negativeMaxConfidence": "lower",
        "evidenceAccuracy": "higher",
        "recallAt1": "higher",
        "recallAt5": "higher",
        "stability": "higher",
        "retrievalAccuracy": "higher",
        "samePairSimilarity": "higher",
        "sameTemplateCosineMean": "higher",
        "sameTemplateCosineMin": "higher",
        "differentPairSimilarity": "lower",
        "differentTemplateCosineMean": "lower",
        "differentTemplateCosineMax": "lower",
        "p50LatencyMs": "lower",
        "p95LatencyMs": "lower",
        "latencyPerPageMs": "lower",
        "rssDeltaMb": "lower",
        "peakRssMb": "lower",
        "peakRssDeltaMb": "lower",
        "cancellationCheckMs": "lower",
        "tempResidueBytes": "lower",
    }

    for provider, languages in acceptance.get("thresholds", {}).items():
        threshold_results[provider] = {}
        for language, metric_map in languages.items():
            threshold_results[provider][language] = {}
            for metric, threshold in metric_map.items():
                full_key = f"{provider}.{language}.{metric}"
                value = metrics.get(full_key)
                if value is None:
                    missing.append(full_key)
                    threshold_results[provider][language][metric] = {
                        "status": "FAIL",
                        "reason": f"required metric {full_key} was not measured",
                        "value": None,
                        "threshold": threshold,
                        "direction": direction.get(metric, "higher"),
                    }
                    overall_pass = False
                    continue
                d = direction.get(metric, "higher")
                passes = (value <= threshold) if d == "lower" else (value >= threshold)
                threshold_results[provider][language][metric] = {
                    "status": "PASS" if passes else "FAIL",
                    "value": value,
                    "threshold": threshold,
                    "direction": d,
                }
                if not passes:
                    overall_pass = False

    return threshold_results, overall_pass, missing


def _build_capabilities(threshold_results: dict, acceptance: dict, hard_failures: dict, execution_error: str | None) -> tuple[list[dict], list[dict]]:
    accepted: list[dict] = []
    rejected: list[dict] = []
    hard_ok = all(v == 0 for v in hard_failures.values())
    provider_refs = {"docling": "ghatana.docling", "paddle": "ghatana.paddleocr", "gliner": "ghatana.gliner", "minilm": "ghatana.minilm"}
    capabilities = {
        "docling": {"mediaTypes": ["application/pdf"], "supportsTables": True, "supportsCoordinates": True, "supportsLanguages": True, "supportedLanguages": ["en", "ne"]},
        "paddle": {"mediaTypes": ["image/png", "image/jpeg"], "supportsTables": False, "supportsCoordinates": True, "supportsLanguages": True, "supportedLanguages": ["en", "ne"]},
        "gliner": {"supportedValueTypes": ["TEXT", "IDENTIFIER"], "supportsConfidenceScores": True, "supportsMultipleCardinality": True},
        "minilm": {"maxDimensions": 384, "modelRef": "sentence-transformers/all-MiniLM-L6-v2"},
    }
    if not hard_ok:
        rejected.append({"reason": execution_error or "hard acceptance checks did not pass", "hardMetrics": hard_failures})
    for provider, languages in acceptance.get("thresholds", {}).items():
        failed_languages: list[dict] = []
        for language in languages:
            results = threshold_results.get(provider, {}).get(language, {})
            if not results or not all(result.get("status") == "PASS" for result in results.values()):
                failed_languages.append({"language": language, "results": results})
        if hard_ok and not failed_languages:
            accepted.append({"providerRef": provider_refs[provider], "capabilities": capabilities[provider]})
        else:
            rejected.append({"providerRef": provider_refs[provider], "failedLanguages": failed_languages})
    return accepted, rejected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--acceptance", required=True)
    parser.add_argument("--environment", required=True)
    parser.add_argument(
        "--preserve-prior-lineage",
        action="store_true",
        help="write this successor result without mutating lineage markers on prior runs",
    )
    args = parser.parse_args()

    generate_corpus()

    manifest_path = Path(args.manifest)
    acceptance_path = Path(args.acceptance)
    environment_path = Path(args.environment)
    corpus_dir = ROOT / "evaluation/corpus"

    manifest_data = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    acceptance_data = yaml.safe_load(acceptance_path.read_text(encoding="utf-8"))
    environment_data = yaml.safe_load(environment_path.read_text(encoding="utf-8"))

    integrity_failures = verify_corpus_integrity(manifest_data, corpus_dir)
    if integrity_failures:
        raise SystemExit(f"corpus integrity check failed: {integrity_failures}")

    ground_truth = load_ground_truth(corpus_dir)

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    output_dir = ROOT / "evaluation/results" / run_id
    output_dir.mkdir(parents=True, exist_ok=False)

    cache_root = Path(os.environ.get("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(ROOT / ".models")))
    missing_models = _check_model_provisioning(ROOT, cache_root)

    execution_error: str | None = None
    metrics: dict[str, float] = {}
    diagnostics: dict[str, list] = {}
    hard_failures: dict[str, int] = {
        "contractAdmissionFailures": 0,
        "sensitiveDiagnosticLeaks": 0,
        "temporaryFileResidue": 0,
        "wrongProviderIdentities": 0,
        "invalidEmbeddingValues": 0,
        "undeclaredFallbacks": 0,
    }

    if missing_models:
        execution_error = f"missing provisioned models: {missing_models}"
    elif os.environ.get("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        execution_error = "DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS is not set to 1"
    else:
        try:
            metrics, diagnostics, provider_hard = run_real_provider_evaluation(manifest_data, corpus_dir, ground_truth, acceptance_data)
            hard_failures.update(provider_hard)
            source_hard = _scan_source_for_hard_failures(ROOT)
            for key in hard_failures:
                if key in source_hard:
                    hard_failures[key] += source_hard[key]
        except Exception as exc:
            execution_error = f"{type(exc).__name__}: {exc}"

    threshold_results, thresholds_pass, missing_metrics = evaluate_thresholds(metrics, acceptance_data)

    # Hard acceptance gates.
    hard_pass = all(v == 0 for v in hard_failures.values())

    if missing_models or execution_error:
        status = "NOT_RUN"
    elif missing_metrics or not thresholds_pass or not hard_pass:
        status = "FAIL"
    else:
        status = "PASS"

    corpus_fp = corpus_fingerprint(manifest_data, corpus_dir)
    frozen = {
        "manifestFingerprint": fingerprint(manifest_path),
        "corpusFingerprint": corpus_fp,
        "acceptanceFingerprint": fingerprint(acceptance_path),
        "environmentFingerprint": fingerprint(environment_path),
        "modelManifestFingerprint": fingerprint(ROOT / "models/model-manifest.yaml"),
        "providerSemanticsFingerprint": provider_semantics_fingerprint(),
        "evaluationImplementationFingerprint": evaluation_implementation_fingerprint(),
    }

    summary = {
        "runId": run_id,
        "manifestFingerprint": frozen["manifestFingerprint"],
        "corpusFingerprint": corpus_fp,
        "acceptanceFingerprint": frozen["acceptanceFingerprint"],
        "environmentFingerprint": frozen["environmentFingerprint"],
        "modelManifestFingerprint": frozen["modelManifestFingerprint"],
        "providerSemanticsFingerprint": frozen["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": frozen["evaluationImplementationFingerprint"],
        "frozen": frozen,
        "environment": {
            "os": platform.platform(),
            "python": sys.version.split()[0],
            "mode": environment_data.get("executionMode", "cpu"),
        },
        "hardMetrics": hard_failures,
        "metrics": metrics,
        "thresholdResults": threshold_results,
        "status": status,
        "missingModels": missing_models,
        "missingMetrics": missing_metrics,
        "executionError": execution_error,
        "diagnostics": diagnostics,
    }

    accepted, rejected = _build_capabilities(threshold_results, acceptance_data, hard_failures, execution_error)
    capabilities = {
        "declared": yaml.safe_load((ROOT / "models/model-manifest.yaml").read_text(encoding="utf-8")),
        "tested": list(diagnostics.keys()),
        "accepted": accepted,
        "rejected": rejected,
    }

    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output_dir / "capabilities.json").write_text(json.dumps(capabilities, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # Freeze lineage: any earlier result recorded against different frozen
    # fingerprints (or predating corpus fingerprinting) is explicitly
    # non-promotable. Only a run whose fingerprints all match the current
    # frozen authority can stand as the promotion authority.
    invalidated: list[str] = []
    if not args.preserve_prior_lineage:
        for prior_dir in sorted(ROOT.glob("evaluation/results/*/")):
            if prior_dir == output_dir:
                continue
            prior_summary_path = prior_dir / "summary.json"
            if not prior_summary_path.exists():
                continue
            try:
                prior = json.loads(prior_summary_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            mismatched = [
                key
                for key, current in (
                    ("manifestFingerprint", frozen["manifestFingerprint"]),
                    ("corpusFingerprint", corpus_fp),
                    ("acceptanceFingerprint", frozen["acceptanceFingerprint"]),
                    ("environmentFingerprint", frozen["environmentFingerprint"]),
                    ("modelManifestFingerprint", frozen["modelManifestFingerprint"]),
                    ("providerSemanticsFingerprint", frozen["providerSemanticsFingerprint"]),
                    ("evaluationImplementationFingerprint", frozen["evaluationImplementationFingerprint"]),
                )
                if prior.get(key) != current
            ]
            marker = prior_dir / "lineage.json"
            if mismatched:
                reason = (
                    "pre-freeze corpus or acceptance change"
                    if "corpusFingerprint" in mismatched or "manifestFingerprint" in mismatched
                    else "provider source or evaluator implementation changed"
                    if "providerSemanticsFingerprint" in mismatched or "evaluationImplementationFingerprint" in mismatched
                    else "frozen authority fingerprint drift"
                )
                marker.write_text(json.dumps({"status": "INVALIDATED_NON_PROMOTABLE", "reason": reason, "mismatchedFingerprints": mismatched, "invalidatedBy": run_id}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                invalidated.append(prior.get("runId", prior_dir.name))
            elif marker.exists() and json.loads(marker.read_text(encoding="utf-8")).get("invalidatedBy") == run_id:
                marker.unlink()
    if invalidated:
        summary["invalidatedRuns"] = invalidated
        (output_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
