"""Review-priority scoring for the active-learning queue (I5-19).

``score_review`` converts a review summary (reason codes plus per-field
observations) into a governed priority record. The score only ranks human
review order — it never auto-labels and never changes product results.
"""
from __future__ import annotations

from typing import Any

# Component weights must sum to 1.0; the order below is also the canonical
# emission order for reasonCodes (matches the schema enum order).
WEIGHTS = {
    "lowConfidence": 0.35,
    "ambiguity": 0.20,
    "providerDisagreement": 0.15,
    "novelTemplateDistance": 0.15,
    "errorProneField": 0.15,
}

REASON_FOR_COMPONENT = {
    "lowConfidence": "LOW_CONFIDENCE",
    "ambiguity": "TEMPLATE_AMBIGUITY",
    "providerDisagreement": "PROVIDER_DISAGREEMENT",
    "novelTemplateDistance": "NOVEL_TEMPLATE_DISTANCE",
    "errorProneField": "HISTORICALLY_ERROR_PRONE_FIELD",
}

# A component contributes a reason code when its value strictly exceeds this.
FIRES_ABOVE = {
    "lowConfidence": 0.5,
    "ambiguity": 0.0,
    "providerDisagreement": 0.0,
    "novelTemplateDistance": 0.5,
    "errorProneField": 0.0,
}


def score_review(review: dict, *, policy: dict | None = None) -> dict:
    """Score one review for queue priority.

    ``review`` shape::

        {"reasons": [ReviewReasonCode, ...],
         "fields": [{"fieldId": str, "confidence": float|None, "status": str}],
         "providerDisagreement": bool,            # optional
         "novelTemplateDistance": float}          # optional

    ``policy`` may declare ``errorProneFields`` — fieldIds with historically
    high correction rates. Returns ``{reasonCodes, scoreComponents, priority}``
    ready to embed in an active-learning-entry.v1 record.
    """
    policy = policy or {}
    reasons = set(review.get("reasons", []))
    fields = review.get("fields", [])

    confidences = [
        float(f["confidence"])
        for f in fields
        if isinstance(f.get("confidence"), (int, float))
        and not isinstance(f.get("confidence"), bool)
    ]
    if confidences:
        low_confidence = 1.0 - min(confidences)
    else:
        low_confidence = 1.0 if "REQUIRED_FIELD_LOW_CONFIDENCE" in reasons else 0.0

    if "TEMPLATE_AMBIGUOUS" in reasons:
        ambiguity = 1.0
    elif "TEMPLATE_UNMATCHED" in reasons:
        ambiguity = 0.5
    else:
        ambiguity = 0.0

    provider_disagreement = 1.0 if review.get("providerDisagreement") else 0.0
    novel_template_distance = float(review.get("novelTemplateDistance") or 0.0)

    error_prone = set(policy.get("errorProneFields", []))
    if fields:
        error_prone_field = sum(1 for f in fields if f.get("fieldId") in error_prone) / len(
            fields
        )
    else:
        error_prone_field = 0.0

    components: dict[str, Any] = {
        "lowConfidence": low_confidence,
        "ambiguity": ambiguity,
        "providerDisagreement": provider_disagreement,
        "novelTemplateDistance": novel_template_distance,
        "errorProneField": error_prone_field,
    }
    priority = sum(WEIGHTS[name] * value for name, value in components.items())

    reason_codes = [
        REASON_FOR_COMPONENT[name]
        for name, value in components.items()
        if value > FIRES_ABOVE[name]
    ]
    if not reason_codes:
        # Entries require at least one reason code: attribute the dominant
        # component (highest weighted contribution; ties resolve to the first
        # in canonical order, so an all-zero review defaults to LOW_CONFIDENCE).
        dominant = max(components, key=lambda n: WEIGHTS[n] * components[n])
        reason_codes = [REASON_FOR_COMPONENT[dominant]]

    return {
        "reasonCodes": reason_codes,
        "scoreComponents": components,
        "priority": priority,
    }
