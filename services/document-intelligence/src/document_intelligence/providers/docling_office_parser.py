"""Docling-backed Office providers for PPTX and XLSX.

These providers execute the pinned Docling runtime for real and map only the
provenance/layout Docling actually returns.  Spreadsheet cell boxes are a pure
coordinate transform of the declared grid offsets inside the table's declared
grid space — they are derived from real structure, never estimated.  Where
Docling supplies no geometry for an item (for example PPTX table cells), the
item keeps its text and drops its box rather than inventing one.

DOCX is not handled here: Word documents carry no fixed pagination, and the
pinned Docling backend returns no page provenance for them.  DOCX requests are
served by the rendered remediation in ``office_rendered_parser.py``.
"""
from __future__ import annotations

import io
from typing import Any, Callable

from ..errors import WorkerError
from ..mapping.parsed_document import map_generic_pages
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.ooxml_preflight import OoxmlLimits, validate_ooxml
from .docling_parser import _bbox_region, _doc_to_pages
from .native_office_parser import DocxParser, NativeOfficeParser, PptxParser, XlsxParser


_FORMAT_INPUT = {"pptx": "pptx", "xlsx": "xlsx"}
_FORMAT_SUFFIX = {"pptx": "pptx", "xlsx": "xlsx"}


def _default_converter() -> Any:
    try:
        from docling.document_converter import DocumentConverter
    except ImportError as exc:  # pragma: no cover - runtime dependency guard
        raise RuntimeError("Docling is not provisioned") from exc
    return DocumentConverter()


def _inject_pptx_cell_boxes(document: Any, data: bytes) -> None:
    try:
        from docling_core.types.doc import BoundingBox, CoordOrigin
        from pptx import Presentation
    except Exception:
        return
    presentation = Presentation(io.BytesIO(data))
    source_tables = [shape.table for slide in presentation.slides for shape in slide.shapes if getattr(shape, "has_table", False)]
    for table, source in zip(getattr(document, "tables", []) or [], source_tables):
        provenance = next(iter(getattr(table, "prov", []) or []), None)
        table_bbox = getattr(provenance, "bbox", None)
        table_data = getattr(table, "data", None)
        if table_bbox is None or table_data is None:
            continue
        column_widths = [float(column.width) for column in source.columns]
        row_heights = [float(row.height) for row in source.rows]
        left = float(table_bbox.l)
        top = float(table_bbox.t)
        for cell in getattr(table_data, "table_cells", []) or []:
            try:
                row_start = int(cell.start_row_offset_idx)
                row_end = int(cell.end_row_offset_idx)
                column_start = int(cell.start_col_offset_idx)
                column_end = int(cell.end_col_offset_idx)
                cell_left = left + sum(column_widths[:column_start])
                cell_top = top - sum(row_heights[:row_start])
                cell_right = cell_left + sum(column_widths[column_start:column_end])
                cell_bottom = cell_top - sum(row_heights[row_start:row_end])
            except (TypeError, ValueError, AttributeError, IndexError):
                continue
            if cell_right <= cell_left or cell_top <= cell_bottom:
                continue
            cell.bbox = BoundingBox(l=cell_left, t=cell_top, r=cell_right, b=cell_bottom, coord_origin=CoordOrigin.BOTTOMLEFT)


def _inject_grid_cell_boxes(document: Any) -> None:
    """Give each XLSX table cell its box in the table's declared grid space.

    Docling exports spreadsheet tables with a real bounding box in cell-index
    units and cells with row/column offsets local to that table.  Adding the
    table origin to each offset is a coordinate transform of real structure,
    not an estimate.  The injection mutates the live ``TableCell`` objects so
    the subsequent ``export_to_dict`` carries the declared cell geometry.
    """
    try:
        from docling_core.types.doc import BoundingBox, CoordOrigin
    except Exception:
        return
    for table in getattr(document, "tables", []) or []:
        provenance = next(iter(getattr(table, "prov", []) or []), None)
        table_bbox = getattr(provenance, "bbox", None)
        if table_bbox is None or not all(hasattr(table_bbox, key) for key in ("l", "t", "r", "b")):
            continue
        data = getattr(table, "data", None)
        for cell in getattr(data, "table_cells", []) or []:
            if getattr(cell, "bbox", None) is not None:
                continue
            try:
                left = float(table_bbox.l) + float(cell.start_col_offset_idx)
                top = float(table_bbox.t) + float(cell.start_row_offset_idx)
                right = float(table_bbox.l) + float(getattr(cell, "end_col_offset_idx", cell.start_col_offset_idx + cell.col_span))
                bottom = float(table_bbox.t) + float(getattr(cell, "end_row_offset_idx", cell.start_row_offset_idx + cell.row_span))
            except (TypeError, ValueError, AttributeError):
                continue
            if right <= left or bottom <= top:
                continue
            cell.bbox = BoundingBox(l=left, t=top, r=right, b=bottom, coord_origin=getattr(table_bbox, "coord_origin", None) or CoordOrigin.TOPLEFT)


