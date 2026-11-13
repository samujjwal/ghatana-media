"""Increment-6 bounded admission scheduler (backlog I6-21, I6-56).

Hard-capped scheduler with per-tenant fairness.  No unbounded growth: the
queued set can never exceed ``max_queued`` and the running set can never
exceed ``max_in_flight``.  Excess submissions fail fast with a
``BACKPRESSURE`` WorkerError instead of silently queueing.

I6-56 extensions:

- per-provider concurrency cap (``max_provider_in_flight``): queued tickets
  whose ``job_desc["providerRef"]`` is already running at cap are skipped at
  dispatch until a provider slot frees;
- per-tenant queued-work limit (``max_tenant_queued``): bounds a single
  tenant's *queued* backlog, distinct from ``max_tenant_share`` which bounds
  the tenant's share of total (queued + running) capacity;
- tenant-fair dispatch: the strict FIFO popleft is replaced by a
  least-active-count round-robin — the tenant holding the fewest active
  (queued + running) tickets is served first, oldest ticket within the
  tenant;
- deadline-aware rejection: a ``job_desc`` carrying ``deadlineMs`` (absolute
  epoch milliseconds) plus an optional ``minRemainingMs`` floor is rejected
  at submit when the remaining budget is already below the floor, with the
  terminal scheduler code ``DEADLINE_INSUFFICIENT``;
- bounded resource accounting: ``complete()`` appends
  ``{tenant, provider, pages, bytes, queuedMs, execMs}`` — derived only from
  ``job_desc`` scalar fields and timestamps, never document content — to a
  bounded log exposed via :meth:`accounting`.

``errors.py`` is sealed Increment-4A material: ``WorkerError.__post_init__``
rewrites any code outside the frozen ``ERROR_CODES`` set to
``PROVIDER_FAILED``.  ``SchedulerError`` overrides that remap so the
increment-6 codes survive while remaining a genuine ``WorkerError``.
"""

from __future__ import annotations

import itertools
import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..errors import WorkerError
from .concurrency_authority import (
    AdmissionLease,
    ConcurrencyAuthorityError,
    InMemoryConcurrencyAuthority,
)


class SchedulerError(WorkerError):
    """WorkerError that preserves increment-6 scheduler codes verbatim."""

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code)


_TICKET_IDS = itertools.count(1)


@dataclass
class SchedulerTicket:
    """Admission ticket returned by :meth:`BoundedScheduler.submit`."""

    ticket_id: int
    tenant: str
    job: dict[str, Any]
    state: str = "QUEUED"  # QUEUED | RUNNING | COMPLETED | CANCELLED
    enqueued_at: float = field(default_factory=time.monotonic)
    dispatched_at: float | None = None
    admission: AdmissionLease | None = None


