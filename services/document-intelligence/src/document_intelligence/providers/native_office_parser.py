from __future__ import annotations

"""Small, offline OOXML readers used for Office qualification.

The readers intentionally consume the OOXML parts directly.  Office documents do
not carry the same kind of page geometry across formats, so each reader uses the
geometry that the format actually stores (slide extents, spreadsheet row/column
metrics, and Word page/flow metrics) rather than manufacturing a full-page box.
"""

import io
import math
import posixpath
from collections import defaultdict
from typing import Any, Iterable
from xml.etree import ElementTree
from zipfile import ZipFile

from ..errors import WorkerError
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.ooxml_preflight import DOCX, PPTX, XLSX, OoxmlLimits, validate_ooxml


_EMU_PER_INCH = 914400.0
_TWIPS_PER_INCH = 1440.0
_NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(node: ElementTree.Element, name: str) -> list[ElementTree.Element]:
    return [child for child in list(node) if _local(child.tag) == name]


def _first(node: ElementTree.Element, name: str) -> ElementTree.Element | None:
    return next((child for child in list(node) if _local(child.tag) == name), None)


def _descendant(node: ElementTree.Element, name: str) -> ElementTree.Element | None:
    return next((child for child in node.iter() if _local(child.tag) == name), None)


def _descendants(node: ElementTree.Element, name: str) -> Iterable[ElementTree.Element]:
    return (child for child in node.iter() if _local(child.tag) == name)


def _attr(node: ElementTree.Element | None, name: str, default: str | None = None) -> str | None:
    if node is None:
        return default
    for key, value in node.attrib.items():
        if _local(key) == name:
            return value
    return default


def _integer(value: str | None, default: int = 0) -> int:
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def _parse_xml(data: bytes) -> ElementTree.Element:
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError as exc:
        raise WorkerError("PROVIDER_FAILED") from exc


def _text(node: ElementTree.Element) -> str:
    parts: list[str] = []
    for child in node.iter():
        name = _local(child.tag)
        if name in {"t", "text"} and child.text:
            parts.append(child.text)
        elif name in {"tab", "tabChar"}:
            parts.append("\t")
        elif name in {"br", "cr", "lineBreak"}:
            parts.append("\n")
    return "".join(parts)


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _box(x: float, y: float, width: float, height: float, page_width: float, page_height: float) -> dict[str, float] | None:
    if page_width <= 0 or page_height <= 0 or width <= 0 or height <= 0:
        return None
    left = max(0.0, min(x, page_width))
    top = max(0.0, min(y, page_height))
    right = max(left, min(x + width, page_width))
    bottom = max(top, min(y + height, page_height))
    if right <= left or bottom <= top:
        return None
    return {
        "x": left / page_width,
        "y": top / page_height,
        "width": (right - left) / page_width,
        "height": (bottom - top) / page_height,
    }


def _page(number: int, width: float, height: float) -> dict[str, Any]:
    return {"pageNumber": number, "width": width, "height": height, "blocks": [], "tables": []}


def _line(block_id: str, number: int, text: str, region: dict[str, float]) -> dict[str, Any]:
    return {"lineId": f"{block_id}-l{number}", "text": text, "boundingRegion": region}


def _word_value(node: ElementTree.Element | None, name: str, default: int) -> int:
    return _integer(_attr(_first(node, name) if node is not None else None, "val"), default)


def _table_cells(rows: list[ElementTree.Element], grid_widths: list[float]) -> tuple[list[dict[str, Any]], int]:
    """Return Word table placements, retaining horizontal and vertical merges."""
    active: dict[int, dict[str, Any]] = {}
    cells: list[dict[str, Any]] = []
    max_columns = len(grid_widths)
    for row_index, row in enumerate(rows):
        cursor = 0
        continued: set[int] = set()
        for tc in _children(row, "tc"):
            properties = _first(tc, "tcPr")
            column_span = max(1, _word_value(properties, "gridSpan", 1))
            merge = _first(properties, "vMerge") if properties is not None else None
            merge_value = _attr(merge, "val")
            if merge is not None and merge_value in (None, "continue") and cursor in active:
                origin = active[cursor]
                origin["rowSpan"] = max(origin.get("rowSpan", 1), row_index - origin["rowIndex"] + 1)
                for column in range(cursor, cursor + column_span):
                    continued.add(column)
                cursor += column_span
                continue
            while cursor in active:
                cursor += 1
            item = {
                "rowIndex": row_index,
                "columnIndex": cursor,
                "columnSpan": column_span,
                "text": _text(tc).strip(),
            }
            if merge is not None and merge_value in (None, "restart"):
                item["rowSpan"] = 1
            cells.append(item)
            if merge is not None and merge_value in (None, "restart"):
                for column in range(cursor, cursor + column_span):
                    active[column] = item
                    continued.add(column)
            cursor += column_span
            max_columns = max(max_columns, cursor)
        for column in list(active):
            if column not in continued:
                del active[column]
    return cells, max_columns


