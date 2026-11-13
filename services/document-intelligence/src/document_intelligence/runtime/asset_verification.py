"""Increment-6 runtime asset verification (backlog I6-27).

``verify_assets`` compares every declared ``{name: sha256}`` manifest entry
against the file tree under ``root`` and returns a ``{verified, corrupt}``
verdict.  Verification fails closed: missing files, unreadable files, and
digest mismatches all land in ``corrupt`` — never silently skipped.
``require_assets`` raises :class:`AssetCorruptionError` carrying the corrupt
names whenever the verdict is not clean.

``errors.py`` is sealed Increment-4A material, so ``AssetCorruptionError``
overrides ``WorkerError.__post_init__`` to keep the increment-6 code
verbatim.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from pathlib import Path

from ..errors import WorkerError


class AssetCorruptionError(WorkerError):
    """WorkerError carrying the names of corrupt or missing assets."""

    def __init__(self, corrupt: Iterable[str]) -> None:
        self.corrupt = tuple(sorted(corrupt))
        super().__init__("ASSET_CORRUPT", retryable=False)

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code)


def verify_assets(manifest: Mapping[str, str], root: Path | str) -> dict[str, list[str]]:
    """Verify ``{name: sha256}`` entries against files under ``root``.

    Returns ``{"verified": [...], "corrupt": [...]}``.  Every manifest name
    appears in exactly one list; names are sorted for deterministic verdicts.
    """
    base = Path(root)
    verified: list[str] = []
    corrupt: list[str] = []
    for name in sorted(manifest):
        expected = manifest[name]
        path = base / name
        if not isinstance(expected, str) or not path.is_file():
            corrupt.append(name)
            continue
        try:
            observed = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            corrupt.append(name)
            continue
        if observed == expected.lower():
            verified.append(name)
        else:
            corrupt.append(name)
    return {"verified": verified, "corrupt": corrupt}


def require_assets(manifest: Mapping[str, str], root: Path | str) -> list[str]:
    """Return verified names or raise :class:`AssetCorruptionError`."""
    verdict = verify_assets(manifest, root)
    if verdict["corrupt"]:
        raise AssetCorruptionError(verdict["corrupt"])
    return verdict["verified"]
