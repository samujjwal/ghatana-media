"""Campaign guard authority for new (I5+) evidence campaigns.

Implements the P0 campaign contract for campaigns built after the I3/I4/I4A
seal — the sealed increment4a scripts already carry equivalent before/after
material guards and must not be modified:

- P0-08  materialFingerprintBefore/After; mismatch ->
         RUN_INVALIDATED_BY_CONCURRENT_MUTATION
- P0-11  networkMode / resolvedModelAssets / resolvedNativeAssets /
         modelCacheFingerprint / remoteFetchCount (frozen qualification
         requires remoteFetchCount == 0)
- P0-12  providerResultCache DISABLED / evaluationResultCache DISABLED /
         modelAssetCache READ_ONLY_ALLOWED; evidence reuse must cite an
         explicit prior receipt
- P0-13  per-provider invocation counts attempted/completed/cancelled/
         timedOut/failed
- P0-16  source-tree snapshot before/after (tracked, untracked in-scope,
         generated authority)
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

WORKER_ROOT = Path(__file__).resolve().parents[1]

CONCURRENT_MUTATION = "RUN_INVALIDATED_BY_CONCURRENT_MUTATION"


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def tree_digest(paths: Iterable[Path]) -> str:
    """Digest a path set as sorted (relative path, content sha) pairs."""
    hasher = hashlib.sha256()
    for path in sorted(paths):
        if not path.exists():
            hasher.update(f"MISSING:{path}\n".encode())
            continue
        if path.is_dir():
            children = sorted(
                p for p in path.rglob("*") if p.is_file() and "__pycache__" not in p.parts
            )
            for child in children:
                hasher.update(str(child.relative_to(path)).encode())
                hasher.update(child.read_bytes())
        else:
            hasher.update(path.name.encode())
            hasher.update(path.read_bytes())
    return "sha256:" + hasher.hexdigest()


def material_snapshot(paths: Iterable[Path]) -> str:
    return tree_digest([p for p in paths])


def source_tree_snapshot(root: Path) -> dict:
    """Tracked + untracked in-scope state via git (P0-16)."""
    try:
        tracked = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True, capture_output=True,
        ).stdout.decode().split("\0")
        status = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain", "-z"],
            check=True, capture_output=True,
        ).stdout.decode().split("\0")
    except (OSError, subprocess.CalledProcessError):
        tracked, status = [], []
    tracked = [t for t in tracked if t]
    modified = sorted({s[3:] for s in status if s})
    digest_pairs = []
    for rel in tracked:
        target = root / rel
        if target.is_file():
            digest_pairs.append([rel, hashlib.sha256(target.read_bytes()).hexdigest()])
    return {
        "trackedFileCount": len(tracked),
        "trackedDigest": "sha256:" + hashlib.sha256(_canonical(digest_pairs)).hexdigest(),
        "dirtyOrUntracked": modified,
    }


@dataclass
class CampaignGuard:
    """Context manager binding before/after material + source-tree state."""

    material_paths: list[Path]
    source_root: Path = WORKER_ROOT
    network_mode: str = "offline"
    allow_model_cache_read: bool = True
    provider_result_cache: str = "DISABLED"
    evaluation_result_cache: str = "DISABLED"
    model_asset_cache: str = "READ_ONLY_ALLOWED"
    resolved_model_assets: dict[str, str] = field(default_factory=dict)
    resolved_native_assets: dict[str, str] = field(default_factory=dict)
    remote_fetch_count: int = 0
    reused_receipt: str | None = None
    provider_invocations: dict[str, dict[str, int]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self._material_before: str | None = None
        self._source_before: dict | None = None

    def __enter__(self) -> "CampaignGuard":
        self._material_before = material_snapshot(self.material_paths)
        self._source_before = source_tree_snapshot(self.source_root)
        return self

    def record_invocation(self, provider: str, outcome: str) -> None:
        counts = self.provider_invocations.setdefault(
            provider,
            {"attempted": 0, "completed": 0, "cancelled": 0, "timedOut": 0, "failed": 0},
        )
        counts["attempted"] += 1
        if outcome in counts:
            counts[outcome] += 1
        else:
            raise ValueError(f"unknown invocation outcome {outcome}")

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is not None:
            return False
        material_after = material_snapshot(self.material_paths)
        if material_after != self._material_before:
            raise RuntimeError(f"{CONCURRENT_MUTATION}: material fingerprint drifted during campaign")
        source_after = source_tree_snapshot(self.source_root)
        if (
            source_after["trackedDigest"] != self._source_before["trackedDigest"]
            or source_after["dirtyOrUntracked"] != self._source_before["dirtyOrUntracked"]
        ):
            raise RuntimeError(f"{CONCURRENT_MUTATION}: source tree drifted during campaign")
        return False

    def authority_fields(self) -> dict:
        """Fields every campaign manifest/attestation must carry."""
        return {
            "networkMode": self.network_mode,
            "remoteFetchCount": self.remote_fetch_count,
            "resolvedModelAssets": self.resolved_model_assets,
            "resolvedNativeAssets": self.resolved_native_assets,
            "modelCacheFingerprint": digest(sorted(self.resolved_model_assets.items())),
            "providerResultCache": self.provider_result_cache,
            "evaluationResultCache": self.evaluation_result_cache,
            "modelAssetCache": self.model_asset_cache,
            "providerInvocations": self.provider_invocations,
            **({"reusedReceiptRef": self.reused_receipt} if self.reused_receipt else {}),
        }

    def assert_frozen_qualification(self) -> None:
        if self.network_mode != "offline" or self.remote_fetch_count != 0:
            raise RuntimeError(
                "frozen qualification requires networkMode=offline and remoteFetchCount=0"
            )
        if self.provider_result_cache != "DISABLED" or self.evaluation_result_cache != "DISABLED":
            if self.reused_receipt is None:
                raise RuntimeError(
                    "result-cache reuse requires an explicit prior receipt reference"
                )
