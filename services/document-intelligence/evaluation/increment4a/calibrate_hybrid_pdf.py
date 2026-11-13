#!/usr/bin/env python3
"""Produce the Increment-4A hybrid-PDF calibration artifact from canonical
campaign observations.

Reads the observed per-page classifications recorded inside the raw
observations (``quality.warnings`` carries the strategy's own
``pageClassifications`` payload) plus the calibration fixture expectations, and
emits ``calibration/hybrid-pdf-calibration.json`` with the measured confusion
matrix, deduplication error rates, and the thresholds selected in the frozen
routing authority.  Nothing is invented: fixtures absent from the canonical
observation set are recorded as missing rather than assumed correct.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
LANE = ROOT / "evaluation" / "increment4a"
OBSERVATIONS = LANE / "results" / "zz-canonical" / "observations.json"
GROUND_TRUTH = LANE / "corpus" / "qualification" / "hybrid-pdf" / "ground_truth.json"
CALIBRATION_FIXTURES = LANE / "corpus" / "calibration" / "hybrid-pdf" / "fixtures.yaml"
ROUTING = ROOT / "routing" / "hybrid-pdf.v1.yaml"
OUTPUT = LANE / "calibration" / "hybrid-pdf-calibration.json"

CLASSES = ("NATIVE", "SCANNED", "MIXED", "BLANK")


def _observed_classifications(observation: dict) -> list[str]:
    warnings = ((observation.get("rawObservation") or {}).get("quality") or {}).get("warnings") or []
    for warning in warnings:
        if not isinstance(warning, str) or not warning.startswith("pageClassifications:"):
            continue
        payload = json.loads(warning.partition(":")[2])
        return [str(item.get("classification", "")) for item in payload if isinstance(item, dict)]
    return []


def main() -> int:
    observations = {item["fixtureId"]: item for item in json.loads(OBSERVATIONS.read_text()) if isinstance(item, dict)}
    truth = json.loads(GROUND_TRUTH.read_text())
    declared = yaml.safe_load(CALIBRATION_FIXTURES.read_text())
    routing = yaml.safe_load(ROUTING.read_text())
    policy = routing["classification"]
    dedup_policy = routing["deduplication"]

    fixture_ids = list(declared["fixtures"])
    matrix = {expected: {observed: 0 for observed in CLASSES + ("MISSING",)} for expected in CLASSES}
    missing: list[str] = []
    for fixture_id in fixture_ids:
        expected_pages = truth.get(fixture_id, {}).get("pages", [])
        observed = _observed_classifications(observations.get(fixture_id, {}))
        if not observed:
            missing.append(fixture_id)
        for index, page in enumerate(expected_pages):
            expected = page.get("classification", "BLANK")
            actual = observed[index] if index < len(observed) else "MISSING"
            matrix.setdefault(expected, {observed: 0 for observed in CLASSES + ("MISSING",)})
            matrix[expected][actual if actual in CLASSES else "MISSING"] += 1

    # Deduplication truth: HYBRID-012 declares a heading the rasterized copy
    # must not duplicate plus a unique line that must survive suppression.
    dedup_obs = observations.get("HYBRID-012", {})
    actual_text = str(dedup_obs.get("actualText", ""))
    duplicate = "Repeated heading text"
    unique = "Unique"
    dedup_truth = truth.get("HYBRID-012", {})
    deduplicated = dedup_truth.get("deduplicatedText", duplicate)
    occurrences = actual_text.count(duplicate)
    # False positive: the unique OCR line was suppressed alongside the copy.
    false_positives = 1 if unique not in actual_text else 0
    # False negative: the duplicated heading survived in both lanes.
    false_negatives = max(0, occurrences - 1)
    total_candidates = 2
    deduplication = {
        "falsePositiveRate": false_positives / total_candidates,
        "falseNegativeRate": false_negatives / total_candidates,
        "duplicateOccurrences": occurrences,
        "deduplicatedTextPresent": deduplicated in actual_text,
    }

    artifact = {
        "schemaVersion": "increment4a.hybrid-pdf-calibration.v1",
        "status": "COMPLETE" if not missing else "CALIBRATION_REQUIRED",
        "inputCorpus": "corpus/calibration/hybrid-pdf/fixtures.yaml",
        "evidenceSource": "evaluation/increment4a/results/zz-canonical/observations.json",
        "selectedThresholds": {
            "nativeTextCharacters": policy["minimumTextCharacters"],
            "ocrImageAreaFraction": policy["ocrImageAreaFraction"],
            "textSimilarity": dedup_policy["textSimilarity"],
            "bboxOverlap": dedup_policy["bboxOverlap"],
        },
        "classificationConfusionMatrix": matrix,
        "deduplication": deduplication,
        "missingFixtures": missing,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"output": str(OUTPUT), "status": artifact["status"], "missing": missing}))
    return 0 if artifact["status"] == "COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main())
