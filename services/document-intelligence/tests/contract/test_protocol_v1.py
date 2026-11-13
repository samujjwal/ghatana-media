from __future__ import annotations

import pytest

from document_intelligence.contracts import PROTOCOL_VERSION, RequestMetadata
from document_intelligence.errors import WorkerError
from document_intelligence.limits import Limits


def metadata(**overrides):
    value = {"protocolVersion": PROTOCOL_VERSION, "operationId": "op-1", "providerRef": "ghatana.docling", "mediaType": "application/pdf", "timeoutMs": 1000, "limits": {}}
    value.update(overrides)
    return value


def test_protocol_rejects_unknown_and_missing_fields():
    with pytest.raises(WorkerError):
        RequestMetadata.parse({**metadata(), "unknown": True}, Limits(), media_type_required=True)
    with pytest.raises(WorkerError):
        RequestMetadata.parse({"protocolVersion": PROTOCOL_VERSION}, Limits(), media_type_required=True)


def test_protocol_rejects_wrong_version_identifiers_and_timeout():
    with pytest.raises(WorkerError):
        RequestMetadata.parse(metadata(protocolVersion="wrong"), Limits(), media_type_required=True)
    with pytest.raises(WorkerError):
        RequestMetadata.parse(metadata(operationId="../secret"), Limits(), media_type_required=True)
    with pytest.raises(WorkerError):
        RequestMetadata.parse(metadata(timeoutMs=0), Limits(), media_type_required=True)


def test_protocol_binds_generation_metadata_to_header():
    generation = "a" * 32
    parsed = RequestMetadata.parse(
        metadata(operationGeneration=generation),
        Limits(),
        media_type_required=True,
        operation_generation_header=generation,
    )
    assert parsed.operation_generation == generation

    with pytest.raises(WorkerError):
        RequestMetadata.parse(
            metadata(operationGeneration=generation),
            Limits(),
            media_type_required=True,
            operation_generation_header="b" * 32,
        )
    with pytest.raises(WorkerError):
        RequestMetadata.parse(metadata(operationGeneration="not-a-token"), Limits(), media_type_required=True)


def test_protocol_rejects_unsupported_media_and_language():
    with pytest.raises(WorkerError) as media:
        RequestMetadata.parse(metadata(mediaType="application/msword"), Limits(), media_type_required=True)
    assert media.value.code == "UNSUPPORTED_MEDIA_TYPE"
    with pytest.raises(WorkerError) as language:
        RequestMetadata.parse(metadata(languageHint="fr"), Limits(), media_type_required=True)
    assert language.value.code == "UNSUPPORTED_LANGUAGE"


@pytest.mark.parametrize(
    "media_type",
    [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
)
def test_office_media_is_capability_driven(media_type):
    allowed = (media_type,)
    assert RequestMetadata.parse(metadata(mediaType=media_type), Limits(), media_type_required=True, allowed_media_types=allowed).media_type == media_type
    with pytest.raises(WorkerError) as rejected:
        RequestMetadata.parse(metadata(mediaType=media_type), Limits(), media_type_required=True)
    assert rejected.value.code == "UNSUPPORTED_MEDIA_TYPE"


@pytest.mark.parametrize("language", ["hi", "mr"])
def test_candidate_language_is_capability_driven(language):
    parsed = RequestMetadata.parse(metadata(languageHint=language), Limits(), media_type_required=True, allowed_languages=("en", "ne", "hi", "mr"))
    assert parsed.language_hint == language
    with pytest.raises(WorkerError) as rejected:
        RequestMetadata.parse(metadata(languageHint=language), Limits(), media_type_required=True)
    assert rejected.value.code == "UNSUPPORTED_LANGUAGE"


def test_language_tags_must_be_canonical():
    with pytest.raises(WorkerError) as rejected:
        RequestMetadata.parse(metadata(languageHint="HI"), Limits(), media_type_required=True, allowed_languages=("hi",))
    assert rejected.value.code == "UNSUPPORTED_LANGUAGE"