def _word_pages(root: ElementTree.Element) -> list[dict[str, Any]]:
    body = _descendant(root, "body")
    if body is None:
        return []
    section = _descendant(body, "sectPr")
    page_width = float(_word_value(section, "pgSz", 12240))
    page_height = float(_word_value(section, "pgSz", 15840))
    if section is not None:
        size = _first(section, "pgSz")
        page_width = float(_integer(_attr(size, "w"), int(page_width)))
        page_height = float(_integer(_attr(size, "h"), int(page_height)))
    margins = _first(section, "pgMar") if section is not None else None
    left = float(_integer(_attr(margins, "left"), 1440))
    right = float(_integer(_attr(margins, "right"), 1440))
    top = float(_integer(_attr(margins, "top"), 1440))
    bottom = float(_integer(_attr(margins, "bottom"), 1440))
    usable_width = max(1.0, page_width - left - right)
    pages = [_page(1, page_width, page_height)]
    cursor_y = top

    def new_page() -> None:
        nonlocal cursor_y
        pages.append(_page(len(pages) + 1, page_width, page_height))
        cursor_y = top

    for child in list(body):
        name = _local(child.tag)
        if name == "sectPr":
            continue
        if name == "p":
            properties = _first(child, "pPr")
            if _first(properties, "pageBreakBefore") is not None if properties is not None else False:
                new_page()
            text = _text(child).strip()
            if text:
                lines = [part for part in text.splitlines() if part] or [text]
                line_height = 240.0
                height = line_height * len(lines)
                if cursor_y + height > page_height - bottom and pages[-1]["blocks"]:
                    new_page()
                region = _box(left, cursor_y, usable_width, height, page_width, page_height)
                if region is not None:
                    block_id = f"p{len(pages)}-b{len(pages[-1]['blocks']) + 1}"
                    line_items = []
                    for index, line_text in enumerate(lines, 1):
                        line_region = _box(left, cursor_y + (index - 1) * line_height, usable_width, line_height, page_width, page_height)
                        if line_region is not None:
                            line_items.append(_line(block_id, index, line_text, line_region))
                    if line_items:
                        pages[-1]["blocks"].append({"blockId": block_id, "kind": "TEXT", "boundingRegion": region, "lines": line_items})
                cursor_y += height + 120.0
            if any(_local(node.tag) == "br" and _attr(node, "type") == "page" for node in child.iter()):
                new_page()
        elif name == "tbl":
            rows = _children(child, "tr")
            if not rows:
                continue
            grid = _first(child, "tblGrid")
            grid_widths = [float(max(1, _integer(_attr(column, "w"), 1440))) for column in _children(grid, "gridCol")] if grid is not None else []
            cells, column_count = _table_cells(rows, grid_widths)
            if not grid_widths:
                grid_widths = [usable_width / max(column_count, 1)] * max(column_count, 1)
            elif len(grid_widths) < column_count:
                grid_widths.extend([grid_widths[-1]] * (column_count - len(grid_widths)))
            row_height = 360.0
            table_height = row_height * len(rows)
            if cursor_y + table_height > page_height - bottom and pages[-1]["blocks"]:
                new_page()
            table_region = _box(left, cursor_y, usable_width, table_height, page_width, page_height)
            if table_region is None:
                continue
            scale = usable_width / max(sum(grid_widths), 1.0)
            edges = [0.0]
            for width in grid_widths:
                edges.append(edges[-1] + width * scale)
            for cell in cells:
                start = cell["columnIndex"]
                end = min(len(edges) - 1, start + cell.get("columnSpan", 1))
                region = _box(left + edges[start], cursor_y + cell["rowIndex"] * row_height, edges[end] - edges[start], row_height * cell.get("rowSpan", 1), page_width, page_height)
                if region is not None:
                    cell["boundingRegion"] = region
            output_cells = [{"cellId": f"p{len(pages)}-t{len(pages[-1]['tables']) + 1}-c{cell['rowIndex']}-{cell['columnIndex']}", **cell} for cell in cells if "boundingRegion" in cell]
            pages[-1]["tables"].append({"tableId": f"p{len(pages)}-t{len(pages[-1]['tables']) + 1}", "boundingRegion": table_region, "rowCount": len(rows), "columnCount": column_count, "cells": output_cells})
            cursor_y += table_height + 120.0
    return pages


