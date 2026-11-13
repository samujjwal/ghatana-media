from __future__ import annotations

from typing import Any

from .evidence import evidence_for_span


def candidate(field_id: str, value_type: str, value: str, score: float, provider: dict[str, str], evidence: list[dict]) -> dict[str, Any]:
    return {"fieldId": field_id, "value": {"kind": value_type, "value": value}, "source": "MODEL", "confidence": score, "evidence": evidence, "provider": provider}


def map_entity(field_id: str, value_type: str, start: int, end: int, score: float, text: str, intervals: list, provider: dict[str, str]) -> dict[str, Any] | None:
    if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start or end > len(text) or not isinstance(score, (float, int)) or not 0 <= score <= 1:
        return None
    raw_value = text[start:end]
    if not raw_value:
        return None
    evidence = evidence_for_span(start, end, intervals)
    if not evidence:
        return None
    return candidate(field_id, value_type, raw_value, float(score), provider, evidence)
