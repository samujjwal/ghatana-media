"""Routing-backed hybrid PDF parsing strategy.

The hybrid policy is deliberately loaded from ``routing/hybrid-pdf.v1.yaml``.
Keeping the classification gates and deduplication calibration in the routing
authority makes calibration changes reviewable without silently changing
provider code or evaluation fixtures.

Execution is per page, never whole-document:

- Docling supplies the native text/layout per page.
- pypdfium2 (via :class:`PdfRenderer`) supplies real page facts: text-layer
  character counts and image-object regions, and rasters pages/regions on
  demand.
- Pages classified SCANNED or raster regions on MIXED pages are rendered to
  PNG and routed through the worker's resilient OCR route (Paddle primary,
  Tesseract fallback).  PDF bytes are never sent to an image OCR provider.
- OCR output is transformed from crop-local to page coordinates and
  deduplicated against native content with calibrated similarity/overlap
  thresholds; native text takes precedence.
"""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Mapping, Sequence

from ..errors import WorkerError
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.pdf_rendering import PdfRenderer


_DEFAULT_ROUTING_PATH = Path(__file__).resolve().parents[3] / "routing" / "hybrid-pdf.v1.yaml"


@dataclass(frozen=True)
class HybridPdfRoutingPolicy:
    """The validated policy surface consumed by the strategy."""

    primary: str
    ocr_route: str
    ocr_media_type: str
    minimum_text_characters: int
    ocr_image_area_fraction: float
    deduplication_key: tuple[str, ...]
    precedence: str
    text_similarity: float
    bbox_overlap: float
    render_scale: float
    render_max_pixels: int
    authority_path: Path


def _routing_document(path: Path) -> Mapping[str, Any]:
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - runtime dependency guard
        raise RuntimeError("PyYAML is required to load hybrid PDF routing authority") from exc

    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"unable to read hybrid PDF routing authority: {path}") from exc
    if not isinstance(document, Mapping):
        raise ValueError("hybrid PDF routing authority must be a mapping")
    return document


def _fraction(section: Mapping[str, Any], name: str, field: str, default: float) -> float:
    raw = section.get(field, default)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not 0 <= float(raw) <= 1:
        raise ValueError(f"{name}.{field} must be a fraction in [0, 1]")
    return float(raw)


def load_routing_policy(path: Path | str | None = None) -> HybridPdfRoutingPolicy:
    """Load and validate the hybrid policy from the routing authority."""

    authority_path = Path(path) if path is not None else _DEFAULT_ROUTING_PATH
    document = _routing_document(authority_path)
    classification = document.get("classification")
    deduplication = document.get("deduplication")
    ocr = document.get("ocr")
    render = document.get("render", {})
    if not isinstance(classification, Mapping) or not isinstance(deduplication, Mapping) or not isinstance(ocr, Mapping):
        raise ValueError("hybrid PDF routing authority requires classification, ocr, and deduplication")
    if not isinstance(render, Mapping):
        raise ValueError("hybrid PDF routing render section must be a mapping")

    primary = classification.get("primary")
    minimum = classification.get("minimumTextCharacters")
    ocr_route = ocr.get("route")
    ocr_media_type = ocr.get("inputMediaType", "image/png")
    key = deduplication.get("key")
    precedence = deduplication.get("precedence")
    if not isinstance(primary, str) or not primary:
        raise ValueError("hybrid PDF routing authority has no primary provider")
    if not isinstance(ocr_route, str) or not ocr_route:
        raise ValueError("hybrid PDF routing authority has no OCR route")
    if not isinstance(ocr_media_type, str) or not ocr_media_type.startswith("image/"):
        raise ValueError("ocr.inputMediaType must be an image media type; PDF bytes are never sent to an OCR provider")
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 0:
        raise ValueError("classification.minimumTextCharacters must be a non-negative integer")
    area = classification.get("ocrImageAreaFraction", 0.05)
    if isinstance(area, bool) or not isinstance(area, (int, float)) or not 0 < float(area) <= 1:
        raise ValueError("classification.ocrImageAreaFraction must be a fraction in (0, 1]")
    if not isinstance(key, Sequence) or isinstance(key, (str, bytes)) or not key or any(not isinstance(item, str) for item in key):
        raise ValueError("deduplication.key must be a non-empty sequence of field names")
    if precedence != "primary":
        raise ValueError("hybrid PDF deduplication precedence must be primary")
    scale = render.get("scale", 2.0)
    if isinstance(scale, bool) or not isinstance(scale, (int, float)) or float(scale) <= 0:
        raise ValueError("render.scale must be positive")
    max_pixels = render.get("maxPixels", 16_777_216)
    if isinstance(max_pixels, bool) or not isinstance(max_pixels, int) or max_pixels <= 0:
        raise ValueError("render.maxPixels must be a positive integer")
    return HybridPdfRoutingPolicy(
        primary=primary,
        ocr_route=ocr_route,
        ocr_media_type=ocr_media_type,
        minimum_text_characters=minimum,
        ocr_image_area_fraction=float(area),
        deduplication_key=tuple(key),
        precedence=precedence,
        text_similarity=_fraction(deduplication, "deduplication", "textSimilarity", 0.85),
        bbox_overlap=_fraction(deduplication, "deduplication", "bboxOverlap", 0.5),
        render_scale=float(scale),
        render_max_pixels=max_pixels,
        authority_path=authority_path,
    )


