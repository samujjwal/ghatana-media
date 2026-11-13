"""Increment-6 crash-recovery write-ahead journal (backlog I6-25).

``CrashRecoveryJournal`` records every admitted execution as a small JSON
journal file (``<executionId>.journal``) written atomically via
tmp+``os.replace``+fsync.  Each record carries ``state``: ``STARTED`` when
the execution is admitted, ``COMPLETED`` when it finishes.  After an unclean
shutdown, :meth:`recover` returns the executionIds whose journals never
reached ``COMPLETED`` so the caller can replay or reap them.  Replay is
bounded by ``max_replay`` so a flooded journal directory cannot stall
startup.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

STATE_STARTED = "STARTED"
STATE_COMPLETED = "COMPLETED"

DEFAULT_MAX_REPLAY = 1024


class CrashRecoveryJournal:
    def __init__(self, directory: Path | str, max_replay: int = DEFAULT_MAX_REPLAY) -> None:
        if max_replay < 1:
            raise ValueError("max_replay must be positive")
        self.directory = Path(directory)
        self.max_replay = max_replay
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _journal_path(self, execution_id: str) -> Path:
        return self.directory / f"{execution_id}.journal"

    def _write_record(self, execution_id: str, state: str) -> None:
        record: dict[str, Any] = {
            "executionId": execution_id,
            "state": state,
            "updatedAt": time.time(),
        }
        payload = json.dumps(record, sort_keys=True).encode("utf-8")
        target = self._journal_path(execution_id)
        tmp = self.directory / f".{execution_id}.{secrets.token_hex(8)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, target)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def record_started(self, execution_id: str) -> None:
        """Write-ahead marker: execution ``execution_id`` is in flight."""
        self._write_record(execution_id, STATE_STARTED)

    def record_completed(self, execution_id: str) -> None:
        """Atomically transition the journal to COMPLETED."""
        self._write_record(execution_id, STATE_COMPLETED)

    def recover(self, max_replay: int | None = None) -> list[str]:
        """Interrupted executionIds from the last unclean shutdown.

        A journal still at STARTED — or one that cannot be parsed — counts
        as interrupted (fail closed).  At most ``max_replay`` ids are
        returned so recovery stays bounded.
        """
        cap = self.max_replay if max_replay is None else max_replay
        interrupted: list[str] = []
        for path in sorted(self.directory.glob("*.journal")):
            if len(interrupted) >= cap:
                break
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                interrupted.append(path.stem)
                continue
            if not isinstance(record, dict):
                interrupted.append(path.stem)
                continue
            if record.get("state") != STATE_COMPLETED:
                execution_id = record.get("executionId")
                interrupted.append(execution_id if isinstance(execution_id, str) else path.stem)
        return interrupted

    def clear(self) -> int:
        """Remove every journal file; returns the number removed."""
        removed = 0
        for path in self.directory.glob("*.journal"):
            path.unlink(missing_ok=True)
            removed += 1
        return removed