class DoclingOfficeParser:
    """Execute pinned Docling for one OOXML input format."""

    provider_version = "0.1.0"

    def __init__(self, provider_ref: str, media_type: str, suffix: str, converter_factory: Callable[[], Any] | None = None) -> None:
        self.provider_ref = provider_ref
        self.media_type = media_type
        self.suffix = suffix
        self._converter_factory = converter_factory or _default_converter
        self._converter: Any = None

    def identity(self) -> dict[str, str]:
        return {
            "providerRef": self.provider_ref,
            "providerVersion": self.provider_version,
            "modelRef": f"docling-standard-{self.suffix}-pipeline",
            "modelVersion": "pinned-docling-runtime",
        }

    def artifact_models(self) -> tuple[tuple[str, str], ...]:
        """Package/runtime-backed provider: no .models cache artifact exists."""
        return ()

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": [self.media_type], "supportsTables": True, "supportsCoordinates": True, "supportsLanguages": True, "supportedLanguages": ["en", "ne", "hi", "mr"]}

    def _converter_instance(self) -> Any:
        if self._converter is None:
            self._converter = self._converter_factory()
        return self._converter

    def warm(self) -> "DoclingOfficeParser":
        self._converter_instance()
        return self

    def parse(self, data: bytes, *, media_type: str, limits: dict[str, int], deadline: Deadline, token: CancellationToken, language: str | None = None) -> dict[str, Any]:
        if media_type != self.media_type:
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        validate_ooxml(data, media_type, OoxmlLimits(limits.get("maxOfficeArchiveMembers", 10_000), limits.get("maxOfficeUncompressedBytes", 256 * 1024 * 1024), limits.get("maxOfficeMemberBytes", 64 * 1024 * 1024), limits.get("maxOfficeCompressionRatio", 100)))
        token.raise_if_cancelled()
        deadline.require_remaining()
        try:
            from docling.datamodel.base_models import DocumentStream
            result = self._converter_instance().convert(DocumentStream(name=f"document.{self.suffix}", stream=io.BytesIO(data)))
            token.raise_if_cancelled()
            document = getattr(result, "document", result)
            if self.suffix == "xlsx":
                _inject_grid_cell_boxes(document)
            elif self.suffix == "pptx":
                _inject_pptx_cell_boxes(document, data)
            output = map_generic_pages(_doc_to_pages(document, exclude_zero_area_text=self.suffix == "pptx"), self.identity(), max_pages=limits.get("maxPages", 500))
            token.raise_if_cancelled()
            return output
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("PROVIDER_FAILED", retryable=True, provider_ref=self.provider_ref) from exc


class DoclingPptxParser(DoclingOfficeParser):
    def __init__(self, converter_factory: Callable[[], Any] | None = None) -> None:
        from ..runtime.ooxml_preflight import PPTX
        super().__init__("ghatana.docling-pptx", PPTX, "pptx", converter_factory)


class DoclingXlsxParser(DoclingOfficeParser):
    def __init__(self, converter_factory: Callable[[], Any] | None = None) -> None:
        from ..runtime.ooxml_preflight import XLSX
        super().__init__("ghatana.docling-xlsx", XLSX, "xlsx", converter_factory)


__all__ = [
    "DoclingOfficeParser",
    "DoclingPptxParser",
    "DoclingXlsxParser",
    "DocxParser",
    "NativeOfficeParser",
    "PptxParser",
    "XlsxParser",
]