def _stable_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _line_key(line: Mapping[str, Any], fields: Sequence[str]) -> tuple[str, ...]:
    return tuple(_stable_value(line.get(field)) for field in fields)


def merge_parsed_documents(
    primary: Mapping[str, Any],
    secondary: Mapping[str, Any],
    identity: Mapping[str, str],
    *,
    deduplication_key: Sequence[str] = ("text", "boundingRegion"),
) -> dict[str, Any]:
    """Merge primary-first pages without mutating either provider result."""

    by_page: dict[int, dict[str, Any]] = {}
    seen_by_page: dict[int, set[tuple[str, ...]]] = {}
    for source in (primary, secondary):
        for raw_page in source.get("pages", []):
            if not isinstance(raw_page, Mapping):
                continue
            number = int(raw_page.get("pageNumber", 0))
            target = by_page.setdefault(number, {"pageNumber": number, "blocks": [], "tables": []})
            seen = seen_by_page.setdefault(number, set())
            for raw_block in raw_page.get("blocks", []):
                if not isinstance(raw_block, Mapping):
                    continue
                lines: list[dict[str, Any]] = []
                for raw_line in raw_block.get("lines", []):
                    if not isinstance(raw_line, Mapping):
                        continue
                    line = copy.deepcopy(dict(raw_line))
                    key = _line_key(line, deduplication_key)
                    if key in seen:
                        continue
                    seen.add(key)
                    lines.append(line)
                if not lines:
                    continue
                block = copy.deepcopy(dict(raw_block))
                block["blockId"] = f"p{number}-b{len(target['blocks']) + 1}"
                block["lines"] = lines
                for index, line in enumerate(lines, 1):
                    line["lineId"] = f"{block['blockId']}-l{index}"
                target["blocks"].append(block)
            if source is primary:
                target["tables"].extend(copy.deepcopy(list(raw_page.get("tables", []))))
    return {"pages": [by_page[key] for key in sorted(by_page)], "providerProvenance": dict(identity), "quality": {}}


def _page_characters(page: Mapping[str, Any]) -> int:
    return sum(
        len(line.get("text", ""))
        for block in page.get("blocks", [])
        for line in block.get("lines", [])
        if isinstance(line.get("text", ""), str)
    )


def _classify_page(text_characters: int, image_area: float, policy: HybridPdfRoutingPolicy) -> str:
    """Per-page NATIVE/SCANNED/MIXED/BLANK classification from real page facts."""
    if text_characters < policy.minimum_text_characters:
        return "SCANNED" if image_area > 0 else "BLANK"
    return "MIXED" if image_area >= policy.ocr_image_area_fraction else "NATIVE"


