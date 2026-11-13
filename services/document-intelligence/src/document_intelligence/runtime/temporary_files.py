from __future__ import annotations

import os
import secrets
import shutil
import time
from pathlib import Path


class TemporaryFileRun:
    """Private, bounded filesystem namespace for one worker operation."""

    def __init__(self, manager: "TemporaryFileManager", root: Path) -> None:
        self.manager = manager
        self.root = root
        self._files: set[Path] = set()
        self._closed = False

    def write(self, data: bytes) -> Path:
        if self._closed or len(self._files) >= self.manager.max_files:
            raise ValueError("temporary file count exceeds ceiling")
        if len(data) > self.manager.max_bytes:
            raise ValueError("temporary file exceeds byte ceiling")
        path = self.root / f"worker-{secrets.token_hex(16)}.bin"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            self._files.add(path)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return path

    def cleanup(self, path: Path | None) -> None:
        if path is None or path not in self._files:
            return
        path.unlink(missing_ok=True)
        self._files.discard(path)

    def cleanup_all(self) -> None:
        """Recursively remove only this run's private directory."""
        if self._closed:
            return
        self._closed = True
        self._files.clear()
        shutil.rmtree(self.root, ignore_errors=True)
        self.manager._runs.pop(self.root, None)


class TemporaryFileManager:
    """Own per-operation private directories and never sweep foreign files."""

    _RUN_PREFIX = ".document-intelligence-run-"

    def __init__(self, root: Path, max_bytes: int, retention_seconds: int = 3600, max_files: int = 128) -> None:
        if max_bytes <= 0 or retention_seconds < 0 or max_files <= 0:
            raise ValueError("invalid temporary-file policy")
        self.root = root
        self.max_bytes = max_bytes
        self.retention_seconds = retention_seconds
        self.max_files = max_files
        self._runs: dict[Path, TemporaryFileRun] = {}
        self._default_run: TemporaryFileRun | None = None
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)

    def create_run(self) -> TemporaryFileRun:
        for _ in range(8):
            run_root = self.root / f"{self._RUN_PREFIX}{secrets.token_hex(12)}"
            try:
                run_root.mkdir(mode=0o700)
            except FileExistsError:
                continue
            os.chmod(run_root, 0o700)
            run = TemporaryFileRun(self, run_root)
            self._runs[run_root] = run
            return run
        raise OSError("could not allocate private temporary run directory")

    def scavenge(self) -> int:
        """Remove only stale directories bearing this manager's ownership prefix."""
        removed = 0
        cutoff = time.time() - self.retention_seconds
        for path in self.root.iterdir():
            if not path.name.startswith(self._RUN_PREFIX) or not path.is_dir() or path in self._runs:
                continue
            try:
                if path.stat().st_mtime < cutoff:
                    shutil.rmtree(path)
                    removed += 1
            except OSError:
                continue
        return removed

    def write(self, data: bytes) -> Path:
        """Compatibility helper; request handlers should use create_run."""
        if self._default_run is None or self._default_run._closed:
            self._default_run = self.create_run()
        return self._default_run.write(data)

    def cleanup(self, path: Path | None) -> None:
        if path is None:
            return
        for run in tuple(self._runs.values()):
            if path in run._files:
                run.cleanup(path)
                return

    def cleanup_all(self) -> None:
        for run in tuple(self._runs.values()):
            run.cleanup_all()
        self._default_run = None