def _shape_box(shape: ElementTree.Element, slide_width: float, slide_height: float) -> tuple[float, float, float, float] | None:
    transform = _descendant(shape, "xfrm")
    offset = _first(transform, "off") if transform is not None else None
    extent = _first(transform, "ext") if transform is not None else None
    if offset is None or extent is None:
        return None
    x, y = _number(_attr(offset, "x")), _number(_attr(offset, "y"))
    width, height = _number(_attr(extent, "cx")), _number(_attr(extent, "cy"))
    return (x, y, width, height) if width > 0 and height > 0 else None


def _drawing_table(frame: ElementTree.Element, slide_width: float, slide_height: float, page_number: int, table_number: int) -> dict[str, Any] | None:
    box = _shape_box(frame, slide_width, slide_height)
    graphic_table = _descendant(frame, "tbl")
    if box is None or graphic_table is None:
        return None
    x, y, width, height = box
    table_region = _box(x, y, width, height, slide_width, slide_height)
    if table_region is None:
        return None
    grid = _first(graphic_table, "tblGrid")
    column_widths = [float(max(1, _integer(_attr(column, "w"), 1))) for column in _children(grid, "gridCol")] if grid is not None else []
    rows = _children(graphic_table, "tr")
    if not column_widths:
        max_columns = max((len(_children(row, "tc")) for row in rows), default=1)
        column_widths = [1.0] * max_columns
    scale = width / max(sum(column_widths), 1.0)
    edges = [0.0]
    for column_width in column_widths:
        edges.append(edges[-1] + column_width * scale)
    row_height = height / max(len(rows), 1)
    cells: list[dict[str, Any]] = []
    for row_index, row in enumerate(rows):
        cursor = 0
        for cell in _children(row, "tc"):
            props = _first(cell, "tcPr")
            column_span = max(1, _word_value(props, "gridSpan", 1))
            start, end = cursor, min(len(edges) - 1, cursor + column_span)
            region = _box(x + edges[start], y + row_index * row_height, edges[end] - edges[start], row_height, slide_width, slide_height)
            if region is not None:
                cells.append({"cellId": f"p{page_number}-t{table_number}-c{row_index}-{cursor}", "rowIndex": row_index, "columnIndex": cursor, "columnSpan": column_span, "text": _text(cell).strip(), "boundingRegion": region})
            cursor += column_span
    return {"tableId": f"p{page_number}-t{table_number}", "boundingRegion": table_region, "rowCount": len(rows), "columnCount": len(column_widths), "cells": cells}


