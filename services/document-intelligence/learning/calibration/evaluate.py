"""Confidence-calibration evaluation and candidate emission (I5-13, I5-14).

Given reviewed-truth observations ``{confidence, correct, language?}`` this
module computes a deterministic reliability curve and calibration metrics
(ECE, Brier score, per-language ECE) and emits a
``calibration-candidate.v1`` artifact.

The artifact is CANDIDATE output only — it never mutates the active
authority; activation requires governed promotion.

CLI:

    --observations                  JSONL file of observations
    --parent-authority-fingerprint  sha256:... fingerprint of active authority
    --policy-ref                    calibration policy reference
    --dataset-fingerprint           sha256:... fingerprint of the source dataset
    --algorithm-name / --algorithm-version
    --threshold KEY=VALUE           proposed threshold (repeatable)
    --limitation TEXT               recorded limitation (repeatable)
    --bins N                        reliability-curve bin count (default 10)
    --out                           artifact output path
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "learning"))

from learning.util import atomic_write_json, digest, validate  # noqa: E402

SCHEMA = "calibration-candidate.v1.schema.json"
SCHEMA_VERSION = "document-intelligence.calibration-candidate.v1"
CANDIDATE_ID_DOMAIN = "learning.calibration-candidate-id.v1"


def _check_observation(obs: dict) -> None:
    confidence = obs.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise ValueError(f"observation confidence must be a number: {obs!r}")
    if not 0.0 <= float(confidence) <= 1.0:
        raise ValueError(f"observation confidence out of range: {confidence}")
    if not isinstance(obs.get("correct"), bool):
        raise ValueError(f"observation correct must be a bool: {obs!r}")


def _bin_index(confidence: float, bins: int) -> int:
    # confidence == 1.0 lands in the final bin.
    return min(int(confidence * bins), bins - 1)


def _ece(observations: list[dict], bins: int) -> float:
    """Expected calibration error over ``bins`` equal-width bins."""
    total = len(observations)
    if total == 0:
        return 0.0
    members: list[list[dict]] = [[] for _ in range(bins)]
    for obs in observations:
        members[_bin_index(float(obs["confidence"]), bins)].append(obs)
    ece = 0.0
    for bucket in members:
        if not bucket:
            continue
        mean_confidence = sum(float(o["confidence"]) for o in bucket) / len(bucket)
        empirical = sum(1.0 if o["correct"] else 0.0 for o in bucket) / len(bucket)
        ece += (len(bucket) / total) * abs(mean_confidence - empirical)
    return ece


def evaluate_calibration(observations: list[dict], *, bins: int = 10) -> dict:
    """Reliability curve + calibration metrics for reviewed observations."""
    if bins <= 0:
        raise ValueError("bins must be positive")
    for obs in observations:
        _check_observation(obs)

    width = 1.0 / bins
    members: list[list[dict]] = [[] for _ in range(bins)]
    for obs in observations:
        members[_bin_index(float(obs["confidence"]), bins)].append(obs)

    curve = []
    for index, bucket in enumerate(members):
        count = len(bucket)
        mean_confidence = (
            sum(float(o["confidence"]) for o in bucket) / count if count else 0.0
        )
        empirical = (
            sum(1.0 if o["correct"] else 0.0 for o in bucket) / count if count else 0.0
        )
        curve.append(
            {
                "binLower": index * width,
                "binUpper": (index + 1) * width,
                "count": count,
                "meanConfidence": mean_confidence,
                "empiricalAccuracy": empirical,
            }
        )

    total = len(observations)
    brier = (
        sum(
            (float(o["confidence"]) - (1.0 if o["correct"] else 0.0)) ** 2
            for o in observations
        )
        / total
        if total
        else 0.0
    )

    per_language: dict[str, list[dict]] = {}
    for obs in observations:
        per_language.setdefault(obs.get("language") or "unknown", []).append(obs)

    return {
        "reliabilityCurve": curve,
        "metrics": {
            "expectedCalibrationError": _ece(observations, bins),
            "brierScore": brier,
            "perLanguage": {
                lang: {
                    "expectedCalibrationError": _ece(bucket, bins),
                    "count": len(bucket),
                }
                for lang, bucket in sorted(per_language.items())
            },
        },
    }


def emit_calibration_candidate(
    observations: list[dict],
    *,
    parent_authority_fingerprint: str,
    policy_ref: str,
    dataset_fingerprint: str,
    algorithm: dict,
    candidate_thresholds: dict,
    limitations: list[str],
    out_path: Path,
    bins: int = 10,
) -> dict:
    """Build, validate, and atomically write a calibration-candidate.v1."""
    evaluation = evaluate_calibration(observations, bins=bins)
    parent_authority = {
        "activeAuthorityFingerprint": parent_authority_fingerprint,
        "policyRef": policy_ref,
    }
    candidate_id = digest(
        {
            "domain": CANDIDATE_ID_DOMAIN,
            "kind": "CONFIDENCE_CALIBRATION",
            "parentAuthority": parent_authority,
            "datasetFingerprint": dataset_fingerprint,
            "algorithm": algorithm,
            "candidateThresholds": candidate_thresholds,
        }
    )
    artifact = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": candidate_id,
        "kind": "CONFIDENCE_CALIBRATION",
        "state": "CANDIDATE",
        "parentAuthority": parent_authority,
        "datasetFingerprint": dataset_fingerprint,
        "algorithm": algorithm,
        "candidateThresholds": candidate_thresholds,
        "reliabilityCurve": evaluation["reliabilityCurve"],
        "metrics": evaluation["metrics"],
        "limitations": list(limitations),
    }
    artifact["candidateFingerprint"] = digest(artifact)
    validate(artifact, SCHEMA)
    atomic_write_json(out_path, artifact)
    return artifact


def _parse_threshold(item: str) -> tuple[str, float]:
    key, sep, value = item.partition("=")
    if not sep or not key:
        raise ValueError(f"--threshold expects KEY=VALUE, got {item!r}")
    return key, float(value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--parent-authority-fingerprint", required=True)
    parser.add_argument("--policy-ref", required=True)
    parser.add_argument("--dataset-fingerprint", required=True)
    parser.add_argument("--algorithm-name", required=True)
    parser.add_argument("--algorithm-version", required=True)
    parser.add_argument("--threshold", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--limitation", action="append", default=[])
    parser.add_argument("--bins", type=int, default=10)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    observations = [
        json.loads(line)
        for line in args.observations.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    thresholds = dict(_parse_threshold(item) for item in args.threshold)
    artifact = emit_calibration_candidate(
        observations,
        parent_authority_fingerprint=args.parent_authority_fingerprint,
        policy_ref=args.policy_ref,
        dataset_fingerprint=args.dataset_fingerprint,
        algorithm={"name": args.algorithm_name, "version": args.algorithm_version},
        candidate_thresholds=thresholds,
        limitations=list(args.limitation),
        out_path=args.out,
        bins=args.bins,
    )
    print(
        json.dumps(
            {
                "candidateId": artifact["candidateId"],
                "candidateFingerprint": artifact["candidateFingerprint"],
                "metrics": artifact["metrics"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
