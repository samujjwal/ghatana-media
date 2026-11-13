from __future__ import annotations

import json

from ..errors import WorkerError


def validate_projection(descriptor: object) -> dict:
    if not isinstance(descriptor, dict) or set(descriptor) != {"version", "pageCount", "blockKindCounts", "tableShapes", "normalizedBlockGeometry", "semanticTextBasis", "structuralFingerprint"} or descriptor.get("version") != "document-structure-embedding.v1":
        raise WorkerError("INVALID_REQUEST")
    if not isinstance(descriptor["pageCount"], int) or descriptor["pageCount"] < 0 or not isinstance(descriptor["blockKindCounts"], dict) or any(not isinstance(key, str) or not isinstance(value, int) or value < 0 for key, value in descriptor["blockKindCounts"].items()):
        raise WorkerError("INVALID_REQUEST")
    if not isinstance(descriptor["tableShapes"], list) or any(not isinstance(item, dict) or set(item) != {"rows", "columns"} or not isinstance(item["rows"], int) or not isinstance(item["columns"], int) or item["rows"] < 0 or item["columns"] < 0 for item in descriptor["tableShapes"]):
        raise WorkerError("INVALID_REQUEST")
    if not isinstance(descriptor["normalizedBlockGeometry"], list):
        raise WorkerError("INVALID_REQUEST")
    for item in descriptor["normalizedBlockGeometry"]:
        if not isinstance(item, dict) or set(item) != {"pageNumber", "x", "y", "width", "height"} or not isinstance(item["pageNumber"], int) or any(not isinstance(item[key], (int, float)) for key in ("x", "y", "width", "height")):
            raise WorkerError("INVALID_REQUEST")
    if not isinstance(descriptor["semanticTextBasis"], str) or len(descriptor["semanticTextBasis"]) > 2_000_000 or not isinstance(descriptor["structuralFingerprint"], str) or len(descriptor["structuralFingerprint"]) > 256:
        raise WorkerError("INVALID_REQUEST")
    return descriptor


def canonical_projection(descriptor: dict) -> str:
    descriptor = validate_projection(descriptor)
    geometry = [{key: item[key] for key in ("pageNumber", "x", "y", "width", "height")} for item in descriptor.get("normalizedBlockGeometry", [])]
    payload = {
        "version": "document-structure-embedding.v1",
        "pageCount": descriptor.get("pageCount", 0),
        "blockKindCounts": {key: descriptor.get("blockKindCounts", {})[key] for key in sorted(descriptor.get("blockKindCounts", {}))},
        "tableShapes": descriptor.get("tableShapes", []),
        "normalizedBlockGeometry": geometry,
        "semanticTextBasis": descriptor.get("semanticTextBasis", ""),
        "structuralFingerprint": descriptor.get("structuralFingerprint", ""),
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