def _iou(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
    try:
        lx = max(float(left["x"]), float(right["x"]))
        ly = max(float(left["y"]), float(right["y"]))
        rx = min(float(left["x"]) + float(left["width"]), float(right["x"]) + float(right["width"]))
        ry = min(float(left["y"]) + float(left["height"]), float(right["y"]) + float(right["height"]))
        union = float(left["width"]) * float(left["height"]) + float(right["width"]) * float(right["height"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    intersection = max(0.0, rx - lx) * max(0.0, ry - ly)
    union -= intersection
    return intersection / union if union > 0 else 0.0


def _normalized_text(text: Any) -> str:
    return " ".join(str(text or "").casefold().split())


def _is_duplicate(line: Mapping[str, Any], kept: list[Mapping[str, Any]], policy: HybridPdfRoutingPolicy) -> bool:
    region = line.get("boundingRegion")
    if not isinstance(region, Mapping):
        return False
    text = _normalized_text(line.get("text"))
    for existing in kept:
        existing_region = existing.get("boundingRegion")
        if not isinstance(existing_region, Mapping):
            continue
        if _iou(region, existing_region) < policy.bbox_overlap:
            continue
        existing_text = _normalized_text(existing.get("text"))
        if text == existing_text:
            return True
        if text and existing_text and SequenceMatcher(None, text, existing_text).ratio() >= policy.text_similarity:
            return True
    return False


def _transform_box(box: Any, region: Mapping[str, Any]) -> dict[str, float] | None:
    """Map a crop-normalized box into page-normalized coordinates."""
    if not isinstance(box, Mapping):
        return None
    try:
        x = float(region["x"]) + float(box["x"]) * float(region["width"])
        y = float(region["y"]) + float(box["y"]) * float(region["height"])
        width = float(box["width"]) * float(region["width"])
        height = float(box["height"]) * float(region["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > 1.000001 or y + height > 1.000001:
        return None
    return {"x": min(x, 1.0), "y": min(y, 1.0), "width": min(width, 1.0 - min(x, 1.0)), "height": min(height, 1.0 - min(y, 1.0))}


def _region_lines(ocr: Mapping[str, Any], region: Mapping[str, Any]) -> list[dict[str, Any]]:
    """OCR lines from one rendered region, transformed to page coordinates."""
    lines: list[dict[str, Any]] = []
    pages = ocr.get("pages", [])
    if not pages:
        return lines
    for block in pages[0].get("blocks", []):
        if not isinstance(block, Mapping):
            continue
        for raw_line in block.get("lines", []):
            if not isinstance(raw_line, Mapping) or not isinstance(raw_line.get("text"), str) or not raw_line["text"].strip():
                continue
            box = _transform_box(raw_line.get("boundingRegion"), region)
            if box is None:
                continue
            line = {"text": raw_line["text"], "boundingRegion": box}
            if isinstance(raw_line.get("confidence"), (int, float)):
                line["confidence"] = float(raw_line["confidence"])
            if isinstance(raw_line.get("languageTag"), str):
                line["languageTag"] = raw_line["languageTag"]
            lines.append(line)
    return lines


def _append_ocr_lines(target: Mapping[str, Any], candidates: list[dict[str, Any]], policy: HybridPdfRoutingPolicy) -> list[dict[str, Any]]:
    """Dedupe OCR lines against native content; native text takes precedence."""
    kept: list[dict[str, Any]] = []
    native = [line for block in target.get("blocks", []) for line in block.get("lines", []) if isinstance(line, Mapping)]
    kept.extend(native)
    accepted: list[dict[str, Any]] = []
    for candidate in candidates:
        if _is_duplicate(candidate, kept, policy):
            continue
        kept.append(candidate)
        accepted.append(candidate)
    if not accepted:
        return []
    block_id = f"p{target.get('pageNumber', 1)}-b{len(target.get('blocks', [])) + 1}"
    lines = []
    for index, line in enumerate(accepted, 1):
        item = dict(line)
        item["lineId"] = f"{block_id}-l{index}"
        lines.append(item)
    xs = [line["boundingRegion"]["x"] for line in lines]
    ys = [line["boundingRegion"]["y"] for line in lines]
    rights = [line["boundingRegion"]["x"] + line["boundingRegion"]["width"] for line in lines]
    bottoms = [line["boundingRegion"]["y"] + line["boundingRegion"]["height"] for line in lines]
    return [{"blockId": block_id, "kind": "TEXT", "boundingRegion": {"x": min(xs), "y": min(ys), "width": max(rights) - min(xs), "height": max(bottoms) - min(ys)}, "lines": lines}]


class HybridPdfStrategy:
    """Page/region hybrid strategy governed by the routing authority."""

    provider_ref = "ghatana.hybrid-pdf"
    is_strategy = True

    def __init__(self, routing_path: Path | str | None = None, renderer_factory: Any = None) -> None:
        self.routing = load_routing_policy(routing_path)
        self._renderer_factory = renderer_factory or (lambda data: PdfRenderer(data, scale=self.routing.render_scale, max_pixels=self.routing.render_max_pixels))

    @classmethod
    def from_routing_authority(cls, path: Path | str | None = None, **kwargs: Any) -> "HybridPdfStrategy":
        return cls(path, **kwargs)

    def identity(self) -> dict[str, str]:
        return {
            "providerRef": self.provider_ref,
            "providerVersion": "0.1.0",
            "modelRef": "hybrid-pdf-v1",
            "modelVersion": "policy-v1",
        }

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": ["application/pdf"], "supportsTables": True, "supportsCoordinates": True}

    def runtime_dependencies(self) -> tuple[str, ...]:
        """Native pages use the primary provider; OCR regions use the OCR route."""
        return (self.routing.primary, self.routing.ocr_route)

    def warm(self) -> "HybridPdfStrategy":
        return self

    async def parse(
        self,
        data: bytes,
        *,
        media_type: str,
        language: str | None,
        limits: Mapping[str, int],
        deadline: Deadline,
        token: CancellationToken,
        executor: Any,
        call_stack: tuple[str, ...],
    ) -> dict[str, Any]:
        if media_type != "application/pdf":
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        primary = await executor.parse(
            self.routing.primary,
            data,
            media_type=media_type,
            language=language,
            limits=limits,
            deadline=deadline,
            token=token,
            call_stack=call_stack,
        )
        max_pages = int(limits.get("maxPages", 500))
        renderer = self._renderer_factory(data)
        classifications: list[dict[str, Any]] = []
        ocr_attempt_lineage: list[dict[str, Any]] = []
        try:
            page_count = min(renderer.page_count(), max_pages)
            primary_pages = {int(page.get("pageNumber", 0)): page for page in primary.get("pages", []) if isinstance(page, Mapping)}
            out_pages: dict[int, dict[str, Any]] = {}
            for index in range(page_count):
                token.raise_if_cancelled()
                deadline.require_remaining()
                info = renderer.page_info(index)
                page_number = info.page_number
                base = primary_pages.get(page_number, {"pageNumber": page_number, "blocks": [], "tables": []})
                target = {"pageNumber": page_number, "blocks": copy.deepcopy(list(base.get("blocks", []))), "tables": copy.deepcopy(list(base.get("tables", [])))}
                image_area = sum(float(region["width"]) * float(region["height"]) for region in info.image_regions)
                classification = _classify_page(max(info.text_characters, _page_characters(base)), image_area, self.routing)
                classifications.append({"pageNumber": page_number, "classification": classification, "textCharacters": info.text_characters, "imageRegions": len(info.image_regions)})
                if classification == "SCANNED":
                    png = renderer.render_page_png(index)
                    ocr = await executor.parse(
                        self.routing.ocr_route,
                        png,
                        media_type=self.routing.ocr_media_type,
                        language=language,
                        limits=limits,
                        deadline=deadline,
                        token=token,
                        call_stack=call_stack,
                    )
                    full = {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
                    ocr_warnings = [warning for warning in ocr.get("quality", {}).get("warnings", []) if isinstance(warning, str)]
                    selected = [warning for warning in ocr_warnings if warning.startswith("selectedProviderRef:")]
                    attempted = [warning for warning in ocr_warnings if warning.startswith("attemptedProviderRefs:")]
                    ocr_attempt_lineage.append({"pageNumber": page_number, "region": full, "attempts": attempted[-1].split(":", 1)[1].split(",") if attempted else [], "selected": selected[-1].split(":", 1)[1] if selected else None})
                    target["blocks"].extend(_append_ocr_lines(target, _region_lines(ocr, full), self.routing))
                elif classification == "MIXED":
                    for region in info.image_regions:
                        token.raise_if_cancelled()
                        deadline.require_remaining()
                        if float(region["width"]) * float(region["height"]) < self.routing.ocr_image_area_fraction:
                            continue
                        png = renderer.render_region_png(index, region)
                        ocr = await executor.parse(
                            self.routing.ocr_route,
                            png,
                            media_type=self.routing.ocr_media_type,
                            language=language,
                            limits=limits,
                            deadline=deadline,
                            token=token,
                            call_stack=call_stack,
                        )
                        ocr_warnings = [warning for warning in ocr.get("quality", {}).get("warnings", []) if isinstance(warning, str)]
                        selected = [warning for warning in ocr_warnings if warning.startswith("selectedProviderRef:")]
                        attempted = [warning for warning in ocr_warnings if warning.startswith("attemptedProviderRefs:")]
                        ocr_attempt_lineage.append({"pageNumber": page_number, "region": dict(region), "attempts": attempted[-1].split(":", 1)[1].split(",") if attempted else [], "selected": selected[-1].split(":", 1)[1] if selected else None})
                        target["blocks"].extend(_append_ocr_lines(target, _region_lines(ocr, region), self.routing))
                out_pages[page_number] = target
        finally:
            close = getattr(renderer, "close", None)
            if callable(close):
                close()
        quality = dict(primary.get("quality", {}))
        warnings = list(quality.get("warnings", []))
        warnings.append("pageClassifications:" + json.dumps(classifications, separators=(",", ":")))
        warnings.append("pdfOcrAttemptLineage:" + json.dumps(ocr_attempt_lineage, separators=(",", ":")))
        quality["warnings"] = warnings
        return {
            "pages": [out_pages[number] for number in sorted(out_pages)],
            "providerProvenance": self.identity(),
            "quality": quality,
        }


# Keep the provider-facing name convenient for callers migrating from the
# original provider-strategy module.
HybridPdfParser = HybridPdfStrategy


__all__ = [
    "HybridPdfParser",
    "HybridPdfRoutingPolicy",
    "HybridPdfStrategy",
    "load_routing_policy",
    "merge_parsed_documents",
]
