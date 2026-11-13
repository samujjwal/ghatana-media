from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.errors import WorkerError  # noqa: E402
from document_intelligence.scanned import (  # noqa: E402
    classify_document,
    classify_page,
    load_scanned_policy,
    provenance_record,
)

POLICY_PATH = ROOT / "routing/scanned-pdf.v1.yaml"
CAPABILITIES = ROOT / "capabilities/document-intelligence-capabilities.yaml"
FALLBACK_CONTRACT = ROOT / "routing/fallback-contract.v1.yaml"


def _page(
    text_length: int = 0,
    image_count: int = 0,
    coverage: float = 0.0,
    ocr: bool = False,
) -> dict:
    return {
        "textLength": text_length,
        "imageCount": image_count,
        "imageCoverage": coverage,
        "ocrLayerDetected": ocr,
    }


def _mutated_policy(tmp_path: Path, mutate) -> Path:
    document = yaml.safe_load(POLICY_PATH.read_text(encoding="utf-8"))
    mutate(document)
    path = tmp_path / "scanned-pdf.v1.yaml"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return path


# ---- page classification (I6-03) ----


def test_classify_text_native_page() -> None:
    result = classify_page(_page(text_length=500))
    assert result.classification == "TEXT_NATIVE"
    assert result.reason_code == "TEXT_DOMINANT"
    # Decorative raster below the hybrid floor does not change the class.
    assert classify_page(_page(text_length=500, image_count=1, coverage=0.01)).classification == "TEXT_NATIVE"


def test_classify_scanned_page() -> None:
    result = classify_page(_page(image_count=1, coverage=0.95))
    assert result.classification == "SCANNED"
    assert result.reason_code == "IMAGE_DOMINANT"


def test_classify_scanned_page_with_sparse_text_layer() -> None:
    # A scanned page may carry a sparse text layer below the usable minimum.
    result = classify_page(_page(text_length=5, image_count=1, coverage=0.2))
    assert result.classification == "SCANNED"
    assert result.reason_code == "NO_TEXT_LAYER"


def test_classify_hybrid_page() -> None:
    result = classify_page(_page(text_length=500, image_count=1, coverage=0.3))
    assert result.classification == "HYBRID"
    assert result.reason_code == "TEXT_AND_IMAGE"
    # A usable text layer plus dominant raster is still HYBRID, not SCANNED.
    assert classify_page(_page(text_length=500, image_count=1, coverage=0.9)).classification == "HYBRID"


def test_classify_empty_page() -> None:
    result = classify_page(_page())
    assert result.classification == "EMPTY"
    assert result.reason_code == "EMPTY_PAGE"


def test_ocr_layer_is_not_native_text() -> None:
    # An injected OCR layer over raster is still a scanned page.
    result = classify_page(_page(text_length=400, image_count=1, coverage=0.9, ocr=True))
    assert result.classification == "SCANNED"


@pytest.mark.parametrize(
    "page",
    [
        _page(text_length=-1),
        _page(image_count=-1),
        _page(coverage=1.5),
        _page(coverage=float("nan")),
        _page(ocr="yes"),
        {"textLength": 10, "imageCount": 0, "imageCoverage": 0.0},  # missing key
        _page(text_length="long"),
    ],
)
def test_malformed_page_facts_are_rejected(page: dict) -> None:
    with pytest.raises(WorkerError) as error:
        classify_page(page)
    assert error.value.code == "INVALID_REQUEST"


def test_thresholds_come_from_policy_not_code(tmp_path: Path) -> None:
    policy = load_scanned_policy(
        _mutated_policy(
            tmp_path,
            lambda doc: doc["thresholds"].update(
                {
                    "textLayerMinChars": 3,
                    "rasterDominanceFraction": 0.95,
                    "hybridRasterMinFraction": 0.9,
                }
            ),
        )
    )
    # 10 chars is below the shipped minimum but above the mutated one.
    assert classify_page(_page(text_length=10), policy).classification == "TEXT_NATIVE"
    # 0.5 coverage is significant under shipped policy but below the mutated hybrid floor.
    assert classify_page(_page(text_length=500, image_count=1, coverage=0.5), policy).classification == "TEXT_NATIVE"


# ---- document aggregation (I6-04) ----


def test_document_aggregation_single_classes() -> None:
    assert classify_document([_page(text_length=500), _page(text_length=300)]).document_class == "TEXT_NATIVE"
    assert classify_document([_page(image_count=1, coverage=0.9)] * 2).document_class == "SCANNED"
    assert classify_document([_page(text_length=500, image_count=1, coverage=0.3)]).document_class == "HYBRID"
    assert classify_document([_page(), _page()]).document_class == "EMPTY"
    assert classify_document([]).document_class == "EMPTY"


def test_document_aggregation_mixed() -> None:
    result = classify_document([_page(text_length=500), _page(image_count=1, coverage=0.9)])
    assert result.document_class == "MIXED"
    assert [p.classification for p in result.page_classes] == ["TEXT_NATIVE", "SCANNED"]


def test_empty_pages_are_non_informative() -> None:
    # A trailing blank page does not make a text document MIXED.
    result = classify_document([_page(text_length=500), _page()])
    assert result.document_class == "TEXT_NATIVE"