class BoundedScheduler:
    """Bounded scheduler with hard caps and tenant/provider fairness.

    ``max_tenant_share`` bounds the fraction of total capacity
    (``max_in_flight + max_queued``) a single tenant may occupy.  Tenants are
    read from ``job_desc["tenantId"]`` (or ``"tenant"``); untagged jobs share
    the ``"default"`` tenant bucket.

    ``max_tenant_queued`` (I6-56) bounds only the queued backlog per tenant —
    independent of the active-share cap — and ``max_provider_in_flight``
    bounds how many tickets for one ``providerRef`` may run at once.
    """

    def __init__(
        self,
        max_in_flight: int,
        max_queued: int,
        max_tenant_share: float = 1.0,
        on_queue_depth: Callable[[int], None] | None = None,
        *,
        max_provider_in_flight: int | None = None,
        max_tenant_queued: int | None = None,
        min_remaining_ms: int = 0,
        accounting_limit: int = 1024,
        now_ms: Callable[[], float] | None = None,
        authority: InMemoryConcurrencyAuthority | None = None,
    ) -> None:
        if max_in_flight < 1 or max_queued < 0:
            raise ValueError("invalid scheduler capacity")
        if not 0 < max_tenant_share <= 1.0:
            raise ValueError("max_tenant_share must be in (0, 1]")
        if max_provider_in_flight is not None and max_provider_in_flight < 1:
            raise ValueError("max_provider_in_flight must be positive")
        if max_tenant_queued is not None and max_tenant_queued < 1:
            raise ValueError("max_tenant_queued must be positive")
        if min_remaining_ms < 0 or accounting_limit < 1:
            raise ValueError("invalid scheduler policy bounds")
        self.max_in_flight = max_in_flight
        self.max_queued = max_queued
        self.max_tenant_share = max_tenant_share
        self.max_provider_in_flight = max_provider_in_flight
        self.max_tenant_queued = max_tenant_queued
        self.min_remaining_ms = min_remaining_ms
        self._on_queue_depth = on_queue_depth
        self._now_ms = now_ms or (lambda: time.time() * 1000)
        self._queue: deque[SchedulerTicket] = deque()
        self._running: set[int] = set()
        self._tickets: dict[int, SchedulerTicket] = {}
        self._tenant_active: dict[str, int] = {}
        self._provider_running: dict[str, int] = {}
        self._accounting: deque[dict[str, Any]] = deque(maxlen=accounting_limit)
        self.authority = authority

    @staticmethod
    def _tenant_of(job_desc: Mapping[str, Any]) -> str:
        tenant = job_desc.get("tenantId", job_desc.get("tenant", "default"))
        return tenant if isinstance(tenant, str) and tenant else "default"

    @staticmethod
    def _provider_of(ticket: SchedulerTicket) -> str:
        provider = ticket.job.get("providerRef", ticket.job.get("provider", "default"))
        return provider if isinstance(provider, str) and provider else "default"

    @property
    def queue_depth(self) -> int:
        return len(self._queue)

    @property
    def in_flight(self) -> int:
        return len(self._running)

    def _emit_depth(self) -> None:
        if self._on_queue_depth is not None:
            self._on_queue_depth(len(self._queue))

    def _tenant_cap(self) -> int:
        total = self.max_in_flight + self.max_queued
        return max(1, int(total * self.max_tenant_share))

    def accounting(self) -> list[dict[str, Any]]:
        """Snapshot of the bounded resource-accounting log.

        Entries carry only scalar ``job_desc`` fields and queue/exec timings;
        no document content, filenames, or tenant-identifying extras.
        """
        return [dict(entry) for entry in self._accounting]

    def _check_deadline(self, job_desc: Mapping[str, Any]) -> None:
        deadline_ms = job_desc.get("deadlineMs")
        if isinstance(deadline_ms, bool) or not isinstance(deadline_ms, (int, float)):
            return
        floor = job_desc.get("minRemainingMs", self.min_remaining_ms)
        if isinstance(floor, bool) or not isinstance(floor, (int, float)):
            floor = self.min_remaining_ms
        if deadline_ms - self._now_ms() < floor:
            # A job whose remaining budget is already below its floor can
            # never be served usefully; rejecting is terminal for that job.
            raise SchedulerError("DEADLINE_INSUFFICIENT", retryable=False)

    def submit(self, job_desc: Mapping[str, Any]) -> SchedulerTicket:
        """Enqueue ``job_desc`` or fail fast when bounded out."""
        tenant = self._tenant_of(job_desc)
        self._check_deadline(job_desc)
        if len(self._queue) >= self.max_queued:
            raise SchedulerError("BACKPRESSURE", retryable=True)
        if self._tenant_active.get(tenant, 0) >= self._tenant_cap():
            raise SchedulerError("BACKPRESSURE", retryable=True)
        if self.max_tenant_queued is not None and sum(
            1 for queued in self._queue if queued.tenant == tenant
        ) >= self.max_tenant_queued:
            raise SchedulerError("BACKPRESSURE", retryable=True)
        ticket = SchedulerTicket(next(_TICKET_IDS), tenant, dict(job_desc))
        self._queue.append(ticket)
        self._tickets[ticket.ticket_id] = ticket
        self._tenant_active[tenant] = self._tenant_active.get(tenant, 0) + 1
        self._emit_depth()
        return ticket

    def dispatch(self) -> SchedulerTicket | None:
        """Move the fairest eligible queued ticket to RUNNING.

        Tenant-fair order: the tenant holding the fewest active tickets is
        served first; within a tenant the oldest ticket wins.  Tickets whose
        provider is already at ``max_provider_in_flight`` are skipped so a
        saturated provider cannot head-of-line block other providers.
        """
        if not self._queue or len(self._running) >= self.max_in_flight:
            return None
        candidates: list[SchedulerTicket] = []
        for ticket in self._queue:
            if (
                self.max_provider_in_flight is not None
                and self._provider_running.get(self._provider_of(ticket), 0)
                >= self.max_provider_in_flight
            ):
                continue
            candidates.append(ticket)
        candidates.sort(key=lambda ticket: (self._tenant_active.get(ticket.tenant, 0), ticket.ticket_id))
        if not candidates:
            return None
        best: SchedulerTicket | None = None
        for candidate in candidates:
            if self.authority is None:
                best = candidate
                break
            operation_id = candidate.job.get("operationId", f"scheduler-ticket-{candidate.ticket_id}")
            if not isinstance(operation_id, str) or not operation_id:
                raise SchedulerError("INVALID_OPERATION_ID")
            try:
                admission = self.authority.admit(operation_id, candidate.tenant)
            except ConcurrencyAuthorityError as exc:
                if exc.code == "DUPLICATE_OPERATION":
                    raise SchedulerError(exc.code, retryable=False)
                raise SchedulerError(exc.code, retryable=True)
            if admission is not None:
                candidate.admission = admission
                best = candidate
                break
        if best is None:
            return None
        self._queue.remove(best)
        best.state = "RUNNING"
        best.dispatched_at = time.monotonic()
        self._running.add(best.ticket_id)
        provider = self._provider_of(best)
        self._provider_running[provider] = self._provider_running.get(provider, 0) + 1
        self._emit_depth()
        return best

    def complete(self, ticket: SchedulerTicket) -> None:
        """Release a RUNNING ticket and record its resource accounting."""
        if ticket.ticket_id not in self._running:
            raise ValueError("ticket is not running")
        self._running.discard(ticket.ticket_id)
        ticket.state = "COMPLETED"
        self._tenant_active[ticket.tenant] -= 1
        provider = self._provider_of(ticket)
        if provider in self._provider_running:
            remaining = self._provider_running[provider] - 1
            if remaining <= 0:
                del self._provider_running[provider]
            else:
                self._provider_running[provider] = remaining
        if self.authority is not None and ticket.admission is not None:
            self.authority.release(ticket.admission)
        now = time.monotonic()
        dispatched = ticket.dispatched_at if ticket.dispatched_at is not None else ticket.enqueued_at
        self._accounting.append(
            {
                "tenant": ticket.tenant,
                "provider": provider,
                "pages": ticket.job.get("pages"),
                "bytes": ticket.job.get("bytes"),
                "queuedMs": max(0, int((dispatched - ticket.enqueued_at) * 1000)),
                "execMs": max(0, int((now - dispatched) * 1000)),
            }
        )
        self._emit_depth()

    def recover_expired_admissions(self) -> int:
        """Reap leases after a dead replica so another replica can take over."""
        return self.authority.reap_expired() if self.authority is not None else 0

    def cancel(self, ticket: SchedulerTicket) -> None:
        """Drop a QUEUED ticket that was never dispatched."""
        if ticket.state != "QUEUED":
            raise ValueError("only queued tickets can be cancelled")
        try:
            self._queue.remove(ticket)
        except ValueError as exc:
            raise ValueError("ticket is not queued") from exc
        ticket.state = "CANCELLED"
        self._tenant_active[ticket.tenant] -= 1
        self._emit_depth()
