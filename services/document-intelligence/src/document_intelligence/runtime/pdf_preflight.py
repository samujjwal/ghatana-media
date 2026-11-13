"""Fail-closed structural preflight for PDF payloads (I6-53/I6-54).

Runs before any parser or renderer touches the document.  All checks are
either raw-byte scans (O(n) over the already-bounded input) or a single
bounded pdfium open — no PDF content is ever executed, interpreted, or
fetched.

Policy:

- ``%PDF-`` magic is required; anything else is INVALID_REQUEST.
- Structural bounds (I6-54): declared object count
  (``\\d+\\s+\\d+\\s+obj``) and stream-declaration count are bounded by
  ``max_objects``/``max_streams``; excess is LIMIT_EXCEEDED.  Deep
  xref/``/Kids`` recursion is bounded indirectly by total input bytes plus
  the object-count bound, so no explicit recursion walk is needed.
- Hostile feature vectors (I6-53, PDF side): top-level name entries
  ``/EmbeddedFiles``, ``/JavaScript``, ``/JS``, ``/Launch``,
  ``/RichMedia``, and ``/AA`` auto-actions are rejected outright with
  INVALID_REQUEST.  Names hidden inside compressed object streams are not
  visible to this raw-byte scan; that residual is accepted because the
  object/stream bounds still apply and the worker never executes PDF
  content.
- Page-dimension ceiling (I6-54): pdfium opens the document and every
  page's width/height must not exceed ``max_pdf_page_dimension_pt``
  BEFORE any rendering; a document pdfium cannot open is INVALID_REQUEST.
  The pdfium pass only runs once the bytes claim real structure (at least
  one object declaration or an ``%%EOF`` marker) — a bare ``%PDF-`` header
  fragment declares no pages and is left to the primary converter, which
  performs its own open.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping

from ..errors import WorkerError

_OBJECT_RE = re.compile(rb"\d+\s+\d+\s+obj")
_STREAM_RE = re.compile(rb"\bstream\b")
_EOF_MARKER = b"%%EOF"

# PDF name objects end at whitespace, a delimiter, or end of input.
def _name_re(name: bytes) -> re.Pattern[bytes]:
    return re.compile(re.escape(b"/" + name) + rb"(?=[\x00-\x20()\[\]<>{}/%]|$)")


_HOSTILE_NAME_RES = tuple(
    _name_re(name)
    for name in (b"EmbeddedFiles", b"JavaScript", b"JS", b"Launch", b"RichMedia", b"AA")
)


@dataclass(frozen=True)
class PdfLimits:
    """Structural bounds applied before PDF parsing/rendering."""

    max_objects: int = 200_000
    max_streams: int = 100_000
    max_page_dimension_pt: int = 14_400  # 200 inches at 72 pt/in
    max_pages: int = 500

    @classmethod
    def from_mapping(cls, limits: Mapping[str, int] | None) -> "PdfLimits":
        """Build from the camelCase provider-facing limits mapping."""
        values = limits or {}
        return cls(
            max_objects=int(values.get("maxPdfObjects", 200_000)),
            max_streams=int(values.get("maxPdfStreams", 100_000)),
            max_page_dimension_pt=int(values.get("maxPdfPageDimensionPt", 14_400)),
            max_pages=int(values.get("maxPages", 500)),
        )


@dataclass(frozen=True)
class PdfInspection:
    """Facts established by preflight; empty values mean not checked."""

    objects: int
    streams: int
    pages: int
    page_dimensions_checked: bool


def _reject() -> None:
    raise WorkerError("INVALID_REQUEST")


def _inspect_pages(data: bytes, limits: PdfLimits, objects: int) -> tuple[int, bool]:
    if objects == 0 and _EOF_MARKER not in data:
        # A bare ``%PDF-`` fragment declares no objects and no pages; the
        # primary converter performs its own open on such payloads.
        return 0, False
    try:
        import pypdfium2 as pdfium
    except ImportError as exc:  # pragma: no cover - runtime dependency guard
        raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True) from exc
    try:
        document = pdfium.PdfDocument(data)
    except Exception as exc:
        _reject()
        raise AssertionError from exc
    try:
        page_count = len(document)
        if page_count > limits.max_pages:
            raise WorkerError("LIMIT_EXCEEDED")
        for index in range(page_count):
            page = document[index]
            try:
                width = float(page.get_width())
                height = float(page.get_height())
            finally:
                page.close()
            if width > limits.max_page_dimension_pt or height > limits.max_page_dimension_pt:
                raise WorkerError("LIMIT_EXCEEDED")
        return page_count, True
    finally:
        document.close()


def validate_pdf(data: bytes, limits: PdfLimits | None = None) -> PdfInspection:
    """Structural preflight; raises WorkerError on any policy violation."""
    limits = limits or PdfLimits()
    if not isinstance(data, bytes) or len(data) < 5 or not data.startswith(b"%PDF-"):
        _reject()
    objects = len(_OBJECT_RE.findall(data))
    if objects > limits.max_objects:
        raise WorkerError("LIMIT_EXCEEDED")
    streams = len(_STREAM_RE.findall(data))
    if streams > limits.max_streams:
        raise WorkerError("LIMIT_EXCEEDED")
    for pattern in _HOSTILE_NAME_RES:
        if pattern.search(data):
            _reject()
    pages, checked = _inspect_pages(data, limits, objects)
    return PdfInspection(objects=objects, streams=streams, pages=pages, page_dimensions_checked=checked)


__all__ = ["PdfInspection", "PdfLimits", "validate_pdf"]
