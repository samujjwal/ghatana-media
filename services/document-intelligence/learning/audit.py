"""Learning audit trail (I5-30).

Append-only JSONL log of governance actions: dataset creation, candidate
creation, evaluation, shadow admission, promotion, rollback, revocation.

Privacy rule: audit records identities, digests, and reason codes — never
document text, extracted values, raw filenames, or credentials. ``audit_event``
enforces the denylist fail-closed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .util import atomic_write_text, canonical_json

AUDIT_SCHEMA_VERSION = "document-intelligence.learning-audit.v1"

AUDIT_KINDS = {
    "DATASET_CREATED",
    "CANDIDATE_CREATED",
    "CANDIDATE_EVALUATED",
    "SHADOW_ADMITTED",
    "PROMOTED",
    "ROLLED_BACK",
    "REVOKED",
    "TOMBSTONED",
}

DENIED_DETAIL_KEYS = {"text", "value", "content", "document", "filename", "credential", "password", "token", "secret"}


def audit_event(
    root: Path,
    *,
    kind: str,
    at: str,
    subject: str,
    detail: dict[str, Any] | None = None,
) -> dict:
    if kind not in AUDIT_KINDS:
        raise ValueError(f"unknown learning audit kind {kind}")
    detail = detail or {}
    _assert_privacy_safe(detail)
    record = {
        "schemaVersion": AUDIT_SCHEMA_VERSION,
        "kind": kind,
        "at": at,
        "subject": subject,
        "detail": detail,
    }
    log = root / "learning-audit.jsonl"
    existing = log.read_text(encoding="utf-8") if log.exists() else ""
    atomic_write_text(log, existing + canonical_json(record) + "\n")
    return record


def _assert_privacy_safe(detail: dict[str, Any], path: str = "") -> None:
    for key, value in detail.items():
        lowered = key.lower()
        if any(denied in lowered for denied in DENIED_DETAIL_KEYS):
            raise ValueError(f"learning audit detail key {path + key!r} may carry protected content")
        if isinstance(value, dict):
            _assert_privacy_safe(value, path + key + ".")
