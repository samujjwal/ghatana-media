"""Model/native asset provenance and allowlist enforcement (I6-89)."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class AssetProvenance:
    origin: str
    source: str
    digest: str
    expected_size: int
    license_ref: str
    signature: str | None = None
    attestation: str | None = None


@dataclass(frozen=True)
class AssetProvenancePolicy:
    allowed_origins: frozenset[str] = frozenset({"local-package-cache", "vendor-bundle"})
    allowed_sources: frozenset[str] = frozenset({"local-package-cache", "offline-bundle"})
    require_signature: bool = False

    def validate(self, provenance: AssetProvenance) -> None:
        if provenance.origin not in self.allowed_origins or provenance.source not in self.allowed_sources:
            raise ValueError("asset origin/source is not allowlisted")
        if not _SHA256.fullmatch(provenance.digest) or provenance.expected_size < 0 or not provenance.license_ref:
            raise ValueError("asset provenance is incomplete")
        if self.require_signature and not (provenance.signature or provenance.attestation):
            raise ValueError("asset signature or attestation is required")


def verify_asset_provenance(path: Path | str, provenance: AssetProvenance, policy: AssetProvenancePolicy | None = None) -> str:
    """Verify digest, size, regular-file status and provenance policy."""
    policy = policy or AssetProvenancePolicy()
    policy.validate(provenance)
    asset = Path(path)
    if asset.is_symlink() or not asset.is_file():
        raise ValueError("asset must be a regular non-symlink file")
    if asset.stat().st_size != provenance.expected_size:
        raise ValueError("asset size does not match provenance")
    observed = hashlib.sha256(asset.read_bytes()).hexdigest()
    if observed != provenance.digest:
        raise ValueError("asset digest does not match provenance")
    return observed


def provenance_from_manifest(record: Mapping[str, object]) -> AssetProvenance:
    """Parse the stable subset used by model/native lock manifests."""
    return AssetProvenance(
        origin=str(record.get("downloadSource", "")),
        source=str(record.get("source", record.get("downloadSource", ""))),
        digest=str(record.get("artifactSha256", "")).lower(),
        expected_size=int(record.get("artifactSize", -1)),
        license_ref=str(record.get("licenseRef", "")),
        signature=record.get("signature") if isinstance(record.get("signature"), str) else None,
        attestation=record.get("attestation") if isinstance(record.get("attestation"), str) else None,
    )
