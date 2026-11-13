"""Pure Increment-4A metrics; provider execution belongs to the worker harness."""
from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable


def _distance(left: list[str], right: list[str]) -> int:
    row = list(range(len(right) + 1))
    for index, source in enumerate(left, 1):
        next_row = [index]
        for column, target in enumerate(right, 1):
            next_row.append(min(next_row[-1] + 1, row[column] + 1, row[column - 1] + (source != target)))
        row = next_row
    return row[-1]


def error_rate(reference: str, actual: str, *, words: bool = False) -> float:
    left = reference.split() if words else list(reference)
    right = actual.split() if words else list(actual)
    return _distance(left, right) / max(len(left), 1)


def cer(reference: str, hypothesis: str) -> float:
    return error_rate(reference, hypothesis)


def wer(reference: str, hypothesis: str) -> float:
    return error_rate(reference, hypothesis, words=True)


def precision_recall_f1(reference: Iterable[str], hypothesis: Iterable[str]) -> dict[str, float]:
    expected = Counter(reference)
    actual = Counter(hypothesis)
    true_positive = sum((expected & actual).values())
    precision = true_positive / max(sum(actual.values()), 1)
    recall = true_positive / max(sum(expected.values()), 1)
    return {"precision": precision, "recall": recall, "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0}


def _iou(left: dict[str, float], right: dict[str, float]) -> float:
    lx = max(left["x"], right["x"])
    ly = max(left["y"], right["y"])
    rx = min(left["x"] + left["width"], right["x"] + right["width"])
    ry = min(left["y"] + left["height"], right["y"] + right["height"])
    intersection = max(0.0, rx - lx) * max(0.0, ry - ly)
    union = left["width"] * left["height"] + right["width"] * right["height"] - intersection
    return intersection / union if union else 0.0


def layout_iou(expected: list[dict[str, float]], actual: list[dict[str, float]]) -> float:
    if not expected:
        return 1.0 if not actual else 0.0
    return sum(max((_iou(region, candidate) for candidate in actual), default=0.0) for region in expected) / len(expected)


def evidence_accuracy(expected: Iterable[tuple], actual: Iterable[tuple]) -> float:
    expected_values = set(expected)
    return len(expected_values & set(actual)) / max(len(expected_values), 1)


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    return ordered[lower] if lower == upper else ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def multiset_accuracy(expected: list[str], actual: list[str]) -> float:
    expected_counts, actual_counts = Counter(expected), Counter(actual)
    return sum((expected_counts & actual_counts).values()) / max(sum(expected_counts.values()), sum(actual_counts.values()), 1)


def aggregate(observations: list[dict]) -> dict[str, float]:
    """Aggregate normalized, evidence-bearing observations without inventing missing values."""
    successful = [
        item for item in observations
        if item.get("error") is None
        and item.get("skipped") is not True
        and item.get("status") != "NOT_RUN"
    ]
    metrics: dict[str, float] = {}
    text = [item for item in successful if isinstance(item.get("expectedText"), str) and isinstance(item.get("actualText"), str)]
    if text:
        metrics["text.cer"] = mean([error_rate(item["expectedText"], item["actualText"]) for item in text])
        metrics["text.wer"] = mean([error_rate(item["expectedText"], item["actualText"], words=True) for item in text])
    for key, output in (("layoutIoU", "layout.iou"), ("structureAccuracy", "office.structureAccuracy")):
        values = [float(item[key]) for item in successful if isinstance(item.get(key), (int, float))]
        if values:
            metrics[output] = mean(values)
    language = [item for item in successful if item.get("expectedLanguage") is not None and item.get("actualLanguage") is not None]
    if language:
        metrics["language.accuracy"] = mean([float(item["expectedLanguage"] == item["actualLanguage"]) for item in language])
    executed = [item for item in observations if item.get("skipped") is not True and item.get("status") != "NOT_RUN"]
    eligible = [item for item in executed if item.get("fallbackEligible") is True]
    ineligible = [item for item in executed if item.get("fallbackEligible") is False]
    if eligible:
        metrics["fallback.eligibleAccuracy"] = mean([float(item.get("fallbackAttempted") is True) for item in eligible])
        metrics["fallback.successRate"] = mean([float(item.get("fallbackSucceeded") is True) for item in eligible])
    if ineligible:
        metrics["fallback.ineligibleRejectionRate"] = mean([float(item.get("fallbackAttempted") is not True) for item in ineligible])
    latency = [float(item["latencyMs"]) for item in executed if isinstance(item.get("latencyMs"), (int, float))]
    memory = [float(item["peakRssDeltaMb"]) for item in executed if isinstance(item.get("peakRssDeltaMb"), (int, float))]
    cancellation = [float(item["cancellationCheckMs"]) for item in executed if isinstance(item.get("cancellationCheckMs"), (int, float))]
    if latency:
        metrics["runtime.p95LatencyMs"] = percentile(latency, 0.95)
    if memory:
        metrics["runtime.peakRssDeltaMb"] = max(memory)
    if cancellation:
        metrics["runtime.cancellationCheckMs"] = max(cancellation)
    return metrics
