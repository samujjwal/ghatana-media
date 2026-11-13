"""Qualification-set authorities for governed datasets (I5-47/I5-51).

Training and tuning must not be allowed to move a qualification holdout.  The
holdout selector is therefore a separate, deterministic authority over the
eligible event set.  This module is intentionally independent of the dataset
writer so callers can freeze and review the selection before materializing a
training dataset.
"""
from __future__ import annotations

import hashlib
from collections import Counter
from collections.abc import Iterable, Mapping
from typing import Any

from ..util import digest


def _group_key(event: Mapping[str, Any], group_key: str) -> str:
    source = event.get("source") or {}
    review = event.get("review") or {}
    if group_key == "reviewLineage":
        lineage = review.get("reprocessLineage") or {}
        return str(lineage.get("handoffId") or (source.get("reviewRef") or {}).get("reviewId") or event.get("eventId"))
    return str(source.get("sourceContentFingerprint") or event.get("eventId"))


def freeze_holdout(
    events: Iterable[Mapping[str, Any]],
    *,
    holdout_id: str,
    event_ids: Iterable[str] | None = None,
    fraction: float = 0.2,
    group_key: str = "sourceContentFingerprint",
    seed: int = 42,
) -> dict[str, Any]:
    """Create an immutable, reproducible holdout selection.

    Explicit event IDs are preferred for a qualification authority.  If a
    fraction is used, all events in a source/review group are selected
    together using a stable hash; timestamps and input ordering do not affect
    the result.
    """
    rows = sorted((dict(event) for event in events), key=lambda item: str(item.get("eventId", "")))
    available = {str(row.get("eventId")) for row in rows}
    if event_ids is not None:
        selected = sorted({str(value) for value in event_ids})
        unknown = set(selected) - available
        if unknown:
            raise ValueError(f"holdout contains unknown event ids: {sorted(unknown)}")
    else:
        if not 0 < fraction < 1:
            raise ValueError("holdout fraction must be in (0, 1)")
        selected = []
        for row in rows:
            key = _group_key(row, group_key)
            score = int.from_bytes(hashlib.sha256(f"{seed}:{key}".encode()).digest()[:8], "big") / 2**64
            if score < fraction:
                selected.append(str(row["eventId"]))
        selected = sorted(set(selected))
    return {
        "holdoutId": holdout_id,
        "selectionAuthority": "explicit-event-set" if event_ids is not None else "stable-group-hash",
        "groupKey": group_key,
        "seed": seed,
        "eventIds": selected,
        "memberFingerprint": digest(selected),
        "selectionFingerprint": digest(
            {
                "domain": "learning.qualification-holdout.v1",
                "holdoutId": holdout_id,
                "eventIds": selected,
                "groupKey": group_key,
                "seed": seed,
            }
        ),
    }


def _language(event: Mapping[str, Any]) -> str:
    return str(((event.get("authority") or {}).get("languageHint")) or "unknown")


def _document_class(event: Mapping[str, Any]) -> str:
    return str((((event.get("authority") or {}).get("schemaRef") or {}).get("schemaId")) or "unknown")


def _field_ids(event: Mapping[str, Any]) -> set[str]:
    return {
        str((correction.get("target") or {}).get("fieldId"))
        for correction in (event.get("review") or {}).get("corrections", [])
        if isinstance(correction, Mapping) and (correction.get("target") or {}).get("fieldId")
    }


def check_statistical_sufficiency(
    events: Iterable[Mapping[str, Any]],
    minimum_support: Mapping[str, int],
) -> dict[str, Any]:
    """Evaluate minimum support without turning missing subgroups into PASS.

    Keys use ``language:<tag>``, ``documentClass:<id>``, and
    ``field:<fieldId>``.  Unknown keys are rejected so a typo cannot silently
    weaken a qualification policy.
    """
    rows = list(events)
    counts: Counter[str] = Counter()
    for event in rows:
        counts[f"language:{_language(event)}"] += 1
        counts[f"documentClass:{_document_class(event)}"] += 1
        for field_id in _field_ids(event):
            counts[f"field:{field_id}"] += 1
    requirements: dict[str, int] = {}
    for key, value in minimum_support.items():
        if not isinstance(key, str) or ":" not in key:
            raise ValueError(f"invalid sufficiency subgroup {key!r}")
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"minimum support for {key!r} must be a positive integer")
        requirements[key] = value
    deficits = [
        {"subgroup": key, "observed": counts.get(key, 0), "required": required}
        for key, required in sorted(requirements.items())
        if counts.get(key, 0) < required
    ]
    return {
        "status": "PASS" if not deficits else "NOT_QUALIFIED",
        "counts": dict(sorted(counts.items())),
        "minimumSupport": requirements,
        "deficits": deficits,
        "supportFingerprint": digest({"counts": dict(sorted(counts.items())), "minimumSupport": requirements}),
    }
