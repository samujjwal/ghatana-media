from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Any, Callable

from ..errors import WorkerError
from ..mapping.parsed_document import map_generic_pages
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.pdf_preflight import PdfLimits, validate_pdf


IDENTITY = {"providerRef": "ghatana.docling", "providerVersion": "0.1.0", "modelRef": "docling-standard-pdf-pipeline", "modelVersion": "pinned-docling-runtime"}


def _default_converter() -> Any:
    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
    except ImportError as exc:
        raise RuntimeError("Docling is not provisioned") from exc
    options = PdfPipelineOptions()
    options.artifacts_path = Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", ".models")) / "ghatana.docling__docling-standard-pdf-pipeline__pinned-docling-runtime"
    options.do_ocr = False
    options.do_table_structure = True
    options.generate_page_images = False
    options.generate_picture_images = False
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})


def _bbox_region(bbox: Any) -> dict[str, float] | None:
    if not isinstance(bbox, dict) or not {"l", "t", "r", "b"}.issubset(bbox):
        return None
    if _bbox_origin(bbox) == "top-left":
        return {"x": bbox["l"], "y": bbox["t"], "width": bbox["r"] - bbox["l"], "height": bbox["b"] - bbox["t"]}
    return {"x": bbox["l"], "y": bbox["b"], "width": bbox["r"] - bbox["l"], "height": bbox["t"] - bbox["b"]}


def _bbox_origin(bbox: Any) -> str:
    if isinstance(bbox, dict) and str(bbox.get("coord_origin", "")).upper() == "TOPLEFT":
        return "top-left"
    return "bottom-left"


_BUILTIN_KINDS = {"TEXT", "HEADER", "FOOTER", "TABLE", "FIGURE", "FORM_FIELD", "KEY_VALUE", "BARCODE"}
_KIND_LABELS = {"text": "TEXT", "paragraph": "TEXT", "section_header": "HEADER", "title": "HEADER", "page_header": "HEADER", "page_footer": "FOOTER", "footnote": "FOOTER", "picture": "FIGURE", "figure": "FIGURE", "caption": "FIGURE", "form": "FORM_FIELD", "key_value_region": "KEY_VALUE", "checkbox_selected": "FORM_FIELD", "checkbox_unselected": "FORM_FIELD", "code": "x-ghatana.docling.code", "list_item": "x-ghatana.docling.list_item", "formula": "x-ghatana.docling.formula", "document_index": "x-ghatana.docling.document_index"}


def _block_kind(label: Any) -> str:
    """Map a Docling item label to a shared-contract block kind; unknown labels
    become `x-ghatana.docling.<label>` extension kinds, preserving provenance
    instead of collapsing them into TEXT."""
    raw = str(label or "text").strip().lower()
    if raw.upper() in _BUILTIN_KINDS:
        return raw.upper()
    return _KIND_LABELS.get(raw, f"x-ghatana.docling.{raw}")


def _pdf_line_boxes(data: bytes) -> dict[int, list[dict[str, Any]]]:
    """Per-page text line boxes via pypdfium2.

    Docling merges adjacent PDF text operators into one text item, collapsing
    line-level provenance the contract requires. pypdfium2 exposes the PDF
    text page's per-line rectangles; each rect is paired with its bounded text
    so a merged Docling item can be split back into real text lines.
    """
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return {}
    try:
        pdf = pdfium.PdfDocument(data)
        try:
            result: dict[int, list[dict[str, Any]]] = {}
            for page_index in range(len(pdf)):
                page = pdf[page_index]
                textpage = page.get_textpage()
                rects: list[dict[str, Any]] = []
                for rect_index in range(textpage.count_rects()):
                    rect = textpage.get_rect(rect_index)
                    if not rect or len(rect) != 4:
                        continue
                    left, bottom, right, top = (float(value) for value in rect)
                    text = textpage.get_text_bounded(left, bottom, right, top)
                    if isinstance(text, str) and text.strip():
                        rects.append({"l": left, "b": bottom, "r": right, "t": top, "text": text.strip()})
                result[page_index + 1] = rects
                textpage.close()
                page.close()
            return result
        finally:
            pdf.close()
    except Exception:
        return {}


