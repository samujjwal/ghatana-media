"""Deterministic fingerprints for the source code that backs Increment-6 evidence.

Unlike Increment-4A, several declared I6 sources (``src/document_intelligence/
scanned/``, the new ``runtime/*`` modules, ``routing/scanned-pdf.v1.yaml``) are
declared-but-absent until their implementation waves land. Missing sources are
recorded as digest markers — never silently skipped — so the fingerprint
changes when a declared source appears.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = Path(__file__).with_name("implementation-material.yaml")
EXPECTED_GROUPS = {"providerSemantics", "evaluationImplementation"}

_MISSING_MARKER = b"MISSING:"


def _source_files(root: Path, source: str) -> list[Path] | None:
    """Return sorted files under ``source``, or None when the declared source is absent."""
    path = (root / source).resolve()
    if root.resolve() != path and root.resolve() not in path.parents:
        raise ValueError(f"implementation source escapes worker root: {source}")
    if not path.exists():
        return None
    if path.is_file():
        return [path]
    return sorted(
        item for item in path.rglob("*")
        if item.is_file() and "__pycache__" not in item.parts and ".pytest_cache" not in item.parts
    )


def _load_groups() -> dict[str, list[str]]:
    spec = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
    groups = spec.get("sourceSets") if isinstance(spec, dict) else None
    if spec.get("schemaVersion") != "increment6.implementation-material.v1" or not isinstance(groups, dict) or set(groups) != EXPECTED_GROUPS:
        raise ValueError("implementation-material.yaml has an invalid source-set schema")
    return groups


def missing_sources(root: Path = ROOT) -> dict[str, list[str]]:
    """Declared sources whose content has not landed yet, per source set."""
    groups = _load_groups()
    missing: dict[str, list[str]] = {}
    for group, sources in groups.items():
        absent = [source for source in sources if _source_files(root, source) is None]
        if absent:
            missing[group] = absent
    return missing


def implementation_fingerprints(root: Path = ROOT) -> dict[str, str]:
    """Hash each declared source set from sorted relative paths and file bytes."""
    groups = _load_groups()

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
            if files is None:
                # Declared-but-absent surface: bind the path as a marker so the
                # fingerprint flips when the wave lands the real content.
                relative = source.encode("utf-8")
                digest.update(_MISSING_MARKER)
                digest.update(len(relative).to_bytes(8, "big"))
                digest.update(relative)
                continue
            for path in files:
                relative = path.relative_to(root.resolve()).as_posix().encode("utf-8")
                content = path.read_bytes()
                digest.update(len(relative).to_bytes(8, "big"))
                digest.update(relative)
                digest.update(len(content).to_bytes(8, "big"))
                digest.update(content)
        result[output_key] = digest.hexdigest()
    return result