def _ppt_pages(archive: ZipFile) -> list[dict[str, Any]]:
    presentation = _parse_xml(archive.read("ppt/presentation.xml"))
    size = _first(presentation, "sldSz")
    slide_width = _number(_attr(size, "cx"))
    slide_height = _number(_attr(size, "cy"))
    if slide_width <= 0 or slide_height <= 0:
        raise WorkerError("PROVIDER_FAILED")
    relationships: dict[str, str] = {}
    rels_name = "ppt/_rels/presentation.xml.rels"
    if rels_name in archive.namelist():
        rels = _parse_xml(archive.read(rels_name))
        for relation in rels.iter():
            if _local(relation.tag) == "Relationship" and _attr(relation, "Id") and _attr(relation, "Target"):
                relationships[_attr(relation, "Id") or ""] = posixpath.normpath(posixpath.join("ppt", _attr(relation, "Target") or ""))
    slide_names: list[str] = []
    slide_list = _descendant(presentation, "sldIdLst")
    if slide_list is not None:
        for slide_id in _children(slide_list, "sldId"):
            relation_id = _attr(slide_id, "id")
            if relation_id in relationships and relationships[relation_id].startswith("ppt/slides/"):
                slide_names.append(relationships[relation_id])
    if not slide_names:
        slide_names = sorted((name for name in archive.namelist() if name.startswith("ppt/slides/slide") and name.endswith(".xml")), key=lambda value: _integer(value.rsplit("slide", 1)[-1].split(".", 1)[0]))
    pages: list[dict[str, Any]] = []
    for page_number, slide_name in enumerate(slide_names, 1):
        slide = _parse_xml(archive.read(slide_name))
        page = _page(page_number, slide_width, slide_height)
        tree = _descendant(slide, "spTree")
        if tree is None:
            pages.append(page)
            continue
        for child in list(tree):
            name = _local(child.tag)
            if name == "sp":
                text_body = _descendant(child, "txBody")
                text = _text(text_body).strip() if text_body is not None else ""
                box = _shape_box(child, slide_width, slide_height)
                if not text or box is None:
                    continue
                x, y, width, height = box
                region = _box(x, y, width, height, slide_width, slide_height)
                if region is None:
                    continue
                block_id = f"p{page_number}-b{len(page['blocks']) + 1}"
                paragraphs = [part for part in text.splitlines() if part] or [text]
                line_height = height / max(len(paragraphs), 1)
                lines = []
                for index, paragraph in enumerate(paragraphs, 1):
                    line_region = _box(x, y + (index - 1) * line_height, width, line_height, slide_width, slide_height)
                    if line_region is not None:
                        lines.append(_line(block_id, index, paragraph, line_region))
                if lines:
                    page["blocks"].append({"blockId": block_id, "kind": "TEXT", "boundingRegion": region, "lines": lines})
            elif name == "graphicFrame":
                table = _drawing_table(child, slide_width, slide_height, page_number, len(page["tables"]) + 1)
                if table is not None:
                    page["tables"].append(table)
        pages.append(page)
    return pages


def _column_name(value: str) -> int:
    result = 0
    for char in value.upper():
        if not "A" <= char <= "Z":
            break
        result = result * 26 + ord(char) - 64
    return result


def _cell_ref(value: str) -> tuple[int, int] | None:
    letters = "".join(char for char in value if char.isalpha())
    digits = "".join(char for char in value if char.isdigit())
    if not letters or not digits:
        return None
    row, column = _integer(digits), _column_name(letters)
    return (row, column) if row > 0 and column > 0 else None


def _shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = _parse_xml(archive.read("xl/sharedStrings.xml"))
    return [_text(item) for item in _children(root, "si")]


def _xlsx_value(cell: ElementTree.Element, shared: list[str]) -> str:
    kind = _attr(cell, "t")
    if kind == "inlineStr":
        inline = _first(cell, "is")
        return _text(inline if inline is not None else cell).strip()
    value = _first(cell, "v")
    raw = (value.text or "") if value is not None else ""
    if kind == "s":
        index = _integer(raw, -1)
        return shared[index] if 0 <= index < len(shared) else ""
    if kind == "b":
        return "TRUE" if raw == "1" else "FALSE"
    if raw:
        return raw
    formula = _first(cell, "f")
    return (formula.text or "") if formula is not None else ""


def _range_cells(reference: str) -> tuple[int, int, int, int] | None:
    parts = reference.split(":", 1)
    start, end = _cell_ref(parts[0]), _cell_ref(parts[-1] if len(parts) == 2 else parts[0])
    if start is None or end is None:
        return None
    return (min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1]))


