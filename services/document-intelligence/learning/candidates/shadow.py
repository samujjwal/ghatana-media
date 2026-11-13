"""Shadow-run receipts (I5-25).

A shadow run executes a candidate alongside the active authority and records
per-case agreement. The ``constraints`` block is asserted by construction:
this module has no write path to user-visible product state, business state,
or the active authority — its only side effect is the receipt artifact itself,
so all three flags are the constant ``true`` required by shadow-evaluation.v1.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..util import atomic_write_json, digest, validate

RECEIPT_SCHEMA = "shadow-evaluation.v1.schema.json"
SCHEMA_VERSION = "document-intelligence.shadow-evaluation.v1"

# Shadow evaluation is observation-only; these constants are schema-enforced.
CONSTRAINTS = {
    "userVisibleUnchanged": True,
    "businessStateUnchanged": True,
    "activeAuthorityUnchanged": True,
}


def emit_shadow_receipt(
    *,
    shadow_run_id: str,
    candidate_id: str,
    candidate_fingerprint: str,
    evaluation_set_fingerprint: str,
    active_authority_fingerprint: str,
    case_results: list[dict],
    executed_at: str,
    out_path: Path,
    candidate_outputs: Any | None = None,
) -> dict:
    """Build, validate, and atomically write a shadow-evaluation.v1 receipt.

    ``case_results`` entries are ``{"caseId": str, "agrees": bool,
    "detail": str?}``; entries may additionally carry ``"candidateOutput"``,
    which feeds ``candidateResultFingerprint`` (overridden wholesale by the
    ``candidate_outputs`` argument) but is stripped from the stored perCase
    records. Returns the receipt as written.
    """
    per_case = []
    for case in case_results:
        item: dict[str, Any] = {
            "caseId": case["caseId"],
            "agrees": bool(case["agrees"]),
        }
        if case.get("detail") is not None:
            item["detail"] = case["detail"]
        per_case.append(item)

    if candidate_outputs is not None:
        candidate_result_fingerprint = digest(candidate_outputs)
    elif case_results and all("candidateOutput" in c for c in case_results):
        candidate_result_fingerprint = digest(
            {c["caseId"]: c["candidateOutput"] for c in case_results}
        )
    else:
        candidate_result_fingerprint = digest(per_case)

    agreed = sum(1 for item in per_case if item["agrees"])
    receipt = {
        "schemaVersion": SCHEMA_VERSION,
        "shadowRunId": shadow_run_id,
        "candidateId": candidate_id,
        "candidateFingerprint": candidate_fingerprint,
        "evaluationSetFingerprint": evaluation_set_fingerprint,
        "activeAuthorityFingerprint": active_authority_fingerprint,
        "comparisons": {
            "caseCount": len(per_case),
            "agreementRate": agreed / len(per_case) if per_case else 0.0,
            "candidateResultFingerprint": candidate_result_fingerprint,
            "perCase": per_case,
        },
        "constraints": dict(CONSTRAINTS),
        "executedAt": executed_at,
    }
    receipt["resultFingerprint"] = digest(receipt)
    validate(receipt, RECEIPT_SCHEMA)
    atomic_write_json(out_path, receipt)
    return receipt