def _split_into_lines(prov_bbox: dict[str, Any], item_text: str, page_lines: list[dict[str, Any]], page_height: float) -> tuple[list[dict[str, Any]], dict[str, float] | None]:
    """Split a Docling text item into per-line entries using pdfium rects.

    Coordinates are reconciled to a top-left origin: pdfium rects arrive as
    bottom-left PDF points and are converted using the page height. Lines are
    emitted in reading order (top to bottom) with their true measured
    geometry; the second return value is the top-left union rect covering the
    item provenance box and every emitted line, which the caller uses as the
    block extent so page ⊇ block ⊇ line holds by construction."""
    region = _bbox_region(prov_bbox)
    if region is None:
        return [{"text": item_text, "bbox": prov_bbox, "coordinateOrigin": _bbox_origin(prov_bbox)}], None
    fallback = [{"text": item_text, "bbox": region, "coordinateOrigin": "bottom-left"}]
    origin = _bbox_origin(prov_bbox)
    # Normalize the item region into top-left (l, t, r, b).
    if origin == "bottom-left":
        item_top = page_height - (region["y"] + region["height"])
        item_bottom = page_height - region["y"]
    else:
        item_top = region["y"]
        item_bottom = region["y"] + region["height"]
    item_left, item_right = region["x"], region["x"] + region["width"]

    lines: list[dict[str, Any]] = []
    for entry in page_lines:
        # pdfium rect (bottom-left origin) → top-left space.
        line_top = page_height - entry["t"]
        line_bottom = page_height - entry["b"]
        line_left, line_right = entry["l"], entry["r"]
        overlap = min(line_bottom, item_bottom) - max(line_top, item_top)
        line_height = line_bottom - line_top
        if line_height <= 0 or overlap < line_height * 0.5:
            continue
        if line_right < item_left - 1 or line_left > item_right + 1:
            continue
        lines.append({"text": entry["text"], "bbox": {"l": line_left, "t": line_top, "r": line_right, "b": line_bottom}, "coordinateOrigin": "top-left", "_top": line_top})
    lines.sort(key=lambda entry: entry["_top"])
    for line in lines:
        line.pop("_top", None)
    if not lines:
        return fallback, None
    union = {
        "l": min(item_left, min(line["bbox"]["l"] for line in lines)),
        "t": min(item_top, min(line["bbox"]["t"] for line in lines)),
        "r": max(item_right, max(line["bbox"]["r"] for line in lines)),
        "b": max(item_bottom, max(line["bbox"]["b"] for line in lines)),
    }
    return lines, union


