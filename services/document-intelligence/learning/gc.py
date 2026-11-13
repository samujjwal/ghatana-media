"""Generation-barrier and two-stage retention cleanup (OCR-GC-11..13)."""

from __future__ import annotations

import hashlib
import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping


class RetentionIntegrityError(ValueError):
    pass


@dataclass(frozen=True)
class RetentionGeneration:
    generation: int
    active_references: frozenset[str]


@dataclass(frozen=True)
class GcPlan:
    generation: RetentionGeneration
    candidates: tuple[Path, ...]
    marked: tuple[Path, ...]


class GenerationBarrier:
    """Active executions contribute temporary roots until they publish."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._generation = 0
        self._active: dict[str, frozenset[str]] = {}

    def begin(self, execution_id: str, references: Iterable[str]) -> int:
        if not execution_id:
            raise ValueError("execution_id is required")
        with self._lock:
            self._generation += 1
            self._active[execution_id] = frozenset(references)
            return self._generation

    def complete(self, execution_id: str) -> None:
        with self._lock:
            self._active.pop(execution_id, None)

    def freeze(self) -> RetentionGeneration:
        with self._lock:
            return RetentionGeneration(self._generation, frozenset().union(*self._active.values()) if self._active else frozenset())


def plan_gc(candidates: Iterable[Path | str], reachable: Iterable[str], barrier: GenerationBarrier) -> GcPlan:
    frozen = barrier.freeze()
    protected = set(reachable) | set(frozen.active_references)
    selected = tuple(sorted((Path(path) for path in candidates if str(path) not in protected), key=lambda path: str(path)))
    return GcPlan(frozen, selected, selected)


def quarantine(plan: GcPlan, quarantine_root: Path | str) -> tuple[Path, ...]:
    destination = Path(quarantine_root)
    destination.mkdir(parents=True, exist_ok=True)
    moved: list[Path] = []
    for source in plan.marked:
        if not source.exists():
            continue
        target = destination / f"{source.name}.generation-{plan.generation.generation}"
        os.replace(source, target)
        moved.append(target)
    return tuple(moved)


def finalize_quarantine(paths: Iterable[Path | str], *, reachable: Iterable[str], barrier: GenerationBarrier) -> tuple[Path, ...]:
    protected = set(reachable) | set(barrier.freeze().active_references)
    deleted: list[Path] = []
    for value in paths:
        path = Path(value)
        if str(path) in protected:
            continue
        if path.is_file():
            path.unlink()
            deleted.append(path)
    return tuple(deleted)


def verify_retained_artifact(
    path: Path | str,
    *,
    expected_sha256: str,
    expected_size: int | None = None,
    manifest: Mapping[str, object] | None = None,
    complete_marker: Path | str | None = None,
) -> None:
    """Verify digest, size, manifest shape, and publication completeness."""

    artifact = Path(path)
    if not artifact.is_file():
        raise RetentionIntegrityError("retained artifact is missing")
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise RetentionIntegrityError("retained artifact digest mismatch")
    if expected_size is not None and artifact.stat().st_size != expected_size:
        raise RetentionIntegrityError("retained artifact size mismatch")
    if manifest is not None:
        if manifest.get("schemaVersion") is None or manifest.get("status") != "COMPLETE":
            raise RetentionIntegrityError("retained artifact manifest is not complete")
    if complete_marker is not None and not Path(complete_marker).is_file():
        raise RetentionIntegrityError("retained artifact publication marker is missing")


__all__ = [
    "GcPlan",
    "GenerationBarrier",
    "RetentionGeneration",
    "RetentionIntegrityError",
    "finalize_quarantine",
    "plan_gc",
    "quarantine",
    "verify_retained_artifact",
]
