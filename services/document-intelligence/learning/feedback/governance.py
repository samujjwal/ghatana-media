"""Deterministic governance checks for learning feedback (I5-45/I5-46).

Feedback is an untrusted boundary.  A reviewed result can be useful for
learning only after its reviewer authority, correction lineage, and bounded
content have been checked.  This module deliberately returns digests and
reason codes only; it never includes corrected values in a quarantine or
audit record.

The functions are pure so product-side projectors and the file-backed worker
authority can apply the same decision without sharing mutable state.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Mapping, Sequence

from ..util import canonical_json, digest


MAX_CORRECTIONS = 128
MAX_VALUE_BYTES = 8 * 1024
MAX_VALUE_DEPTH = 8


@dataclass(frozen=True)
class GovernanceVerdict:
    state: str  # ELIGIBLE | QUARANTINED | EXCLUDED
    reason_codes: tuple[str, ...]
    reviewer_fingerprint: str | None = None

    @property
    def eligible(self) -> bool:
        return self.state == "ELIGIBLE"

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "reasonCodes": list(self.reason_codes),
            **(
                {"reviewerFingerprint": self.reviewer_fingerprint}
                if self.reviewer_fingerprint
                else {}
            ),
        }


def _reviewer_authority(review: Mapping[str, Any]) -> Mapping[str, Any] | None:
    value = review.get("reviewerAuthority")
    if value is None:
        # ``reviewer`` was used by an early candidate producer.  Accepting it
        # here makes the boundary additive while the v2 schema remains the
        # canonical spelling.
        value = review.get("reviewer")
    return value if isinstance(value, Mapping) else None


def reviewer_verdict(review: Mapping[str, Any]) -> tuple[bool, tuple[str, ...], str | None]:
    """Check optional reviewer authority and revision binding.

    Legacy v1 events have no reviewer block because the product-side review
    authority is external; those events remain structurally valid.  Once a
    reviewer block is present, all authority fields are mandatory and the
    declared review/correction revisions must match the review itself.
    """
    authority = _reviewer_authority(review)
    if authority is None:
        return True, (), None
    required = ("reviewerRef", "authorizationClass", "authorizationRef")
    if any(not isinstance(authority.get(key), str) or not authority[key] for key in required):
        return False, ("REVIEWER_AUTHORITY_INCOMPLETE",), None
    if authority.get("authorizationClass", "").upper() in {
        "UNAUTHORIZED",
        "UNTRUSTED",
        "REVOKED",
        "DISABLED",
    }:
        return False, ("REVIEWER_UNAUTHORIZED",), digest(dict(authority))
    for key in ("reviewRevision", "correctionRevision"):
        declared = authority.get(key)
        if declared is not None and declared != review.get(key):
            return False, (f"{key.upper()}_MISMATCH",), digest(dict(authority))
    return True, (), digest(dict(authority))


def resolve_conflicting_reviews(reviews: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Resolve a review set without using timestamps as authority.

    A higher explicit authority rank wins, then review revision, then
    correction revision.  Equal-ranked contradictory decisions are
    quarantined.  ``reviewId`` is only a final deterministic tie-breaker when
    decisions are identical; it can never make a conflicting decision win.
    """
    if not reviews:
        return {"state": "QUARANTINED", "reasonCode": "NO_REVIEW"}
    rows: list[dict[str, Any]] = []
    for review in reviews:
        valid, reasons, reviewer_fp = reviewer_verdict(review)
        if not valid:
            return {
                "state": "QUARANTINED",
                "reasonCode": reasons[0],
                **({"reviewerFingerprint": reviewer_fp} if reviewer_fp else {}),
            }
        authority = _reviewer_authority(review) or {}
        rank = authority.get("authorityRank", review.get("authorityRank", 0))
        if isinstance(rank, bool) or not isinstance(rank, (int, float)):
            return {"state": "QUARANTINED", "reasonCode": "INVALID_AUTHORITY_RANK"}
        rows.append(
            {
                "review": review,
                "rank": float(rank),
                "reviewRevision": int(review.get("reviewRevision", 0)),
                "correctionRevision": int(review.get("correctionRevision", 0)),
                "reviewerFingerprint": reviewer_fp,
            }
        )
    rows.sort(
        key=lambda row: (
            -row["rank"],
            -row["reviewRevision"],
            -row["correctionRevision"],
            str(row["review"].get("reviewId", "")),
        )
    )
    winner = rows[0]
    winner_key = (winner["rank"], winner["reviewRevision"], winner["correctionRevision"])
    tied = [row for row in rows if (row["rank"], row["reviewRevision"], row["correctionRevision"]) == winner_key]
    decisions = {
        canonical_json(
            {
                "status": row["review"].get("status"),
                "terminalAction": row["review"].get("terminalAction"),
                "corrections": row["review"].get("corrections", []),
            }
        )
        for row in tied
    }
    if len(decisions) > 1:
        return {
            "state": "QUARANTINED",
            "reasonCode": "CONFLICTING_REVIEWS",
            "reviewerFingerprints": sorted(
                row["reviewerFingerprint"] for row in tied if row["reviewerFingerprint"]
            ),
        }
    review = winner["review"]
    return {
        "state": "RESOLVED",
        "selectedReviewRef": review.get("reviewId"),
        "authorityRank": winner["rank"],
        "reviewerFingerprint": winner["reviewerFingerprint"],
    }


