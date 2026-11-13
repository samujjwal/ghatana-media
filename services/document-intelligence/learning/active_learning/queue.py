"""Persistent active-learning queue (I5-20).

Store layout — a single atomic JSON document:

    <root>/active-learning-queue.json
    {"schemaVersion": "document-intelligence.active-learning-queue.v1",
     "entries": [active-learning-entry.v1, ...]}

Every write re-validates each entry against ``active-learning-entry.v1`` and
publishes via an atomic rename, so a crash never leaves a torn queue. The
queue ranks human review order only; it never auto-labels and never changes
product results.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from ..util import atomic_write_json, digest, load_json, validate

ENTRY_SCHEMA = "active-learning-entry.v1.schema.json"
QUEUE_SCHEMA_VERSION = "document-intelligence.active-learning-queue.v1"
ENTRY_SCHEMA_VERSION = "document-intelligence.active-learning-entry.v1"


class ActiveLearningQueue:
    """Append-and-transition store for prioritized review work."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.path = self.root / "active-learning-queue.json"

    def enqueue(self, execution_id: str, scored: dict, created_at: str) -> dict:
        """Queue one scored review. Idempotent on ``execution_id``: a repeat
        enqueue returns the existing entry unchanged."""
        store = self._load()
        for entry in store["entries"]:
            if entry["executionId"] == execution_id:
                return entry
        entry = {
            "schemaVersion": ENTRY_SCHEMA_VERSION,
            "entryId": digest(
                {
                    "domain": "al-entry.v1",
                    "executionId": execution_id,
                    "reasonCodes": scored["reasonCodes"],
                }
            ),
            "executionId": execution_id,
            "reasonCodes": list(scored["reasonCodes"]),
            "scoreComponents": dict(scored["scoreComponents"]),
            "priority": scored["priority"],
            "status": "QUEUED",
            "createdAt": created_at,
        }
        validate(entry, ENTRY_SCHEMA)
        store["entries"].append(entry)
        self._save(store)
        return entry

    def claim(self, entry_id: str, actor: str, at: str) -> dict:
        """QUEUED -> CLAIMED; conflicts (already claimed or terminal) raise."""

        def apply(entry: dict) -> None:
            if entry["status"] != "QUEUED":
                raise ValueError(
                    f"entry {entry_id} is {entry['status']}, cannot claim"
                )
            entry["status"] = "CLAIMED"
            entry["claimedBy"] = actor
            entry["claimedAt"] = at

        return self._update(entry_id, apply)

    def mark_reviewed(self, entry_id: str, at: str) -> dict:
        """CLAIMED|QUEUED -> REVIEWED."""

        def apply(entry: dict) -> None:
            if entry["status"] not in ("QUEUED", "CLAIMED"):
                raise ValueError(
                    f"entry {entry_id} is {entry['status']}, cannot mark reviewed"
                )
            entry["status"] = "REVIEWED"
            entry["reviewedAt"] = at

        return self._update(entry_id, apply)

    def withdraw(self, entry_id: str, at: str) -> dict:
        """QUEUED|CLAIMED -> WITHDRAWN. Terminal entries cannot be withdrawn."""

        def apply(entry: dict) -> None:
            if entry["status"] in ("REVIEWED", "WITHDRAWN"):
                raise ValueError(
                    f"entry {entry_id} is {entry['status']}, cannot withdraw"
                )
            entry["status"] = "WITHDRAWN"

        return self._update(entry_id, apply)

    def list(self, status: str | None = None) -> list[dict]:
        """Entries (optionally filtered by status), highest priority first;
        ties break on entryId for a deterministic order."""
        entries = self._load()["entries"]
        if status is not None:
            entries = [e for e in entries if e["status"] == status]
        return sorted(entries, key=lambda e: (-e["priority"], e["entryId"]))

    def get(self, entry_id: str) -> dict | None:
        for entry in self._load()["entries"]:
            if entry["entryId"] == entry_id:
                return entry
        return None

    def _update(self, entry_id: str, apply: Callable[[dict], None]) -> dict:
        store = self._load()
        entry = next(
            (e for e in store["entries"] if e["entryId"] == entry_id), None
        )
        if entry is None:
            raise ValueError(f"unknown active-learning entry {entry_id}")
        apply(entry)
        validate(entry, ENTRY_SCHEMA)
        self._save(store)
        return entry

    def _load(self) -> dict:
        if not self.path.exists():
            return {"schemaVersion": QUEUE_SCHEMA_VERSION, "entries": []}
        store = load_json(self.path)
        if store.get("schemaVersion") != QUEUE_SCHEMA_VERSION:
            raise ValueError(f"queue {self.path} has wrong schemaVersion")
        return store

    def _save(self, store: dict) -> None:
        for entry in store["entries"]:
            validate(entry, ENTRY_SCHEMA)
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.path, store)
