import math

import pytest

from document_intelligence.contracts import PROTOCOL_VERSION, validate_provider_output
from document_intelligence.errors import WorkerError
from document_intelligence.limits import Limits


def _identity(provider="ghatana.docling"):
    return {"providerRef": provider, "providerVersion": "0.1.0", "modelRef": "local", "modelVersion": "pinned"}


def _parsed():
    return {
        "protocolVersion": PROTOCOL_VERSION, "operationId": "op-1", "providerRef": "ghatana.docling",
        "pages": [{"pageNumber": 1, "blocks": [{"blockId": "p1-b1", "kind": "TEXT", "boundingRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "lines": [{"lineId": "p1-b1-l1", "text": "safe", "boundingRegion": {"x": 0, "y": 0, "width": 1, "height": 1}}]}], "tables": []}],
        "providerProvenance": _identity(), "quality": {},
    }


@pytest.mark.parametrize("mutation", [
    lambda value: {**value, "unknown": True},
    lambda value: {**value, "providerProvenance": {"providerRef": "ghatana.docling"}},
    lambda value: {**value, "pages": [{**value["pages"][0], "blocks": [{**value["pages"][0]["blocks"][0], "lines": [{**value["pages"][0]["blocks"][0]["lines"][0], "boundingRegion": {"x": 0, "y": 0, "width": 2, "height": 1}}]}]}]},
    lambda value: {**value, "pages": [{**value["pages"][0], "blocks": [{**value["pages"][0]["blocks"][0], "lines": [{**value["pages"][0]["blocks"][0]["lines"][0], "confidence": math.nan}]}]}]},
])
def test_provider_output_attacks_fail_closed(mutation):
    with pytest.raises(WorkerError):
        validate_provider_output(mutation(_parsed()), Limits())


def test_oversized_text_and_invalid_identity_fail_closed():
    value = _parsed()
    value["pages"][0]["blocks"][0]["lines"][0]["text"] = "x" * (Limits().max_text_characters + 1)
    with pytest.raises(WorkerError):
        validate_provider_output(value, Limits())


@pytest.mark.parametrize("model_ref", [
    "../model",
    "foo/../bar",
    "/foo",
    "foo\\",
    "foo//bar",
    "foo/",
    "/foo/bar",
    "file:///etc/passwd",
    "file://host/model",
    "https://models.example/x",
    "http://models.example/x",
    "%2e%2e/model",
    "model name",
    "model\tname",
    "model\x00name",
    ".hidden",
    "-leading",
    "_leading",
    ":leading",
    "a/b/c",
    "",
])
def test_hostile_model_references_fail_closed(model_ref):
    value = _parsed()
    value["providerProvenance"] = {**value["providerProvenance"], "modelRef": model_ref}
    with pytest.raises(WorkerError):
        validate_provider_output(value, Limits())


@pytest.mark.parametrize("model_ref", [
    "urchade/gliner_multi-v2.1",
    "sentence-transformers/all-MiniLM-L6-v2",
    "docling-standard-pdf-pipeline",
    "PP-OCRv5-en",
    "PP-OCRv5-devanagari-shared",
])
def test_namespace_qualified_model_references_are_admitted(model_ref):
    value = _parsed()
    value["providerProvenance"] = {**value["providerProvenance"], "modelRef": model_ref}
    assert validate_provider_output(value, Limits()) is value
