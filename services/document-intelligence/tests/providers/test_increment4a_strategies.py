from __future__ import annotations

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.providers.strategies import ResilientParser, merge_parsed_documents
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


def test_composite_merge_is_deterministic_and_deduplicates_exact_lines():
    line = {"lineId": "x", "text": "same", "boundingRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 0.1}}
    document = {"pages": [{"pageNumber": 1, "blocks": [{"blockId": "x", "lines": [line]}], "tables": []}]}
    result = merge_parsed_documents(document, document, {"providerRef": "composite"})
    assert len(result["pages"][0]["blocks"]) == 1
    assert result["providerProvenance"] == {"providerRef": "composite"}


class FakeExecutor:
    def __init__(self, failures): self.failures, self.calls = list(failures), []
    async def parse(self, provider, data, **kwargs):
        self.calls.append((provider, kwargs["deadline"], kwargs["token"], kwargs["call_stack"]))
        if self.failures:
            raise self.failures.pop(0)
        return {"pages": [], "providerProvenance": {"providerRef": provider}}


async def test_resilient_fallback_preserves_context_and_records_selected_provider():
    strategy = ResilientParser({"image/png": ("one", "two")}, minimum_remaining_budget_ms=1)
    executor = FakeExecutor([WorkerError("PROVIDER_FAILED", retryable=True)])
    deadline, token = Deadline(1000, margin_ms=0), CancellationToken()
    result = await strategy.parse(b"x", media_type="image/png", language="hi", limits={}, deadline=deadline, token=token, executor=executor, call_stack=(strategy.provider_ref,))
    assert result["providerProvenance"]["providerRef"] == strategy.provider_ref
    assert result["quality"]["warnings"] == ["attemptedProviderRefs:one,two", "selectedProviderRef:two"]
    assert all(call[1:] == (deadline, token, (strategy.provider_ref,)) for call in executor.calls)


async def test_resilient_never_falls_back_on_invalid_output():
    strategy = ResilientParser({"image/png": ("one", "two")}, minimum_remaining_budget_ms=1)
    executor = FakeExecutor([WorkerError("INVALID_PROVIDER_OUTPUT")])
    with pytest.raises(WorkerError, match="INVALID_PROVIDER_OUTPUT"):
        await strategy.parse(b"x", media_type="image/png", language="en", limits={}, deadline=Deadline(1000, margin_ms=0), token=CancellationToken(), executor=executor, call_stack=(strategy.provider_ref,))
    assert len(executor.calls) == 1
