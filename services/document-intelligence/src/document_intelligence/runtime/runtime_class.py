"""Explicit functional/performance qualification by runtime class (I6-90)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import yaml


FUNCTIONAL = "FUNCTIONALLY_QUALIFIED"
PERFORMANCE = "PERFORMANCE_QUALIFIED"
NOT_QUALIFIED = "NOT_QUALIFIED"
_STATES = frozenset({FUNCTIONAL, PERFORMANCE, NOT_QUALIFIED})


@dataclass(frozen=True)
class RuntimeClassQualification:
    capability_id: str
    runtime_class: str
    functional_state: str
    performance_state: str
    evidence_ref: str | None = None

    @property
    def qualified(self) -> bool:
        return self.functional_state == FUNCTIONAL and self.performance_state == PERFORMANCE


@dataclass(frozen=True)
class RuntimeClassMatrix:
    schema_version: str
    classes: tuple[str, ...]
    qualifications: tuple[RuntimeClassQualification, ...]

    def validate(self) -> None:
        if self.schema_version != "document-intelligence.runtime-class-qualification.v1":
            raise ValueError("runtime-class matrix schemaVersion is invalid")
        if not self.classes or len(set(self.classes)) != len(self.classes):
            raise ValueError("runtime-class matrix must declare unique classes")
        keys: set[tuple[str, str]] = set()
        for item in self.qualifications:
            key = (item.capability_id, item.runtime_class)
            if key in keys:
                raise ValueError(f"duplicate runtime-class qualification: {key}")
            keys.add(key)
            if item.runtime_class not in self.classes:
                raise ValueError(f"qualification references unknown runtime class: {item.runtime_class}")
            if item.functional_state not in _STATES or item.performance_state not in _STATES:
                raise ValueError("runtime-class qualification state is invalid")
            if not item.capability_id:
                raise ValueError("runtime-class capability id is required")

    def get(self, capability_id: str, runtime_class: str) -> RuntimeClassQualification:
        for item in self.qualifications:
            if item.capability_id == capability_id and item.runtime_class == runtime_class:
                return item
        raise KeyError((capability_id, runtime_class))

    def is_qualified(self, capability_id: str, runtime_class: str) -> bool:
        try:
            return self.get(capability_id, runtime_class).qualified
        except KeyError:
            return False


def load_runtime_class_matrix(path: Path | str) -> RuntimeClassMatrix:
    try:
        raw: Any = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError("runtime-class matrix is unavailable or malformed") from exc
    if not isinstance(raw, Mapping) or not isinstance(raw.get("classes"), Mapping) or not isinstance(raw.get("qualifications"), list):
        raise ValueError("runtime-class matrix shape is invalid")
    classes = tuple(str(name) for name in raw["classes"])
    qualifications: list[RuntimeClassQualification] = []
    for record in raw["qualifications"]:
        if not isinstance(record, Mapping):
            raise ValueError("runtime-class qualification record is invalid")
        capability_id = record.get("capabilityId")
        runtime_class = record.get("runtimeClass")
        if not isinstance(capability_id, str) or not isinstance(runtime_class, str):
            raise ValueError("runtime-class qualification identity is invalid")
        qualifications.append(
            RuntimeClassQualification(
                capability_id,
                runtime_class,
                str(record.get("functionalState", "")),
                str(record.get("performanceState", "")),
                record.get("evidenceRef") if isinstance(record.get("evidenceRef"), str) else None,
            )
        )
    matrix = RuntimeClassMatrix(
        str(raw.get("schemaVersion", "")),
        classes,
        tuple(qualifications),
    )
    matrix.validate()
    return matrix


__all__ = [
    "FUNCTIONAL",
    "PERFORMANCE",
    "NOT_QUALIFIED",
    "RuntimeClassMatrix",
    "RuntimeClassQualification",
    "load_runtime_class_matrix",
]
