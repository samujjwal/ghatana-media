"""Scanned-PDF page/document classification governed by routing authority.

Increment 6 (I6-03, I6-04): every PDF page is classified from real per-page
facts — ``textLength``, ``imageCount``, ``imageCoverage`` and
``ocrLayerDetected`` — into TEXT_NATIVE, SCANNED, HYBRID or EMPTY, and the
per-page classes aggregate into a document class drawn from TEXT_NATIVE,
SCANNED, HYBRID, EMPTY or MIXED.

All thresholds and routing decisions are loaded from
``routing/scanned-pdf.v1.yaml``; nothing is hardcoded here. The policy's
sha256 fingerprint is carried on every :class:`DocumentClassification` so a
threshold or routing change is visible in every emitted record.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping

from ..errors import WorkerError

WORKER_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_POLICY_PATH = WORKER_ROOT / "routing" / "scanned-pdf.v1.yaml"

SCHEMA_VERSION = "document-intelligence.scanned-pdf.v1"

PAGE_CLASSES = frozenset({"TEXT_NATIVE", "SCANNED", "HYBRID", "EMPTY"})
DOCUMENT_CLASSES = frozenset({"TEXT_NATIVE", "SCANNED", "HYBRID", "EMPTY", "MIXED"})
# Reason codes the classifier may emit; the routing authority must declare at
# least this set so a policy cannot silently drop a decision code.
REASON_CODES = frozenset(
    {"NO_TEXT_LAYER", "IMAGE_DOMINANT", "TEXT_AND_IMAGE", "TEXT_DOMINANT", "EMPTY_PAGE"}
)


def _fraction(section: Mapping[str, Any], field: str) -> float:
    raw = section.get(field)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not 0 < float(raw) <= 1:
        raise ValueError(f"thresholds.{field} must be a fraction in (0, 1]")
    return float(raw)


@dataclass(frozen=True)
class ScannedPdfPolicy:
    """The validated policy surface consumed by the classifier."""

    classifier_ref: str
    text_layer_min_chars: int
    raster_dominance_fraction: float
    hybrid_raster_min_fraction: float
    reason_codes: frozenset[str]
    routing: Mapping[str, Mapping[str, Any]]
    scanned_table_disposition: str
    authority_path: Path
    fingerprint: str


def load_scanned_policy(path: Path | str | None = None) -> ScannedPdfPolicy:
    """Load and validate the scanned-PDF policy from the routing authority."""
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - runtime dependency guard
        raise RuntimeError("PyYAML is required to load scanned-PDF routing authority") from exc

    authority_path = Path(path) if path is not None else DEFAULT_POLICY_PATH
    try:
        raw = authority_path.read_bytes()
    except OSError as exc:
        raise ValueError(f"unable to read scanned-PDF routing authority: {authority_path}") from exc
    document = yaml.safe_load(raw)
    if not isinstance(document, Mapping):
        raise ValueError("scanned-PDF routing authority must be a mapping")
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("scanned-PDF routing authority schemaVersion mismatch")

    classifier_ref = document.get("classifierRef")
    if not isinstance(classifier_ref, str) or not classifier_ref:
        raise ValueError("scanned-PDF routing authority has no classifierRef")

    thresholds = document.get("thresholds")
    if not isinstance(thresholds, Mapping):
        raise ValueError("scanned-PDF routing authority requires thresholds")
    min_chars = thresholds.get("textLayerMinChars")
    if isinstance(min_chars, bool) or not isinstance(min_chars, int) or min_chars < 0:
        raise ValueError("thresholds.textLayerMinChars must be a non-negative integer")
    dominance = _fraction(thresholds, "rasterDominanceFraction")
    hybrid_min = _fraction(thresholds, "hybridRasterMinFraction")
    if hybrid_min > dominance:
        raise ValueError("thresholds.hybridRasterMinFraction must be <= thresholds.rasterDominanceFraction")

    reason_codes = document.get("reasonCodes")
    if (
        not isinstance(reason_codes, list)
        or any(not isinstance(code, str) or not code for code in reason_codes)
        or not REASON_CODES.issubset(reason_codes)
    ):
        raise ValueError("reasonCodes must declare every code the classifier can emit")

    routing = document.get("routing")
    if not isinstance(routing, Mapping) or set(routing) != DOCUMENT_CLASSES:
        raise ValueError("routing must declare a decision for every document class")
    route_table: dict[str, Mapping[str, Any]] = {}
    for document_class, decision in routing.items():
        if not isinstance(decision, Mapping) or not isinstance(decision.get("pipeline"), str):
            raise ValueError(f"routing.{document_class} requires a pipeline")
        route_table[document_class] = dict(decision)

    disposition = document.get("scannedTableDisposition")
    if not isinstance(disposition, str) or not disposition:
        raise ValueError("scannedTableDisposition must be a non-empty string")

    return ScannedPdfPolicy(
        classifier_ref=classifier_ref,
        text_layer_min_chars=min_chars,
        raster_dominance_fraction=dominance,
        hybrid_raster_min_fraction=hybrid_min,
        reason_codes=frozenset(reason_codes),
        routing=route_table,
        scanned_table_disposition=disposition,
        authority_path=authority_path,
        fingerprint="sha256:" + hashlib.sha256(raw).hexdigest(),
    )


@lru_cache(maxsize=1)
def _default_policy() -> ScannedPdfPolicy:
    return load_scanned_policy()


@dataclass(frozen=True)
class PageClassification:
    """One page's class plus the reason code recorded in receipts."""

    classification: str
    reason_code: str
    text_length: int
    image_count: int
    image_coverage: float
    ocr_layer_detected: bool


