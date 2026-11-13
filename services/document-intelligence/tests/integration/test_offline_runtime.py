"""Offline-runtime proof: every declared provider executes with outbound
network disabled at the process socket layer.

Local model files alone do not prove offline execution — libraries can still
consult hubs, metadata URLs, tokenizer sources, or plugin registries. This test
denies all outbound connection and name-resolution primitives while real
Docling, PaddleOCR (en+ne), GLiNER and MiniLM inference runs end to end.
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import socket
from pathlib import Path

import pytest

from document_intelligence.config import WorkerSettings
from document_intelligence.lifecycle import WorkerRuntime
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline

REQUIRED = ["docling", "paddleocr", "gliner", "sentence_transformers"]


def _require_real_providers() -> None:
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        pytest.skip("real provider promotion runs require explicit opt-in")
    missing = [module for module in REQUIRED if importlib.util.find_spec(module) is None]
    if missing:
        pytest.skip(f"declared provider packages are not provisioned: {missing}")


@pytest.fixture
def outbound_network_disabled(monkeypatch):
    def deny(*args, **kwargs):
        raise AssertionError("outbound network access is forbidden during provider execution")

    monkeypatch.setattr(socket.socket, "connect", deny)
    monkeypatch.setattr(socket.socket, "connect_ex", deny)
    monkeypatch.setattr(socket, "create_connection", deny)
    monkeypatch.setattr(socket, "getaddrinfo", deny)
    monkeypatch.setattr(socket, "gethostbyname", deny)
    monkeypatch.setattr(socket, "gethostbyname_ex", deny)
    monkeypatch.setattr(socket, "gethostbyaddr", deny)
    monkeypatch.setattr(socket, "getnameinfo", deny)


@pytest.mark.integration
def test_providers_execute_with_outbound_network_disabled(outbound_network_disabled):
    _require_real_providers()
    root = Path(__file__).resolve().parents[2]
    corpus = root / "evaluation" / "corpus"
    settings = WorkerSettings.from_env()
    assert settings.offline, "offline-by-default must stay enabled for this proof"
    runtime = WorkerRuntime.create(settings)
    asyncio.run(runtime.start())
    try:
        assert runtime.health.ready, runtime.health.reason

        docling = runtime.providers["ghatana.docling"]
        parsed = docling.parse(
            (corpus / "pdf-en-simple.pdf").read_bytes(),
            media_type="application/pdf",
            limits={"maxPages": settings.limits.max_pages},
            deadline=Deadline(120_000),
            token=CancellationToken(),
        )
        assert parsed["providerProvenance"]["providerRef"] == "ghatana.docling"

        paddle = runtime.providers["ghatana.paddleocr"]
        english = paddle.parse(
            (corpus / "image-en-clean.png").read_bytes(),
            media_type="image/png",
            language="en",
            deadline=Deadline(120_000),
            token=CancellationToken(),
        )
        assert english["providerProvenance"]["modelRef"] == "PP-OCRv5-en"
        nepali = paddle.parse(
            (corpus / "image-ne-clean.png").read_bytes(),
            media_type="image/png",
            language="ne",
            deadline=Deadline(120_000),
            token=CancellationToken(),
        )
        assert nepali["providerProvenance"]["modelRef"] == "PP-OCRv5-devanagari-shared"

        extracted = runtime.providers["ghatana.gliner"].extract(
            parsed,
            [{"fieldId": "document_number", "aliases": ["invoice number"], "valueType": "IDENTIFIER", "cardinality": "SINGLE"}],
            deadline=Deadline(120_000),
            token=CancellationToken(),
            language="en",
        )
        assert extracted["provider"]["providerRef"] == "ghatana.gliner"

        embedding = runtime.providers["ghatana.minilm"].embed(
            {
                "version": "document-structure-embedding.v1",
                "pageCount": 1,
                "blockKindCounts": {"TEXT": 1},
                "tableShapes": [],
                "normalizedBlockGeometry": [{"pageNumber": 1, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.1}],
                "semanticTextBasis": "Synthetic English invoice number INV-1001",
                "structuralFingerprint": "offline-runtime-proof",
            },
            deadline=Deadline(120_000),
            token=CancellationToken(),
        )
        assert embedding["dimensions"] == 384 and len(embedding["values"]) == 384
    finally:
        asyncio.run(runtime.shutdown())