def _bounded_value(value: Any, *, depth: int = 0) -> tuple[bool, str | None]:
    if depth > MAX_VALUE_DEPTH:
        return False, "CORRECTION_VALUE_TOO_DEEP"
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_VALUE_BYTES:
            return False, "CORRECTION_VALUE_TOO_LARGE"
        if any(ord(char) < 32 and char not in "\t\n\r" for char in value):
            return False, "CORRECTION_VALUE_CONTROL_CHARACTER"
        return True, None
    if isinstance(value, (str, int, float, bool)) or value is None:
        return True, None
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str) or len(key.encode("utf-8")) > 512:
                return False, "CORRECTION_KEY_INVALID"
            valid, reason = _bounded_value(child, depth=depth + 1)
            if not valid:
                return False, reason
        return True, None
    if isinstance(value, (list, tuple)):
        if len(value) > MAX_CORRECTIONS:
            return False, "CORRECTION_VALUE_TOO_MANY_ITEMS"
        for child in value:
            valid, reason = _bounded_value(child, depth=depth + 1)
            if not valid:
                return False, reason
        return True, None
    return False, "CORRECTION_VALUE_TYPE_UNSUPPORTED"


def poisoning_reasons(event: Mapping[str, Any]) -> tuple[str, ...]:
    """Return bounded, non-sensitive quarantine reasons for one event."""
    review = event.get("review")
    if not isinstance(review, Mapping):
        return ("REVIEW_MISSING",)
    valid, reasons, _ = reviewer_verdict(review)
    if not valid:
        return reasons
    corrections = review.get("corrections", [])
    if not isinstance(corrections, list) or len(corrections) > MAX_CORRECTIONS:
        return ("CORRECTION_BULK_LIMIT",)
    seen_ids: set[str] = set()
    for correction in corrections:
        if not isinstance(correction, Mapping):
            return ("CORRECTION_SHAPE_INVALID",)
        correction_id = correction.get("correctionId")
        if not isinstance(correction_id, str) or not correction_id or correction_id in seen_ids:
            return ("CORRECTION_ID_INVALID",)
        seen_ids.add(correction_id)
        target = correction.get("target")
        if not isinstance(target, Mapping) or not isinstance(target.get("fieldId"), str) or not target["fieldId"]:
            return ("CORRECTION_TARGET_INVALID",)
        valid, reason = _bounded_value(correction.get("correctedValue"))
        if not valid:
            return (reason or "CORRECTION_VALUE_INVALID",)
    return ()


def assess_event(event: Mapping[str, Any]) -> GovernanceVerdict:
    """Return the learning disposition for an immutable feedback event."""
    reasons = poisoning_reasons(event)
    review = event.get("review")
    if not isinstance(review, Mapping):
        return GovernanceVerdict("QUARANTINED", reasons)
    conflict = review.get("conflictResolution")
    if isinstance(conflict, Mapping) and conflict.get("state") == "QUARANTINED":
        reasons = (*reasons, str(conflict.get("reasonCode") or "CONFLICTING_REVIEWS"))
    poisoning = review.get("poisoningAssessment")
    if isinstance(poisoning, Mapping) and poisoning.get("state") == "QUARANTINED":
        reasons = (*reasons, str(poisoning.get("reasonCode") or "POISONING_ASSESSMENT"))
    if reasons:
        return GovernanceVerdict("QUARANTINED", tuple(dict.fromkeys(reasons)))
    if event.get("eligibility", {}).get("state") != "ACCEPTED":
        return GovernanceVerdict("EXCLUDED", (f"ELIGIBILITY_{event.get('eligibility', {}).get('state', 'UNKNOWN')}",))
    _, _, reviewer_fp = reviewer_verdict(review)
    return GovernanceVerdict("ELIGIBLE", (), reviewer_fp)


def safe_event_digest(event: Mapping[str, Any]) -> str:
    """Digest an event for audit/queue references without exposing content."""
    return "sha256:" + sha256(canonical_json(dict(event)).encode("utf-8")).hexdigest()
