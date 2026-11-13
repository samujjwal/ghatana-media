from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


VALID_STATES = frozenset({"QUALIFIED", "CANDIDATE", "NOT_EVALUATED"})


@dataclass(frozen=True)
class LanguageRegistry:
    languages: dict[str, str]
    default_state: str = "NOT_EVALUATED"

    def state(self, language: str | None) -> str:
        return self.languages.get((language or "").lower(), self.default_state)

    def admitted(self, language: str | None) -> bool:
        return self.state(language) in {"QUALIFIED", "CANDIDATE"}


def load_language_registry(path: Path) -> LanguageRegistry:
    raw: Any = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != "document-intelligence.language-registry.v1":
        raise ValueError("invalid language registry")
    entries = raw.get("languages")
    default = raw.get("defaultState", "NOT_EVALUATED")
    if not isinstance(entries, dict) or default not in VALID_STATES:
        raise ValueError("invalid language registry")
    result: dict[str, str] = {}
    for tag, value in entries.items():
        state = value.get("targetState") if isinstance(value, dict) else None
        if not isinstance(tag, str) or not tag.islower() or state not in VALID_STATES:
            raise ValueError("invalid language registry entry")
        result[tag] = state
    return LanguageRegistry(result, default)
