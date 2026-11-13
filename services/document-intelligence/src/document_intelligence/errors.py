from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ERROR_CODES = frozenset(
    {
        "INVALID_REQUEST",
        "LIMIT_EXCEEDED",
        "UNSUPPORTED_MEDIA_TYPE",
        "UNSUPPORTED_LANGUAGE",
        "PROVIDER_BUSY",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_FAILED",
        "TIMEOUT",
        "CANCELLED",
        "INVALID_PROVIDER_OUTPUT",
        "DUPLICATE_OPERATION",
    }
)


@dataclass
class WorkerError(Exception):
    code: str
    retryable: bool = False
    provider_ref: str | None = None

    def __post_init__(self) -> None:
        if self.code not in ERROR_CODES:
            object.__setattr__(self, "code", "PROVIDER_FAILED")
        Exception.__init__(self, self.code)

    def envelope(self, operation_id: str) -> dict[str, Any]:
        result: dict[str, Any] = {
            "protocolVersion": "document-intelligence.v1",
            "operationId": operation_id,
            "code": self.code,
            "retryable": self.retryable,
        }
        if self.provider_ref is not None:
            result["providerRef"] = self.provider_ref
        return result


def sanitized_error(exc: BaseException, operation_id: str, provider_ref: str | None = None) -> dict[str, Any]:
    if isinstance(exc, WorkerError):
        return exc.envelope(operation_id)
    return WorkerError("PROVIDER_FAILED", provider_ref=provider_ref).envelope(operation_id)
