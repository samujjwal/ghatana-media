from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LabelPolicy:
    labels: tuple[str, ...]
    label_to_field: dict[str, str]


def build_label_policy(fields: list[dict], language: str | None = None, max_labels: int = 256, max_length: int = 128) -> LabelPolicy:
    labels: list[str] = []
    reverse: dict[str, str] = {}
    for field in fields:
        field_id = field["fieldId"]
        aliases = [alias for alias in field.get("aliases", []) if isinstance(alias, str)]
        local_aliases = [alias for alias in aliases if language in {"hi", "mr", "ne"} and any(ord(char) > 127 for char in alias)]
        other_aliases = [alias for alias in aliases if alias not in local_aliases]
        candidates = [*local_aliases, field_id, *other_aliases]
        for candidate in candidates:
            if not isinstance(candidate, str):
                continue
            label = candidate.strip()
            key = label.casefold()
            if not label or len(label) > max_length or key in reverse:
                continue
            labels.append(label)
            reverse[key] = field_id
            if len(labels) >= max_labels:
                return LabelPolicy(tuple(labels), reverse)
    return LabelPolicy(tuple(labels), reverse)
