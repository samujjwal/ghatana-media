"""Candidate-only bounded metrics, correlation, and diagnostic redaction."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

FORBIDDEN_FIELD_NAMES = frozenset({"text", "value", "filename", "content", "raw", "token", "credential", "password", "temppath", "path", "documentid", "userid", "fieldvalue", "tenantname", "rawtenantid"})
METRIC_LABELS = frozenset({"provider", "capability", "mediaType", "language", "status", "failureCategory", "profile"})
CORRELATION_ONLY = frozenset({"operationId", "correlationId", "providerAttemptId", "campaignId"})


@dataclass(frozen=True, slots=True)
class TraceCorrelation:
    """Content-free correlation context for logs/traces, never metrics."""

    request_id: str
    operation_id: str
    provider_attempt_id: str | None = None
    campaign_id: str | None = None

    def as_fields(self) -> dict[str, str]:
        return {
            key: value
            for key, value in {
                "requestId": self.request_id,
                "operationId": self.operation_id,
                "providerAttemptId": self.provider_attempt_id,
                "campaignId": self.campaign_id,
            }.items()
            if isinstance(value, str) and value
        }


class BoundedMetricRecorder:
    """Small in-process metric sink with an explicit series ceiling (I6-50/I6-51)."""

    def __init__(self, *, max_series: int = 1024) -> None:
        if max_series < 1:
            raise ValueError("max_series must be positive")
        self.max_series = max_series
        self._values: Counter[tuple[str, tuple[tuple[str, str], ...]]] = Counter()

    def observe(self, name: str, value: float, *, labels: dict[str, str] | None = None) -> bool:
        if not isinstance(name, str) or not name or not isinstance(value, (int, float)):
            raise ValueError("metric name/value invalid")
        labels = labels or {}
        if set(labels) - METRIC_LABELS:
            raise ValueError("metric labels must use the bounded observability authority")
        if set(labels) & CORRELATION_ONLY:
            raise ValueError("correlation identifiers are not metric labels")
        key = (name, tuple(sorted((key, str(value)) for key, value in labels.items())))
        if key not in self._values and len(self._values) >= self.max_series:
            return False
        self._values[key] += float(value)
        return True

    def snapshot(self) -> list[dict[str, Any]]:
        return [
            {"name": name, "labels": dict(labels), "value": value}
            for (name, labels), value in sorted(self._values.items())
        ]


def redact_diagnostics(value: Any) -> Any:
    """Recursively remove content-bearing diagnostic fields."""
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, child in value.items():
            lowered = str(key).lower()
            if any(part in lowered for part in FORBIDDEN_FIELD_NAMES):
                continue
            result[str(key)] = redact_diagnostics(child)
        return result
    if isinstance(value, list):
        return [redact_diagnostics(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return None

