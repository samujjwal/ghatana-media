"""Process-boundary sanitization helpers.

Provider exceptions and payloads must cross the HTTP boundary only through the
small public error envelope.  This module is intentionally dependency-free so
it can also be used by startup and shutdown paths.
"""

from __future__ import annotations

import re
from typing import Any

from ..errors import sanitized_error


def safe_error(exc: BaseException, operation_id: str, provider_ref: str | None = None) -> dict[str, Any]:
    return sanitized_error(exc, operation_id, provider_ref)


def safe_text(value: object, limit: int = 256) -> str:
    """Return bounded operator text without exposing arbitrary provider data."""
    return sanitize_diagnostic_text(value, limit=limit)


_DIAGNOSTIC_SECRET = re.compile(
    r"(?i)(authorization|api[-_ ]?key|credential|password|passwd|secret|token)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_DIAGNOSTIC_PATH = re.compile(r"(?:[A-Za-z]:[\\/]|/)[^\s\n\r]+")


def sanitize_diagnostic_text(value: object, *, limit: int = 4096) -> str:
    """Bound and redact provider diagnostics before they reach logs/evidence."""

    if not isinstance(value, str) or limit <= 0:
        return ""
    text = value.replace("\x00", "�")
    text = "".join(character if character in "\n\r\t" or ord(character) >= 0x20 else "�" for character in text)
    text = _DIAGNOSTIC_SECRET.sub(r"\1\2[REDACTED]", text)
    text = _DIAGNOSTIC_PATH.sub("[PATH]", text)
    return text[:limit]


def sanitize_diagnostic_bytes(value: bytes, *, limit: int = 4096) -> bytes:
    """Sanitize bounded child stderr while keeping provider stdout as data."""

    if not isinstance(value, bytes):
        return b""
    return sanitize_diagnostic_text(value.decode("utf-8", "replace"), limit=limit).encode("utf-8")
