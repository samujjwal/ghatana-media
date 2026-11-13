#!/usr/bin/env python3
"""Run-scoped evidence locks (P0-09).

A scope lock prevents two campaigns from writing the same canonical evidence
location concurrently. The lock is:

- PID-safe:      owned by a pid + process start time, verified via /proc
- crash-recoverable: a dead owner's lock is reclaimable
- runId-bound:   the lock record names the owning campaign run id

Layout: ``<evidence-root>/.scope-locks/<name>.lock/lock.json``
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


class ScopeLockHeld(Exception):
    def __init__(self, name: str, owner: dict):
        super().__init__(f"scope lock {name!r} held by runId={owner.get('runId')} pid={owner.get('pid')}")
        self.owner = owner


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _pid_start_time(pid: int) -> str | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        # field 22 = starttime (after the comm field which may contain spaces)
        return stat.rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def _owner_alive(record: dict) -> bool:
    pid = record.get("pid")
    start = record.get("processStartTime")
    if not isinstance(pid, int) or pid <= 0 or not start:
        return False
    return _pid_start_time(pid) == start


def acquire(evidence_root: Path, name: str, run_id: str) -> Path:
    """Acquire the scope lock; returns the lock dir. Raises ScopeLockHeld."""
    locks_dir = evidence_root / ".scope-locks"
    locks_dir.mkdir(parents=True, exist_ok=True)
    lock_dir = locks_dir / f"{name}.lock"
    record_path = lock_dir / "lock.json"
    try:
        lock_dir.mkdir()
    except FileExistsError:
        try:
            owner = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            owner = {}
        if _owner_alive(owner):
            raise ScopeLockHeld(name, owner)
        # Owner is dead (or record unreadable): recover the stale lock.
        release(evidence_root, name, force=True)
        lock_dir.mkdir()
    record = {
        "schemaVersion": "document-intelligence.scope-lock.v1",
        "name": name,
        "runId": run_id,
        "pid": os.getpid(),
        "processStartTime": _pid_start_time(os.getpid()),
        "acquiredAt": _now(),
    }
    record_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return lock_dir


def release(evidence_root: Path, name: str, *, force: bool = False) -> None:
    locks_dir = evidence_root / ".scope-locks"
    lock_dir = locks_dir / f"{name}.lock"
    record_path = lock_dir / "lock.json"
    if not lock_dir.exists():
        return
    if not force:
        try:
            owner = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            owner = {}
        if _owner_alive(owner) and owner.get("pid") != os.getpid():
            raise ScopeLockHeld(name, owner)
    try:
        record_path.unlink(missing_ok=True)
        lock_dir.rmdir()
    except OSError as exc:
        raise RuntimeError(f"failed to release scope lock {name}: {exc}") from exc


def status(evidence_root: Path) -> dict:
    locks_dir = evidence_root / ".scope-locks"
    result = {}
    if locks_dir.is_dir():
        for lock_dir in sorted(locks_dir.glob("*.lock")):
            record_path = lock_dir / "lock.json"
            try:
                record = json.loads(record_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                record = {}
            result[lock_dir.stem] = {**record, "ownerAlive": _owner_alive(record)}
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="evidence root to lock")
    parser.add_argument("--name", required=True, help="lock name")
    parser.add_argument("--run-id", default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("acquire")
    sub.add_parser("release")
    sub.add_parser("status")
    args = parser.parse_args(argv)

    try:
        if args.command == "acquire":
            if not args.run_id:
                parser.error("acquire requires --run-id")
            acquire(args.root, args.name, args.run_id)
            print(json.dumps({"status": "ACQUIRED", "name": args.name}))
            return 0
        if args.command == "release":
            release(args.root, args.name)
            print(json.dumps({"status": "RELEASED", "name": args.name}))
            return 0
        print(json.dumps(status(args.root), indent=2, sort_keys=True))
        return 0
    except ScopeLockHeld as exc:
        print(json.dumps({"status": "HELD", "owner": exc.owner}))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
