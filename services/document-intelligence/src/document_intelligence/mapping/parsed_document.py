from __future__ import annotations

import math
from typing import Any, Iterable

from ..errors import WorkerError


def normalized_box(x: float, y: float, width: float, height: float) -> dict[str, float]:
    values = (x, y, width, height)
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in values) or width < 0 or height < 0 or x < 0 or y < 0 or x + width > 1 or y + height > 1:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    return {"x": float(x), "y": float(y), "width": float(width), "height": float(height)}


def _provider_box(raw: Any, page_width: float, page_height: float, origin: str = "top-left") -> dict[str, float] | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        if {"x", "y", "width", "height"}.issubset(raw):
            x, y, width, height = (float(raw[key]) for key in ("x", "y", "width", "height"))
        elif {"l", "t", "r", "b"}.issubset(raw):
            x, y, width, height = float(raw["l"]), float(raw["t"]), float(raw["r"]) - float(raw["l"]), float(raw["b"]) - float(raw["t"])
        else:
            return None
    elif isinstance(raw, (list, tuple)) and len(raw) == 4:
        x, y, width, height = (float(value) for value in raw)
    else:
        return None
    if page_width <= 0 or page_height <= 0:
        return None
    if origin.lower() in {"bottom-left", "bottomleft"}:
        y = page_height - y - height
    return normalized_box(x / page_width, y / page_height, width / page_width, height / page_height)


def map_lines(lines: Iterable[dict[str, Any]], page_number: int, block_id: str, page_width: float, page_height: float) -> list[dict[str, Any]]:
    mapped: list[dict[str, Any]] = []
    for index, line in enumerate(lines, 1):
        text = line.get("text")
        box = _provider_box(line.get("boundingRegion", line.get("bbox")), page_width, page_height, line.get("coordinateOrigin", "top-left"))
        if not isinstance(text, str) or not text or box is None:
            continue
        item: dict[str, Any] = {"lineId": f"{block_id}-l{index}", "text": text, "boundingRegion": box}
        confidence = line.get("confidence")
        if isinstance(confidence, (int, float)) and math.isfinite(confidence) and 0 <= confidence <= 1:
            item["confidence"] = float(confidence)
        if isinstance(line.get("languageTag"), str):
            item["languageTag"] = line["languageTag"]
        mapped.append(item)
    return mapped


def map_tables(tables: Iterable[dict[str, Any]], page_number: int, page_width: float, page_height: float) -> list[dict[str, Any]]:
    mapped: list[dict[str, Any]] = []
    for table_index, table in enumerate(tables, 1):
        table_box = _provider_box(table.get("boundingRegion", table.get("bbox")), page_width, page_height, table.get("coordinateOrigin", "top-left"))
        if table_box is None:
            continue
        cells: list[dict[str, Any]] = []
        for cell in sorted(table.get("cells", []), key=lambda value: (int(value.get("rowIndex", 0)), int(value.get("columnIndex", 0)))):
            cell_box = _provider_box(cell.get("boundingRegion", cell.get("bbox")), page_width, page_height, cell.get("coordinateOrigin", "top-left"))
            if cell_box is None or not isinstance(cell.get("text"), str):
                continue
            row_index = int(cell.get("rowIndex", 0)); column_index = int(cell.get("columnIndex", 0))
            item: dict[str, Any] = {"cellId": f"p{page_number}-t{table_index}-c{row_index}-{column_index}", "rowIndex": row_index, "columnIndex": column_index, "text": cell["text"], "boundingRegion": cell_box}
            for key in ("rowSpan", "columnSpan"):
                if isinstance(cell.get(key), int) and cell[key] > 0:
                    item[key] = cell[key]
            if isinstance(cell.get("confidence"), (int, float)) and math.isfinite(cell["confidence"]) and 0 <= cell["confidence"] <= 1:
                item["confidence"] = float(cell["confidence"])
            cells.append(item)
        row_count = int(table.get("rowCount", max((cell["rowIndex"] for cell in cells), default=-1) + 1))
        column_count = int(table.get("columnCount", max((cell["columnIndex"] for cell in cells), default=-1) + 1))
        item = {"tableId": f"p{page_number}-t{table_index}", "boundingRegion": table_box, "rowCount": row_count, "columnCount": column_count, "cells": cells}
        if isinstance(table.get("headers"), list) and all(isinstance(header, str) for header in table["headers"]):
            item["headers"] = table["headers"]
        mapped.append(item)
    return mapped


def map_generic_pages(pages: Iterable[dict[str, Any]], provider_identity: dict[str, str], *, max_pages: int = 500) -> dict[str, Any]:
    output_pages: list[dict[str, Any]] = []
    for page_index, page in enumerate(pages, 1):
        if page_index > max_pages:
            raise WorkerError("LIMIT_EXCEEDED")
        page_number = int(page.get("pageNumber", page_index))
        width = float(page.get("width", page.get("pageWidth", 1)))
        height = float(page.get("height", page.get("pageHeight", 1)))
        blocks: list[dict[str, Any]] = []
        for block_index, block in enumerate(page.get("blocks", []), 1):
            block_id = f"p{page_number}-b{block_index}"
            box = _provider_box(block.get("boundingRegion", block.get("bbox")), width, height, block.get("coordinateOrigin", "top-left"))
            if box is None:
                continue
            lines = map_lines(block.get("lines", []), page_number, block_id, width, height)
            if not lines and isinstance(block.get("text"), str) and block["text"]:
                lines = map_lines([{"text": block["text"], "bbox": block.get("bbox")}], page_number, block_id, width, height)
            item: dict[str, Any] = {"blockId": block_id, "kind": block.get("kind", "TEXT"), "boundingRegion": box, "lines": lines}
            confidence = block.get("confidence")
            if isinstance(confidence, (int, float)) and math.isfinite(confidence) and 0 <= confidence <= 1:
                item["confidence"] = float(confidence)
            blocks.append(item)
        output_pages.append({"pageNumber": page_number, "blocks": blocks, "tables": map_tables(page.get("tables", []), page_number, width, height)})
    return {"pages": output_pages, "providerProvenance": provider_identity, "quality": {}}
