"""Deterministic fingerprints for the source code that backs Increment-4A evidence."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = Path(__file__).with_name("implementation-material.yaml")
EXPECTED_GROUPS = {"providerSemantics", "evaluationImplementation"}


def _source_files(root: Path, source: str) -> list[Path]:
    path = (root / source).resolve()
    if root.resolve() != path and root.resolve() not in path.parents:
        raise ValueError(f"implementation source escapes worker root: {source}")
    if path.is_file():
        return [path]
    if not path.is_dir():
        raise ValueError(f"implementation source is missing: {source}")
    return sorted(
        item for item in path.rglob("*")
        if item.is_file() and "__pycache__" not in item.parts and ".pytest_cache" not in item.parts
    )


def implementation_fingerprints(root: Path = ROOT) -> dict[str, str]:
    """Hash each declared source set from sorted relative paths and file bytes."""
    spec = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
    groups = spec.get("sourceSets") if isinstance(spec, dict) else None
    if spec.get("schemaVersion") != "increment4a.implementation-material.v1" or not isinstance(groups, dict) or set(groups) != EXPECTED_GROUPS:
        raise ValueError("implementation-material.yaml has an invalid source-set schema")

    result: dict[str, str] = {}
    for group, output_key in (
        ("providerSemantics", "providerSemanticsFingerprint"),
        ("evaluationImplementation", "evaluationImplementationFingerprint"),
    ):
        sources = groups[group]
        if not isinstance(sources, list) or not sources or any(not isinstance(item, str) for item in sources):
            raise ValueError(f"implementation source set '{group}' must be a non-empty path list")
        digest = hashlib.sha256()
        for source in sources:
            files = _source_files(root, source)
            if not files:
                raise ValueError(f"implementation source contains no files: {source}")
            for path in files:
                relative = path.relative_to(root.resolve()).as_posix().encode("utf-8")
                content = path.read_bytes()
                digest.update(len(relative).to_bytes(8, "big"))
                digest.update(relative)
                digest.update(len(content).to_bytes(8, "big"))
                digest.update(content)
        result[output_key] = digest.hexdigest()
    return result
