from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Sequence

from ..errors import WorkerError
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.fallback import (
    RETRYABLE_FALLBACK_CODES,
    TERMINAL_FALLBACK_CODES,
    RetryPolicy,
    qualify_fallback,
    qualify_retry,
)
from ..runtime.fallback_contract import (
    ContractRejection,
    FallbackContract,
    FallbackContractError,
)


_DEFAULT_ROUTING_PATH = Path(__file__).resolve().parents[3] / "routing" / "parser-routing.v1.yaml"


class RoutingTable(dict):
    """Route table carrying the optional I6-57 policy surface.

    ``load_parser_routing`` keeps its frozen 3-tuple return shape for the
    lifecycle/campaign callers; the retry policy and fallback-contract
    binding travel on the mapping itself so non-default routing authorities
    can activate them without changing the construction sites.
    """

    retry_policy: RetryPolicy | None = None
    fallback_contract: FallbackContract | None = None


def _code_list(value: Any, field: str) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or any(
        not isinstance(code, str) for code in value
    ):
        raise ValueError(f"{field} must be a list of error codes")
    ineligible = [code for code in value if code in TERMINAL_FALLBACK_CODES]
    if ineligible:
        raise ValueError(f"{field} must not contain terminal codes: {sorted(ineligible)}")
    unknown = [code for code in value if code not in RETRYABLE_FALLBACK_CODES]
    if unknown:
        raise ValueError(f"{field} contains codes outside the retryable policy: {sorted(unknown)}")
    return tuple(value)


def load_parser_routing(path: Path | str | None = None) -> tuple[dict[str, tuple[str, ...]], int, int]:
    """Load and validate the single parser route/fallback authority.

    Returns ``(routes, max_attempts, minimum_remaining_budget_ms)``.  The
    eligible-error list must stay inside the code-level retryable set and must
    never contain a terminal code such as TIMEOUT: request timeouts consume
    the deadline and are not retryable by construction.

    ``routes`` is a :class:`RoutingTable`: when the authority declares an
    optional ``retry:`` block (same-provider retry — I6-57) or a
    ``fallbackContract:`` path (runtime contract enforcement), the policy
    travels on the mapping so :class:`ResilientParser` picks it up without
    changing the frozen 3-tuple signature.
    """
    authority = Path(path) if path is not None else _DEFAULT_ROUTING_PATH
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - runtime dependency guard
        raise RuntimeError("PyYAML is required to load parser routing authority") from exc
    try:
        document = yaml.safe_load(authority.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"unable to read parser routing authority: {authority}") from exc
    if not isinstance(document, Mapping):
        raise ValueError("parser routing authority must be a mapping")
    raw_routes = document.get("routes")
    if not isinstance(raw_routes, Mapping) or not raw_routes:
        raise ValueError("parser routing authority requires a non-empty routes mapping")
    routes: dict[str, tuple[str, ...]] = {}
    for media_type, chain in raw_routes.items():
        if not isinstance(media_type, str) or "/" not in media_type:
            raise ValueError("parser routing authority contains an invalid media type")
        if not isinstance(chain, Sequence) or isinstance(chain, (str, bytes)) or not chain or any(not isinstance(item, str) or not item for item in chain):
            raise ValueError(f"parser route for {media_type} must be a non-empty provider list")
        if len(set(chain)) != len(tuple(chain)):
            raise ValueError(f"parser route for {media_type} contains a cycle")
        routes[media_type] = tuple(chain)
    fallback = document.get("fallback", {})
    if fallback is None:
        fallback = {}
    if not isinstance(fallback, Mapping):
        raise ValueError("parser routing fallback policy must be a mapping")
    eligible = fallback.get("eligibleErrors", sorted(RETRYABLE_FALLBACK_CODES))
    _code_list(eligible, "fallback.eligibleErrors")
    max_attempts = fallback.get("maxAttempts", 2)
    if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or max_attempts < 1:
        raise ValueError("fallback.maxAttempts must be a positive integer")
    minimum_budget = fallback.get("minimumRemainingBudgetMs", 1000)
    if isinstance(minimum_budget, bool) or not isinstance(minimum_budget, int) or minimum_budget < 0:
        raise ValueError("fallback.minimumRemainingBudgetMs must be a non-negative integer")

    # I6-57 retry block — same-provider retry, distinct from the
    # cross-provider fallback policy above.  Defaults preserve the sealed
    # default path: maxAttempts=1 means no same-provider retry.
    retry = document.get("retry", {})
    if retry is None:
        retry = {}
    if not isinstance(retry, Mapping):
        raise ValueError("parser routing retry policy must be a mapping")
    retry_attempts = retry.get("maxAttempts", 1)
    if isinstance(retry_attempts, bool) or not isinstance(retry_attempts, int) or retry_attempts < 1:
        raise ValueError("retry.maxAttempts must be a positive integer")
    retry_categories = _code_list(
        retry.get("retryableFailureCategories", sorted(RETRYABLE_FALLBACK_CODES)),
        "retry.retryableFailureCategories",
    )
    retry_budget = retry.get("deadlineBudget", "shared")
    if retry_budget != "shared":
        raise ValueError("retry.deadlineBudget must be 'shared' — retries never reset the request deadline")
    retry_min_budget = retry.get("minimumRemainingBudgetMs", minimum_budget)
    if isinstance(retry_min_budget, bool) or not isinstance(retry_min_budget, int) or retry_min_budget < 0:
        raise ValueError("retry.minimumRemainingBudgetMs must be a non-negative integer")

    table = RoutingTable(routes)
    table.retry_policy = RetryPolicy(
        max_attempts=retry_attempts,
        retryable_categories=frozenset(retry_categories),
        minimum_remaining_budget_ms=retry_min_budget,
    )
    contract_ref = document.get("fallbackContract")
    if contract_ref is not None:
        if not isinstance(contract_ref, str) or not contract_ref or Path(contract_ref).is_absolute():
            raise ValueError("fallbackContract must be a repository-relative path")
        contract_path = (authority.parent / contract_ref).resolve()
        table.fallback_contract = FallbackContract(contract_path)
    return table, max_attempts, minimum_budget


