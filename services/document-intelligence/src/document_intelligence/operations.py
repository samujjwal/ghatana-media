from __future__ import annotations

import asyncio
import copy
import hashlib
import fcntl
import tempfile
from contextlib import contextmanager
import json
import os
import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from .errors import WorkerError
from .runtime.cancellation import CancellationToken
from .runtime.deadline import Deadline


class OperationState(str, Enum):
    ACTIVE = "ACTIVE"
    CANCEL_REQUESTED = "CANCEL_REQUESTED"
    FINISHED = "FINISHED"


@dataclass
class Operation:
    operation_id: str
    operation_generation: str
    provider_ref: str
    created_at: float
    deadline: Deadline
    token: CancellationToken = field(default_factory=CancellationToken)
    state: OperationState = OperationState.ACTIVE
    task: asyncio.Task[object] | None = None
    claim_token: str | None = None
    request_fingerprint: str | None = None


@dataclass(frozen=True)
class OperationOutcome:
    operation_id: str
    operation_generation: str
    status: str
    response: dict[str, object]
    status_code: int = 200
    request_fingerprint: str | None = None


class FileOutcomeStore:
    """Atomic outcome store for shared durable storage (I6-91).

    The directory may be backed by a shared filesystem for multiple replicas.
    The content is private (0700/0600) and keyed by a digest rather than a
    caller-controlled filename. A database-backed adapter can implement the
    same get/put-if-absent contract without changing the registry.
    """

    def __init__(self, directory: Path | str, claim_ttl_seconds: float = 900.0) -> None:
        if claim_ttl_seconds <= 0:
            raise ValueError("claim_ttl_seconds must be positive")
        self.directory = Path(directory)
        self.claim_ttl_seconds = claim_ttl_seconds
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)

    def _path(self, operation_id: str, generation: str) -> Path:
        key = hashlib.sha256(f"{operation_id}\0{generation}".encode("utf-8")).hexdigest()
        return self.directory / f"{key}.json"

    def _claim_path(self, operation_id: str, generation: str) -> Path:
        key = hashlib.sha256(f"{operation_id}\0{generation}".encode("utf-8")).hexdigest()
        return self.directory / f"{key}.claim"

    @contextmanager
    def _locked(self, operation_id: str, generation: str):
        # The lock inode is never unlinked: all replicas serialize the same generation.
        path = self._claim_path(operation_id, generation).with_suffix(".lock")
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    @staticmethod
    def _read(path: Path) -> dict | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        if not isinstance(value, dict):
            raise OSError("invalid operation record")
        return value

    def _write(self, path: Path, value: dict) -> None:
        fd, name = tempfile.mkstemp(prefix=".pending-", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, path)
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            Path(name).unlink(missing_ok=True)

    @staticmethod
    def _check(value: dict, operation_id: str, generation: str,
               fingerprint: str | None = None) -> None:
        if value.get("operationId") != operation_id or value.get("operationGeneration") != generation:
            raise OSError("operation record identity mismatch")
        if fingerprint is not None and value.get("requestFingerprint") != fingerprint:
            raise WorkerError("INVALID_REQUEST")

    def _get(self, operation_id: str, generation: str,
             fingerprint: str | None = None) -> OperationOutcome | None:
        value = self._read(self._path(operation_id, generation))
        if value is not None:
            self._check(value, operation_id, generation, fingerprint)
            return OperationOutcome(operation_id, generation, str(value["status"]),
                                    value["response"], int(value.get("statusCode", 200)),
                                    value.get("requestFingerprint"))
        cancelled = self._read(self._claim_path(operation_id, generation).with_suffix(".cancel"))
        if cancelled is not None:
            self._check(cancelled, operation_id, generation)
            claim = self._read(self._claim_path(operation_id, generation))
            if claim is not None:
                self._check(claim, operation_id, generation, fingerprint)
            return OperationOutcome(operation_id, generation, "CANCELLED",
                                    WorkerError("CANCELLED").envelope(operation_id), 400,
                                    claim.get("requestFingerprint") if claim is not None else None)
        return None

    def claim(self, operation_id: str, generation: str, owner_id: str,
              fingerprint: str | None = None) -> str | None:
        with self._locked(operation_id, generation):
            if self._get(operation_id, generation, fingerprint) is not None:
                return None
            path = self._claim_path(operation_id, generation)
            previous = self._read(path)
            now = time.time()
            if previous is not None:
                self._check(previous, operation_id, generation)
                if previous.get("requestFingerprint") != fingerprint:
                    raise WorkerError("INVALID_REQUEST")
                if float(previous["expiresAt"]) > now:
                    return None
            token = secrets.token_hex(16)
            self._write(path, {
                "operationId": operation_id, "operationGeneration": generation,
                "ownerId": owner_id, "fencingToken": token,
                "expiresAt": now + self.claim_ttl_seconds,
                "requestFingerprint": fingerprint,
            })
            return token

    def get(self, operation_id: str, generation: str | None,
            fingerprint: str | None = None) -> OperationOutcome | None:
        # Absence of a generation never authorizes arbitrary historical readback.
        if generation is None:
            return None
        with self._locked(operation_id, generation):
            return self._get(operation_id, generation, fingerprint)

    def cancel(self, operation_id: str, generation: str) -> bool:
        """Persist a generation-specific publication fence, not a process-kill receipt."""
        with self._locked(operation_id, generation):
            outcome = self._get(operation_id, generation)
            if outcome is not None:
                return outcome.status == "CANCELLED"
            self._write(self._claim_path(operation_id, generation).with_suffix(".cancel"), {
                "operationId": operation_id, "operationGeneration": generation,
            })
            return True

    def put_if_absent(self, outcome: OperationOutcome, owner_id: str, token: str) -> bool:
        # Check the live lease and publish atomically under the SAME lock.
        operation_id, generation = outcome.operation_id, outcome.operation_generation
        with self._locked(operation_id, generation):
            if self._get(operation_id, generation, outcome.request_fingerprint) is not None:
                return False
            claim = self._read(self._claim_path(operation_id, generation))
            if claim is None:
                return False
            self._check(claim, operation_id, generation)
            if (claim.get("ownerId") != owner_id or claim.get("fencingToken") != token
                    or claim.get("requestFingerprint") != outcome.request_fingerprint
                    or float(claim["expiresAt"]) <= time.time()):
                return False
            self._write(self._path(operation_id, generation), {
                "operationId": operation_id, "operationGeneration": generation,
                "status": outcome.status, "response": outcome.response,
                "statusCode": outcome.status_code, "requestFingerprint": outcome.request_fingerprint,
            })
            return True


