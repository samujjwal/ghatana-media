#!/usr/bin/env python3
"""Validate the canonical OCR mapping and its generated projections.

The checker is intentionally compare-only by default.  ``--write`` is the
explicit projection-generation operation; normal verification fails when a
projection was hand-edited or the canonical mapping drifted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
MAPPING_PATH = ROOT / "config/ocr-mapping.v1.yaml"
_ENV_RE = re.compile(r"(?:os\.getenv|os\.environ\.get)\(\s*['\"]([^'\"]+)")
_ENV_INDEX_RE = re.compile(r"os\.environ\[\s*['\"]([^'\"]+)['\"]\s*\]")
_COMMAND_RE = re.compile(r"subprocess\.(?:run|Popen|check_output)\(\s*\[?\s*['\"]([^'\"]+)")
_MODEL_RE = re.compile(r"(?:models/[^'\"\s]+|[^'\"\s]+\.(?:onnx|safetensors|pdmodel|pdiparams|traineddata))")


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _fingerprint(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _source_files(selector: str) -> list[Path]:
    path = (ROOT / selector).resolve()
    if path.is_dir():
        return sorted(item for item in path.rglob("*") if item.is_file())
    return [path] if path.is_file() else []


def _diagnostics(mapping: dict[str, Any]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for item in mapping["mappings"]:
        declared = item["runtimeInputs"]
        env_names = {entry.get("name") for entry in declared if entry.get("kind") == "environment"}
        native_names = {str(entry.get("name", "")).lower() for entry in declared if entry.get("kind") == "native_dependency"}
        model_paths = {str(entry.get("path", "")) for entry in declared if entry.get("kind") == "model_asset"}
        for selector in item["sourceSelectors"]:
            for source in _source_files(selector):
                text = source.read_text(encoding="utf-8", errors="replace")
                for name in {*_ENV_RE.findall(text), *_ENV_INDEX_RE.findall(text)}:
                    if name not in env_names:
                        findings.append({"code": "UNDECLARED_RUNTIME_INPUT", "mappingId": item["mappingId"], "source": str(source.relative_to(ROOT)), "input": name})
                for command in _COMMAND_RE.findall(text):
                    if command.lower() not in native_names and Path(command).name.lower() not in native_names:
                        findings.append({"code": "UNDECLARED_NATIVE_DEPENDENCY", "mappingId": item["mappingId"], "source": str(source.relative_to(ROOT)), "input": command})
                for asset in _MODEL_RE.findall(text):
                    if asset.startswith("models/") and asset not in model_paths and not any(asset.endswith(Path(path).name) for path in model_paths):
                        findings.append({"code": "UNDECLARED_MODEL_ASSET", "mappingId": item["mappingId"], "source": str(source.relative_to(ROOT)), "input": asset})
    return sorted(findings, key=lambda value: (value["code"], value["mappingId"], value["source"], value["input"]))


def build_projections(mapping: dict[str, Any]) -> dict[str, dict[str, Any]]:
    source_digest = _fingerprint({"canonicalSource": mapping["canonicalSource"], "mappings": mapping["mappings"]})
    profile = {
        "schemaVersion": "document-intelligence.ocr-profile-material.v1",
        "producerVersion": mapping["producerVersion"],
        "mappingFingerprint": source_digest,
        "profiles": {
            "default": ["provider.docling", "provider.paddleocr", "provider.gliner", "provider.minilm"],
            "increment4a": ["provider.docling", "provider.paddleocr", "provider.gliner", "provider.minilm"],
            "increment6": [item["mappingId"] for item in mapping["mappings"]],
        },
    }
    proofs = {
        "schemaVersion": "document-intelligence.ocr-proof-inputs.v1",
        "producerVersion": mapping["producerVersion"],
        "mappingFingerprint": source_digest,
        "producers": {
            item["mappingId"]: {
                "producerAuthority": item["producerAuthority"],
                "semanticClass": item["semanticClass"],
                "sourceSelectors": item["sourceSelectors"],
                "runtimeInputs": item["runtimeInputs"],
            }
            for item in mapping["mappings"]
        },
    }
    invalidation = {
        "schemaVersion": "document-intelligence.ocr-invalidation-graph.v1",
        "producerVersion": mapping["producerVersion"],
        "mappingFingerprint": source_digest,
        "edges": [
            {
                "mappingId": item["mappingId"],
                "producerAuthority": item["producerAuthority"],
                "affectedProofClasses": item["affectedProofClasses"],
                "runtimeInputIds": [entry["inputId"] for entry in item["runtimeInputs"]],
            }
            for item in mapping["mappings"]
        ],
    }
    diagnostics = {
        "schemaVersion": "document-intelligence.ocr-mapping-diagnostics.v1",
        "producerVersion": mapping["producerVersion"],
        "mappingFingerprint": source_digest,
        "findings": _diagnostics(mapping),
    }
    return {
        "profileMaterial": profile,
        "proofInputs": proofs,
        "invalidationGraph": invalidation,
        "diagnostics": diagnostics,
    }


def validate_mapping(mapping: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if mapping.get("schemaVersion") != "document-intelligence.ocr-mapping.v1":
        errors.append("schemaVersion must be document-intelligence.ocr-mapping.v1")
    canonical_source = ROOT / str(mapping.get("canonicalSource", ""))
    if not canonical_source.is_file():
        errors.append(f"canonical source is missing: {mapping.get('canonicalSource')}")
    targets = mapping.get("projectionTargets")
    if not isinstance(targets, dict) or set(targets) != {"profileMaterial", "proofInputs", "invalidationGraph", "diagnostics"}:
        errors.append("projectionTargets must declare every generated projection")
    entries = mapping.get("mappings")
    if not isinstance(entries, list) or not entries:
        errors.append("mappings must be a non-empty list")
        return errors
    ids: set[str] = set()
    for item in entries:
        if not isinstance(item, dict):
            errors.append("mapping entry is not an object")
            continue
        mapping_id = item.get("mappingId")
        if not isinstance(mapping_id, str) or not mapping_id or mapping_id in ids:
            errors.append(f"mappingId is missing or duplicated: {mapping_id}")
        ids.add(mapping_id)
        selectors = item.get("sourceSelectors")
        if not isinstance(selectors, list) or not selectors:
            errors.append(f"{mapping_id}: sourceSelectors must be non-empty")
        else:
            for selector in selectors:
                if not _source_files(str(selector)):
                    errors.append(f"{mapping_id}: source selector has no material: {selector}")
        inputs = item.get("runtimeInputs")
        if not isinstance(inputs, list) or not inputs:
            errors.append(f"{mapping_id}: runtimeInputs must be non-empty")
            continue
        input_ids: set[str] = set()
        for entry in inputs:
            if not isinstance(entry, dict) or set(entry) - {"inputId", "kind", "name", "path", "required"}:
                errors.append(f"{mapping_id}: malformed runtime input")
                continue
            if entry.get("inputId") in input_ids:
                errors.append(f"{mapping_id}: duplicate runtime input id")
            input_ids.add(entry.get("inputId"))
            if entry.get("kind") not in {"model_asset", "native_dependency", "environment"}:
                errors.append(f"{mapping_id}: runtime input kind is not declared")
            if entry.get("kind") == "model_asset" and entry.get("required") and not (ROOT / str(entry.get("path", ""))).is_file():
                errors.append(f"{mapping_id}: required model asset is missing: {entry.get('path')}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="write deterministic projections")
    args = parser.parse_args(argv)
    try:
        mapping = yaml.safe_load(MAPPING_PATH.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        print(f"mapping read failed: {exc}", file=sys.stderr)
        return 1
    errors = validate_mapping(mapping if isinstance(mapping, dict) else {})
    projections = build_projections(mapping) if isinstance(mapping, dict) and not errors else {}
    if not errors:
        findings = projections["diagnostics"]["findings"]
        errors.extend(f"{row['code']}: {row['mappingId']} {row['source']} {row['input']}" for row in findings)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    for key, relative in mapping["projectionTargets"].items():
        target = ROOT / relative
        expected = json.dumps(projections[key], ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        if args.write:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(expected, encoding="utf-8")
        elif not target.is_file() or target.read_text(encoding="utf-8") != expected:
            print(f"projection drift: {relative}", file=sys.stderr)
            errors.append(relative)
    if errors:
        return 1
    print("OCR mapping and projections are current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
