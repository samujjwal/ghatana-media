from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable


def _edit_distance(left: list[str], right: list[str]) -> int:
    row = list(range(len(right) + 1))
    for i, source in enumerate(left, 1):
        next_row = [i]
        for j, target in enumerate(right, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (source != target)))
        row = next_row
    return row[-1]


def cer(reference: str, hypothesis: str) -> float:
    ref = list(reference)
    return _edit_distance(ref, list(hypothesis)) / max(len(ref), 1)


def wer(reference: str, hypothesis: str) -> float:
    ref = reference.split()
    return _edit_distance(ref, hypothesis.split()) / max(len(ref), 1)


def iou(left: dict[str, float], right: dict[str, float]) -> float:
    lx = max(left["x"], right["x"])
    ly = max(left["y"], right["y"])
    rx = min(left["x"] + left["width"], right["x"] + right["width"])
    ry = min(left["y"] + left["height"], right["y"] + right["height"])
    intersection = max(0.0, rx - lx) * max(0.0, ry - ly)
    union = left["width"] * left["height"] + right["width"] * right["height"] - intersection
    return intersection / union if union else 0.0


def precision_recall_f1(reference: Iterable[str], hypothesis: Iterable[str]) -> dict[str, float]:
    expected = Counter(reference)
    actual = Counter(hypothesis)
    true_positive = sum((expected & actual).values())
    precision = true_positive / max(sum(actual.values()), 1)
    recall = true_positive / max(sum(expected.values()), 1)
    return {"precision": precision, "recall": recall, "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0}


def entity_f1(reference: Iterable[str], hypothesis: Iterable[str]) -> float:
    """Entity F1 used for GLiNER extraction evaluation.

    Values are normalized entity labels/values (e.g., ``document_number::INV-1001``).
    """
    return precision_recall_f1(reference, hypothesis)["f1"]


def recall_at_k(rankings: list[list[str]], expected: list[str], k: int) -> float:
    if not expected:
        return 1.0
    return sum(bool(set(ranking[:k]) & set(expected)) for ranking in rankings) / len(expected)


def cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left or any(not math.isfinite(value) for value in [*left, *right]):
        raise ValueError("embedding dimensions or values are invalid")
    numerator = sum(a * b for a, b in zip(left, right))
    denominator = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
    return numerator / denominator if denominator else 0.0


def layout_iou(expected: list[dict[str, float]], actual: list[dict[str, float]]) -> float:
    """Mean best IoU for each expected region against any actual region.

    This is a strict per-region overlap metric suitable for acceptance thresholds.
    """
    if not expected:
        return 1.0 if not actual else 0.0
    scores = []
    for region in expected:
        best = max((iou(region, candidate) for candidate in actual), default=0.0)
        scores.append(best)
    return sum(scores) / len(scores)


def layout_metrics(expected: list[dict[str, float]], actual: list[dict[str, float]], threshold: float = 0.5) -> dict[str, float]:
    """Greedy one-to-one region matching with the frozen IoU threshold."""
    remaining = list(actual)
    matches = 0
    agreements = []
    for region in expected:
        candidate = max(remaining, key=lambda item: iou(region, item), default=None)
        score = iou(region, candidate) if candidate is not None else 0.0
        if candidate is not None and score >= threshold:
            remaining.remove(candidate)
            matches += 1
            agreements.append(score)
    return {
        "regionPrecision": matches / max(len(actual), 1),
        "regionRecall": matches / max(len(expected), 1),
        "boundingBoxAgreement": sum(agreements) / max(len(agreements), 1),
        "readingOrderCorrectness": 1.0 if len(expected) == len(actual) and matches == len(expected) else matches / max(len(expected), 1),
    }


def table_structure_accuracy(expected: list[dict[str, int]], actual: list[dict[str, int]]) -> float:
    pairs = zip(expected, actual)
    correct = sum(left.get("rows") == right.get("rows") and left.get("columns") == right.get("columns") for left, right in pairs)
    return correct / max(len(expected), len(actual), 1)


def table_cell_metrics(expected: list[dict], actual: list[dict]) -> dict[str, float]:
    """Docling table cell metrics: text accuracy, coordinate agreement, and structure.

    ``expected``/``actual`` entries carry ``rowIndex``, ``columnIndex``, ``text``
    and optionally ``boundingRegion``. Metrics are positional: an expected cell is
    matched by its (row, column) coordinate before text/geometry are compared.
    """
    if not expected:
        empty = 1.0 if not actual else 0.0
        return {"cellTextAccuracy": empty, "cellCoordinateAgreement": empty, "cellStructureAccuracy": empty}
    actual_by_position = {
        (cell.get("rowIndex"), cell.get("columnIndex")): cell
        for cell in actual
        if isinstance(cell.get("rowIndex"), int) and isinstance(cell.get("columnIndex"), int)
    }
    text_matches = 0
    structure_matches = 0
    agreements: list[float] = []
    for cell in expected:
        candidate = actual_by_position.get((cell.get("rowIndex"), cell.get("columnIndex")))
        if candidate is None:
            continue
        structure_matches += 1
        if candidate.get("text") == cell.get("text"):
            text_matches += 1
        expected_box = cell.get("boundingRegion")
        actual_box = candidate.get("boundingRegion")
        if isinstance(expected_box, dict) and isinstance(actual_box, dict):
            agreements.append(iou(expected_box, actual_box))
    return {
        "cellTextAccuracy": text_matches / len(expected),
        "cellCoordinateAgreement": sum(agreements) / len(agreements) if agreements else 0.0,
        "cellStructureAccuracy": structure_matches / len(expected),
    }


def evidence_accuracy(expected: Iterable[tuple], actual: Iterable[tuple]) -> float:
    """Overlap between expected and actual evidence descriptors.

    Each descriptor is an arbitrary hashable tuple, typically including
    ``(lineId, start, end)``.
    """
    expected_values = set(expected)
    actual_values = set(actual)
    return len(expected_values & actual_values) / max(len(expected_values), 1)


def embedding_stability(vectors: Iterable[list[float]]) -> float:
    values = list(vectors)
    if not values:
        return 1.0
    baseline = values[0]
    return sum(cosine(baseline, value) >= 0.999999 for value in values) / len(values)
