#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LANE = ROOT / "evaluation/increment4a"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_strict_verifier():
    verifier_path = ROOT / "scripts/verify_increment4a.py"
    spec = importlib.util.spec_from_file_location("increment4a_promotion_verifier", verifier_path)
    if spec is None or spec.loader is None:
        raise ValueError("Increment-4A strict verifier is unavailable")
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    verifier.ROOT = ROOT
    verifier.LANE = LANE
    verifier.RESULTS = LANE / "results"
    verifier.CANONICAL_POINTER = LANE / "canonical-run.json"
    verifier.SUPERSEDED_RUNS_PATH = LANE / "superseded-runs.json"
    return verifier


def _require_direct_campaign_origin(summary_path: Path, run_id: str, visited: set[str]) -> None:
    """Require every reuse chain to end at a recorded real campaign run."""
    if run_id in visited or Path(run_id).name != run_id or run_id in {".", ".."}:
        raise ValueError("canonical observation lineage contains an invalid id or cycle")
    visited.add(run_id)
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        lineage = json.loads(summary_path.with_name("lineage.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"run {run_id} is missing readable summary or lineage") from error
    if not isinstance(summary, dict) or not isinstance(lineage, dict):
        raise ValueError(f"run {run_id} has invalid summary or lineage")
    for name in (
        "providerSemanticsFingerprint",
        "evaluationImplementationFingerprint",
        "observationsFingerprint",
        "materialFingerprints",
    ):
        if lineage.get(name) != summary.get(name):
            raise ValueError(f"run {run_id} lineage does not match summary field {name}")

    reuse = summary.get("observationReuse")
    if reuse is None:
        if (
            lineage.get("runId") not in {None, run_id}
            or lineage.get("providerCampaignExecution") != "EXECUTED"
            or lineage.get("providerExecutionReused") is not False
            or lineage.get("observationReuse") is not None
            or lineage.get("rawObservationFingerprints") != summary.get("rawObservationFingerprints")
        ):
            raise ValueError(f"run {run_id} has no authenticated direct provider-campaign lineage")
        return

    source_run_id = reuse.get("observationSourceRunId") if isinstance(reuse, dict) else None
    if (
        not isinstance(source_run_id, str)
        or not source_run_id
        or Path(source_run_id).name != source_run_id
        or source_run_id in {".", ".."}
        or reuse.get("providerExecutionReused") is not True
        or lineage.get("observationReuse") != reuse
    ):
        raise ValueError(f"run {run_id} has invalid observation-reuse lineage")
    child_summary_path = LANE / "results" / source_run_id / "summary.json"
    if reuse.get("sourceSummaryFingerprint") != sha256(child_summary_path):
        raise ValueError(f"run {run_id} does not pin the exact source summary bytes")
    _require_direct_campaign_origin(child_summary_path, source_run_id, visited)


def load_verified_canonical_candidate() -> dict[str, Any]:
    """Load a canonical candidate only after the strict verifier accepts it."""
    pointer_path = LANE / "canonical-run.json"
    try:
        pointer_bytes = pointer_path.read_bytes()
        pointer = json.loads(pointer_bytes)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("canonical Increment-4A pointer is missing or invalid") from error
    if not isinstance(pointer, dict):
        raise ValueError("canonical Increment-4A pointer must be an object")
    run_id = pointer.get("runId")
    if (
        pointer.get("schemaVersion") != "increment4a.canonical-run.v1"
        or pointer.get("state") != "ACTIVE"
        or not isinstance(run_id, str)
        or not run_id
        or Path(run_id).name != run_id
        or run_id in {".", ".."}
    ):
        raise ValueError("canonical run pointer is invalid")

    verifier = _load_strict_verifier()
    strict_results = verifier.evaluation_checks()
    if strict_results != ("PASS", "PASS", "PASS"):
        raise ValueError(f"canonical Increment-4A evidence is not promotable: {strict_results}")
    if verifier.material_lock_status() != "PASS":
        raise ValueError("canonical Increment-4A material lock is stale or not frozen")
    summary_path, summary = verifier.canonical_summary()
    if summary is None or summary_path != LANE / "results" / run_id / "summary.json":
        raise ValueError("canonical Increment-4A summary is not authenticated by its pointer")

    summary_bytes = summary_path.read_bytes()
    summary_fingerprint = hashlib.sha256(summary_bytes).hexdigest()
    capabilities_path = summary_path.with_name("capabilities.json")
    capabilities_bytes = capabilities_path.read_bytes()
    capabilities_fingerprint = hashlib.sha256(capabilities_bytes).hexdigest()
    capabilities = json.loads(capabilities_bytes)
    current_implementation = verifier.implementation_fingerprints()
    expected_pointer_fields = {
        "summaryFingerprint": summary_fingerprint,
        "capabilitiesFingerprint": capabilities_fingerprint,
        "materialFingerprint": summary.get("materialFingerprint"),
        "observationsFingerprint": summary.get("observationsFingerprint"),
        "providerSemanticsFingerprint": summary.get("providerSemanticsFingerprint"),
        "evaluationImplementationFingerprint": summary.get("evaluationImplementationFingerprint"),
    }
    if any(pointer.get(key) != value for key, value in expected_pointer_fields.items()):
        raise ValueError("canonical pointer fingerprints do not match the active summary and capabilities")
    if any(summary.get(key) != value for key, value in current_implementation.items()):
        raise ValueError("canonical summary implementation fingerprints are stale")
    if (
        summary.get("status") != "PASS"
        or summary.get("realProviderEvidence") is not True
        or capabilities.get("qualificationStatus") != "PASS"
        or capabilities.get("promotable") is not True
        or capabilities.get("materialFingerprint") != summary.get("materialFingerprint")
        or not isinstance(capabilities.get("accepted"), list)
    ):
        raise ValueError("canonical qualification is not eligible for promotion")
    provider_fingerprint = current_implementation["providerSemanticsFingerprint"]
    if verifier._source_run_observation_binding_status(
        summary_path,
        provider_fingerprint,
        expected_summary_fingerprint=summary_fingerprint,
    ) != "PASS":
        raise ValueError("canonical summary observation lineage is stale or unbound")
    _require_direct_campaign_origin(summary_path, run_id, set())

    # Refuse a candidate that changed while validation was in progress.
    if (
        pointer_path.read_bytes() != pointer_bytes
        or sha256(summary_path) != summary_fingerprint
        or sha256(capabilities_path) != capabilities_fingerprint
    ):
        raise ValueError("canonical evidence changed during promotion validation")
    return {
        "runId": run_id,
        "pointer": pointer,
        "summary": summary,
        "capabilities": capabilities,
        "summaryFingerprint": summary_fingerprint,
        "capabilitiesFingerprint": capabilities_fingerprint,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "capabilities/increment4a.accepted.json")
    args = parser.parse_args()
    candidate = load_verified_canonical_candidate()
    pointer = candidate["pointer"]
    run_id = candidate["runId"]
    source = candidate["capabilities"]
    accepted = source.get("accepted")
    if not isinstance(accepted, list):
        raise ValueError("canonical accepted capabilities are invalid")
    artifact: dict[str, Any] = {
        "schemaVersion": "increment4a.promoted-capabilities.v1",
        "sourceRunId": run_id,
        "sourceMaterialFingerprint": pointer["materialFingerprint"],
        "sourceCapabilitiesFingerprint": pointer["capabilitiesFingerprint"],
        "sourceSummaryFingerprint": pointer["summaryFingerprint"],
        "sourceObservationsFingerprint": pointer["observationsFingerprint"],
        "sourceProviderSemanticsFingerprint": pointer["providerSemanticsFingerprint"],
        "sourceEvaluationImplementationFingerprint": pointer["evaluationImplementationFingerprint"],
        "sourceObservationReuse": candidate["summary"].get("observationReuse"),
        "qualificationStatus": source.get("qualificationStatus"),
        "promotable": source.get("promotable") is True,
        "accepted": accepted,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