def _doc_to_pages(document: Any, *, exclude_zero_area_text: bool = False, pdf_lines: dict[int, list[dict[str, Any]]] | None = None) -> list[dict[str, Any]]:
    if isinstance(document, dict):
        return list(document.get("pages", []))
    if hasattr(document, "export_to_dict"):
        exported = document.export_to_dict()
        if isinstance(exported, dict) and isinstance(exported.get("pages"), dict):
            pages: dict[int, dict[str, Any]] = {}
            for raw_page in exported["pages"].values():
                number = int(raw_page.get("page_no", len(pages) + 1))
                size = raw_page.get("size", {})
                pages[number] = {"pageNumber": number, "width": size.get("width", 1), "height": size.get("height", 1), "blocks": [], "tables": []}
            for text in exported.get("texts", []):
                if not isinstance(text, dict) or not isinstance(text.get("text"), str):
                    continue
                for provenance in text.get("prov", []):
                    page_no = int(provenance.get("page_no", 0))
                    page = pages.get(page_no)
                    region = _bbox_region(provenance.get("bbox"))
                    if page is None or region is None:
                        continue
                    if exclude_zero_area_text and (region["width"] <= 0 or region["height"] <= 0):
                        continue
                    page_height = float(page.get("height") or 0)
                    block_bbox: Any = region
                    block_origin = "bottom-left"
                    if pdf_lines is not None and page_height > 0:
                        lines, union = _split_into_lines(provenance.get("bbox"), text["text"], pdf_lines.get(page_no, []), page_height)
                        if union is not None:
                            block_bbox = union
                            block_origin = "top-left"
                    else:
                        lines = [{"text": text["text"], "bbox": region, "coordinateOrigin": "bottom-left"}]
                    for line in lines:
                        line.setdefault("coordinateOrigin", _bbox_origin(provenance.get("bbox")))
                    page["blocks"].append({"kind": _block_kind(text.get("label")), "bbox": block_bbox, "coordinateOrigin": block_origin, "lines": lines})
            for table in exported.get("tables", []):
                if not isinstance(table, dict):
                    continue
                provenance = next((item for item in table.get("prov", []) if isinstance(item, dict)), None)
                page = pages.get(int(provenance.get("page_no", 0))) if provenance else None
                table_bbox = provenance.get("bbox") if provenance else None
                table_region = _bbox_region(table_bbox)
                data = table.get("data", {})
                if page is None or table_region is None or not isinstance(data, dict):
                    continue
                cells = []
                for cell in data.get("table_cells", []):
                    if not isinstance(cell, dict) or not isinstance(cell.get("text"), str):
                        continue
                    cell_bbox = cell.get("bbox")
                    cell_region = _bbox_region(cell_bbox)
                    if cell_region is None:
                        continue
                    cells.append({
                        "rowIndex": int(cell.get("start_row_offset_idx", 0)),
                        "columnIndex": int(cell.get("start_col_offset_idx", 0)),
                        "rowSpan": int(cell.get("row_span", 1)),
                        "columnSpan": int(cell.get("col_span", 1)),
                        "text": cell["text"],
                        "bbox": cell_region,
                        "coordinateOrigin": _bbox_origin(cell_bbox),
                    })
                if not cells:
                    # Docling supplies no cell geometry for PPTX tables; the
                    # contract requires a boundingRegion per cell, so a table
                    # that yields zero valid cells cannot be emitted.
                    continue
                page["tables"].append({
                    "bbox": table_region,
                    "coordinateOrigin": _bbox_origin(table_bbox),
                    "rowCount": int(data.get("num_rows", 0)),
                    "columnCount": int(data.get("num_cols", 0)),
                    "cells": cells,
                })
            return [pages[number] for number in sorted(pages)]
    pages = getattr(document, "pages", None)
    if pages is None:
        return []
    result: list[dict[str, Any]] = []
    for page in pages:
        if isinstance(page, dict):
            result.append(page)
        else:
            result.append({"pageNumber": getattr(page, "page_no", len(result) + 1), "width": getattr(page, "width", 1), "height": getattr(page, "height", 1), "blocks": getattr(page, "blocks", []), "tables": getattr(page, "tables", [])})
    return result


def map_docling_document(document: Any, *, max_pages: int = 500, pdf_lines: dict[int, list[dict[str, Any]]] | None = None) -> dict[str, Any]:
    """Map only stable content fields; provider object identities are ignored."""
    pages = _doc_to_pages(document, pdf_lines=pdf_lines)
    result = map_generic_pages(pages, IDENTITY, max_pages=max_pages)
    result["providerProvenance"] = IDENTITY
    return result


class DoclingParser:
    provider_ref = "ghatana.docling"

    def __init__(self, converter_factory: Callable[[], Any] = _default_converter) -> None:
        self._converter_factory = converter_factory
        self._converter: Any = None

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": ["application/pdf"], "supportsTables": True, "supportsCoordinates": True, "supportsLanguages": True, "supportedLanguages": ["en", "ne"]}

    def identity(self) -> dict[str, str]:
        return dict(IDENTITY)

    def warm(self) -> "DoclingParser":
        self._converter_instance()
        return self

    def _converter_instance(self) -> Any:
        if self._converter is None:
            self._converter = self._converter_factory()
        return self._converter

    def parse(self, data: bytes, *, media_type: str, limits: dict[str, int], deadline: Deadline, token: CancellationToken, language: str | None = None) -> dict[str, Any]:
        if media_type != "application/pdf":
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        # I6-54/I6-53: structural preflight (magic, object/stream bounds,
        # hostile name vectors, page-dimension ceiling) before conversion.
        validate_pdf(data, PdfLimits.from_mapping(limits))
        token.raise_if_cancelled()
        deadline.require_remaining()
        try:
            from docling.datamodel.base_models import DocumentStream
            result = self._converter_instance().convert(DocumentStream(name="document.pdf", stream=io.BytesIO(data)))
            token.raise_if_cancelled()
            document = getattr(result, "document", result)
            return map_docling_document(document, max_pages=limits.get("maxPages", 500), pdf_lines=_pdf_line_boxes(data))
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("PROVIDER_FAILED", provider_ref=self.provider_ref) from exc
