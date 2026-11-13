import pytest

from document_intelligence.contracts import PROTOCOL_VERSION, RequestMetadata
from document_intelligence.errors import WorkerError
from document_intelligence.limits import Limits


def test_nepali_unicode_and_combining_text_are_valid_metadata_inputs():
    value = {"protocolVersion": PROTOCOL_VERSION, "operationId": "ne-unicode", "providerRef": "ghatana.gliner", "languageHint": "ne", "timeoutMs": 1000, "limits": {}}
    parsed = RequestMetadata.parse(value, Limits(), media_type_required=False)
    assert parsed.language_hint == "ne"


@pytest.mark.parametrize("field", ["operationId", "providerRef"])
def test_path_like_identifiers_are_rejected(field):
    value = {"protocolVersion": PROTOCOL_VERSION, "operationId": "op-1", "providerRef": "ghatana.docling", "timeoutMs": 1000, "limits": {}}
    value[field] = "../credential"
    with pytest.raises(WorkerError):
        RequestMetadata.parse(value, Limits(), media_type_required=False)
