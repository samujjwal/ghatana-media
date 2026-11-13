"""Shared learning-authority utilities: canonical JSON, digests, atomic writes,
and a focused validator for the checked-in learning schemas.

The worker does not depend on ``jsonschema``; ``validate`` implements exactly
the schema constructs used by ``learning/schemas/*.schema.json`` and fails
closed on anything outside them.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

LEARNING_ROOT = Path(__file__).resolve().parent
SCHEMAS = LEARNING_ROOT / "schemas"

FINGERPRINT_RE = re.compile(r"^sha256:[a-f0-9]{64}$")


def canonical_json(value: Any) -> str:
    """Deterministic JSON: sorted object keys, compact separators, UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    """`sha256:` digest over the canonical JSON form of ``value``."""
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write_text(path: Path, text: str) -> None:
    """Temp-file -> rename so a crash never publishes a partial artifact."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, canonical_json(value) + "\n")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_schema(name: str) -> dict:
    return load_json(SCHEMAS / name)


def _fail(path: str, message: str) -> None:
    raise ValueError(f"schema violation at {path or '<root>'}: {message}")


def _check_type(instance: Any, expected: Any, path: str) -> None:
    types = expected if isinstance(expected, list) else [expected]
    for t in types:
        if t == "object" and isinstance(instance, dict):
            return
        if t == "array" and isinstance(instance, list):
            return
        if t == "string" and isinstance(instance, str):
            return
        if t == "integer" and isinstance(instance, int) and not isinstance(instance, bool):
            return
        if t == "number" and isinstance(instance, (int, float)) and not isinstance(instance, bool):
            return
        if t == "boolean" and isinstance(instance, bool):
            return
        if t == "null" and instance is None:
            return
    _fail(path, f"expected type {expected}, got {type(instance).__name__}")


def _resolve(ref: str, root: dict) -> dict:
    if not ref.startswith("#/"):
        _fail("", f"unsupported $ref {ref}")
    node: Any = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def _validate(instance: Any, schema: dict, path: str, root: dict) -> None:
    if "$ref" in schema:
        _validate(instance, _resolve(schema["$ref"], root), path, root)
        return
    if "oneOf" in schema:
        errors = []
        for sub in schema["oneOf"]:
            try:
                _validate(instance, sub, path, root)
                return
            except ValueError as exc:
                errors.append(str(exc))
        _fail(path, "no oneOf branch matched: " + "; ".join(errors))
    if "type" in schema:
        _check_type(instance, schema["type"], path)
    if "const" in schema and instance != schema["const"]:
        _fail(path, f"expected const {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        _fail(path, f"value {instance!r} not in enum {schema['enum']}")
    if isinstance(instance, str):
        if "pattern" in schema and not re.match(schema["pattern"], instance):
            _fail(path, f"string {instance!r} fails pattern {schema['pattern']}")
        if "minLength" in schema and len(instance) < schema["minLength"]:
            _fail(path, "string shorter than minLength")
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            _fail(path, f"{instance} < minimum {schema['minimum']}")
        if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
            _fail(path, f"{instance} <= exclusiveMinimum {schema['exclusiveMinimum']}")
        if "exclusiveMaximum" in schema and instance >= schema["exclusiveMaximum"]:
            _fail(path, f"{instance} >= exclusiveMaximum {schema['exclusiveMaximum']}")
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            _fail(path, "fewer items than minItems")
        item_schema = schema.get("items")
        if item_schema is not None:
            for index, item in enumerate(instance):
                _validate(item, item_schema, f"{path}[{index}]", root)
    if isinstance(instance, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in instance:
                _fail(path, f"missing required property {key!r}")
        properties = schema.get("properties", {})
        additional = schema.get("additionalProperties", True)
        for key, value in instance.items():
            if key in properties:
                _validate(value, properties[key], f"{path}.{key}", root)
            elif additional is False:
                _fail(path, f"unexpected property {key!r}")
            elif isinstance(additional, dict):
                _validate(value, additional, f"{path}.{key}", root)
        if "minProperties" in schema and len(instance) < schema["minProperties"]:
            _fail(path, "fewer properties than minProperties")


def validate(instance: Any, schema_name: str) -> dict:
    """Validate ``instance`` against a checked-in schema; returns the instance.

    Fails closed (ValueError) on any violation. ``format`` keywords are
    informational and not enforced here.
    """
    schema = load_schema(schema_name)
    _validate(instance, schema, "", schema)
    return instance
