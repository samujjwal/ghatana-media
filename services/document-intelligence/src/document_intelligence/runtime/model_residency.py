"""Increment-6 model residency planning and verification (backlog I6-22).

``ModelResidencyPlanner`` decides which declared models fit inside a byte
budget, produces a deterministic cold-start load order, and verifies that
on-disk cache assets still match the sha256 digests declared in a residency
manifest.  Verification fails closed: missing or corrupt assets are never
reported resident.

Manifest format (YAML or JSON)::

    models:
      - ref: "ghatana.minilm"
        sha256: "<hex digest of the asset file>"
        path: "minilm.bin"        # optional; defaults to "<ref>"
        bytes: 12345              # optional, informational

A bare ``{ref: sha256}`` mapping is also accepted.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from ..errors import WorkerError


class ResidencyError(WorkerError):
    """WorkerError that preserves increment-6 residency codes verbatim."""

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code)


def _normalize_declared(declared: Iterable[Mapping[str, Any]] | Mapping[str, int]) -> list[dict[str, Any]]:
    if isinstance(declared, Mapping):
        items = [{"ref": ref, "bytes": int(size)} for ref, size in declared.items()]
    else:
        items = [dict(item) for item in declared]
    normalized: list[dict[str, Any]] = []
    for item in items:
        ref = item.get("ref")
        size = item.get("bytes", item.get("size"))
        if not isinstance(ref, str) or not ref or not isinstance(size, int) or size < 0:
            raise ValueError("declared model entries need {ref: str, bytes: int >= 0}")
        normalized.append({"ref": ref, "bytes": size})
    return normalized


@dataclass(frozen=True)
class ResidencyPlan:
    """Ordered residency decision for a declared model set."""

    resident: tuple[str, ...]
    excluded: tuple[str, ...]
    budget_bytes: int
    reserved_bytes: int

    def cold_start_order(self) -> list[str]:
        """Deterministic load order for the resident set (declaration order)."""
        return list(self.resident)


@dataclass(frozen=True)
class ResidencyVerification:
    """Result of comparing a residency manifest against the asset cache."""

    verified: tuple[str, ...]
    corrupt: tuple[str, ...]
    missing: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return not self.corrupt and not self.missing


class ModelResidencyPlanner:
    def __init__(self, budget_bytes: int) -> None:
        if budget_bytes < 0:
            raise ValueError("budget_bytes must be >= 0")
        self.budget_bytes = budget_bytes

    def plan(self, declared: Iterable[Mapping[str, Any]] | Mapping[str, int]) -> ResidencyPlan:
        """Greedily admit declared models in order until the budget is full."""
        resident: list[str] = []
        excluded: list[str] = []
        used = 0
        for item in _normalize_declared(declared):
            if used + item["bytes"] <= self.budget_bytes:
                resident.append(item["ref"])
                used += item["bytes"]
            else:
                excluded.append(item["ref"])
        return ResidencyPlan(tuple(resident), tuple(excluded), self.budget_bytes, used)

    @staticmethod
    def _manifest_entries(manifest_path: Path) -> list[dict[str, Any]]:
        try:
            document = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            raise ResidencyError("MODEL_MANIFEST_UNAVAILABLE", retryable=True) from exc
        if isinstance(document, Mapping) and isinstance(document.get("models"), list):
            raw = document["models"]
        elif isinstance(document, Mapping):
            raw = [{"ref": ref, "sha256": digest} for ref, digest in document.items()]
        else:
            raise ResidencyError("MODEL_MANIFEST_UNAVAILABLE")
        entries: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, Mapping) or not isinstance(item.get("ref"), str) or not isinstance(item.get("sha256"), str):
                raise ResidencyError("MODEL_MANIFEST_UNAVAILABLE")
            entries.append(dict(item))
        return entries

    def verify_residency(self, manifest_path: Path | str, cache_dir: Path | str) -> ResidencyVerification:
        """Check on-disk assets under ``cache_dir`` against declared sha256.

        Returns per-model verdicts; ``ok`` is true only when every declared
        asset exists and digests match.  Fails closed on unreadable or
        malformed manifests.
        """
        cache_root = Path(cache_dir)
        verified: list[str] = []
        corrupt: list[str] = []
        missing: list[str] = []
        for entry in self._manifest_entries(Path(manifest_path)):
            ref = entry["ref"]
            relative = entry.get("path", ref)
            asset = cache_root / str(relative)
            if not asset.is_file():
                missing.append(ref)
                continue
            try:
                observed = hashlib.sha256(asset.read_bytes()).hexdigest()
            except OSError:
                missing.append(ref)
                continue
            if observed == entry["sha256"].lower():
                verified.append(ref)
            else:
                corrupt.append(ref)
        return ResidencyVerification(tuple(verified), tuple(corrupt), tuple(missing))
