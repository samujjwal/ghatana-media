"""Per-page provenance receipts for scanned-PDF classification (I6-05).

Every classification emits a receipt binding the page-level decisions, the
aggregated document class, the routing decision and the policy fingerprint.
The receipt fingerprint is a sha256 over the canonical JSON of the record
minus the fingerprint field itself, so the receipt is tamper-evident and
byte-deterministic.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Sequence

from ..errors import WorkerError
from .classifier import DocumentClassification

RECEIPT_SCHEMA_VERSION = "document-intelligence.scanned-provenance.v1"


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def provenance_record(
    document_classification: DocumentClassification,
    page_refs: Sequence[Any] | None = None,
) -> dict[str, Any]:
    """Build the per-page provenance receipt for a classified document.

    ``page_refs`` optionally supplies caller-side page identifiers (e.g. PDF
    page numbers or region refs); when given it must align 1:1 with the
    classified pages and is stamped into each decision as ``pageRef``.
    """
    if not isinstance(document_classification, DocumentClassification):
        raise WorkerError("INVALID_REQUEST")
    if page_refs is not None and (
        isinstance(page_refs, (str, bytes))
        or not isinstance(page_refs, Sequence)
        or len(page_refs) != len(document_classification.page_classes)
    ):
        raise WorkerError("INVALID_REQUEST")
    decisions: list[dict[str, Any]] = []
    for index, page in enumerate(document_classification.page_classes):
        decision: dict[str, Any] = {
            "pageIndex": index,
            "class": page.classification,
            "reasonCode": page.reason_code,
        }
        if page_refs is not None:
            decision["pageRef"] = page_refs[index]
        decisions.append(decision)
    record: dict[str, Any] = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "documentClass": document_classification.document_class,
        "classifierRef": document_classification.classifier_ref,
        "policyFingerprint": document_classification.policy_fingerprint,
        "route": dict(document_classification.route),
        "pageDecisions": decisions,
    }
    record["receiptFingerprint"] = "sha256:" + hashlib.sha256(_canonical(record)).hexdigest()
    return record


__all__ = ["RECEIPT_SCHEMA_VERSION", "provenance_record"]
