from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.increment6.candidate_app import Increment6ContentSafetyMiddleware  # noqa: E402


def _multipart(metadata: dict[str, object], file_bytes: bytes) -> tuple[bytes, bytes]:
    boundary = b"candidate-boundary"
    content_type = b"multipart/form-data; boundary=" + boundary
    body = b"".join(
        (
            b"--" + boundary + b"\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n",
            json.dumps(metadata, separators=(",", ":")).encode(),
            b"\r\n--" + boundary + b"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"input.pdf\"\r\nContent-Type: application/pdf\r\n\r\n",
            file_bytes,
            b"\r\n--" + boundary + b"--\r\n",
        )
    )
    return content_type, body


async def _invoke(middleware, content_type: bytes, body: bytes):
    received = []
    sent = []

    async def receive():
        if received:
            return {"type": "http.disconnect"}
        received.append(True)
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/v1/parse",
        "headers": [(b"content-type", content_type)],
    }
    await middleware(scope, receive, send)
    return sent


@pytest.mark.asyncio
async def test_candidate_hook_rejects_mismatched_content_before_sealed_app():
    called = False

    async def sealed_app(scope, receive, send):
        nonlocal called
        called = True

    middleware = Increment6ContentSafetyMiddleware(sealed_app, max_body_bytes=10_000)
    content_type, body = _multipart(
        {
            "protocolVersion": "document-intelligence.v1",
            "operationId": "op-1",
            "mediaType": "image/png",
        },
        b"%PDF-1.7\n",
    )
    sent = await _invoke(middleware, content_type, body)
    assert not called
    assert sent[0]["status"] == 400


@pytest.mark.asyncio
async def test_candidate_hook_replays_valid_content_to_sealed_app():
    replayed = {}

    async def sealed_app(scope, receive, send):
        replayed["message"] = await receive()
        await send({"type": "http.response.start", "status": 200, "headers": []})

    middleware = Increment6ContentSafetyMiddleware(sealed_app, max_body_bytes=10_000)
    content_type, body = _multipart(
        {
            "protocolVersion": "document-intelligence.v1",
            "operationId": "op-2",
            "mediaType": "application/pdf",
        },
        b"%PDF-1.7\n",
    )
    sent = await _invoke(middleware, content_type, body)
    assert sent[0]["status"] == 200
    assert replayed["message"]["body"] == body
