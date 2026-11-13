from __future__ import annotations

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.operations import OperationRegistry, OperationState

GENERATION_A = "a" * 32
GENERATION_B = "b" * 32


@pytest.mark.asyncio
async def test_cancelled_operation_id_cannot_be_reused_until_finish():
    registry = OperationRegistry()
    operation = await registry.begin("same-id", "provider", 1000, GENERATION_A)
    assert await registry.cancel("same-id", GENERATION_A)
    assert operation.state is OperationState.CANCEL_REQUESTED
    with pytest.raises(WorkerError) as rejected:
        await registry.begin("same-id", "provider", 1000, GENERATION_B)
    assert rejected.value.code == "INVALID_REQUEST"

    await registry.finish(operation)
    replacement = await registry.begin("same-id", "provider", 1000, GENERATION_B)
    assert replacement is not operation
    assert replacement.state is OperationState.ACTIVE


@pytest.mark.asyncio
async def test_stale_finish_cannot_terminate_reused_operation_generation():
    registry = OperationRegistry()
    old = await registry.begin("same-id", "provider", 1000, GENERATION_A)
    await registry.finish(old)
    current = await registry.begin("same-id", "provider", 1000, GENERATION_B)

    await registry.finish(old)

    assert registry.get("same-id") is current
    assert current.state is OperationState.ACTIVE
    await registry.finish(current)


@pytest.mark.asyncio
async def test_cancellation_that_overtakes_submission_is_applied_to_matching_generation():
    registry = OperationRegistry()

    assert await registry.cancel("same-id", GENERATION_B)
    operation = await registry.begin("same-id", "provider", 1000, GENERATION_B)

    assert operation.state is OperationState.CANCEL_REQUESTED
    assert operation.token.cancelled


@pytest.mark.asyncio
async def test_expired_pre_submission_cancellation_is_pruned_before_begin():
    registry = OperationRegistry(retention_seconds=0)

    assert await registry.cancel("same-id", GENERATION_A)
    operation = await registry.begin("same-id", "provider", 1000, GENERATION_A)

    assert operation.state is OperationState.ACTIVE
    assert not operation.token.cancelled


@pytest.mark.asyncio
async def test_stale_cancel_cannot_cancel_new_generation_after_operation_id_reuse():
    registry = OperationRegistry()
    previous = await registry.begin("same-id", "provider", 1000, GENERATION_A)
    await registry.finish(previous)
    current = await registry.begin("same-id", "provider", 1000, GENERATION_B)

    assert not await registry.cancel("same-id", GENERATION_A)

    assert registry.get("same-id") is current
    assert current.state is OperationState.ACTIVE
    assert not current.token.cancelled

    assert await registry.cancel("same-id", GENERATION_B)
    assert current.state is OperationState.CANCEL_REQUESTED
    assert current.token.cancelled


@pytest.mark.asyncio
async def test_completed_generation_cannot_be_reused_during_retention_window():
    registry = OperationRegistry(retention_seconds=60)
    previous = await registry.begin("same-id", "provider", 1000, GENERATION_A)
    await registry.finish(previous)
    replacement = await registry.begin("same-id", "provider", 1000, GENERATION_B)
    await registry.finish(replacement)

    assert not await registry.cancel("same-id", GENERATION_A)
    assert not await registry.cancel("same-id", GENERATION_B)
    with pytest.raises(WorkerError) as rejected:
        await registry.begin("same-id", "provider", 1000, GENERATION_A)
    assert rejected.value.code == "INVALID_REQUEST"
