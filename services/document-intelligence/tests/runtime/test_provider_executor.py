from __future__ import annotations

import asyncio
import threading
import time

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.concurrency import BoundedLane
from document_intelligence.runtime.deadline import Deadline
from document_intelligence.runtime.provider_trace import AttemptRecord
from document_intelligence.runtime.provider_executor import ProviderExecutor
from document_intelligence.providers.strategies import ResilientParser


class Leaf:
    def __init__(self, gate: threading.Event | None = None) -> None:
        self.calls = 0
        self.gate = gate

    def parse(self, data, **kwargs):
        self.calls += 1
        if self.gate is not None:
            self.gate.wait(1)
        return {"value": data.decode()}


class Strategy:
    is_strategy = True

    async def parse(self, data, *, executor, deadline, token, call_stack, **kwargs):
        return await executor.parse("child", data, media_type="image/png", language="en", limits={}, deadline=deadline, token=token, call_stack=call_stack)


class Cycle:
    is_strategy = True

    async def parse(self, data, *, executor, deadline, token, call_stack, **kwargs):
        return await executor.parse("cycle", data, media_type="image/png", language="en", limits={}, deadline=deadline, token=token, call_stack=call_stack)


class IdentifiedLeaf(Leaf):
    def identity(self):
        return {"providerRef": "leaf", "providerVersion": "v1", "modelRef": "model", "modelVersion": "m1"}


class RetryableFailure:
    def __init__(self, provider_ref="ghatana.paddleocr", code="PROVIDER_FAILED", retryable=True):
        self.calls = 0
        self.provider_ref = provider_ref
        self.code = code
        self.retryable = retryable

    def identity(self):
        return {"providerRef": self.provider_ref, "providerVersion": "v1", "modelRef": "model-one", "modelVersion": "m1"}

    def parse(self, data, **kwargs):
        self.calls += 1
        raise WorkerError(self.code, retryable=self.retryable, provider_ref=self.provider_ref)


class SuccessfulLeaf(Leaf):
    def __init__(self, provider_ref="ghatana.tesseractocr"):
        super().__init__()
        self.provider_ref = provider_ref

    def identity(self):
        return {"providerRef": self.provider_ref, "providerVersion": "v2", "modelRef": "model-two", "modelVersion": "m2"}


def executor(providers, *, queue=1):
    lanes = {name: BoundedLane(name, 1, queue) for name in providers}
    return ProviderExecutor(providers, lanes, tuple(providers)), lanes


async def invoke(target, *, deadline=None, token=None):
    return await target.parse("leaf", b"ok", media_type="image/png", language="en", limits={}, deadline=deadline or Deadline(1_000, margin_ms=0), token=token or CancellationToken())


async def test_leaf_executes_once():
    leaf = Leaf()
    target, _ = executor({"leaf": leaf})
    assert await invoke(target) == {"value": "ok"}
    assert leaf.calls == 1


async def test_attempt_lineage_is_secret_safe_and_has_identity_and_budget():
    leaf = IdentifiedLeaf()
    target, _ = executor({"leaf": leaf})
    assert await invoke(target) == {"value": "ok"}
    trace = target.last_trace
    assert trace is not None
    assert len(trace.attempts) == 1
    attempt = trace.attempts[0]
    assert isinstance(attempt, AttemptRecord)
    assert (attempt.sequence, attempt.route, attempt.provider_ref) == (1, "leaf", "leaf")
    assert (attempt.provider_version, attempt.model_ref, attempt.model_version) == ("v1", "model", "m1")
    assert (attempt.operation, attempt.outcome, attempt.failure) == ("parse", "success", None)
    assert attempt.elapsed_ms >= 0 and attempt.remaining_deadline_ms >= 0
    assert "ok" not in repr(attempt.as_dict()) and "data" not in attempt.as_dict()


async def test_retryable_failure_falls_back_and_records_both_attempts():
    first, second = RetryableFailure(), SuccessfulLeaf()
    strategy = ResilientParser({"image/png": ("ghatana.paddleocr", "ghatana.tesseractocr")}, minimum_remaining_budget_ms=1)
    target, _ = executor({"route": strategy, "ghatana.paddleocr": first, "ghatana.tesseractocr": second})
    result = await target.parse("route", b"ok", media_type="image/png", language="en", limits={}, deadline=Deadline(1_000, margin_ms=0), token=CancellationToken())
    assert result["quality"]["warnings"] == [
        "attemptedProviderRefs:ghatana.paddleocr,ghatana.tesseractocr",
        "selectedProviderRef:ghatana.tesseractocr",
    ]
    assert first.calls == 1 and second.calls == 1
    trace = target.last_trace
    assert trace is not None
    assert [(item.sequence, item.provider_ref, item.outcome, item.failure) for item in trace.attempts] == [
        (1, "ghatana.paddleocr", "failure", "PROVIDER_FAILED"),
        (2, "ghatana.tesseractocr", "success", None),
    ]


