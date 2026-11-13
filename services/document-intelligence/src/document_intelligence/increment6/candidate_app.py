"""Increment-6 candidate ASGI composition.

The default/I4A ASGI application remains sealed.  This candidate entry point
wraps that application at the transport boundary, validates the uploaded
multipart document, and then replays the unchanged request to the sealed
composition.  It is therefore an actual candidate hook without changing
``document_intelligence.app``.
"""
from __future__ import annotations

import json
from email.parser import BytesParser
from email.policy import default as email_default
from typing import Any, Awaitable, Callable

from ..app import create_app as create_sealed_app
from ..config import WorkerSettings
from ..errors import WorkerError
from .content_safety import validate_content

ASGIMessage = dict[str, Any]
Receive = Callable[[], Awaitable[ASGIMessage]]
Send = Callable[[ASGIMessage], Awaitable[None]]


def _header(scope: dict[str, Any], name: bytes) -> bytes | None:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return value
    return None


def _part_value(part: Any) -> bytes:
    value = part.get_payload(decode=True)
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    return b""


def _parse_multipart(body: bytes, content_type: bytes) -> tuple[dict[str, Any], bytes]:
    envelope = b"Content-Type: " + content_type + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    message = BytesParser(policy=email_default).parsebytes(envelope)
    if not message.is_multipart():
        raise WorkerError("INVALID_REQUEST")
    metadata_bytes: bytes | None = None
    file_bytes: bytes | None = None
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name == "metadata":
            metadata_bytes = _part_value(part)
        elif name == "file":
            file_bytes = _part_value(part)
    if metadata_bytes is None or file_bytes is None:
        raise WorkerError("INVALID_REQUEST")
    try:
        metadata = json.loads(metadata_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkerError("INVALID_REQUEST") from exc
    if not isinstance(metadata, dict):
        raise WorkerError("INVALID_REQUEST")
    return metadata, file_bytes


async def _read_body(receive: Receive, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        message = await receive()
        if message.get("type") == "http.disconnect":
            raise WorkerError("INVALID_REQUEST")
        if message.get("type") != "http.request":
            raise WorkerError("INVALID_REQUEST")
        chunk = message.get("body", b"")
        if not isinstance(chunk, bytes):
            raise WorkerError("INVALID_REQUEST")
        size += len(chunk)
        if size > max_bytes:
            raise WorkerError("LIMIT_EXCEEDED")
        chunks.append(chunk)
        if not message.get("more_body", False):
            return b"".join(chunks)


def _replay_receive(body: bytes) -> Receive:
    delivered = False

    async def receive() -> ASGIMessage:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


async def _send_error(send: Send, error: WorkerError, operation_id: str) -> None:
    body = json.dumps(error.envelope(operation_id), separators=(",", ":")).encode("utf-8")
    status = 413 if error.code == "LIMIT_EXCEEDED" else 400
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode("ascii"))],
    })
    await send({"type": "http.response.body", "body": body})


class Increment6ContentSafetyMiddleware:
    """Candidate-only request-boundary enforcement for parse uploads."""

    def __init__(self, app: Callable[..., Awaitable[None]], *, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: dict[str, Any], receive: Receive, send: Send) -> None:
        content_type = _header(scope, b"content-type")
        if (
            scope.get("type") != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/v1/parse"
            or content_type is None
            or not content_type.lower().startswith(b"multipart/form-data")
        ):
            await self.app(scope, receive, send)
            return

        operation_id = "invalid-request"
        try:
            body = await _read_body(receive, self.max_body_bytes)
            metadata, file_bytes = _parse_multipart(body, content_type)
            if isinstance(metadata.get("operationId"), str):
                operation_id = metadata["operationId"]
            media_type = metadata.get("mediaType")
            if not isinstance(media_type, str):
                raise WorkerError("INVALID_REQUEST")
            validate_content(file_bytes, media_type)
        except WorkerError as error:
            await _send_error(send, error, operation_id)
            return
        await self.app(scope, _replay_receive(body), send)


def create_candidate_app(settings: WorkerSettings | None = None, runtime: Any | None = None) -> Any:
    """Build the I6 candidate app while preserving the sealed app underneath."""
    settings = settings or WorkerSettings.from_env()
    app = create_sealed_app(settings, runtime)
    max_body_bytes = settings.limits.max_upload_bytes + settings.limits.max_metadata_bytes + 128 * 1024
    return Increment6ContentSafetyMiddleware(app, max_body_bytes=max_body_bytes)


try:
    app = create_candidate_app()
except Exception:
    app = None


def main() -> None:
    import uvicorn

    settings = WorkerSettings.from_env()
    uvicorn.run("document_intelligence.increment6.candidate_app:app", host=settings.host, port=settings.port, log_level="info")

