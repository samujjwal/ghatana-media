"""Operational-run continuity authority for load, soak, and chaos evidence."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping


class ContinuityError(ValueError):
    pass


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise ContinuityError(f"{field} must be an ISO-8601 timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContinuityError(f"{field} is not a valid timestamp") from exc


def validate_operational_run(run: Mapping[str, Any], *, expected_run_id: str | None = None) -> dict[str, Any]:
    """Validate one immutable measurement interval.

    An interrupted run remains one run only when its continuity is explicitly
    recorded.  This function intentionally does not infer continuity from two
    adjacent files or from matching material fingerprints.
    """

    required = {"runId", "startedAt", "completedAt", "workerGeneration", "materialFingerprint", "interruptions", "measurementContinuity", "continuationPolicy"}
    if set(run) != required:
        raise ContinuityError("operational run must declare its complete continuity envelope")
    run_id = run["runId"]
    if not isinstance(run_id, str) or not run_id or (expected_run_id is not None and run_id != expected_run_id):
        raise ContinuityError("operational run id is not bound to the evidence run")
    started = _timestamp(run["startedAt"], "startedAt")
    completed = _timestamp(run["completedAt"], "completedAt")
    if completed <= started:
        raise ContinuityError("operational run must have a positive interval")
    if not isinstance(run["workerGeneration"], str) or not run["workerGeneration"]:
        raise ContinuityError("workerGeneration is required")
    material = run["materialFingerprint"]
    if not isinstance(material, str) or len(material) != 64 or any(char not in "0123456789abcdef" for char in material):
        raise ContinuityError("materialFingerprint must be a SHA-256 hex digest")
    interruptions = run["interruptions"]
    if not isinstance(interruptions, list):
        raise ContinuityError("interruptions must be a list")
    previous_end: datetime | None = None
    for interruption in interruptions:
        if not isinstance(interruption, Mapping) or set(interruption) != {"startedAt", "completedAt", "reason"}:
            raise ContinuityError("interruption records must declare interval and reason")
        interruption_start = _timestamp(interruption["startedAt"], "interruption.startedAt")
        interruption_end = _timestamp(interruption["completedAt"], "interruption.completedAt")
        if interruption_end <= interruption_start or interruption_start < started or interruption_end > completed:
            raise ContinuityError("interruption falls outside the operational run")
        if previous_end is not None and interruption_start < previous_end:
            raise ContinuityError("interruption intervals overlap or are unordered")
        if not isinstance(interruption["reason"], str) or not interruption["reason"]:
            raise ContinuityError("interruption reason is required")
        previous_end = interruption_end
    if run["measurementContinuity"] is not True:
        raise ContinuityError("only a continuous measurement interval may be accepted")
    if run["continuationPolicy"] not in {"SINGLE_INTERVAL", "CHECKPOINT_AUTHORIZED"}:
        raise ContinuityError("unknown operational continuation policy")
    return dict(run)


def combine_segments(segments: list[Mapping[str, Any]], *, checkpoint_authorized: bool) -> dict[str, Any]:
    """Combine segments only under explicit checkpoint authority.

    The segments must carry the same worker generation and material identity;
    otherwise the result is a new measurement, never a stitched continuation.
    """

    if not segments:
        raise ContinuityError("at least one operational segment is required")
    if not checkpoint_authorized:
        raise ContinuityError("interrupted segments require checkpoint authorization")
    ordered = sorted((dict(segment) for segment in segments), key=lambda item: item.get("startedAt", ""))
    first = validate_operational_run(ordered[0])
    worker_generation = first["workerGeneration"]
    material = first["materialFingerprint"]
    interruptions: list[dict[str, str]] = list(first["interruptions"])
    for previous, current in zip(ordered, ordered[1:]):
        if current.get("workerGeneration") != worker_generation or current.get("materialFingerprint") != material:
            raise ContinuityError("segments do not share worker generation and material identity")
        previous_end = _timestamp(previous["completedAt"], "completedAt")
        current_start = _timestamp(current["startedAt"], "startedAt")
        if current_start < previous_end:
            raise ContinuityError("operational segments overlap")
        interruptions.extend(current.get("interruptions", []))
        interruptions.append({"startedAt": previous["completedAt"], "completedAt": current["startedAt"], "reason": "CHECKPOINT_CONTINUATION"})
        validate_operational_run(current)
    combined = {
        "runId": first["runId"],
        "startedAt": first["startedAt"],
        "completedAt": ordered[-1]["completedAt"],
        "workerGeneration": worker_generation,
        "materialFingerprint": material,
        "interruptions": interruptions,
        "measurementContinuity": True,
        "continuationPolicy": "CHECKPOINT_AUTHORIZED",
    }
    return validate_operational_run(combined)


__all__ = ["ContinuityError", "combine_segments", "validate_operational_run"]
