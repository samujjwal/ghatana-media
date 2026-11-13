"""Qualification rules for governed provider fallback."""

from __future__ import annotations

from dataclasses import dataclass

from ..errors import WorkerError


# A provider may be retried only when it explicitly reports a retryable,
# provider-side failure.  TIMEOUT and CANCELLED are terminal for the request:
# using the remaining deadline for another provider would violate the budget.
RETRYABLE_FALLBACK_CODES = frozenset({"PROVIDER_BUSY", "PROVIDER_UNAVAILABLE", "PROVIDER_FAILED"})
TERMINAL_FALLBACK_CODES = frozenset(
    {"CANCELLED", "TIMEOUT", "INVALID_REQUEST", "INVALID_PROVIDER_OUTPUT", "LIMIT_EXCEEDED", "UNSUPPORTED_MEDIA_TYPE", "UNSUPPORTED_LANGUAGE"}
)


@dataclass(frozen=True, slots=True)
class FallbackQualification:
    eligible: bool
    reason: str


@dataclass(frozen=True, slots=True)
class RetryQualification:
    """Same-provider retry verdict (I6-57).

    Retry is deliberately a *distinct* concept from fallback: it repeats the
    same providerRef under a transient-failure policy, consumes no route
    position, requires no declared (from,to) contract chain, and shares the
    original request deadline with the primary attempt.
    """

    eligible: bool
    reason: str


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Bounded same-provider retry policy declared by the routing authority."""

    max_attempts: int = 1
    retryable_categories: frozenset[str] = frozenset(RETRYABLE_FALLBACK_CODES)
    minimum_remaining_budget_ms: int = 0


def qualify_retry(
    failure: WorkerError,
    *,
    remaining_deadline_ms: int,
    attempts_used: int,
    policy: RetryPolicy = RetryPolicy(),
) -> RetryQualification:
    """Classify whether the *same* provider may be invoked once more.

    Unlike :func:`qualify_fallback` this never inspects attempted/next
    provider identity — the providerRef does not change on a retry.  The
    attempt count, failure categories, and remaining-budget floor are the
    retry policy's own, independent of fallback eligibility.
    """

    if not isinstance(failure, WorkerError):
        return RetryQualification(False, "non-worker-failure")
    if failure.code in TERMINAL_FALLBACK_CODES:
        return RetryQualification(False, f"terminal:{failure.code}")
    if failure.code not in policy.retryable_categories or not failure.retryable:
        return RetryQualification(False, f"not-retryable:{failure.code}")
    if attempts_used >= max(1, policy.max_attempts):
        return RetryQualification(False, "retry-attempts-exhausted")
    if remaining_deadline_ms < max(0, policy.minimum_remaining_budget_ms):
        return RetryQualification(False, "insufficient-deadline")
    return RetryQualification(True, "retryable-provider-failure")


@dataclass(frozen=True, slots=True)
class FallbackPolicy:
    """Reusable qualification policy for a bounded route."""

    minimum_remaining_budget_ms: int = 0

    def qualify(
        self,
        failure: WorkerError,
        *,
        remaining_deadline_ms: int,
        attempted_providers: frozenset[str] = frozenset(),
        next_provider: str | None = None,
    ) -> FallbackQualification:
        return qualify_fallback(
            failure,
            remaining_deadline_ms=remaining_deadline_ms,
            minimum_remaining_budget_ms=self.minimum_remaining_budget_ms,
            attempted_providers=attempted_providers,
            next_provider=next_provider,
        )


def qualify_fallback(
    failure: WorkerError,
    *,
    remaining_deadline_ms: int,
    minimum_remaining_budget_ms: int = 0,
    attempted_providers: frozenset[str] = frozenset(),
    next_provider: str | None = None,
) -> FallbackQualification:
    """Classify whether a subsequent route provider may be invoked."""

    if not isinstance(failure, WorkerError):
        return FallbackQualification(False, "non-worker-failure")
    if failure.code in TERMINAL_FALLBACK_CODES:
        return FallbackQualification(False, f"terminal:{failure.code}")
    if failure.code not in RETRYABLE_FALLBACK_CODES or not failure.retryable:
        return FallbackQualification(False, f"not-retryable:{failure.code}")
    if remaining_deadline_ms < max(0, minimum_remaining_budget_ms):
        return FallbackQualification(False, "insufficient-deadline")
    if next_provider is not None and next_provider in attempted_providers:
        return FallbackQualification(False, "provider-already-attempted")
    return FallbackQualification(True, "retryable-provider-failure")


def is_fallback_eligible(
    failure: WorkerError,
    *,
    remaining_deadline_ms: int,
    minimum_remaining_budget_ms: int = 0,
) -> bool:
    return qualify_fallback(
        failure,
        remaining_deadline_ms=remaining_deadline_ms,
        minimum_remaining_budget_ms=minimum_remaining_budget_ms,
    ).eligible

