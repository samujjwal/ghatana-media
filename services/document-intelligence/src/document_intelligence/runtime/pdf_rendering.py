"""Bounded PDF page/region rasterization used by the hybrid PDF strategy.

Rendering is a runtime service: the strategy never talks to pypdfium2 directly
and tests can substitute a fake renderer with the same surface.  All returned
geometry is normalized top-left ``{x, y, width, height}`` in the unit square of
the source page; raster output is PNG bytes sized for the OCR providers.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

from ..errors import WorkerError
from ..mapping.parsed_document import normalized_box
from .pdf_preflight import PdfLimits, validate_pdf


_FPDF_PAGEOBJ_IMAGE = 3
_FPDF_PAGEOBJ_FORM = 5


@dataclass(frozen=True)
class PdfPageInfo:
    """Real per-page facts used for NATIVE/SCANNED/MIXED classification."""

    page_index: int
    page_number: int
    width: float
    height: float
    text_characters: int
    image_regions: tuple[dict[str, float], ...]


class PdfRenderer:
    """Render pages and image regions of a PDF with pypdfium2."""

    def __init__(self, data: bytes, *, max_pixels: int = 16_777_216, scale: float = 2.0, pdf_limits: PdfLimits | None = None) -> None:
        # I6-54/I6-53: hostile-input structural preflight before any page is
        # opened or rasterized.
        validate_pdf(data, pdf_limits)
        try:
            import pypdfium2 as pdfium
        except ImportError as exc:  # pragma: no cover - runtime dependency guard
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True) from exc
        self._pdfium = pdfium
        self._document: Any = None
        self._max_pixels = max_pixels
        self._scale = scale
        try:
            self._document = pdfium.PdfDocument(data)
        except Exception as exc:
            raise WorkerError("PROVIDER_FAILED") from exc

    def close(self) -> None:
        if self._document is not None:
            self._document.close()
            self._document = None

    def __enter__(self) -> "PdfRenderer":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def page_count(self) -> int:
        return len(self._document)

    def _page(self, index: int) -> Any:
        if self._document is None or index < 0 or index >= len(self._document):
            raise WorkerError("INVALID_REQUEST")
        return self._document[index]

    def page_info(self, index: int) -> PdfPageInfo:
        """Real text-layer and image-object facts for one page."""
        page = self._page(index)
        try:
            width = float(page.get_width())
            height = float(page.get_height())
            text_characters = 0
            try:
                text_page = page.get_textpage()
                try:
                    text_characters = int(text_page.count_chars())
                finally:
                    text_page.close()
            except Exception:
                text_characters = 0
            regions: list[dict[str, float]] = []
            for obj in page.get_objects():
                if obj.type not in {_FPDF_PAGEOBJ_IMAGE, _FPDF_PAGEOBJ_FORM}:
                    continue
                try:
                    left, bottom, right, top = obj.get_bounds()
                except Exception:
                    continue
                if width <= 0 or height <= 0 or right <= left or top <= bottom:
                    continue
                try:
                    regions.append(normalized_box(
                        max(0.0, left) / width,
                        max(0.0, height - top) / height,
                        min(right, width) / width - max(0.0, left) / width,
                        min(top, height) / height - max(0.0, bottom) / height,
                    ))
                except WorkerError:
                    continue
            return PdfPageInfo(index, index + 1, width, height, text_characters, tuple(regions))
        finally:
            page.close()

    def _check_pixels(self, width: float, height: float) -> float:
        pixels = width * height * self._scale * self._scale
        if pixels > self._max_pixels:
            raise WorkerError("LIMIT_EXCEEDED")
        return self._scale

    def render_page_png(self, index: int) -> bytes:
        """Rasterize a full page for the OCR route."""
        page = self._page(index)
        try:
            scale = self._check_pixels(float(page.get_width()), float(page.get_height()))
            bitmap = page.render(scale=scale)
            try:
                image = bitmap.to_pil()
            finally:
                bitmap.close()
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return buffer.getvalue()
        finally:
            page.close()

    def render_region_png(self, index: int, region: dict[str, float]) -> bytes:
        """Rasterize one normalized page region for the OCR route."""
        page = self._page(index)
        try:
            width = float(page.get_width())
            height = float(page.get_height())
            self._check_pixels(width, height)
            bitmap = page.render(scale=self._scale)
            try:
                image = bitmap.to_pil()
            finally:
                bitmap.close()
            if image.width * image.height > self._max_pixels:
                raise WorkerError("LIMIT_EXCEEDED")
            left = int(region["x"] * image.width)
            top = int(region["y"] * image.height)
            right = min(image.width, int((region["x"] + region["width"]) * image.width + 0.5))
            bottom = min(image.height, int((region["y"] + region["height"]) * image.height + 0.5))
            if right - left < 2 or bottom - top < 2:
                raise WorkerError("INVALID_REQUEST")
            buffer = io.BytesIO()
            image.crop((left, top, right, bottom)).save(buffer, format="PNG")
            return buffer.getvalue()
        finally:
            page.close()


__all__ = ["PdfPageInfo", "PdfRenderer"]
