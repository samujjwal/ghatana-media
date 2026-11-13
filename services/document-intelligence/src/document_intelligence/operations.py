from __future__ import annotations

import asyncio
import copy
import hashlib
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


@dataclass(frozen=True)
class OperationOutcome:
    operation_id: str
    operation_generation: str
    status: str
    response: dict[str, object]
    status_code: int = 200


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

    def claim(self, operation_id: str, generation: str, owner_id: str) -> str | None:
        """Atomically claim an in-flight operation across worker replicas."""
        path = self._claim_path(operation_id, generation)
        now = time.time()
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, ValueError):
            existing = None
        if isinstance(existing, dict) and float(existing.get("expiresAt", 0)) > now:
            return None
        if existing is not None:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                return None
        token = secrets.token_hex(16)
        payload = json.dumps(
            {
                "operationId": operation_id,
                "operationGeneration": generation,
                "ownerId": owner_id,
                "fencingToken": token,
                "expiresAt": now + self.claim_ttl_seconds,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return None
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return token

    def claim_is_current(self, operation_id: str, generation: str, owner_id: str, token: str) -> bool:
        try:
            value = json.loads(self._claim_path(operation_id, generation).read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, ValueError):
            return False
        return (
            isinstance(value, dict)
            and value.get("operationId") == operation_id
            and value.get("operationGeneration") == generation
            and value.get("ownerId") == owner_id
            and value.get("fencingToken") == token
            and float(value.get("expiresAt", 0)) > time.time()
        )

    def get(self, operation_id: str, generation: str | None) -> OperationOutcome | None:
        candidates = [self._path(operation_id, generation)] if generation is not None else sorted(self.directory.glob("*.json"))
        for path in candidates:
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (FileNotFoundError, OSError, ValueError):
                continue
            if not isinstance(value, dict) or value.get("operationId") != operation_id:
                continue
            if generation is not None and value.get("operationGeneration") != generation:
                continue
            return OperationOutcome(
                str(value["operationId"]),
                str(value["operationGeneration"]),
                str(value["status"]),
                value["response"],
                int(value.get("statusCode", 200)),
            )
        return None

    def put_if_absent(self, outcome: OperationOutcome) -> bool:
        path = self._path(outcome.operation_id, outcome.operation_generation)
        payload = json.dumps({
            "operationId": outcome.operation_id,
            "operationGeneration": outcome.operation_generation,
            "status": outcome.status,
            "response": outcome.response,
            "statusCode": outcome.status_code,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return False
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            raise
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
            if self._outcome_store is not None and self._outcome_store.get(operation_id, generation) is not None:
                raise WorkerError("DUPLICATE_OPERATION")
            claim_token = None
            if self._outcome_store is not None:
                claim_token = self._outcome_store.claim(operation_id, generation, self._owner_id)
                if claim_token is None:
                    raise WorkerError("DUPLICATE_OPERATION")
            operation = Operation(
                operation_id,
                generation,
                provider_ref,
                time.monotonic(),
                Deadline(timeout_ms),
                claim_token=claim_token,
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
                if operation.state is OperationState.ACTIVE:
                    operation.state = OperationState.CANCEL_REQUESTED
                    operation.token.cancel()
                    return True
                return operation.state is OperationState.CANCEL_REQUESTED
            # A mismatched generation can be a cancellation that overtook its
            # submission, but never let it cancel a different active operation
            # that has already reused the public ID.
            if operation is not None and operation.state is not OperationState.FINISHED:
                return False
            self._prune_generation_history(time.monotonic())
            if operation_generation in self._known_generations.get(operation_id, {}):
                return False
            key = (operation_id, operation_generation)
            self._pending_cancellations[key] = time.monotonic() + self.retention_seconds
            while len(self._pending_cancellations) > self._MAX_PENDING_CANCELLATIONS:
                oldest = min(self._pending_cancellations, key=self._pending_cancellations.__getitem__)
                self._pending_cancellations.pop(oldest, None)
            return True

    async def get_outcome(self, operation_id: str, operation_generation: str | None) -> OperationOutcome | None:
        """Return a committed result for an idempotent retry, if one exists."""
        async with self._lock:
            outcome = self._outcomes.get((operation_id, operation_generation)) if operation_generation is not None else next(
                (item for (item_operation_id, _), item in self._outcomes.items() if item_operation_id == operation_id),
                None,
            )
            if outcome is None and self._outcome_store is not None:
                outcome = self._outcome_store.get(operation_id, operation_generation)
                if outcome is not None:
                    self._outcomes[(outcome.operation_id, outcome.operation_generation)] = outcome
            return copy.deepcopy(outcome) if outcome is not None else None

    async def publish_success(self, operation: Operation, response: dict[str, object]) -> bool:
        """Commit the result before the HTTP response leaves the worker.

        The commit is the uncertain-outcome boundary: a disconnected caller
        can retry and receive the exact same response, while a cancellation
        that won the race prevents a late provider result from being
        resurrected.
        """
        async with self._lock:
            key = (operation.operation_id, operation.operation_generation)
            existing = self._outcomes.get(key)
            if existing is None and self._outcome_store is not None:
                existing = self._outcome_store.get(*key)
                if existing is not None:
                    self._outcomes[key] = existing
            if existing is not None:
                return existing.status == "SUCCEEDED"
            current = self._operations.get(operation.operation_id)
            if current is not operation or operation.state is OperationState.CANCEL_REQUESTED or operation.token.cancelled:
                return False
            if self._outcome_store is not None and (
                operation.claim_token is None
                or not self._outcome_store.claim_is_current(
                    operation.operation_id,
                    operation.operation_generation,
                    self._owner_id,
                    operation.claim_token,
                )
            ):
                return False
            outcome = OperationOutcome(operation.operation_id, operation.operation_generation, "SUCCEEDED", copy.deepcopy(response), 200)
            if self._outcome_store is not None and not self._outcome_store.put_if_absent(outcome):
                existing = self._outcome_store.get(*key)
                self._outcomes[key] = existing if existing is not None else outcome
                return existing is not None and existing.status == "SUCCEEDED"
            self._outcomes[key] = outcome
            operation.state = OperationState.FINISHED
            return True

    async def publish_failure(self, operation: Operation, response: dict[str, object], status_code: int) -> None:
        """Commit a terminal error/cancellation exactly once."""
        async with self._lock:
            key = (operation.operation_id, operation.operation_generation)
            existing = self._outcomes.get(key)
            if existing is None and self._outcome_store is not None:
                existing = self._outcome_store.get(*key)
            if existing is None:
                if self._outcome_store is not None and (
                    operation.claim_token is None
                    or not self._outcome_store.claim_is_current(
                        operation.operation_id,
                        operation.operation_generation,
                        self._owner_id,
                        operation.claim_token,
                    )
                ):
                    if self._operations.get(operation.operation_id) is operation:
                        operation.state = OperationState.FINISHED
                    return
                status = "CANCELLED" if response.get("code") == "CANCELLED" else "FAILED"
                outcome = OperationOutcome(operation.operation_id, operation.operation_generation, status, copy.deepcopy(response), status_code)
                if self._outcome_store is None or self._outcome_store.put_if_absent(outcome):
                    self._outcomes[key] = outcome
                else:
                    persisted = self._outcome_store.get(*key)
                    if persisted is not None:
                        self._outcomes[key] = persisted
            if self._operations.get(operation.operation_id) is operation:
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