def _xlsx_page(sheet: ElementTree.Element, shared: list[str], page_number: int, sheet_name: str) -> dict[str, Any]:
    cells: dict[tuple[int, int], str] = {}
    row_heights: dict[int, float] = {}
    column_widths: dict[int, float] = {}
    sheet_data = _descendant(sheet, "sheetData")
    if sheet_data is not None:
        for row in _children(sheet_data, "row"):
            row_number = _integer(_attr(row, "r"), 0)
            if row_number <= 0:
                continue
            row_heights[row_number] = max(1.0, _number(_attr(row, "ht"), 15.0))
            for cell in _children(row, "c"):
                reference = _cell_ref(_attr(cell, "r", "") or "")
                if reference is None:
                    continue
                value = _xlsx_value(cell, shared)
                if value or _first(cell, "f") is not None:
                    cells[reference] = value
    columns = _descendant(sheet, "cols")
    if columns is not None:
        for column in _children(columns, "col"):
            first, last = _integer(_attr(column, "min")), _integer(_attr(column, "max"))
            width = max(1.0, _number(_attr(column, "width"), 8.43))
            for index in range(first, last + 1):
                column_widths[index] = width
    merged: list[tuple[int, int, int, int]] = []
    merges = _descendant(sheet, "mergeCells")
    if merges is not None:
        merged = [item for item in (_range_cells(_attr(node, "ref", "") or "") for node in _children(merges, "mergeCell")) if item is not None]
    for first_row, first_column, last_row, last_column in merged:
        cells.setdefault((first_row, first_column), "")
    if not cells:
        return _page(page_number, 1.0, 1.0)
    max_row = max(row for row, _ in cells)
    max_column = max(column for _, column in cells)
    default_row_height = 15.0
    default_column_width = 8.43
    x_edges = [0.0]
    for column in range(1, max_column + 1):
        x_edges.append(x_edges[-1] + column_widths.get(column, default_column_width))
    y_edges = [0.0]
    for row in range(1, max_row + 1):
        y_edges.append(y_edges[-1] + row_heights.get(row, default_row_height))
    page_width, page_height = x_edges[-1], y_edges[-1]
    page = _page(page_number, page_width, page_height)
    merge_by_anchor = {(first_row, first_column): (first_row, first_column, last_row, last_column) for first_row, first_column, last_row, last_column in merged}
    covered = {(row, column) for first_row, first_column, last_row, last_column in merged for row in range(first_row, last_row + 1) for column in range(first_column, last_column + 1) if (row, column) != (first_row, first_column) for _ in [0]}
    output_cells: list[dict[str, Any]] = []
    min_row = min(row for row, _ in cells)
    min_column = min(column for _, column in cells)
    max_used_row = max(row for row, _ in cells)
    max_used_column = max(column for _, column in cells)
    table_region = _box(x_edges[min_column - 1], y_edges[min_row - 1], x_edges[max_used_column] - x_edges[min_column - 1], y_edges[max_used_row] - y_edges[min_row - 1], page_width, page_height)
    if table_region is None:
        return page
    for (row, column), value in sorted(cells.items()):
        if (row, column) in covered:
            continue
        first_row, first_column, last_row, last_column = merge_by_anchor.get((row, column), (row, column, row, column))
        region = _box(x_edges[first_column - 1], y_edges[first_row - 1], x_edges[last_column] - x_edges[first_column - 1], y_edges[last_row] - y_edges[first_row - 1], page_width, page_height)
        if region is None:
            continue
        cell = {"cellId": f"p{page_number}-t1-c{row - 1}-{column - 1}", "rowIndex": row - 1, "columnIndex": column - 1, "text": value, "boundingRegion": region}
        if last_row > first_row:
            cell["rowSpan"] = last_row - first_row + 1
        if last_column > first_column:
            cell["columnSpan"] = last_column - first_column + 1
        output_cells.append(cell)
    page["tables"].append({"tableId": f"p{page_number}-t1", "boundingRegion": table_region, "rowCount": max_row, "columnCount": max_column, "cells": output_cells})
    return page


