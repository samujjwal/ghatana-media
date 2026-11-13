"""Governed candidate registry (I5-21, I5-22).

Layout:

    <root>/candidates/<candidateId>/manifest.json       candidate-manifest.v1
    <root>/candidates/<candidateId>/transitions/<n>-<toState>.json
    <root>/candidates/<candidateId>/artifact.json       kind-specific artifact

Rules:

- A candidate identity is derived from its dependency fingerprint bundle —
  any dependency change produces a NEW candidateId; manifests are write-once.
- Every state transition appends an immutable state-transition-receipt and is
  validated against the allowed transition graph.
- The registry never mutates active authority; promotion publishes a new
  authority revision through ``learning.promotion``.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..tenant_scope import (
    MULTI_TENANT,
    TENANT_LOCAL,
    TENANT_SCOPES,
    TenantScopeError,
)
from ..util import atomic_write_json, digest, load_json, validate

MANIFEST_SCHEMA = "candidate-manifest.v2.schema.json"
MANIFEST_SCHEMA_VERSION = "document-intelligence.candidate-manifest.v2"
MANIFEST_SCHEMA_BY_VERSION = {
    "document-intelligence.candidate-manifest.v1": "candidate-manifest.v1.schema.json",
    "document-intelligence.candidate-manifest.v2": "candidate-manifest.v2.schema.json",
}
RECEIPT_SCHEMA = "state-transition-receipt.v1.schema.json"

STATES = ("CANDIDATE", "EVALUATED", "REJECTED", "APPROVED_FOR_SHADOW", "PROMOTED", "SUPERSEDED")

ALLOWED_TRANSITIONS = {
    "CANDIDATE": {"EVALUATED", "REJECTED"},
    "EVALUATED": {"APPROVED_FOR_SHADOW", "REJECTED", "PROMOTED"},
    "APPROVED_FOR_SHADOW": {"PROMOTED", "REJECTED"},
    "PROMOTED": {"SUPERSEDED"},
    "REJECTED": set(),
    "SUPERSEDED": set(),
}


def validate_manifest(manifest: dict) -> dict:
    """Validate against the schema matching the manifest's own schemaVersion.

    Consumers accept both v1 (pre-scope) and v2 manifests; new registrations
    are always written as v2.
    """
    schema = MANIFEST_SCHEMA_BY_VERSION.get(manifest.get("schemaVersion"))
    if schema is None:
        raise ValueError(
            f"unknown candidate manifest schemaVersion {manifest.get('schemaVersion')!r}"
        )
    return validate(manifest, schema)


def candidate_id_for(kind: str, dependencies: dict[str, Any]) -> str:
    """Deterministic identity: same dependency bundle -> same candidate id."""
    return digest({"domain": "learning.candidate-id.v1", "kind": kind, "dependencies": dependencies})


def register(
    root: Path,
    *,
    kind: str,
    artifact: dict,
    dependencies: dict[str, Any],
    created_at: str,
    actor_ref: str | None = None,
    reason: str | None = None,
    model: dict | None = None,
    tenant_scope: str = TENANT_LOCAL,
    tenant_ref: str | None = None,
    scope_authorization_ref: str | None = None,
) -> dict:
    if tenant_scope not in TENANT_SCOPES:
        raise TenantScopeError(f"unknown tenantScope {tenant_scope!r}")
    if tenant_scope == MULTI_TENANT and not scope_authorization_ref:
        raise TenantScopeError(
            "MULTI_TENANT_EXPLICITLY_AUTHORIZED requires scopeAuthorizationRef"
        )
    candidate_id = candidate_id_for(kind, dependencies)
    manifest_dir = root / "candidates" / _safe(candidate_id)
    manifest_path = manifest_dir / "manifest.json"
    fingerprint = digest(
        {
            "domain": "learning.candidate-manifest.v1",
            "candidateId": candidate_id,
            "candidateKind": kind,
            "artifact": artifact,
            "dependencies": dependencies,
            "model": model,
        }
    )
    if manifest_path.exists():
        existing = load_json(manifest_path)
        if existing["candidateFingerprint"] != fingerprint:
            raise ValueError(f"candidate id collision with divergent content: {candidate_id}")
        return existing
    receipt = {
        "schemaVersion": "document-intelligence.state-transition-receipt.v1",
        "candidateId": candidate_id,
        "candidateFingerprint": fingerprint,
        "fromState": "NONE",
        "toState": "CANDIDATE",
        "at": created_at,
        **({"actorRef": actor_ref} if actor_ref else {}),
        "reason": reason or "registered",
        "dependencyFingerprints": {
            k: v for k, v in dependencies.items() if isinstance(v, str)
        },
    }
    receipt["receiptFingerprint"] = digest(receipt)
    validate(receipt, RECEIPT_SCHEMA)
    manifest: dict[str, Any] = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "candidateId": candidate_id,
        "candidateKind": kind,
        "state": "CANDIDATE",
        "createdAt": created_at,
        "tenantScope": tenant_scope,
        **({"tenantRef": tenant_ref} if tenant_ref else {}),
        **(
            {"scopeAuthorizationRef": scope_authorization_ref}
            if scope_authorization_ref
            else {}
        ),
        "artifactRef": {
            "artifactFingerprint": digest(artifact),
            "artifactKind": kind,
        },
        "dependencies": dependencies,
        "transitions": [
            {
                "fromState": "NONE",
                "toState": "CANDIDATE",
                "at": created_at,
                **({"actorRef": actor_ref} if actor_ref else {}),
                "reason": "registered",
                "receiptFingerprint": receipt["receiptFingerprint"],
            }
        ],
        "candidateFingerprint": fingerprint,
    }
    if model is not None:
        manifest["model"] = model
    validate_manifest(manifest)
    manifest_dir.mkdir(parents=True, exist_ok=True)
    (manifest_dir / "transitions").mkdir(exist_ok=True)
    atomic_write_json(manifest_dir / "artifact.json", artifact)
    atomic_write_json(manifest_path, manifest)
    atomic_write_json(manifest_dir / "transitions" / "0000-CANDIDATE.json", receipt)
    return manifest


def get(root: Path, candidate_id: str) -> dict | None:
    path = root / "candidates" / _safe(candidate_id) / "manifest.json"
    return load_json(path) if path.exists() else None


def load_artifact(root: Path, candidate_id: str) -> dict | None:
    path = root / "candidates" / _safe(candidate_id) / "artifact.json"
    return load_json(path) if path.exists() else None


def list_candidates(root: Path) -> list[dict]:
    base = root / "candidates"
    if not base.is_dir():
        return []
    return [get(root, p.name) for p in sorted(base.iterdir()) if (p / "manifest.json").exists()]


def transition(
    root: Path,
    candidate_id: str,
    *,
    to_state: str,
    at: str,
    actor_ref: str | None = None,
    reason: str | None = None,
) -> dict:
    manifest_path = root / "candidates" / _safe(candidate_id) / "manifest.json"
    manifest = load_json(manifest_path)
    current = manifest["state"]
    if to_state != current and to_state not in ALLOWED_TRANSITIONS[current]:
        raise ValueError(f"illegal candidate transition {current} -> {to_state}")
    if to_state == current:
        raise ValueError(f"no-op transition {current} -> {to_state}")
    receipt = {
        "schemaVersion": "document-intelligence.state-transition-receipt.v1",
        "candidateId": candidate_id,
        "candidateFingerprint": manifest["candidateFingerprint"],
        "fromState": current,
        "toState": to_state,
        "at": at,
        **({"actorRef": actor_ref} if actor_ref else {}),
        **({"reason": reason} if reason else {}),
        "dependencyFingerprints": _dependency_fingerprints(manifest),
    }
    receipt["receiptFingerprint"] = digest(receipt)
    validate(receipt, RECEIPT_SCHEMA)
    manifest["state"] = to_state
    manifest["transitions"] = [
        *manifest["transitions"],
        {
            "fromState": receipt["fromState"],
            "toState": receipt["toState"],
            "at": receipt["at"],
            **({"actorRef": actor_ref} if actor_ref else {}),
            **({"reason": reason} if reason else {}),
            "receiptFingerprint": receipt["receiptFingerprint"],
        },
    ]
    validate_manifest(manifest)
    atomic_write_json(manifest_path, manifest)
    seq = len(manifest["transitions"]) - 1
    atomic_write_json(
        manifest_path.parent / "transitions" / f"{seq:04d}-{to_state}.json", receipt
    )
    return receipt


def _dependency_fingerprints(manifest: dict) -> dict[str, str]:
    deps = manifest.get("dependencies", {})
    return {k: v for k, v in deps.items() if isinstance(v, str)}


def _safe(candidate_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in candidate_id)
