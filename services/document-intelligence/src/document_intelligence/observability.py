from __future__ import annotations

import json
import logging
import math
import time
from typing import Any

from .runtime.sanitization import sanitize_diagnostic_text

# Bounded label surface (config/observability-labels.v1.yaml, I6-60):
# provider/capability/mediaType/language/status/failureCategory/profile are
# the only metric-label-safe names; operationId is log/trace correlation
# only and is never a metric label.
SAFE_FIELDS = frozenset({"operationId", "providerRef", "modelRef", "mediaType", "language", "inputByteCount", "pageCount", "elapsedMs", "status", "failureCategory", "diagnostic"})
FORBIDDEN_FIELD_NAMES = frozenset({"text", "value", "filename", "content", "raw", "token", "credential", "password", "tempPath", "path"})


def safe_event(**fields: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in fields.items():
        if key not in SAFE_FIELDS or any(part in key.lower() for part in FORBIDDEN_FIELD_NAMES):
            continue
        if isinstance(value, str):
            result[key] = sanitize_diagnostic_text(value, limit=256)
        elif isinstance(value, bool):
            result[key] = value
        elif isinstance(value, int):
            result[key] = value
        elif isinstance(value, float) and math.isfinite(value):
            result[key] = value
    return result


def log_event(logger: logging.Logger, **fields: Any) -> None:
    logger.info(json.dumps(safe_event(**fields), sort_keys=True, separators=(",", ":")))


class Timer:
    def __enter__(self) -> "Timer":
        self.started = time.monotonic()
        return self

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self.started) * 1000)

    def __exit__(self, *_: Any) -> None:
        return None