@dataclass(frozen=True)
class DocumentClassification:
    """Aggregated document class plus classifier/policy provenance."""

    document_class: str
    page_classes: tuple[PageClassification, ...]
    classifier_ref: str
    policy_fingerprint: str
    route: Mapping[str, Any]

    @property
    def provenance(self) -> dict[str, Any]:
        return {
            "pageClasses": [page.classification for page in self.page_classes],
            "classifierRef": self.classifier_ref,
            "policyFingerprint": self.policy_fingerprint,
        }


def _page_facts(page: Mapping[str, Any]) -> tuple[int, int, float, bool]:
    if not isinstance(page, Mapping) or set(page) != {"textLength", "imageCount", "imageCoverage", "ocrLayerDetected"}:
        raise WorkerError("INVALID_REQUEST")
    text_length = page["textLength"]
    image_count = page["imageCount"]
    coverage = page["imageCoverage"]
    ocr_layer = page["ocrLayerDetected"]
    if isinstance(text_length, bool) or not isinstance(text_length, int) or text_length < 0:
        raise WorkerError("INVALID_REQUEST")
    if isinstance(image_count, bool) or not isinstance(image_count, int) or image_count < 0:
        raise WorkerError("INVALID_REQUEST")
    if (
        isinstance(coverage, bool)
        or not isinstance(coverage, (int, float))
        or not math.isfinite(coverage)
        or not 0 <= float(coverage) <= 1
    ):
        raise WorkerError("INVALID_REQUEST")
    if not isinstance(ocr_layer, bool):
        raise WorkerError("INVALID_REQUEST")
    return text_length, image_count, float(coverage), ocr_layer


def classify_page(
    page: Mapping[str, Any], policy: ScannedPdfPolicy | None = None
) -> PageClassification:
    """Classify one page from real facts; thresholds come from the policy."""
    policy = policy or _default_policy()
    text_length, image_count, coverage, ocr_layer = _page_facts(page)
    raster_present = image_count > 0 or coverage > 0.0
    # An injected OCR layer is not a native text layer: when raster content is
    # present the page is fundamentally scanned, whatever the layer contains.
    native_text = text_length >= policy.text_layer_min_chars and not (ocr_layer and raster_present)
    if not raster_present and text_length < policy.text_layer_min_chars:
        classification, reason_code = "EMPTY", "EMPTY_PAGE"
    elif not native_text:
        classification = "SCANNED"
        reason_code = (
            "IMAGE_DOMINANT" if coverage >= policy.raster_dominance_fraction else "NO_TEXT_LAYER"
        )
    elif coverage >= policy.hybrid_raster_min_fraction:
        classification, reason_code = "HYBRID", "TEXT_AND_IMAGE"
    else:
        classification, reason_code = "TEXT_NATIVE", "TEXT_DOMINANT"
    if reason_code not in policy.reason_codes:  # pragma: no cover - policy invariant
        raise WorkerError("INVALID_REQUEST")
    return PageClassification(
        classification=classification,
        reason_code=reason_code,
        text_length=text_length,
        image_count=image_count,
        image_coverage=coverage,
        ocr_layer_detected=ocr_layer,
    )


def classify_document(
    pages: Iterable[Mapping[str, Any]], policy: ScannedPdfPolicy | None = None
) -> DocumentClassification:
    """Aggregate page classes into a document class and routing decision.

    EMPTY pages are non-informative: a document is EMPTY only when no page
    carries usable content; two or more distinct content classes yield MIXED.
    """
    policy = policy or _default_policy()
    if isinstance(pages, (str, bytes)) or not isinstance(pages, Iterable):
        raise WorkerError("INVALID_REQUEST")
    page_classes = tuple(classify_page(page, policy) for page in pages)
    distinct = {page.classification for page in page_classes} - {"EMPTY"}
    if not distinct:
        document_class = "EMPTY"
    elif len(distinct) == 1:
        document_class = next(iter(distinct))
    else:
        document_class = "MIXED"
    return DocumentClassification(
        document_class=document_class,
        page_classes=page_classes,
        classifier_ref=policy.classifier_ref,
        policy_fingerprint=policy.fingerprint,
        route=dict(policy.routing[document_class]),
    )


__all__ = [
    "DEFAULT_POLICY_PATH",
    "DOCUMENT_CLASSES",
    "DocumentClassification",
    "PAGE_CLASSES",
    "PageClassification",
    "REASON_CODES",
    "SCHEMA_VERSION",
    "ScannedPdfPolicy",
    "classify_document",
    "classify_page",
    "load_scanned_policy",
]
