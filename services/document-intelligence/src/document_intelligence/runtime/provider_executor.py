from __future__ import annotations

import asyncio
from types import MappingProxyType
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import time
from collections.abc import Mapping
from typing import Any

from ..errors import WorkerError
from .cancellation import CancellationToken
from .concurrency import BoundedLane
from .deadline import Deadline
from .provider_trace import (
    ProviderTrace,
    bind_provider_trace,
    current_provider_trace,
    provider_identity,
    reset_provider_trace,
)
from .scheduler import BoundedScheduler, SchedulerTicket

_ATTEMPT_KINDS = frozenset({"PRIMARY", "RETRY", "FALLBACK"})


class ProviderExecutor:
    def __init__(self, providers: Mapping[str, Any], lanes: Mapping[str, BoundedLane], enabled_providers: tuple[str, ...], *, scheduler: BoundedScheduler | None = None) -> None:
        self._providers = MappingProxyType(dict(providers))
        self._lanes = MappingProxyType(dict(lanes))
        self._enabled = frozenset(enabled_providers)
        # Every submitted leaf native call holds its provider lane until its
        # future completes, so the tracked set cannot exceed total lane capacity.
        self._native_capacity = sum(lane.capacity for lane in lanes.values())
        self._last_trace: ProviderTrace | None = None
        self._native_futures: set[asyncio.Future[Any]] = set()
        self._material_frozen = False
        # I6-56: optional admission scheduler.  ``None`` (the default, and the
        # default-profile path) disables all scheduler machinery entirely.
        self._scheduler = scheduler

    @property
    def scheduler(self) -> BoundedScheduler | None:
        return self._scheduler

    @scheduler.setter
    def scheduler(self, value: BoundedScheduler | None) -> None:
        object.__setattr__(self, "_scheduler", value)

    def __setattr__(self, name: str, value: Any) -> None:
        if getattr(self, "_material_frozen", False) and name in {"_providers", "_lanes", "_enabled"}:
            raise RuntimeError("provider material registry is immutable after startup readiness")
        object.__setattr__(self, name, value)

    def freeze_material(self) -> None:
        self._material_frozen = True

    def _release_after_shutdown(self) -> None:
        if any(not future.done() for future in self._native_futures):
            raise RuntimeError("cannot release provider material while native calls are running")
        object.__setattr__(self, "_providers", MappingProxyType({}))
        object.__setattr__(self, "_lanes", MappingProxyType({}))

    @property
    def active_native_calls(self) -> int:
        return sum(not future.done() for future in self._native_futures)

    def _track_native_future(self, future: asyncio.Future[Any]) -> None:
        self._native_futures.add(future)

        def completed(done: asyncio.Future[Any]) -> None:
            self._native_futures.discard(done)
            if not done.cancelled():
                # Retrieve late native exceptions even when the HTTP request
                # already returned CANCELLED or TIMEOUT.
                done.exception()

        future.add_done_callback(completed)

    async def drain_native(self, timeout_seconds: float) -> bool:
        pending = tuple(future for future in self._native_futures if not future.done())
        if not pending:
            return True
        _, remaining = await asyncio.wait(pending, timeout=max(0.0, timeout_seconds))
        return not remaining

    @property
    def last_trace(self) -> ProviderTrace | None:
        """The most recently completed top-level trace (for diagnostics/tests)."""

        return self._last_trace

    async def parse(
        self,
        provider_ref: str,
        data: bytes,
        *,
        media_type: str | None,
        language: str | None,
        limits: Mapping[str, int],
        deadline: Deadline,
        token: CancellationToken,
        call_stack: tuple[str, ...] = (),
        trace: ProviderTrace | None = None,
        attempt_kind: str = "PRIMARY",
        operation_id: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._execute(provider_ref, "parse", (data,), {"media_type": media_type, "language": language, "limits": dict(limits)}, deadline, token, call_stack, trace=trace, attempt_kind=attempt_kind, operation_id=operation_id, tenant_id=tenant_id)

    async def extract(
        self,
        provider_ref: str,
        parsed: dict[str, Any],
        fields: list[dict[str, Any]],
        *,
        language: str | None,
        deadline: Deadline,
        token: CancellationToken,
        call_stack: tuple[str, ...] = (),
        trace: ProviderTrace | None = None,
        operation_id: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._execute(provider_ref, "extract", (parsed, fields), {"language": language}, deadline, token, call_stack, trace=trace, operation_id=operation_id, tenant_id=tenant_id)

    async def embed(
        self,
        provider_ref: str,
        projection: dict[str, Any],
        *,
        deadline: Deadline,
        token: CancellationToken,
        call_stack: tuple[str, ...] = (),
        trace: ProviderTrace | None = None,
        operation_id: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._execute(provider_ref, "embed", (projection,), {}, deadline, token, call_stack, trace=trace, operation_id=operation_id, tenant_id=tenant_id)

    async def _execute(
        self,
        provider_ref: str,
        method: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        deadline: Deadline,
        token: CancellationToken,
        call_stack: tuple[str, ...],
        *,
        trace: ProviderTrace | None = None,
        attempt_kind: str = "PRIMARY",
        operation_id: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        if attempt_kind not in _ATTEMPT_KINDS:
            raise WorkerError("INVALID_REQUEST", provider_ref=provider_ref)
        active_trace = current_provider_trace() or trace or ProviderTrace()
        owns_trace = current_provider_trace() is None
        context_token = bind_provider_trace(active_trace) if owns_trace else None
        route = call_stack[0] if call_stack else provider_ref
        ticket: SchedulerTicket | None = None
        result: dict[str, Any] | None = None
        try:
            # A native timeout cancels the shared token so a strategy cannot
            # spend the expired request budget on another provider.  Preserve
            # the original timeout when the strategy probes the next route.
            # ``attempt_kind`` distinguishes same-provider RETRY calls from
            # cross-provider FALLBACK hops; a retry re-invokes with the same
            # call_stack and never extends the chain.
            if provider_ref in call_stack:
                raise WorkerError("INVALID_REQUEST", provider_ref=provider_ref)
            blocked = active_trace.blocked_error(route)
            if blocked is not None:
                raise blocked
            token.raise_if_cancelled()
            provider = self._providers.get(provider_ref)
            lane = self._lanes.get(provider_ref)
            if provider is None or lane is None or provider_ref not in self._enabled:
                active_trace.record(
                    route=route,
                    provider_ref=provider_ref,
                    provider_version=None,
                    model_ref=None,
                    model_version=None,
                    operation=method,
                    outcome="failure",
                    failure="PROVIDER_UNAVAILABLE",
                    elapsed_ms=0,
                    remaining_deadline_ms=deadline.remaining_ms(),
                    retryable=True,
                )
                raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=provider_ref)
            # I6-56: admission scheduling applies once per request — at the
            # top-level entry only, so nested strategy children cannot queue
            # behind their own parent's scheduler slot.
            if self._scheduler is not None and not call_stack:
                ticket = await self._scheduler_admit(provider_ref, method, args, deadline, token, operation_id=operation_id, tenant_id=tenant_id)
            stack = (*call_stack, provider_ref)
            if getattr(provider, "is_strategy", False):
                result = await self.execute_strategy(provider_ref, provider, lane, method, args, kwargs, deadline, token, stack)
            else:
                result = await self.execute_leaf(provider_ref, provider, lane, method, args, kwargs, deadline, token, route=route, trace=active_trace)
            if ticket is not None and isinstance(result.get("pages"), list):
                ticket.job["pages"] = len(result["pages"])
            return result
        finally:
            if ticket is not None and ticket.state == "RUNNING":
                self._scheduler.complete(ticket)
            if owns_trace:
                self._last_trace = active_trace
                if context_token is not None:
                    reset_provider_trace(context_token)

    async def _scheduler_admit(
        self,
        provider_ref: str,
        method: str,
        args: tuple[Any, ...],
        deadline: Deadline,
        token: CancellationToken,
        *,
        operation_id: str | None = None,
        tenant_id: str | None = None,
    ) -> SchedulerTicket:
        """Submit an admission ticket and wait for a dispatch slot (I6-56).

        ``SchedulerError`` (BACKPRESSURE / DEADLINE_INSUFFICIENT) propagates
        verbatim.  While queued, a cancelled token raises CANCELLED and an
        exhausted deadline converts to PROVIDER_BUSY so a request never waits
        past its own budget.
        """
        assert self._scheduler is not None
        job: dict[str, Any] = {"providerRef": provider_ref}
        if operation_id is not None:
            job["operationId"] = operation_id
        if tenant_id is not None:
            job["tenantId"] = tenant_id
        if method == "parse" and args and isinstance(args[0], (bytes, bytearray)):
            job["bytes"] = len(args[0])
        job["deadlineMs"] = time.time() * 1000 + deadline.remaining_ms()
        ticket = self._scheduler.submit(job)
        while ticket.state == "QUEUED":
            self._scheduler.dispatch()
            if ticket.state != "QUEUED":
                break
            token.raise_if_cancelled()
            if deadline.remaining_ms() <= 0:
                try:
                    self._scheduler.cancel(ticket)
                except ValueError:
                    pass
                raise WorkerError("PROVIDER_BUSY", retryable=True, provider_ref=provider_ref)
            await asyncio.sleep(0.002)
        return ticket

    async def execute_leaf(
        self,
        provider_ref: str,
        provider: Any,
        lane: BoundedLane,
        method: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        deadline: Deadline,
        token: CancellationToken,
        *,
        route: str | None = None,
        trace: ProviderTrace | None = None,
    ) -> dict[str, Any]:
        started = time.monotonic()
        outcome = "failure"
        failure: str | None = None
        retryable = False
        identity = provider_identity(provider_ref, provider)
        active_trace = trace or current_provider_trace()
        try:
            async with lane.acquire(deadline.require_remaining(), token) as lease:
                token.raise_if_cancelled()
                remaining_ms = deadline.require_remaining()
                # Use a per-invocation executor instead of asyncio's process
                # wide default pool.  The pool is shut down as soon as the
                # native call completes, so pytest/worker shutdown cannot be
                # held open by an idle provider thread.  On timeout or
                # cancellation the lane still holds the task until completion.
                pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="document-provider")
                loop = asyncio.get_running_loop()
                native_task = asyncio.wrap_future(
                    pool.submit(partial(getattr(provider, method), *args, deadline=deadline, token=token, **kwargs)),
                    loop=loop,
                )
                self._track_native_future(native_task)
                cancel_task = asyncio.create_task(token.wait())
                try:
                    done, _ = await asyncio.wait({native_task, cancel_task}, timeout=max(remaining_ms, 1) / 1000, return_when=asyncio.FIRST_COMPLETED)
                    if cancel_task in done and token.cancelled:
                        lease.hold_until(native_task)
                        raise WorkerError("CANCELLED", provider_ref=provider_ref)
                    if native_task not in done:
                        token.cancel()
                        lease.hold_until(native_task)
                        raise WorkerError("TIMEOUT", retryable=True, provider_ref=provider_ref)
                    try:
                        result = native_task.result()
                    except WorkerError:
                        raise
                    except Exception as exc:
                        raise WorkerError("PROVIDER_FAILED", retryable=True, provider_ref=provider_ref) from exc
                    token.raise_if_cancelled()
                    if not isinstance(result, dict):
                        raise WorkerError("INVALID_PROVIDER_OUTPUT", provider_ref=provider_ref)
                    outcome = "success"
                    return result
                finally:
                    if not cancel_task.done():
                        cancel_task.cancel()
                    await asyncio.gather(cancel_task, return_exceptions=True)
                    # Also retain the lane if the asyncio request task itself
                    # was cancelled; only native completion releases capacity.
                    if not native_task.done():
                        lease.hold_until(native_task)
                    if native_task.done():
                        pool.shutdown(wait=True, cancel_futures=False)
                    else:
                        native_task.add_done_callback(lambda _completed: pool.shutdown(wait=True, cancel_futures=False))
        except WorkerError as exc:
            failure = exc.code
            retryable = exc.retryable
            # A provider-reported timeout is just as terminal as an executor
            # timeout.  This also protects legacy strategies from falling
            # through to a second provider after the deadline is exhausted.
            if exc.code == "TIMEOUT":
                token.cancel()
            raise
        finally:
            if active_trace is not None:
                if failure == "CANCELLED":
                    outcome = "cancelled"
                elif failure == "TIMEOUT":
                    outcome = "timeout"
                active_trace.record(
                    route=route or provider_ref,
                    provider_ref=identity[0],
                    provider_version=identity[1],
                    model_ref=identity[2],
                    model_version=identity[3],
                    operation=method,
                    outcome=outcome,
                    failure=failure,
                    elapsed_ms=int((time.monotonic() - started) * 1000),
                    remaining_deadline_ms=deadline.remaining_ms(),
                    retryable=retryable,
                )

    async def execute_strategy(
        self,
        provider_ref: str,
        provider: Any,
        lane: BoundedLane,
        method: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        deadline: Deadline,
        token: CancellationToken,
        call_stack: tuple[str, ...],
    ) -> dict[str, Any]:
        async with lane.acquire(deadline.require_remaining(), token):
            token.raise_if_cancelled()
            result = await getattr(provider, method)(*args, deadline=deadline, token=token, executor=self, call_stack=call_stack, **kwargs)
            token.raise_if_cancelled()
            if not isinstance(result, dict):
                raise WorkerError("INVALID_PROVIDER_OUTPUT", provider_ref=provider_ref)
            return result
