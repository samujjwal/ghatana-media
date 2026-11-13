"""Rolling deployment compatibility authority (I6-87)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from ..errors import WorkerError


PROTOCOL_V1 = "document-intelligence.v1"


@dataclass(frozen=True)
class VersionSkewMatrix:
    """Explicit client/API/worker compatibility matrix.

    A pair is admitted only when it is present in the matrix. This prevents a
    new worker from accidentally treating an old fixture as proof that every
    mixed deployment is safe.
    """

    schema_version: str
    pairs: Mapping[tuple[str, str, str], str]

    def disposition(self, client_version: str, worker_version: str, surface: str = "worker") -> str:
        return self.pairs.get((surface, client_version, worker_version), "UNSUPPORTED")

    def require_supported(self, client_version: str, worker_version: str, surface: str = "worker") -> None:
        if self.disposition(client_version, worker_version, surface) != "SUPPORTED":
            raise WorkerError("INVALID_REQUEST")

    def as_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "pairs": [
                {"surface": surface, "clientVersion": client, "workerVersion": worker, "disposition": disposition}
                for (surface, client, worker), disposition in sorted(self.pairs.items())
            ],
        }


def default_version_skew_matrix() -> VersionSkewMatrix:
    versions = (PROTOCOL_V1,)
    return VersionSkewMatrix(
        "document-intelligence.version-skew.v1",
        {
            (surface, client, worker): "SUPPORTED"
            for surface in ("worker", "api")
            for client in versions
            for worker in versions
        },
    )


def load_version_skew_matrix(value: Mapping[str, object]) -> VersionSkewMatrix:
    if value.get("schemaVersion") != "document-intelligence.version-skew.v1":
        raise ValueError("unsupported version-skew schema")
    raw_pairs = value.get("pairs")
    if not isinstance(raw_pairs, list):
        raise ValueError("version-skew pairs must be a list")
    pairs: dict[tuple[str, str, str], str] = {}
    for item in raw_pairs:
        if not isinstance(item, Mapping):
            raise ValueError("invalid version-skew pair")
        keys = {"surface", "clientVersion", "workerVersion", "disposition"}
        if set(item) != keys or any(not isinstance(item[key], str) or not item[key] for key in keys):
            raise ValueError("invalid version-skew pair")
        disposition = item["disposition"]
        if disposition not in {"SUPPORTED", "UNSUPPORTED"}:
            raise ValueError("invalid version-skew disposition")
        key = (item["surface"], item["clientVersion"], item["workerVersion"])
        if key in pairs:
            raise ValueError("duplicate version-skew pair")
        pairs[key] = disposition
    return VersionSkewMatrix("document-intelligence.version-skew.v1", pairs)
