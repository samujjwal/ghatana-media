"""Increment-6 runtime-policy tests (I6-56..I6-60).

Covers scheduler tenant/provider fairness, deadline-aware rejection and
resource accounting; retry-vs-fallback separation with runtime contract
enforcement and shared-deadline propagation; language-resolution ordering,
NFC normalization, and Devanagari ambiguity; observability cardinality.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
import yaml

from document_intelligence.contracts import RequestMetadata
from document_intelligence.errors import WorkerError
from document_intelligence.limits import Limits
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.concurrency import BoundedLane
from document_intelligence.runtime.deadline import Deadline
from document_intelligence.runtime.fallback import RetryPolicy, qualify_retry
from document_intelligence.runtime.fallback_contract import (
    ContractRejection,
    FallbackContract,
)
from document_intelligence.runtime.language_resolution import (
    LanguageResolution,
    load_resolution_authority,
    resolve_language,
)
from document_intelligence.runtime.provider_executor import ProviderExecutor
from document_intelligence.runtime.scheduler import BoundedScheduler, SchedulerError
from document_intelligence.strategies.resilient_parser import (
    ResilientParser,
    load_parser_routing,
)

WORKER_ROOT = Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------- I6-56 ---
# Scheduler: provider cap, tenant queued limit, fair dispatch, deadlines,
# accounting.


def test_scheduler_per_provider_in_flight_cap_skips_saturated_provider():
    scheduler = BoundedScheduler(max_in_flight=4, max_queued=10, max_provider_in_flight=1)
    first = scheduler.submit({"providerRef": "p1"})
    second = scheduler.submit({"providerRef": "p1"})
    third = scheduler.submit({"providerRef": "p2"})
    assert scheduler.dispatch() is first
    # p1 is saturated: the p2 ticket dispatches ahead of the queued p1 ticket.
    assert scheduler.dispatch() is third
    assert scheduler.dispatch() is None
    scheduler.complete(first)
    assert scheduler.dispatch() is second


def test_scheduler_per_tenant_queued_limit_is_distinct_from_share():
    scheduler = BoundedScheduler(max_in_flight=2, max_queued=10, max_tenant_queued=2)
    scheduler.submit({"tenantId": "a"})
    scheduler.submit({"tenantId": "a"})
    with pytest.raises(WorkerError) as error:
        scheduler.submit({"tenantId": "a"})
    assert error.value.code == "BACKPRESSURE"
    # Other tenants keep their own queued budget.
    scheduler.submit({"tenantId": "b"})
    # Dispatching frees queued budget even though the tenant's active share
    # (queued + running) is unchanged.  Fair order dispatches b (least
    # active) first, then one of a's queued tickets.
    scheduler.dispatch()
    scheduler.dispatch()
    scheduler.submit({"tenantId": "a"})


def test_scheduler_fair_dispatch_uses_least_active_count():
    scheduler = BoundedScheduler(max_in_flight=8, max_queued=16)
    a1 = scheduler.submit({"tenantId": "busy", "seq": 1})
    a2 = scheduler.submit({"tenantId": "busy", "seq": 2})
    a3 = scheduler.submit({"tenantId": "busy", "seq": 3})
    b1 = scheduler.submit({"tenantId": "small", "seq": 4})
    # The tenant holding fewer active tickets is served first; within a
    # tenant the oldest ticket wins.  A busy tenant cannot starve others.
    assert scheduler.dispatch() is b1
    assert scheduler.dispatch() is a1
    assert scheduler.dispatch() is a2
    assert scheduler.dispatch() is a3


def test_scheduler_deadline_aware_rejection():
    clock = lambda: 10_000.0  # noqa: E731 - deterministic epoch-ms clock
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=4, now_ms=clock)
    with pytest.raises(WorkerError) as expired:
        scheduler.submit({"deadlineMs": 9_900})
    assert expired.value.code == "DEADLINE_INSUFFICIENT"
    assert expired.value.retryable is False
    with pytest.raises(WorkerError) as below_floor:
        scheduler.submit({"deadlineMs": 10_050, "minRemainingMs": 100})
    assert below_floor.value.code == "DEADLINE_INSUFFICIENT"
    ticket = scheduler.submit({"deadlineMs": 10_200, "minRemainingMs": 100})
    assert ticket.state == "QUEUED"
    # Jobs without a deadline field are never deadline-rejected.
    scheduler.submit({})


def test_scheduler_deadline_floor_defaults_to_scheduler_policy():
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=4, min_remaining_ms=500, now_ms=lambda: 0.0)
    with pytest.raises(WorkerError) as error:
        scheduler.submit({"deadlineMs": 200})
    assert error.value.code == "DEADLINE_INSUFFICIENT"


def test_scheduler_accounting_records_bounded_scalar_fields():
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=8, accounting_limit=3)
    for index in range(5):
        ticket = scheduler.submit({"tenantId": "t1", "providerRef": "p", "pages": index, "bytes": index * 10})
        scheduler.dispatch()
        scheduler.complete(ticket)
    entries = scheduler.accounting()
    assert len(entries) == 3  # bounded log retains the most recent entries
    last = entries[-1]
    assert last["tenant"] == "t1" and last["provider"] == "p"
    assert last["pages"] == 4 and last["bytes"] == 40
    assert last["queuedMs"] >= 0 and last["execMs"] >= 0
    assert set(last) == {"tenant", "provider", "pages", "bytes", "queuedMs", "execMs"}


def test_scheduler_accounting_excludes_document_content():
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=2)
    ticket = scheduler.submit({"providerRef": "p", "text": "secret-document-body"})
    scheduler.dispatch()
    scheduler.complete(ticket)
    (entry,) = scheduler.accounting()
    assert "secret-document-body" not in repr(entry)


# ------------------------------------------------- executor wiring (I6-56)


class _Leaf:
    def __init__(self) -> None:
        self.calls = 0

    def parse(self, data, **kwargs):
        self.calls += 1
        return {"pages": [{"pageNumber": 1, "blocks": [], "tables": []}], "providerProvenance": {"providerRef": "leaf"}, "quality": {}}


class _DelegatingStrategy:
    is_strategy = True

    async def parse(self, data, *, executor, deadline, token, call_stack, **kwargs):
        return await executor.parse("leaf", data, media_type="image/png", language="en", limits={}, deadline=deadline, token=token, call_stack=call_stack)


def _executor(providers, *, scheduler=None):
    lanes = {name: BoundedLane(name, 1, 1) for name in providers}
    return ProviderExecutor(providers, lanes, tuple(providers), scheduler=scheduler)


async def test_executor_scheduler_admission_records_accounting():
    scheduler = BoundedScheduler(max_in_flight=2, max_queued=4)
    leaf = _Leaf()
    executor = _executor({"leaf": leaf}, scheduler=scheduler)
    result = await executor.parse("leaf", b"ok", media_type="image/png", language="en", limits={}, deadline=Deadline(1_000, margin_ms=0), token=CancellationToken())
    assert result["pages"]
    (entry,) = scheduler.accounting()
    assert entry["provider"] == "leaf" and entry["bytes"] == 2 and entry["pages"] == 1


async def test_executor_scheduler_rejection_propagates_backpressure():
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=1)
    scheduler.submit({})  # fills the queue
    executor = _executor({"leaf": _Leaf()}, scheduler=scheduler)
    with pytest.raises(SchedulerError) as error:
        await executor.parse("leaf", b"ok", media_type="image/png", language="en", limits={}, deadline=Deadline(1_000, margin_ms=0), token=CancellationToken())
    assert error.value.code == "BACKPRESSURE"
    assert error.value.retryable is True


async def test_executor_nested_strategy_calls_skip_scheduler_admission():
    # A strategy holds the single in-flight slot while its child executes:
    # children must not queue behind the parent's ticket or this would
    # deadlock at max_in_flight=1.
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=4)
    leaf = _Leaf()
    executor = _executor({"route": _DelegatingStrategy(), "leaf": leaf}, scheduler=scheduler)
    result = await executor.parse("route", b"ok", media_type="image/png", language="en", limits={}, deadline=Deadline(1_000, margin_ms=0), token=CancellationToken())
    assert result["pages"]
    assert leaf.calls == 1
    (entry,) = scheduler.accounting()
    assert entry["provider"] == "route"


async def test_executor_without_scheduler_is_unchanged():
    executor = _executor({"leaf": _Leaf()})
    assert executor.scheduler is None
    result = await executor.parse("leaf", b"ok", media_type="image/png", language="en", limits={}, deadline=Deadline(1_000, margin_ms=0), token=CancellationToken())
    assert result["pages"]


# ---------------------------------------------------------------- I6-57 ---
# Retry vs fallback.


class _ScriptedExecutor:
    """Executor double: per-provider outcome scripts, records attempt kind."""

    def __init__(self, scripts):
        self.scripts = {key: list(value) for key, value in scripts.items()}
        self.calls: list[tuple[str, str | None, Deadline]] = []

    async def parse(self, provider, data, **kwargs):
        self.calls.append((provider, kwargs.get("attempt_kind"), kwargs["deadline"]))
        script = self.scripts.get(provider, [])
        outcome = script.pop(0) if script else {"pages": [], "quality": {}}
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _strategy(routes, **kwargs):
    merged = {"minimum_remaining_budget_ms": 1, **kwargs}
    return ResilientParser(routes, **merged)


def test_qualify_retry_is_distinct_from_fallback_eligibility():
    failure = WorkerError("PROVIDER_FAILED", retryable=True)
    policy = RetryPolicy(max_attempts=2)
    assert qualify_retry(failure, remaining_deadline_ms=500, attempts_used=1, policy=policy).eligible
    assert not qualify_retry(failure, remaining_deadline_ms=500, attempts_used=2, policy=policy).eligible
    terminal = WorkerError("TIMEOUT", retryable=True)
    verdict = qualify_retry(terminal, remaining_deadline_ms=500, attempts_used=1, policy=policy)
    assert not verdict.eligible and verdict.reason.startswith("terminal:")
    non_retryable = WorkerError("PROVIDER_FAILED", retryable=False)
    assert not qualify_retry(non_retryable, remaining_deadline_ms=500, attempts_used=1, policy=policy).eligible


async def test_same_provider_retry_inside_attempt_before_fallback():
    strategy = _strategy(
        {"image/png": ("one", "two")},
        retry_policy=RetryPolicy(max_attempts=2),
    )
    executor = _ScriptedExecutor(
        {
            "one": [WorkerError("PROVIDER_FAILED", retryable=True), {"pages": [], "quality": {}}],
            "two": [{"pages": [], "quality": {}}],
        }
    )
    result = await strategy.parse(
        b"x", media_type="image/png", language="en", limits={},
        deadline=Deadline(1_000, margin_ms=0), token=CancellationToken(),
        executor=executor, call_stack=(strategy.provider_ref,),
    )
    # The retry repeats the same provider; the fallback provider is untouched.
    assert [call[0] for call in executor.calls] == ["one", "one"]
    assert [call[1] for call in executor.calls] == ["PRIMARY", "RETRY"]
    warnings = result["quality"]["warnings"]
    assert "selectedProviderRef:one" in warnings
    assert "attempt:1:one:PRIMARY" in warnings
    assert "attempt:2:one:RETRY" in warnings


async def test_retry_exhaustion_then_fallback_with_distinct_kinds():
    strategy = _strategy(
        {"image/png": ("one", "two")},
        retry_policy=RetryPolicy(max_attempts=2),
    )
    executor = _ScriptedExecutor(
        {
            "one": [
                WorkerError("PROVIDER_FAILED", retryable=True),
                WorkerError("PROVIDER_FAILED", retryable=True),
            ],
            "two": [{"pages": [], "quality": {}}],
        }
    )
    result = await strategy.parse(
        b"x", media_type="image/png", language="en", limits={},
        deadline=Deadline(1_000, margin_ms=0), token=CancellationToken(),
        executor=executor, call_stack=(strategy.provider_ref,),
    )
    assert [call[0] for call in executor.calls] == ["one", "one", "two"]
    assert [call[1] for call in executor.calls] == ["PRIMARY", "RETRY", "FALLBACK"]
    warnings = result["quality"]["warnings"]
    assert "attempt:3:two:FALLBACK" in warnings
    assert warnings[:2] == ["attemptedProviderRefs:one,two", "selectedProviderRef:two"]


async def test_default_path_has_no_retry_and_unchanged_warnings():
    strategy = _strategy({"image/png": ("one", "two")})
    executor = _ScriptedExecutor(
        {"one": [WorkerError("PROVIDER_FAILED", retryable=True)], "two": [{"pages": [], "quality": {}}]}
    )
    result = await strategy.parse(
        b"x", media_type="image/png", language="en", limits={},
        deadline=Deadline(1_000, margin_ms=0), token=CancellationToken(),
        executor=executor, call_stack=(strategy.provider_ref,),
    )
    assert [call[0] for call in executor.calls] == ["one", "two"]
    assert result["quality"]["warnings"] == [
        "attemptedProviderRefs:one,two",
        "selectedProviderRef:two",
    ]


async def test_fallback_attempt_shares_the_same_deadline_object():
    strategy = _strategy({"image/png": ("one", "two")}, retry_policy=RetryPolicy(max_attempts=2))
    executor = _ScriptedExecutor(
        {
            "one": [WorkerError("PROVIDER_FAILED", retryable=True)] * 2,
            "two": [{"pages": [], "quality": {}}],
        }
    )
    deadline = Deadline(1_000, margin_ms=0)
    await strategy.parse(
        b"x", media_type="image/png", language="en", limits={},
        deadline=deadline, token=CancellationToken(),
        executor=executor, call_stack=(strategy.provider_ref,),
    )
    deadlines = [call[2] for call in executor.calls]
    # The shared Deadline instance is never reset or replaced: every attempt
    # receives remaining-budget only.
    assert all(item is deadline for item in deadlines)


async def test_fallback_contract_admits_declared_chain_at_runtime():
    contract = FallbackContract()  # routing/fallback-contract.v1.yaml
    strategy = _strategy(
        {"image/png": ("ghatana.paddleocr", "ghatana.resilient-parser.tesseract")},
        fallback_contract=contract,
    )
    executor = _ScriptedExecutor(
        {
            "ghatana.paddleocr": [WorkerError("PROVIDER_FAILED", retryable=True)],
            "ghatana.resilient-parser.tesseract": [{"pages": [], "quality": {}}],
        }
    )
    result = await strategy.parse(
        b"x", media_type="image/png", language="en", limits={},
        deadline=Deadline(1_000, margin_ms=0), token=CancellationToken(),
        executor=executor, call_stack=(strategy.provider_ref,),
    )
    assert result["providerProvenance"]["providerRef"] == strategy.provider_ref
    assert "selectedProviderRef:ghatana.resilient-parser.tesseract" in result["quality"]["warnings"]


async def test_fallback_contract_rejection_is_terminal_not_silent():
    contract = FallbackContract()
    strategy = _strategy(
        {"application/pdf": ("ghatana.gliner", "ghatana.docling")},
        fallback_contract=contract,
    )
    executor = _ScriptedExecutor(
        {
            "ghatana.gliner": [WorkerError("PROVIDER_FAILED", retryable=True)],
            "ghatana.docling": [{"pages": [], "quality": {}}],
        }
    )
    with pytest.raises(WorkerError) as error:
        await strategy.parse(
            b"x", media_type="application/pdf", language="en", limits={},
            deadline=Deadline(1_000, margin_ms=0), token=CancellationToken(),
            executor=executor, call_stack=(strategy.provider_ref,),
        )
    # The contract veto surfaces as a terminal FALLBACK_NOT_IN_CONTRACT —
    # the undeclared (from,to) hop is never silently taken.
    assert isinstance(error.value, ContractRejection)
    assert error.value.code == "FALLBACK_NOT_IN_CONTRACT"
    assert error.value.retryable is False
    assert [call[0] for call in executor.calls] == ["ghatana.gliner"]


def test_parser_routing_retry_policy_defaults_preserve_sealed_behavior():
    routes, max_attempts, minimum_budget = load_parser_routing(WORKER_ROOT / "routing/parser-routing.v1.yaml")
    assert max_attempts == 2 and minimum_budget == 1000
    policy = getattr(routes, "retry_policy", None)
    assert policy is not None and policy.max_attempts == 1  # no same-provider retry
    assert getattr(routes, "fallback_contract", None) is None
    strategy = ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=minimum_budget)
    assert strategy.retry_policy.max_attempts == 1


def test_parser_routing_retry_validation(tmp_path: Path):
    bad = tmp_path / "routing.yaml"
    bad.write_text(
        yaml.safe_dump(
            {
                "routes": {"image/png": ["a"]},
                "retry": {"maxAttempts": 0},
            }
        )
    )
    with pytest.raises(ValueError, match="retry.maxAttempts"):
        load_parser_routing(bad)
    bad.write_text(
        yaml.safe_dump(
            {
                "routes": {"image/png": ["a"]},
                "retry": {"deadlineBudget": "reset"},
            }
        )
    )
    with pytest.raises(ValueError, match="deadlineBudget"):
        load_parser_routing(bad)
    bad.write_text(
        yaml.safe_dump(
            {
                "routes": {"image/png": ["a"]},
                "retry": {"retryableFailureCategories": ["TIMEOUT"]},
            }
        )
    )
    with pytest.raises(ValueError, match="terminal"):
        load_parser_routing(bad)


def test_parser_routing_fallback_contract_binding(tmp_path: Path):
    contract = tmp_path / "contract.yaml"
    contract.write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "document-intelligence.fallback-contract.v1",
                "rules": {"implicitFallback": "REJECT"},
                "chains": [
                    {
                        "id": "a-to-b",
                        "from": "a",
                        "to": "b",
                        "mediaTypes": ["image/png"],
                        "triggers": ["PROVIDER_CRASH"],
                        "record": ["reasonCode"],
                    }
                ],
            }
        )
    )
    routing = tmp_path / "routing.yaml"
    routing.write_text(
        yaml.safe_dump({"routes": {"image/png": ["a", "b"]}, "fallbackContract": "contract.yaml"})
    )
    routes, _, _ = load_parser_routing(routing)
    bound = getattr(routes, "fallback_contract", None)
    assert isinstance(bound, FallbackContract)
    assert bound.admit("a", "b", "PROVIDER_CRASH", "image/png").allowed


# ---------------------------------------------------------------- I6-58 ---
# Language resolution.


def test_resolve_language_validated_hint_wins():
    resolution = resolve_language(
        "ne", media_type="image/png", candidate_languages=("en", "ne"), default_language="en"
    )
    assert resolution == LanguageResolution("ne", "REQUEST_HINT", "HINT")


def test_resolve_language_profile_default_then_none():
    resolution = resolve_language(
        None, media_type="image/png", candidate_languages=("en", "ne"), default_language="ne"
    )
    assert resolution == LanguageResolution("ne", "PROFILE_DEFAULT", "PROFILE")
    resolution = resolve_language(None, media_type="image/png", candidate_languages=("en", "ne"))
    assert resolution.language is None and resolution.source == "NONE"


def test_resolve_language_detection_disabled_by_default_and_never_fabricates():
    for enabled in (False, True):
        resolution = resolve_language(
            None,
            media_type="image/png",
            candidate_languages=("en", "ne", "hi", "mr"),
            detection_enabled=enabled,
        )
        # Script identity may never select among ne/hi/mr — and no detector
        # output may manufacture a language at all.
        assert resolution.language not in {"ne", "hi", "mr"}
        assert resolution.language is None
        assert resolution.source == "NONE"


def test_resolve_language_nfc_normalizes_hint():
    from document_intelligence.runtime.language_resolution import normalize_language_input

    # NFC composes canonical equivalents (decomposed accent -> precomposed)
    # but deliberately does NOT apply compatibility folding (NFKC): a
    # full-width "en" is not a valid tag and must not be smuggled in.
    assert normalize_language_input("e\u0301") == "\u00e9"  # NFD -> NFC
    assert normalize_language_input("en") == "en"
    resolution = resolve_language("en", media_type="image/png", candidate_languages=("en", "ne"))
    assert resolution.language == "en" and resolution.source == "HINT"
    resolution = resolve_language("ｅｎ", media_type="image/png", candidate_languages=("en", "ne"))
    assert resolution.language is None and resolution.reason_code == "HINT_NOT_CANDIDATE"


def test_resolve_language_non_candidate_hint_yields_none_not_substitute():
    resolution = resolve_language("fr", media_type="image/png", candidate_languages=("en", "ne"))
    assert resolution.language is None and resolution.reason_code == "HINT_NOT_CANDIDATE"


def test_request_metadata_nfc_hint_canonical_and_unknown_rejected():
    limits = Limits()
    metadata = RequestMetadata.parse(
        {
            "protocolVersion": "document-intelligence.v1",
            "operationId": "op-nfc",
            "providerRef": "ghatana.paddleocr",
            "mediaType": "image/png",
            "languageHint": "en",
            "timeoutMs": 1_000,
            "limits": {},
        },
        limits,
        media_type_required=True,
        allowed_media_types=("image/png",),
        allowed_languages=("en", "ne"),
    )
    assert metadata.language_hint == "en"
    # NFC does not smuggle compatibility lookalikes into the admitted set.
    with pytest.raises(WorkerError) as full_width:
        RequestMetadata.parse(
            {
                "protocolVersion": "document-intelligence.v1",
                "operationId": "op-fw",
                "providerRef": "ghatana.paddleocr",
                "mediaType": "image/png",
                "languageHint": "ｅｎ",
                "timeoutMs": 1_000,
                "limits": {},
            },
            limits,
            media_type_required=True,
            allowed_media_types=("image/png",),
            allowed_languages=("en", "ne"),
        )
    assert full_width.value.code == "UNSUPPORTED_LANGUAGE"
    with pytest.raises(WorkerError) as error:
        RequestMetadata.parse(
            {
                "protocolVersion": "document-intelligence.v1",
                "operationId": "op-bad",
                "providerRef": "ghatana.paddleocr",
                "mediaType": "image/png",
                "languageHint": "fr",
                "timeoutMs": 1_000,
                "limits": {},
            },
            limits,
            media_type_required=True,
            allowed_media_types=("image/png",),
            allowed_languages=("en", "ne"),
        )
    assert error.value.code == "UNSUPPORTED_LANGUAGE"


def test_language_resolution_authority_loads():
    document = load_resolution_authority()
    assert document["resolutionOrder"] == [
        "validatedRequestHint",
        "profileDefault",
        "detection",
        "fallbackOrError",
    ]
    assert document["unicodeNormalization"] == "NFC"
    assert document["detection"]["enabledByDefault"] is False


# ---------------------------------------------------------------- I6-60 ---
# Observability cardinality.


def test_observability_cardinality_check_passes():
    sys_path = WORKER_ROOT / "scripts"
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "check_observability_cardinality", sys_path / "check_observability_cardinality.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.check() == []


def test_observability_cardinality_detects_forbidden_labels(tmp_path: Path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "check_observability_cardinality",
        WORKER_ROOT / "scripts/check_observability_cardinality.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    (tmp_path / "observability.py").write_text(
        'SAFE_FIELDS = frozenset({"operationId", "tenantName"})\n'
    )
    (tmp_path / "metrics.py").write_text(
        'def report(counter):\n'
        '    counter.labels(tenantName="acme", operationId="op-1")\n'
    )
    errors = module.check(tmp_path)
    assert any("tenantName" in error for error in errors)
    assert any("operationId" in error for error in errors)


# ---------------------------------------------------------------- I6-59 ---
# Office projection authority.


def test_office_projection_authority_loads_and_declares_actual_behavior():
    document = yaml.safe_load(
        (WORKER_ROOT / "routing/office-projection.v1.yaml").read_text(encoding="utf-8")
    )
    assert document["schemaVersion"] == "document-intelligence.office-projection.v1"
    assert document["pptx"]["slideToPage"]["order"] == "sldIdLst"
    assert document["pptx"]["speakerNotes"]["policy"] == "EXCLUDED"
    assert document["xlsx"]["cellIdentity"] == "p{page}-t1-c{row-1}-{column-1}"
    assert document["xlsx"]["hiddenContent"]["policy"] == "included"
    assert document["xlsx"]["valueMapping"]["formula"]["execution"] == "NEVER"
    assert document["docx"]["headersFooters"]["policy"] == "EXCLUDED"