async def test_non_retryable_invalid_input_does_not_invoke_fallback_provider():
    first, second = RetryableFailure(retryable=False), SuccessfulLeaf()
    strategy = ResilientParser({"image/png": ("ghatana.paddleocr", "ghatana.tesseractocr")}, minimum_remaining_budget_ms=1)
    target, _ = executor({"route": strategy, "ghatana.paddleocr": first, "ghatana.tesseractocr": second})
    with pytest.raises(WorkerError) as rejected:
        await target.parse("route", b"not-image", media_type="image/png", language="en", limits={}, deadline=Deadline(1_000, margin_ms=0), token=CancellationToken())
    assert rejected.value.code == "PROVIDER_FAILED"
    assert first.calls == 1 and second.calls == 0


async def test_composite_invokes_bounded_child_with_same_deadline():
    child = Leaf()
    target, _ = executor({"strategy": Strategy(), "child": child})
    deadline = Deadline(1_000, margin_ms=0)
    result = await target.parse("strategy", b"ok", media_type="image/png", language="en", limits={}, deadline=deadline, token=CancellationToken())
    assert result == {"value": "ok"}
    assert child.calls == 1


async def test_cycles_fail_closed():
    target, _ = executor({"cycle": Cycle()})
    with pytest.raises(WorkerError) as rejected:
        await target.parse("cycle", b"x", media_type="image/png", language="en", limits={}, deadline=Deadline(1_000), token=CancellationToken())
    assert rejected.value.code == "INVALID_REQUEST"


async def test_timeout_does_not_release_leaf_lane_until_native_completion():
    gate = threading.Event()
    leaf = Leaf(gate)
    target, _ = executor({"leaf": leaf}, queue=0)
    with pytest.raises(WorkerError) as timeout:
        await invoke(target, deadline=Deadline(30, margin_ms=0))
    assert timeout.value.code == "TIMEOUT"
    with pytest.raises(WorkerError) as busy:
        await invoke(target, deadline=Deadline(30, margin_ms=0))
    assert busy.value.code == "PROVIDER_BUSY"
    gate.set()
    await asyncio.sleep(0.02)


async def test_cancellation_propagates_and_retains_lane():
    gate = threading.Event()
    leaf = Leaf(gate)
    target, _ = executor({"leaf": leaf}, queue=0)
    token = CancellationToken()
    task = asyncio.create_task(invoke(target, deadline=Deadline(1_000, margin_ms=0), token=token))
    while leaf.calls == 0:
        await asyncio.sleep(0)
    token.cancel()
    with pytest.raises(WorkerError) as cancelled:
        await task
    assert cancelled.value.code == "CANCELLED"
    with pytest.raises(WorkerError) as busy:
        await invoke(target, deadline=Deadline(30, margin_ms=0))
    assert busy.value.code == "PROVIDER_BUSY"
    gate.set()
    await asyncio.sleep(0.02)


async def test_queue_is_bounded():
    gate = threading.Event()
    leaf = Leaf(gate)
    target, _ = executor({"leaf": leaf}, queue=0)
    first = asyncio.create_task(invoke(target))
    while leaf.calls == 0:
        await asyncio.sleep(0)
    with pytest.raises(WorkerError) as busy:
        await invoke(target, deadline=Deadline(20, margin_ms=0))
    assert busy.value.code == "PROVIDER_BUSY"
    gate.set()
    assert await first == {"value": "ok"}


async def test_leaf_failures_are_sanitized():
    class Broken:
        def parse(self, *args, **kwargs):
            raise RuntimeError("sensitive source text")

    target, _ = executor({"leaf": Broken()})
    with pytest.raises(WorkerError) as rejected:
        await invoke(target)
    assert rejected.value.code == "PROVIDER_FAILED"
    assert str(rejected.value) == "PROVIDER_FAILED"


async def test_task_cancellation_retains_native_future_and_lane_until_completion():
    gate = threading.Event()
    leaf = Leaf(gate)
    target, _ = executor({"leaf": leaf}, queue=0)
    request = asyncio.create_task(invoke(target, deadline=Deadline(5_000, margin_ms=0)))
    while leaf.calls == 0:
        await asyncio.sleep(0)

    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert target.active_native_calls == 1
    with pytest.raises(WorkerError) as busy:
        await invoke(target, deadline=Deadline(30, margin_ms=0))
    assert busy.value.code == "PROVIDER_BUSY"

    gate.set()
    assert await target.drain_native(2.0)
    assert target.active_native_calls == 0
