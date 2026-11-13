"""PROTO-02 — canonical Increment-3 request replay.

Replays every fixture in contracts/fixtures/i3-canonical/ through the frozen
request grammar (contracts.RequestMetadata.parse) plus the endpoint payload
gates mirrored from app.py, and asserts:

* the acceptance decision and error code match the fixture expectation, and
* every accepted request is I3-compatible — only canonical I3 metadata keys,
  only the canonical I3 media/language catalogs, and no required I4A/I6-only
  fields.

The fixtures pin the backward-compatibility contract: a request an I3 consumer
could emit must still be admitted by the current runtime, and requests outside
the I3 grammar must still fail closed with the same codes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from document_intelligence.contracts import RequestMetadata
from document_intelligence.errors import WorkerError
from document_intelligence.limits import Limits

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "contracts" / "fixtures" / "i3-canonical"

# Canonical Increment-3 admission surface: the implicit default catalog.
I3_MEDIA_TYPES = ("application/pdf", "image/png", "image/jpeg")
I3_LANGUAGES = ("en", "ne")
I3_METADATA_KEYS = {
    "protocolVersion",
    "operationId",
    "operationGeneration",
    "providerRef",
    "mediaType",
    "languageHint",
    "timeoutMs",
    "limits",
}

# Keys the endpoints strip before metadata validation (app.py contract).
_PAYLOAD_KEYS = {"extract": "payload", "embed": "projection"}

FIXTURES = sorted(FIXTURE_DIR.glob("*.json"))


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _metadata_for(endpoint: str, request: dict) -> dict:
    """Mirror app.py: strip the endpoint payload key before RequestMetadata.parse."""
    payload_key = _PAYLOAD_KEYS.get(endpoint)
    if payload_key is None:
        return request
    return {key: value for key, value in request.items() if key != payload_key}


def _payload_gate(endpoint: str, request: dict) -> str | None:
    """Mirror the post-metadata payload checks in the /v1/extract and /v1/embed routes."""
    if endpoint == "extract" and not isinstance(request.get("payload"), dict):
        return "INVALID_REQUEST"
    if endpoint == "embed" and not isinstance(request.get("projection"), dict):
        return "INVALID_REQUEST"
    return None


@pytest.mark.parametrize("fixture_path", FIXTURES, ids=lambda path: path.stem)
def test_i3_canonical_request_replay(fixture_path: Path):
    fixture = _load(fixture_path)
    endpoint = fixture["endpoint"]
    request = fixture["request"]
    expected = fixture["expected"]

    metadata = _metadata_for(endpoint, request)
    try:
        parsed = RequestMetadata.parse(
            metadata,
            Limits(),
            media_type_required=endpoint == "parse",
            allowed_media_types=I3_MEDIA_TYPES,
            allowed_languages=I3_LANGUAGES,
            operation_generation_header=fixture.get("headerGeneration"),
        )
        metadata_error = None
    except WorkerError as exc:
        parsed = None
        metadata_error = exc.code

    if not expected["accepted"]:
        if expected.get("stage", "metadata") == "metadata":
            assert parsed is None, f"{fixture['id']}: metadata must fail closed"
            assert metadata_error == expected["code"]
        else:
            # Rejection happens at the endpoint payload gate after valid metadata.
            assert parsed is not None, f"{fixture['id']}: metadata must stay admissible"
            assert _payload_gate(endpoint, request) == expected["code"]
        return

    assert parsed is not None, f"{fixture['id']}: canonical I3 request must be admitted"
    assert _payload_gate(endpoint, request) is None

    # I3-compatible shape: only canonical I3 metadata keys survived admission.
    assert set(metadata) <= I3_METADATA_KEYS
    assert set(request) <= I3_METADATA_KEYS | {key for key in _PAYLOAD_KEYS.values()}
    if endpoint == "parse":
        assert parsed.media_type in I3_MEDIA_TYPES
    assert parsed.language_hint in (None, *I3_LANGUAGES)
    assert parsed.operation_id == request["operationId"]
    assert parsed.provider_ref == request["providerRef"]


def test_fixture_corpus_is_present_and_declared():
    assert len(FIXTURES) >= 10, "canonical I3 corpus must cover valid and invalid envelopes"
    for path in FIXTURES:
        fixture = _load(path)
        assert fixture["id"] == path.stem
        assert fixture["endpoint"] in {"parse", "extract", "embed"}
        assert isinstance(fixture["request"], dict)
        assert isinstance(fixture["expected"]["accepted"], bool)
        if not fixture["expected"]["accepted"]:
            assert fixture["expected"]["code"]
