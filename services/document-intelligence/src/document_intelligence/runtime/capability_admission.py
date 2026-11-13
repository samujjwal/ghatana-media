from __future__ import annotations

from .model_registry import ModelRegistry
from ..errors import WorkerError

_OPERATION_PREFIXES = {
    "parse": ("parser.", "ocr.", "fallback."),
    "extract": ("extraction.",),
    "embed": ("embedding.",),
}


def _legacy_operations(accepted: dict) -> frozenset[str]:
    """Operations implied by a pre-capability-id authority record.

    Frozen Increment-3 records predate capability identifiers, so the
    admitted operation surface is inferred from the fields the authority
    actually declares: media types imply ``parse``, value-type/confidence/
    cardinality declarations imply ``extract``, and a dimension bound implies
    ``embed``.  A record declaring none of these admits no operation.
    """
    allowed: set[str] = set()
    if accepted.get("mediaTypes"):
        allowed.add("parse")
    if accepted.get("supportedValueTypes") or accepted.get("supportsConfidenceScores") or accepted.get("supportsMultipleCardinality"):
        allowed.add("extract")
    if accepted.get("maxDimensions") is not None:
        allowed.add("embed")
    return frozenset(allowed)


class CapabilityAdmission:
    def __init__(self, models: ModelRegistry, enforced: bool) -> None:
        self._models = models
        self._enforced = enforced

    def require(self, provider_ref: str, operation: str, media_type: str | None, language: str | None) -> None:
        if not self._enforced:
            return
        accepted = self._models.accepted_capabilities(provider_ref)
        if accepted is None:
            raise WorkerError("PROVIDER_UNAVAILABLE", provider_ref=provider_ref)
        capability_ids = accepted.get("capabilityIds", [])
        prefixes = _OPERATION_PREFIXES.get(operation, ())
        if not prefixes:
            raise WorkerError("PROVIDER_UNAVAILABLE", provider_ref=provider_ref)
        # An authority record without declared capability identifiers is a
        # legacy Increment-3 record: the operation surface is inferred from the
        # fields the frozen authority declares, not admitted wholesale.  The
        # composed Increment-4A authority always declares ids, so deferred or
        # unqualified leaves stay inadmissible.
        if capability_ids:
            if not any(isinstance(value, str) and value.startswith(prefixes) for value in capability_ids):
                raise WorkerError("PROVIDER_UNAVAILABLE", provider_ref=provider_ref)
        elif operation not in _legacy_operations(accepted):
            raise WorkerError("PROVIDER_UNAVAILABLE", provider_ref=provider_ref)
        if language is not None and language not in accepted.get("languages", []):
            raise WorkerError("UNSUPPORTED_LANGUAGE", provider_ref=provider_ref)
        media_types = accepted.get("mediaTypes", [])
        if media_type is not None and media_types and media_type not in media_types:
            raise WorkerError("PROVIDER_UNAVAILABLE", provider_ref=provider_ref)
