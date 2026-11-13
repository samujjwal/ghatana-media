"""Increment-6 candidate content-safety and bounded-spooling primitives.

This module is additive candidate material. The sealed default/I4A app does
not import it; candidate composition applies the request-boundary hook from
``candidate_app`` before the sealed application receives a parse request.
"""
from __future__ import annotations

import io
import posixpath
import tempfile
import zipfile
from dataclasses import dataclass
from typing import Iterable

from ..errors import WorkerError

PDF = "application/pdf"
PNG = "image/png"
JPEG = "image/jpeg"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@dataclass(frozen=True)
class ContentInspection:
    detected_media_type: str | None
    encrypted: bool = False
    active_content: bool = False
    container: str | None = None


def sniff_content(data: bytes) -> ContentInspection:
    """Inspect magic/container structure without executing document content."""
    if not isinstance(data, (bytes, bytearray)):
        raise WorkerError("INVALID_REQUEST")
    payload = bytes(data)
    if payload.startswith(b"%PDF-"):
        active = any(marker in payload for marker in (b"/JavaScript", b"/JS ", b"/Launch", b"/AA ", b"/RichMedia"))
        return ContentInspection(PDF, b"/Encrypt" in payload, active, "pdf")
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return ContentInspection(PNG, container="png")
    if payload.startswith(b"\xff\xd8\xff"):
        return ContentInspection(JPEG, container="jpeg")
    if not payload.startswith(b"PK\x03\x04"):
        return ContentInspection(None)
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            encrypted = any(info.flag_bits & 0x1 for info in archive.infolist())
            names = {posixpath.normpath(info.filename) for info in archive.infolist()}
            content_types = b""
            if "[Content_Types].xml" in names:
                info = archive.getinfo("[Content_Types].xml")
                if info.file_size <= 1024 * 1024:
                    content_types = archive.read(info)
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as exc:
        raise WorkerError("INVALID_REQUEST") from exc
    lowered = content_types.lower()
    active = any(marker in lowered for marker in (b"macroenabled", b"vbaproject", b"activex", b"oleobject"))
    if b"presentationml.presentation.main+xml" in lowered:
        return ContentInspection(PPTX, encrypted, active, "ooxml")
    if b"spreadsheetml.sheet.main+xml" in lowered:
        return ContentInspection(XLSX, encrypted, active, "ooxml")
    if b"wordprocessingml.document.main+xml" in lowered:
        return ContentInspection(DOCX, encrypted, active, "ooxml")
    return ContentInspection("application/zip", encrypted, active, "zip")


def validate_content(data: bytes, declared_media_type: str) -> ContentInspection:
    """Fail closed on type mismatch, encryption, or active content."""
    inspection = sniff_content(data)
    if inspection.detected_media_type != declared_media_type:
        raise WorkerError("UNSUPPORTED_MEDIA_TYPE")
    if inspection.encrypted:
        raise WorkerError("UNSUPPORTED_MEDIA_TYPE")
    if inspection.active_content:
        raise WorkerError("INVALID_REQUEST")
    return inspection


class BoundedSpool:
    """Chunked input spool with a hard byte ceiling (I6-77)."""

    def __init__(self, max_bytes: int, *, memory_bytes: int = 1024 * 1024) -> None:
        if max_bytes <= 0 or memory_bytes <= 0:
            raise ValueError("spool limits must be positive")
        self.max_bytes = max_bytes
        self._size = 0
        self._file = tempfile.SpooledTemporaryFile(max_size=memory_bytes, mode="w+b")

    @property
    def size(self) -> int:
        return self._size

    def write(self, chunk: bytes) -> int:
        if not isinstance(chunk, (bytes, bytearray)):
            raise TypeError("spool chunks must be bytes")
        if self._size + len(chunk) > self.max_bytes:
            raise WorkerError("LIMIT_EXCEEDED")
        self._file.write(chunk)
        self._size += len(chunk)
        return len(chunk)

    def rewind(self) -> None:
        self._file.seek(0)

    def read(self, size: int = -1) -> bytes:
        return self._file.read(size)

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> "BoundedSpool":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def spool_chunks(chunks: Iterable[bytes], max_bytes: int, *, memory_bytes: int = 1024 * 1024) -> BoundedSpool:
    spool = BoundedSpool(max_bytes, memory_bytes=memory_bytes)
    try:
        for chunk in chunks:
            spool.write(chunk)
        spool.rewind()
        return spool
    except BaseException:
        spool.close()
        raise


def require_complete_pages(expected_pages: int, completed_pages: Iterable[int], *, allow_partial: bool = False) -> dict[str, object]:
    """Make partial-result policy explicit; never silently return gaps."""
    if expected_pages < 0:
        raise ValueError("expected_pages must be non-negative")
    completed = sorted({int(page) for page in completed_pages})
    missing = [page for page in range(1, expected_pages + 1) if page not in completed]
    if missing and not allow_partial:
        raise WorkerError("PROVIDER_FAILED")
    return {
        "status": "PARTIAL" if missing else "COMPLETE",
        "completedPages": completed,
        "missingPages": missing,
        "partialAllowed": allow_partial,
    }

