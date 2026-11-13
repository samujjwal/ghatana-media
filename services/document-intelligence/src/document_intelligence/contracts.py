from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Mapping

from .errors import WorkerError
from .limits import Limits, require_limit

PROTOCOL_VERSION = "document-intelligence.v1"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$")
_OPERATION_GENERATION = re.compile(r"^[0-9a-f]{32}$")
_MODEL_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?:/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})?$")
_MEDIA_TYPES = {"application/pdf", "image/png", "image/jpeg"}


def _object(value: Any, allowed: set[str], required: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError("INVALID_REQUEST")
    if set(value) - allowed or not required.issubset(value):
        raise WorkerError("INVALID_REQUEST")
    return value


def _identifier(value: Any) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise WorkerError("INVALID_REQUEST")
    return value


def parse_operation_generation(value: Any) -> str:
    if not isinstance(value, str) or not _OPERATION_GENERATION.fullmatch(value):
        raise WorkerError("INVALID_REQUEST")
    return value


def _timeout(value: Any, limits: Limits) -> int:
    if not isinstance(value, int) or value <= 0 or value > limits.max_operation_timeout_ms:
        raise WorkerError("INVALID_REQUEST")
    return value


@dataclass(frozen=True)
class RequestMetadata:
    operation_id: str
    provider_ref: str
    media_type: str | None
    language_hint: str | None
    timeout_ms: int
    limits: Mapping[str, int]
    operation_generation: str | None = None

    @classmethod
    def parse(
        cls,
        raw: Any,
        limits: Limits,
        *,
        media_type_required: bool,
        allowed_media_types: tuple[str, ...] = tuple(_MEDIA_TYPES),
        allowed_languages: tuple[str, ...] = ("en", "ne"),
        operation_generation_header: str | None = None,
    ) -> "RequestMetadata":
        value = _object(raw, {"protocolVersion", "operationId", "operationGeneration", "providerRef", "mediaType", "languageHint", "timeoutMs", "limits"}, {"protocolVersion", "operationId", "providerRef", "timeoutMs", "limits"})
        if value["protocolVersion"] != PROTOCOL_VERSION:
            raise WorkerError("INVALID_REQUEST")
        operation_id = _identifier(value["operationId"])
        raw_generation = value.get("operationGeneration")
        if raw_generation is not None:
            raw_generation = parse_operation_generation(raw_generation)
        if operation_generation_header is not None:
            operation_generation_header = parse_operation_generation(operation_generation_header)
        if raw_generation is not None and operation_generation_header is not None and raw_generation != operation_generation_header:
            raise WorkerError("INVALID_REQUEST")
        operation_generation = raw_generation or operation_generation_header
        provider_ref = _identifier(value["providerRef"])
        media_type = value.get("mediaType")
        if media_type_required and (not isinstance(media_type, str) or media_type not in allowed_media_types):
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE")
        language = value.get("languageHint")
        if language is not None:
            if not isinstance(language, str):
                raise WorkerError("UNSUPPORTED_LANGUAGE")
            # I6-58: language/hint inputs are NFC-normalized at the input
            # boundary (never document text).  Canonical lowercase tags are
            # NFC-stable, so every previously valid hint is unchanged.
            language = unicodedata.normalize("NFC", language)
            if language not in allowed_languages:
                raise WorkerError("UNSUPPORTED_LANGUAGE")
        raw_limits = value["limits"]
        if not isinstance(raw_limits, dict) or any(not isinstance(k, str) or not isinstance(v, int) for k, v in raw_limits.items()):
            raise WorkerError("INVALID_REQUEST")
        return cls(operation_id, provider_ref, media_type, language, _timeout(value["timeoutMs"], limits), dict(raw_limits), operation_generation)


@dataclass(frozen=True)
class ParsedLine:
    page_number: int
    block_id: str
    line_id: str
    text: str
    bounding_region: dict[str, Any]


def response(operation_id: str, provider_ref: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    return {**payload, "protocolVersion": PROTOCOL_VERSION, "operationId": operation_id, "providerRef": provider_ref}


def validate_provider_output(value: Any, limits: Limits) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if value.get("protocolVersion") != PROTOCOL_VERSION:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if not isinstance(value.get("operationId"), str) or not _IDENTIFIER.fullmatch(value["operationId"]):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if not isinstance(value.get("providerRef"), str) or not _IDENTIFIER.fullmatch(value["providerRef"]):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if "pages" in value:
        _validate_parsed_output(value, limits)
    elif "candidates" in value:
        _validate_extraction_output(value, limits)
    elif "dimensions" in value or "values" in value:
        _validate_embedding_output(value, limits)
    else:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    try:
        serialized_size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise WorkerError("INVALID_PROVIDER_OUTPUT") from exc
    if serialized_size > limits.max_serialized_response_bytes:
        raise WorkerError("LIMIT_EXCEEDED")
    return value


def _box(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"x", "y", "width", "height"}:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    numbers = [value[key] for key in ("x", "y", "width", "height")]
    if any(not isinstance(item, (int, float)) or not math.isfinite(item) for item in numbers) or value["x"] < 0 or value["y"] < 0 or value["width"] < 0 or value["height"] < 0 or value["x"] + value["width"] > 1 or value["y"] + value["height"] > 1:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")


def _validate_identity(value: Any) -> None:
    if not isinstance(value, dict) or set(value) not in ({"providerRef", "providerVersion"}, {"providerRef", "providerVersion", "modelRef", "modelVersion"}):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if not isinstance(value["providerRef"], str) or not _IDENTIFIER.fullmatch(value["providerRef"]) or not isinstance(value["providerVersion"], str) or not _IDENTIFIER.fullmatch(value["providerVersion"]):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if "modelRef" in value and (not isinstance(value["modelRef"], str) or not _MODEL_REF.fullmatch(value["modelRef"])):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if "modelVersion" in value and (not isinstance(value["modelVersion"], str) or not _IDENTIFIER.fullmatch(value["modelVersion"])):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")


def _validate_parsed_output(value: dict[str, Any], limits: Limits) -> None:
    allowed = {"protocolVersion", "operationId", "providerRef", "pages", "providerProvenance", "quality", "languageTag"}
    if set(value) - allowed or not {"pages", "providerProvenance", "quality"}.issubset(value) or not isinstance(value["pages"], list) or len(value["pages"]) > limits.max_pages:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    _validate_identity(value["providerProvenance"])
    if value["providerProvenance"].get("providerRef") != value["providerRef"]:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if not isinstance(value["quality"], dict) or set(value["quality"]) - {"parseConfidence", "completeness", "warnings"}:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    for key in ("parseConfidence", "completeness"):
        if key in value["quality"] and (not isinstance(value["quality"][key], (int, float)) or not math.isfinite(value["quality"][key]) or not 0 <= value["quality"][key] <= 1):
            raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if "warnings" in value["quality"] and (not isinstance(value["quality"]["warnings"], list) or any(not isinstance(item, str) for item in value["quality"]["warnings"])):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    block_count = 0
    line_count = 0
    table_count = 0
    table_row_count = 0
    table_cell_count = 0
    region_count = 0
    text_characters = 0
    for page in value["pages"]:
        if not isinstance(page, dict) or set(page) - {"pageNumber", "blocks", "tables", "languageTag"} or not {"pageNumber", "blocks", "tables"}.issubset(page) or not isinstance(page.get("pageNumber"), int) or page["pageNumber"] < 1 or not isinstance(page.get("blocks"), list) or not isinstance(page.get("tables"), list):
            raise WorkerError("INVALID_PROVIDER_OUTPUT")
        if len(page["blocks"]) > limits.max_blocks:
            raise WorkerError("LIMIT_EXCEEDED")
        block_count += len(page["blocks"])
        region_count += len(page["blocks"])
        for block in page["blocks"]:
            if not isinstance(block, dict) or set(block) - {"blockId", "kind", "boundingRegion", "lines", "confidence", "languageTag"} or not {"blockId", "kind", "boundingRegion", "lines"}.issubset(block) or not isinstance(block.get("blockId"), str) or not isinstance(block.get("kind"), str) or not isinstance(block.get("lines"), list):
                raise WorkerError("INVALID_PROVIDER_OUTPUT")
            _box(block.get("boundingRegion"))
            for key in ("confidence",):
                if key in block and (not isinstance(block[key], (int, float)) or not math.isfinite(block[key]) or not 0 <= block[key] <= 1):
                    raise WorkerError("INVALID_PROVIDER_OUTPUT")
            if len(block["lines"]) > limits.max_lines:
                raise WorkerError("LIMIT_EXCEEDED")
            line_count += len(block["lines"])
            region_count += len(block["lines"])
            for line in block["lines"]:
                if not isinstance(line, dict) or set(line) - {"lineId", "text", "boundingRegion", "confidence", "languageTag"} or not {"lineId", "text", "boundingRegion"}.issubset(line) or not isinstance(line.get("lineId"), str) or not isinstance(line.get("text"), str) or len(line["text"]) > limits.max_text_characters:
                    raise WorkerError("INVALID_PROVIDER_OUTPUT")
                _box(line.get("boundingRegion"))
                if "confidence" in line and (not isinstance(line["confidence"], (int, float)) or not math.isfinite(line["confidence"]) or not 0 <= line["confidence"] <= 1):
                    raise WorkerError("INVALID_PROVIDER_OUTPUT")
                text_characters += len(line["text"])
        for table in page["tables"]:
            if not isinstance(table, dict) or set(table) - {"tableId", "boundingRegion", "rowCount", "columnCount", "headers", "cells", "confidence"} or not {"tableId", "boundingRegion", "rowCount", "columnCount", "cells"}.issubset(table) or not isinstance(table.get("tableId"), str) or not isinstance(table.get("rowCount"), int) or not isinstance(table.get("columnCount"), int) or not isinstance(table.get("cells"), list):
                raise WorkerError("INVALID_PROVIDER_OUTPUT")
            _box(table.get("boundingRegion"))
            table_count += 1
            region_count += 1
            table_row_count += table["rowCount"]
            table_cell_count += len(table["cells"])
            if table["rowCount"] * table["columnCount"] > limits.max_table_cells:
                raise WorkerError("LIMIT_EXCEEDED")
            if table["rowCount"] < 0 or table["columnCount"] < 0 or len(table["cells"]) > limits.max_lines:
                raise WorkerError("LIMIT_EXCEEDED")
            if "confidence" in table and (not isinstance(table["confidence"], (int, float)) or not math.isfinite(table["confidence"]) or not 0 <= table["confidence"] <= 1):
                raise WorkerError("INVALID_PROVIDER_OUTPUT")
            for cell in table["cells"]:
                if not isinstance(cell, dict) or set(cell) - {"cellId", "rowIndex", "columnIndex", "rowSpan", "columnSpan", "text", "boundingRegion", "confidence"} or not {"cellId", "rowIndex", "columnIndex", "text", "boundingRegion"}.issubset(cell) or not isinstance(cell.get("cellId"), str) or not isinstance(cell.get("rowIndex"), int) or not isinstance(cell.get("columnIndex"), int) or not isinstance(cell.get("text"), str):
                    raise WorkerError("INVALID_PROVIDER_OUTPUT")
                _box(cell.get("boundingRegion"))
                if cell["rowIndex"] < 0 or cell["columnIndex"] < 0 or "confidence" in cell and (not isinstance(cell["confidence"], (int, float)) or not math.isfinite(cell["confidence"]) or not 0 <= cell["confidence"] <= 1):
                    raise WorkerError("INVALID_PROVIDER_OUTPUT")
                region_count += 1
                text_characters += len(cell["text"])
    if (
        block_count > limits.max_blocks
        or line_count > limits.max_lines
        or table_count > limits.max_tables
        or table_row_count > limits.max_table_rows
        or table_cell_count > limits.max_table_cells
        or region_count > limits.max_regions
        or text_characters > limits.max_text_characters
    ):
        raise WorkerError("LIMIT_EXCEEDED")


def _validate_extraction_output(value: dict[str, Any], limits: Limits) -> None:
    if set(value) != {"protocolVersion", "operationId", "providerRef", "candidates", "provider"} or not isinstance(value.get("candidates"), list) or len(value["candidates"]) > limits.max_candidates:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    _validate_identity(value["provider"])
    if value["provider"].get("providerRef") != value["providerRef"]:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    evidence_span_count = 0
    for candidate in value["candidates"]:
        if not isinstance(candidate, dict) or set(candidate) != {"fieldId", "value", "source", "confidence", "evidence", "provider"} or not isinstance(candidate.get("fieldId"), str) or not _IDENTIFIER.fullmatch(candidate["fieldId"]) or candidate.get("source") != "MODEL" or not isinstance(candidate.get("evidence"), list) or len(candidate["evidence"]) > limits.max_evidence:
            raise WorkerError("INVALID_PROVIDER_OUTPUT")
        _validate_identity(candidate["provider"])
        if candidate["provider"].get("providerRef") != value["providerRef"]:
            raise WorkerError("INVALID_PROVIDER_OUTPUT")
        if not isinstance(candidate.get("confidence"), (int, float)) or not math.isfinite(candidate["confidence"]) or not 0 <= candidate["confidence"] <= 1 or not isinstance(candidate.get("value"), dict) or set(candidate["value"]) != {"kind", "value"} or candidate["value"].get("kind") not in {"TEXT", "IDENTIFIER"} or not isinstance(candidate["value"].get("value"), str) or len(candidate["value"]["value"]) > limits.max_text_characters:
            raise WorkerError("INVALID_PROVIDER_OUTPUT")
        for evidence in candidate["evidence"]:
            evidence_span_count += 1
            if not isinstance(evidence, dict) or set(evidence) - {"pageNumber", "blockId", "lineId", "boundingRegion", "textSpan"} or not isinstance(evidence.get("pageNumber"), int) or evidence["pageNumber"] < 1:
                raise WorkerError("INVALID_PROVIDER_OUTPUT")
            if evidence.get("boundingRegion") is not None:
                _box(evidence["boundingRegion"])
            if evidence.get("textSpan") is not None:
                span = evidence["textSpan"]
                if not isinstance(span, dict) or set(span) != {"start", "end"} or not isinstance(span.get("start"), int) or not isinstance(span.get("end"), int) or span["start"] < 0 or span["end"] < span["start"] or span["end"] > limits.max_text_characters:
                    raise WorkerError("INVALID_PROVIDER_OUTPUT")
    if evidence_span_count > limits.max_evidence_spans:
        raise WorkerError("LIMIT_EXCEEDED")


def _validate_embedding_output(value: dict[str, Any], limits: Limits) -> None:
    if set(value) != {"protocolVersion", "operationId", "providerRef", "model", "dimensions", "values"} or value.get("dimensions") != 384 or value.get("dimensions") > limits.max_embedding_dimensions or not isinstance(value.get("values"), list) or len(value["values"]) != 384 or any(not isinstance(item, (int, float)) or not math.isfinite(item) for item in value["values"]):
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
    _validate_identity(value["model"])
    if value["model"].get("providerRef") != value["providerRef"]:
        raise WorkerError("INVALID_PROVIDER_OUTPUT")