def test_document_classification_carries_provenance() -> None:
    result = classify_document([_page(text_length=500)])
    assert result.provenance == {
        "pageClasses": ["TEXT_NATIVE"],
        "classifierRef": result.classifier_ref,
        "policyFingerprint": result.policy_fingerprint,
    }


# ---- routing decisions (I6-06) ----


def test_routing_decisions_per_document_class() -> None:
    policy = load_scanned_policy()
    assert classify_document([_page(text_length=500)], policy).route == {
        "pipeline": "text",
        "providerRef": "ghatana.docling",
    }
    scanned = classify_document([_page(image_count=1, coverage=0.9)], policy)
    assert scanned.route["pipeline"] == "ocr"
    assert scanned.route["providerRef"] == "ghatana.resilient-parser"
    assert scanned.route["inputMediaType"] == "image/png"
    hybrid = classify_document([_page(text_length=500, image_count=1, coverage=0.3)], policy)
    assert hybrid.route["pipeline"] == "hybrid"
    assert hybrid.route["providerRef"] == "ghatana.hybrid-pdf"
    assert hybrid.route["requirePageRegionEvidence"] is True
    mixed = classify_document([_page(text_length=500), _page(image_count=1, coverage=0.9)], policy)
    assert mixed.route["pipeline"] == "hybrid"
    assert mixed.route["requirePageRegionEvidence"] is True
    empty = classify_document([_page()], policy)
    assert empty.route["pipeline"] == "reject"
    assert empty.route["reasonCode"] == "EMPTY_DOCUMENT"


# ---- provenance receipts (I6-05) ----


def test_provenance_record_shape_and_page_refs() -> None:
    pages = [_page(text_length=500), _page(image_count=1, coverage=0.9)]
    record = provenance_record(classify_document(pages), page_refs=[1, 2])
    assert record["schemaVersion"] == "document-intelligence.scanned-provenance.v1"
    assert record["documentClass"] == "MIXED"
    assert record["pageDecisions"] == [
        {"pageIndex": 0, "class": "TEXT_NATIVE", "reasonCode": "TEXT_DOMINANT", "pageRef": 1},
        {"pageIndex": 1, "class": "SCANNED", "reasonCode": "IMAGE_DOMINANT", "pageRef": 2},
    ]
    assert record["policyFingerprint"].startswith("sha256:")
    assert record["receiptFingerprint"].startswith("sha256:")


def test_provenance_page_refs_must_align() -> None:
    document = classify_document([_page(text_length=500)])
    with pytest.raises(WorkerError):
        provenance_record(document, page_refs=[1, 2])


def test_receipt_fingerprint_is_deterministic_and_tamper_evident() -> None:
    pages = [_page(text_length=500), _page(image_count=1, coverage=0.9)]
    first = provenance_record(classify_document(pages))
    second = provenance_record(classify_document([dict(p) for p in pages]))
    assert first == second
    assert first["receiptFingerprint"] == second["receiptFingerprint"]

    payload = {key: value for key, value in first.items() if key != "receiptFingerprint"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    assert first["receiptFingerprint"] == "sha256:" + hashlib.sha256(canonical).hexdigest()

    different = provenance_record(classify_document([_page(text_length=500)]))
    assert different["receiptFingerprint"] != first["receiptFingerprint"]


# ---- policy binding (I6-07) ----


def test_policy_fingerprint_binds_policy_bytes(tmp_path: Path) -> None:
    policy = load_scanned_policy()
    expected = "sha256:" + hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest()
    assert policy.fingerprint == expected
    document = classify_document([_page(text_length=500)], policy)
    assert document.policy_fingerprint == policy.fingerprint
    assert provenance_record(document)["policyFingerprint"] == expected

    mutated = load_scanned_policy(
        _mutated_policy(tmp_path, lambda doc: doc["thresholds"].update({"textLayerMinChars": 3}))
    )
    assert mutated.fingerprint != policy.fingerprint
    assert provenance_record(classify_document([_page(text_length=500)], mutated))[
        "policyFingerprint"
    ] == mutated.fingerprint


def test_policy_schema_version_is_enforced(tmp_path: Path) -> None:
    path = _mutated_policy(tmp_path, lambda doc: doc.update({"schemaVersion": "other.v1"}))
    with pytest.raises(ValueError):
        load_scanned_policy(path)


def test_policy_routing_must_be_exhaustive(tmp_path: Path) -> None:
    path = _mutated_policy(tmp_path, lambda doc: doc["routing"].pop("EMPTY"))
    with pytest.raises(ValueError):
        load_scanned_policy(path)


# ---- scanned-table disposition (I6-06) ----


def test_scanned_table_disposition_is_unsupported_by_design() -> None:
    policy = load_scanned_policy()
    assert policy.scanned_table_disposition == "UNSUPPORTED_BY_DESIGN"

    capabilities = yaml.safe_load(CAPABILITIES.read_text(encoding="utf-8"))
    scanned_tables = capabilities["capabilities"]["parser.pdf.hybrid.tables.scanned.en"]
    assert scanned_tables["developmentState"] == "UNSUPPORTED"
    assert scanned_tables["consumerAdmission"] == "DENIED"
    assert scanned_tables["futureOwner"] == "UNSUPPORTED_BY_DESIGN"

    contract = yaml.safe_load(FALLBACK_CONTRACT.read_text(encoding="utf-8"))
    prohibited = {item["id"] for item in contract["prohibited"]}
    assert "scanned-table-reconstruction" in prohibited
