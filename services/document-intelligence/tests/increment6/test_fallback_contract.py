from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.runtime.fallback_contract import (  # noqa: E402
    FallbackContract,
    FallbackContractError,
)


@pytest.fixture()
def contract() -> FallbackContract:
    return FallbackContract()


def test_declared_chain_admitted(contract):
    decision = contract.admit(
        "ghatana.paddleocr", "ghatana.resilient-parser.tesseract",
        "PROVIDER_TIMEOUT", "image/png",
    )
    assert decision.allowed
    assert decision.chain_id == "image-ocr-resilience"
    assert "reasonCode" in decision.required_record
    assert decision.contract_fingerprint.startswith("sha256:")


def test_undeclared_chain_rejected(contract):
    with pytest.raises(FallbackContractError):
        contract.admit("ghatana.gliner", "ghatana.docling", "PROVIDER_CRASH", "application/pdf")


def test_wrong_trigger_rejected(contract):
    with pytest.raises(FallbackContractError):
        contract.admit(
            "ghatana.paddleocr", "ghatana.resilient-parser.tesseract",
            "SOME_NEW_REASON", "image/png",
        )


def test_wrong_media_rejected(contract):
    with pytest.raises(FallbackContractError):
        contract.admit(
            "ghatana.paddleocr", "ghatana.resilient-parser.tesseract",
            "PROVIDER_TIMEOUT", "application/pdf",
        )


def test_receipt_binds_contract_fingerprint(contract):
    decision = contract.admit(
        "ghatana.docling", "ghatana.resilient-parser.tesseract",
        "EMPTY_TEXT_LAYER", "application/pdf",
    )
    receipt = contract.receipt(
        decision, reason_code="EMPTY_TEXT_LAYER",
        provenance={"fromProviderRef": "ghatana.docling"},
    )
    assert receipt["contractFingerprint"] == contract.fingerprint
    assert receipt["receiptFingerprint"].startswith("sha256:")
