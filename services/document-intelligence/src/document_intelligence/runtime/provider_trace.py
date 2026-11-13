"""Secret-safe provider attempt lineage.

The trace is deliberately an execution detail.  It is not part of the
document-intelligence wire contract and must never contain request bytes,
parsed documents, OCR text, or provider exception messages.
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass, field
from typing import Any, Mapping

from ..errors import WorkerError


@dataclass(frozen=True, slots=True)
class AttemptRecord:
    """The bounded, secret-safe record for one provider invocation."""

    sequence: int
    route_id: str
    provider_ref: str
    provider_version: str | None
    model_ref: str | None
    model_version: str | None
    operation_kind: str
    outcome: str
    failure_code: str | None
    elapsed_ms: int
    remaining_deadline_ms: int

    @property
    def provider(self) -> str:
        """Compatibility alias for consumers that call the provider identity ``provider``."""

        return self.provider_ref

    @property
    def route(self) -> str:
        return self.route_id

    @property
    def operation(self) -> str:
        return self.operation_kind

    @property
    def failure(self) -> str | None:
        return self.failure_code

    @property
    def provider_identity(self) -> str:
        return self.provider_ref

    @property
    def model_identity(self) -> str | None:
        return self.model_ref

    @property
    def remaining_ms(self) -> int:
        return self.remaining_deadline_ms

    @property
    def elapsed(self) -> int:
        return self.elapsed_ms

    @property
    def remaining_deadline(self) -> int:
        return self.remaining_deadline_ms

    def as_dict(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "route": self.route_id,
            "routeId": self.route_id,
            "providerRef": self.provider_ref,
            "providerVersion": self.provider_version,
            "modelRef": self.model_ref,
            "modelVersion": self.model_version,
            "operation": self.operation_kind,
            "operationKind": self.operation_kind,
            "outcome": self.outcome,
            "failure": self.failure_code,
            "failureCode": self.failure_code,
            "elapsedMs": self.elapsed_ms,
            "remainingDeadlineMs": self.remaining_deadline_ms,
        }


def provider_identity(provider_ref: str, provider: Any) -> tuple[str, str | None, str | None, str | None]:
    """Return only identity fields that are safe to put in a trace."""

    identity: Mapping[str, Any] = {}
    getter = getattr(provider, "identity", None)
    if callable(getter):
        try:
            value = getter()
        except Exception:
            value = None
    else:
        value = getter
    if isinstance(value, Mapping):
        identity = value
    return (
        provider_ref,
        identity.get("providerVersion") if isinstance(identity.get("providerVersion"), str) else None,
        identity.get("modelRef") if isinstance(identity.get("modelRef"), str) else None,
        identity.get("modelVersion") if isinstance(identity.get("modelVersion"), str) else None,
    )


@dataclass
class ProviderTrace:
    """Per-operation attempt trace, with bounded in-memory state."""

    attempts: list[AttemptRecord] = field(default_factory=list)
    _last_error: WorkerError | None = field(default=None, init=False, repr=False)
    _last_route: str | None = field(default=None, init=False, repr=False)

    def record(
        self,
        *,
        route: str,
        provider_ref: str,
        provider_version: str | None,
        model_ref: str | None,
        model_version: str | None,
        operation: str,
        outcome: str,
        failure: str | None,
        elapsed_ms: int,
        remaining_deadline_ms: int,
        retryable: bool = False,
    ) -> AttemptRecord:
        record = AttemptRecord(
            sequence=len(self.attempts) + 1,
            route_id=route,
            provider_ref=provider_ref,
            provider_version=provider_version,
            model_ref=model_ref,
            model_version=model_version,
            operation_kind=operation,
            outcome=outcome,
            failure_code=failure,
            elapsed_ms=max(0, int(elapsed_ms)),
            remaining_deadline_ms=max(0, int(remaining_deadline_ms)),
        )
        self.attempts.append(record)
        self._last_route = route
        self._last_error = None if failure is None else WorkerError(failure, retryable=retryable, provider_ref=provider_ref)
        return record

    @property
    def last_error(self) -> WorkerError | None:
        return self._last_error

    @property
    def last_route(self) -> str | None:
        return self._last_route

    def blocked_error(self, route: str) -> WorkerError | None:
        """Return a terminal error that must not be hidden by a fallback route."""

        if self._last_route != route or self._last_error is None:
            return None
        if self._last_error.code in {"CANCELLED", "TIMEOUT"} or not self._last_error.retryable:
            return self._last_error
        return None


_CURRENT_TRACE: contextvars.ContextVar[ProviderTrace | None] = contextvars.ContextVar(
    "document_intelligence_provider_trace", default=None
)


def current_provider_trace() -> ProviderTrace | None:
    return _CURRENT_TRACE.get()


def bind_provider_trace(trace: ProviderTrace) -> contextvars.Token[ProviderTrace | None]:
    return _CURRENT_TRACE.set(trace)


def reset_provider_trace(token: contextvars.Token[ProviderTrace | None]) -> None:
    _CURRENT_TRACE.reset(token)
