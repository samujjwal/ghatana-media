"""Shared admission authority for horizontally replicated workers (I6-86).

The worker-local scheduler remains responsible for queueing and fair dispatch.
This module is the cross-replica boundary: production can provide a backend
shared by replicas, while tests and single-process deployments use the
thread-safe in-memory backend. A fencing token is issued for every admission;
expired leases can be taken over, but stale owners cannot be considered
current again.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable


class ConcurrencyAuthorityError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class AdmissionLease:
    operation_id: str
    tenant: str
    replica_id: str
    lease_id: str
    fencing_token: int
    expires_at: float


class InMemoryConcurrencyBackend:
    """A backend that can be shared by multiple worker replicas in one host."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.next_fencing_token = 0
        self.leases: dict[str, AdmissionLease] = {}


class InMemoryConcurrencyAuthority:
    """Cluster/tenant/replica admission with lease takeover semantics.

    This class deliberately does not pretend that process-local memory is a
    cluster store. A real deployment must give every replica the same backend
    implementation (or reject the cluster-global policy at configuration
    time). The backend shape is intentionally small so Redis/SQL adapters can
    implement the same atomic operations later.
    """

    def __init__(
        self,
        *,
        replica_id: str,
        cluster_limit: int,
        per_replica_limit: int,
        tenant_limit: int | None = None,
        lease_seconds: float = 30.0,
        backend: InMemoryConcurrencyBackend | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        if not replica_id or cluster_limit < 1 or per_replica_limit < 1 or lease_seconds <= 0:
            raise ValueError("invalid concurrency authority policy")
        if tenant_limit is not None and tenant_limit < 1:
            raise ValueError("tenant_limit must be positive")
        self.replica_id = replica_id
        self.cluster_limit = cluster_limit
        self.per_replica_limit = per_replica_limit
        self.tenant_limit = tenant_limit
        self.lease_seconds = lease_seconds
        self.backend = backend or InMemoryConcurrencyBackend()
        self._now = now or time.monotonic

    def _reap_locked(self, now: float) -> None:
        for operation_id, lease in tuple(self.backend.leases.items()):
            if lease.expires_at <= now:
                del self.backend.leases[operation_id]

    def reap_expired(self) -> int:
        with self.backend.lock:
            before = len(self.backend.leases)
            self._reap_locked(self._now())
            return before - len(self.backend.leases)

    def admit(self, operation_id: str, tenant: str) -> AdmissionLease | None:
        """Acquire a lease, return ``None`` for capacity, reject duplicates."""
        if not operation_id or not tenant:
            raise ValueError("operation_id and tenant are required")
        now = self._now()
        with self.backend.lock:
            self._reap_locked(now)
            existing = self.backend.leases.get(operation_id)
            if existing is not None:
                raise ConcurrencyAuthorityError("DUPLICATE_OPERATION")
            leases = tuple(self.backend.leases.values())
            replica_count = sum(lease.replica_id == self.replica_id for lease in leases)
            tenant_count = sum(lease.tenant == tenant for lease in leases)
            if len(leases) >= self.cluster_limit or replica_count >= self.per_replica_limit or (
                self.tenant_limit is not None and tenant_count >= self.tenant_limit
            ):
                return None
            self.backend.next_fencing_token += 1
            token = self.backend.next_fencing_token
            lease = AdmissionLease(
                operation_id=operation_id,
                tenant=tenant,
                replica_id=self.replica_id,
                lease_id=f"{self.replica_id}:{token}",
                fencing_token=token,
                expires_at=now + self.lease_seconds,
            )
            self.backend.leases[operation_id] = lease
            return lease

    def renew(self, lease: AdmissionLease) -> AdmissionLease:
        now = self._now()
        with self.backend.lock:
            current = self.backend.leases.get(lease.operation_id)
            if current != lease:
                raise ConcurrencyAuthorityError("STALE_FENCE")
            renewed = AdmissionLease(**{**lease.__dict__, "expires_at": now + self.lease_seconds})
            self.backend.leases[lease.operation_id] = renewed
            return renewed

    def release(self, lease: AdmissionLease) -> None:
        with self.backend.lock:
            current = self.backend.leases.get(lease.operation_id)
            if current == lease:
                del self.backend.leases[lease.operation_id]

    def assert_current(self, lease: AdmissionLease) -> None:
        with self.backend.lock:
            self._reap_locked(self._now())
            if self.backend.leases.get(lease.operation_id) != lease:
                raise ConcurrencyAuthorityError("STALE_FENCE")

    def snapshot(self) -> tuple[AdmissionLease, ...]:
        with self.backend.lock:
            self._reap_locked(self._now())
            return tuple(sorted(self.backend.leases.values(), key=lambda item: item.fencing_token))