_IDENTITY = {
    "providerRef": "ghatana.resilient-parser",
    "providerVersion": "0.1.0",
    "modelRef": "governed-fallback",
    "modelVersion": "policy-v1",
}

# Failure-code → contract-trigger mapping for runtime FallbackContract
# admission.  A cross-provider hop is declared in the contract by trigger
# names (PROVIDER_TIMEOUT/PROVIDER_CRASH/...), not by wire error codes.
_FAILURE_TRIGGERS = {
    "TIMEOUT": "PROVIDER_TIMEOUT",
    "PROVIDER_FAILED": "PROVIDER_CRASH",
    "PROVIDER_BUSY": "PROVIDER_BUSY",
    "PROVIDER_UNAVAILABLE": "PROVIDER_UNAVAILABLE",
}


class ResilientParser:
    """Bounded, qualification-aware route strategy.

    Attempt lineage remains internal to the executor.  The returned value is
    still the frozen ParsedDocument-compatible payload.  I6-57 separates the
    two concepts the route composes:

    - *retry* — same providerRef, transient categories only, bounded by the
      authority's ``retry:`` policy; never a chain hop, never a deadline reset;
    - *fallback* — a different providerRef under declared routing; when a
      ``FallbackContract`` is bound, every hop is admitted by the contract at
      runtime and a rejection surfaces as terminal FALLBACK_NOT_IN_CONTRACT.
    """

    provider_ref = "ghatana.resilient-parser"
    is_strategy = True

    def __init__(
        self,
        routes: Mapping[str, Sequence[str]],
        *,
        max_attempts: int = 2,
        minimum_remaining_budget_ms: int = 1000,
        retry_policy: RetryPolicy | None = None,
        fallback_contract: FallbackContract | Path | str | None = None,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        self.routes = {key: tuple(value) for key, value in routes.items()}
        self.max_attempts = max_attempts
        self.minimum_remaining_budget_ms = max(0, minimum_remaining_budget_ms)
        # Policy carried on a RoutingTable mapping (from load_parser_routing)
        # is honoured unless an explicit constructor argument overrides it.
        self.retry_policy = retry_policy or getattr(routes, "retry_policy", None) or RetryPolicy()
        contract = fallback_contract if fallback_contract is not None else getattr(routes, "fallback_contract", None)
        if isinstance(contract, (str, Path)):
            contract = FallbackContract(Path(contract))
        self._contract = contract
        # Kind lineage (attempt:{seq}:{providerRef}:{kind}) is emitted only
        # when the I6-57 surface is active, so the sealed default path stays
        # byte-identical.
        self._detailed_lineage = self.retry_policy.max_attempts > 1 or self._contract is not None

    def identity(self) -> dict[str, str]:
        return dict(_IDENTITY)

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": sorted(self.routes)}

    def runtime_dependencies(self) -> tuple[str, ...]:
        """Every provider reachable through the active route table."""
        return tuple(sorted({ref for chain in self.routes.values() for ref in chain} - {self.provider_ref}))

    def warm(self) -> "ResilientParser":
        return self

    def _admit_fallback(self, last: WorkerError, attempted_order: list[str], attempted: set[str], provider: str, media_type: str, deadline: Deadline) -> None:
        qualification = qualify_fallback(
            last,
            remaining_deadline_ms=deadline.remaining_ms(),
            minimum_remaining_budget_ms=self.minimum_remaining_budget_ms,
            attempted_providers=frozenset(attempted),
            next_provider=provider,
        )
        if not qualification.eligible:
            raise last
        if self._contract is not None:
            trigger = _FAILURE_TRIGGERS.get(last.code, last.code)
            try:
                self._contract.admit(attempted_order[-1], provider, trigger, media_type)
            except FallbackContractError as exc:
                # Contract rejection is terminal — never silent, never
                # retried, never rewritten into a fallback success.
                raise ContractRejection("FALLBACK_NOT_IN_CONTRACT") from exc

    async def parse(
        self,
        data: bytes,
        *,
        media_type: str,
        language: str | None,
        limits: Mapping[str, int],
        deadline: Deadline,
        token: CancellationToken,
        executor: Any,
        call_stack: tuple[str, ...],
    ) -> dict[str, Any]:
        providers = self.routes.get(media_type, ())
        if not providers:
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)

        attempted: set[str] = set()
        attempted_order: list[str] = []
        lineage: list[tuple[str, str]] = []  # (provider_ref, attempt kind)
        last: WorkerError | None = None
        for provider in providers:
            if len(attempted) >= self.max_attempts:
                break
            token.raise_if_cancelled()
            if last is not None:
                self._admit_fallback(last, attempted_order, attempted, provider, media_type, deadline)
            if deadline.remaining_ms() < self.minimum_remaining_budget_ms:
                if last is not None:
                    raise last
                raise WorkerError("TIMEOUT", retryable=True, provider_ref=self.provider_ref)
            attempted.add(provider)
            attempted_order.append(provider)
            base_kind = "PRIMARY" if len(attempted) == 1 else "FALLBACK"
            attempt_index = 0
            while True:
                attempt_index += 1
                kind = base_kind if attempt_index == 1 else "RETRY"
                try:
                    # The original absolute deadline, token, and call stack
                    # are deliberately preserved — a retry shares the same
                    # request budget and is not a chain hop.
                    result = await executor.parse(
                        provider,
                        data,
                        media_type=media_type,
                        language=language,
                        limits=limits,
                        deadline=deadline,
                        token=token,
                        call_stack=call_stack,
                        attempt_kind=kind,
                    )
                    lineage.append((provider, kind))
                    quality = dict(result.get("quality", {}))
                    warnings = list(quality.get("warnings", []))
                    warnings.append("attemptedProviderRefs:" + ",".join(attempted_order))
                    warnings.append(f"selectedProviderRef:{provider}")
                    if self._detailed_lineage:
                        warnings.extend(
                            f"attempt:{seq}:{ref}:{attempt_kind}"
                            for seq, (ref, attempt_kind) in enumerate(lineage, 1)
                        )
                    quality["warnings"] = warnings
                    return {**result, "providerProvenance": self.identity(), "quality": quality}
                except WorkerError as exc:
                    last = exc
                    lineage.append((provider, kind))
                    retry = qualify_retry(
                        exc,
                        remaining_deadline_ms=deadline.remaining_ms(),
                        attempts_used=attempt_index,
                        policy=self.retry_policy,
                    )
                    if retry.eligible:
                        continue  # same-provider retry; chain position unchanged
                    qualification = qualify_fallback(
                        exc,
                        remaining_deadline_ms=deadline.remaining_ms(),
                        minimum_remaining_budget_ms=self.minimum_remaining_budget_ms,
                        attempted_providers=frozenset(attempted),
                    )
                    if not qualification.eligible:
                        raise
                    break  # advance the declared fallback chain
        if last is not None:
            raise last
        raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=self.provider_ref)