class OperationRegistry:
    _MAX_PENDING_CANCELLATIONS = 4096

    def __init__(
        self,
        retention_seconds: int = 60,
        outcome_store: FileOutcomeStore | None = None,
        *,
        owner_id: str | None = None,
    ) -> None:
        self._operations: dict[str, Operation] = {}
        self._pending_cancellations: dict[tuple[str, str], float] = {}
        self._known_generations: dict[str, dict[str, float]] = {}
        self._outcomes: dict[tuple[str, str], OperationOutcome] = {}
        self._outcome_store = outcome_store
        self._owner_id = owner_id or secrets.token_hex(16)
        self._lock = asyncio.Lock()
        self.retention_seconds = retention_seconds
        self._shutting_down = False

    async def begin(
        self,
        operation_id: str,
        provider_ref: str,
        timeout_ms: int,
        operation_generation: str | None = None,
        request_fingerprint: str | None = None,
    ) -> Operation:
        async with self._lock:
            if self._shutting_down:
                raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True)
            self._prune_pending_cancellations()
            self._prune()
            now = time.monotonic()
            self._prune_generation_history(now)
            existing = self._operations.get(operation_id)
            if existing is not None and existing.state is not OperationState.FINISHED:
                raise WorkerError("INVALID_REQUEST")
            generation = operation_generation or secrets.token_hex(16)
            if generation in self._known_generations.get(operation_id, {}):
                raise WorkerError("INVALID_REQUEST")
            claim_token = None
            if self._outcome_store is not None:
                claim_token = self._outcome_store.claim(operation_id, generation, self._owner_id, request_fingerprint)
                if claim_token is None:
                    raise WorkerError("DUPLICATE_OPERATION")
            operation = Operation(
                operation_id,
                generation,
                provider_ref,
                time.monotonic(),
                Deadline(timeout_ms),
                claim_token=claim_token,
                request_fingerprint=request_fingerprint,
            )
            operation.task = asyncio.current_task()
            self._known_generations.setdefault(operation_id, {})[generation] = now + self.retention_seconds
            pending_key = (operation_id, generation)
            if self._pending_cancellations.pop(pending_key, None) is not None:
                operation.state = OperationState.CANCEL_REQUESTED
                operation.token.cancel()
            self._operations[operation_id] = operation
            return operation

    async def cancel(self, operation_id: str, operation_generation: str) -> bool:
        async with self._lock:
            self._prune_pending_cancellations()
            operation = self._operations.get(operation_id)
            if operation is not None and operation.operation_generation == operation_generation:
                if operation.state is OperationState.FINISHED:
                    return False
                if self._outcome_store is not None and not self._outcome_store.cancel(operation_id, operation_generation):
                    return False
                operation.state = OperationState.CANCEL_REQUESTED
                operation.token.cancel()
                return True
            # A mismatched generation can be a cancellation that overtook its
            # submission, but never let it cancel a different active operation
            # that has already reused the public ID.
            if operation is not None and operation.state is not OperationState.FINISHED:
                return False
            self._prune_generation_history(time.monotonic())
            if operation_generation in self._known_generations.get(operation_id, {}):
                return False
            if self._outcome_store is not None:
                return self._outcome_store.cancel(operation_id, operation_generation)
            key = (operation_id, operation_generation)
            self._pending_cancellations[key] = time.monotonic() + self.retention_seconds
            while len(self._pending_cancellations) > self._MAX_PENDING_CANCELLATIONS:
                oldest = min(self._pending_cancellations, key=self._pending_cancellations.__getitem__)
                self._pending_cancellations.pop(oldest, None)
            return True

    async def get_outcome(self, operation_id: str, operation_generation: str | None,
                          request_fingerprint: str | None = None) -> OperationOutcome | None:
        """Read only the exact generation and bind replay to the normalized request."""
        if operation_generation is None:
            return None
        async with self._lock:
            if self._outcome_store is not None:
                outcome = self._outcome_store.get(operation_id, operation_generation, request_fingerprint)
            else:
                outcome = self._outcomes.get((operation_id, operation_generation))
                if outcome is not None and request_fingerprint is not None and outcome.request_fingerprint != request_fingerprint:
                    raise WorkerError("INVALID_REQUEST")
            return copy.deepcopy(outcome) if outcome is not None else None

    async def publish_success(self, operation: Operation, response: dict[str, object]) -> bool:
        async with self._lock:
            key = (operation.operation_id, operation.operation_generation)
            if (self._operations.get(operation.operation_id) is not operation
                    or operation.state is not OperationState.ACTIVE or operation.token.cancelled):
                return False
            if key in self._outcomes:
                return False
            outcome = OperationOutcome(*key, "SUCCEEDED", copy.deepcopy(response), 200,
                                       operation.request_fingerprint)
            if self._outcome_store is not None:
                if operation.claim_token is None or not self._outcome_store.put_if_absent(
                    outcome, self._owner_id, operation.claim_token
                ):
                    return False
            else:
                self._outcomes[key] = outcome
            operation.state = OperationState.FINISHED
            return True

    async def publish_failure(self, operation: Operation, response: dict[str, object], status_code: int) -> None:
        async with self._lock:
            key = (operation.operation_id, operation.operation_generation)
            if self._operations.get(operation.operation_id) is not operation:
                return
            if key not in self._outcomes:
                status = "CANCELLED" if response.get("code") == "CANCELLED" else "FAILED"
                outcome = OperationOutcome(*key, status, copy.deepcopy(response), status_code,
                                           operation.request_fingerprint)
                if self._outcome_store is not None:
                    if operation.claim_token is not None:
                        self._outcome_store.put_if_absent(outcome, self._owner_id, operation.claim_token)
                else:
                    self._outcomes[key] = outcome
            operation.state = OperationState.FINISHED

    async def finish(self, operation: Operation) -> None:
        async with self._lock:
            if self._operations.get(operation.operation_id) is operation:
                operation.state = OperationState.FINISHED
                self._known_generations.setdefault(operation.operation_id, {})[
                    operation.operation_generation
                ] = time.monotonic() + self.retention_seconds

    def get(self, operation_id: str) -> Operation | None:
        return self._operations.get(operation_id)

    def _prune(self) -> None:
        cutoff = time.monotonic() - self.retention_seconds
        for operation_id, operation in list(self._operations.items()):
            if operation.state is OperationState.FINISHED and operation.created_at < cutoff:
                self._operations.pop(operation_id, None)

    def _prune_pending_cancellations(self) -> None:
        now = time.monotonic()
        for key, expires_at in list(self._pending_cancellations.items()):
            if expires_at <= now:
                self._pending_cancellations.pop(key, None)

    def _prune_generation_history(self, now: float) -> None:
        for operation_id, generations in list(self._known_generations.items()):
            current = self._operations.get(operation_id)
            for generation, expires_at in list(generations.items()):
                if current is not None and current.operation_generation == generation and current.state is not OperationState.FINISHED:
                    continue
                if expires_at <= now:
                    generations.pop(generation, None)
            if not generations:
                self._known_generations.pop(operation_id, None)

    async def shutdown(self, timeout_seconds: float) -> bool:
        self._shutting_down = True
        for operation in list(self._operations.values()):
            if operation.state is OperationState.ACTIVE:
                operation.state = OperationState.CANCEL_REQUESTED
            operation.token.cancel()
        tasks = [operation.task for operation in self._operations.values() if operation.task is not None and not operation.task.done()]
        if not tasks:
            return True
        _, pending = await asyncio.wait(tasks, timeout=max(0.0, timeout_seconds))
        return not pending