class NativeOfficeParser:
    provider_version = "0.1.0"

    def __init__(self, provider_ref: str, media_type: str, suffix: str, converter_factory: Any = None) -> None:
        self.provider_ref = provider_ref
        self.media_type = media_type
        self.suffix = suffix
        self._converter_factory = converter_factory
        self._converter: Any = None

    def identity(self) -> dict[str, str]:
        return {"providerRef": self.provider_ref, "providerVersion": self.provider_version, "modelRef": f"native-ooxml-{self.suffix}-reader", "modelVersion": self.provider_version}

    def artifact_models(self) -> tuple[tuple[str, str], ...]:
        """Dependency-free OOXML reader: no .models cache artifact exists."""
        return ()

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": [self.media_type], "supportsTables": True, "supportsCoordinates": True, "supportsLanguages": True, "supportedLanguages": ["en", "ne", "hi", "mr"]}

    def warm(self) -> "NativeOfficeParser":
        return self

    def _parse_native(self, data: bytes) -> list[dict[str, Any]]:
        with ZipFile(io.BytesIO(data)) as archive:
            if self.media_type == DOCX:
                return _word_pages(_parse_xml(archive.read("word/document.xml")))
            if self.media_type == PPTX:
                return _ppt_pages(archive)
            if self.media_type == XLSX:
                workbook = _parse_xml(archive.read("xl/workbook.xml"))
                shared = _shared_strings(archive)
                relationships: dict[str, str] = {}
                rels_name = "xl/_rels/workbook.xml.rels"
                if rels_name in archive.namelist():
                    rels = _parse_xml(archive.read(rels_name))
                    for relation in rels.iter():
                        if _local(relation.tag) == "Relationship" and _attr(relation, "Id") and _attr(relation, "Target"):
                            target = _attr(relation, "Target") or ""
                            # Absolute targets are package-root-relative per the
                            # OOXML spec; relative targets resolve against xl/.
                            resolved = target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target)
                            relationships[_attr(relation, "Id") or ""] = posixpath.normpath(resolved)
                pages = []
                sheets = _descendant(workbook, "sheets")
                for index, sheet in enumerate(_children(sheets, "sheet") if sheets is not None else [], 1):
                    relation_id = _attr(sheet, "id")
                    target = relationships.get(relation_id or "", f"xl/worksheets/sheet{index}.xml")
                    if target not in archive.namelist():
                        raise WorkerError("PROVIDER_FAILED")
                    pages.append(_xlsx_page(_parse_xml(archive.read(target)), shared, index, _attr(sheet, "name", f"Sheet{index}") or f"Sheet{index}"))
                return pages
        raise WorkerError("PROVIDER_FAILED")

    def parse(self, data: bytes, *, media_type: str, limits: dict[str, int], deadline: Deadline, token: CancellationToken, language: str | None = None) -> dict[str, Any]:
        if media_type != self.media_type:
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        validate_ooxml(data, media_type, OoxmlLimits(limits.get("maxOfficeArchiveMembers", 10_000), limits.get("maxOfficeUncompressedBytes", 256 * 1024 * 1024), limits.get("maxOfficeMemberBytes", 64 * 1024 * 1024), limits.get("maxOfficeCompressionRatio", 100)))
        token.raise_if_cancelled()
        deadline.require_remaining()
        try:
            if self._converter_factory is not None:
                from .docling_parser import _doc_to_pages
                from ..mapping.parsed_document import map_generic_pages
                if self._converter is None:
                    self._converter = self._converter_factory()
                from docling.datamodel.base_models import DocumentStream
                result = self._converter.convert(DocumentStream(name=f"document.{self.suffix}", stream=io.BytesIO(data)))
                output = map_generic_pages(_doc_to_pages(getattr(result, "document", result)), self.identity(), max_pages=limits.get("maxPages", 500))
            else:
                output = {"pages": self._parse_native(data), "providerProvenance": self.identity(), "quality": {}}
            if len(output.get("pages", [])) > limits.get("maxPages", 500):
                raise WorkerError("LIMIT_EXCEEDED")
            # Width and height are internal layout inputs, not fields in the
            # normalized ParsedDocument page contract.
            for page in output.get("pages", []):
                page.pop("width", None)
                page.pop("height", None)
            token.raise_if_cancelled()
            return output
        except WorkerError:
            raise
        except (KeyError, OSError, ValueError, TypeError, ElementTree.ParseError) as exc:
            raise WorkerError("PROVIDER_FAILED", provider_ref=self.provider_ref) from exc


class DocxParser(NativeOfficeParser):
    def __init__(self, converter_factory: Any = None) -> None:
        super().__init__("ghatana.ooxml-docx", DOCX, "docx", converter_factory)


class PptxParser(NativeOfficeParser):
    def __init__(self, converter_factory: Any = None) -> None:
        super().__init__("ghatana.ooxml-pptx", PPTX, "pptx", converter_factory)


class XlsxParser(NativeOfficeParser):
    def __init__(self, converter_factory: Any = None) -> None:
        super().__init__("ghatana.ooxml-xlsx", XLSX, "xlsx", converter_factory)
