"""Single-authority OCR boundary regression, NOT runtime model qualification.

All OCR providers must remain behind the frozen Document Intelligence v1
protocol; products consume one public client, not provider implementations.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_single_public_ocr_gateway_is_frozen_di_v1():
    app = (ROOT / "src/document_intelligence/app.py").read_text(encoding="utf-8")
    protocol = (ROOT / "clients/typescript/src/protocol.ts").read_text(encoding="utf-8")
    client = (ROOT / "clients/typescript/src/client.ts").read_text(encoding="utf-8")
    assert "@app.post(\"/v1/parse\")" in app
    assert "@app.get(\"/v1/providers\")" in app
    assert "document-intelligence.v1" in protocol
    assert "this.request('/v1/parse'" in client
    assert "this.request('/v1/providers'" in client
    assert '"/v1/media/ocr"' not in app
    assert "document-intelligence.v2" not in protocol


def test_ocr_engines_are_internal_provider_adapters():
    providers = (ROOT / "src/document_intelligence/providers/__init__.py").read_text(
        encoding="utf-8"
    )
    routing = (ROOT / "routing/parser-routing.v1.yaml").read_text(encoding="utf-8")
    assert "PaddleOcrParser" in providers
    assert "TesseractOcrParser" in providers
    assert "HybridPdfParser" in providers
    assert "ghatana.paddleocr" in routing or "ghatana.resilient-parser" in routing


def test_public_client_does_not_export_media_specific_ocr_engine():
    index = (ROOT / "clients/typescript/src/index.ts").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "from './client.js'" in index
    assert "media-roi.js" not in index
    assert "only" in readme.lower()
    assert "Document Intelligence" in readme
