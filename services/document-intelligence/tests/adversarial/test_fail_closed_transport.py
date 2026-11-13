from document_intelligence.errors import sanitized_error


def test_provider_exception_does_not_cross_the_process_boundary():
    envelope = sanitized_error(RuntimeError("credential SECRET document text"), "operation-1", "ghatana.docling")
    assert envelope == {
        "protocolVersion": "document-intelligence.v1",
        "operationId": "operation-1",
        "code": "PROVIDER_FAILED",
        "retryable": False,
        "providerRef": "ghatana.docling",
    }
