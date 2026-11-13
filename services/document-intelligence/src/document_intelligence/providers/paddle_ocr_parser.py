from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any, Callable

from PIL import Image, UnidentifiedImageError
import io
import numpy as np

from ..errors import WorkerError
from ..mapping.parsed_document import normalized_box
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline


IDENTITY_BASE = {"providerRef": "ghatana.paddleocr", "providerVersion": "0.1.0"}
# Language binding, model identity, and physical artifact are separate
# concepts.  The single PP-OCRv5 Devanagari recognition artifact covers
# Nepali, Hindi, and Marathi, so all three language bindings resolve to the
# same physical cache entry rather than per-language duplicates.
_DEVANAGARI_ARTIFACT = ("PP-OCRv5-devanagari-shared", "PP-OCRv5-local-devanagari-shared", "devanagari_PP-OCRv5_mobile_rec")
_LANGUAGE_MODELS = {
    "en": ("PP-OCRv5-en", "PP-OCRv5-local-en", "en_PP-OCRv5_mobile_rec"),
    "ne": _DEVANAGARI_ARTIFACT,
    "hi": _DEVANAGARI_ARTIFACT,
    "mr": _DEVANAGARI_ARTIFACT,
}


def paddle_model_path(language: str, cache_root: Path | None = None) -> Path:
    """Return the repository-local Paddle artifact path for ``language``."""
    try:
        model_ref, model_version, _ = _LANGUAGE_MODELS[language]
    except KeyError as exc:
        raise ValueError("unsupported PaddleOCR language") from exc
    root = cache_root or Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", ".models"))
    return root / f"ghatana.paddleocr__{model_ref}__{model_version}"


def paddle_model_is_provisioned(language: str, cache_root: Path | None = None) -> bool:
    """Check local artifact presence without attempting a hub or network load."""
    root = paddle_model_path(language, cache_root)
    if not root.is_dir() or (root / "PROVISIONING_REQUIRED").exists():
        return False
    if not (root / ".artifact.sha256").is_file():
        return False
    return any(path.is_file() for path in root.rglob("*") if path.name not in {".artifact.sha256", "PROVISIONING_REQUIRED"})


def _default_ocr(language: str) -> Any:
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError("PaddleOCR is not provisioned") from exc
    try:
        model_ref, model_version, recognition = _LANGUAGE_MODELS[language]
    except KeyError as exc:
        raise RuntimeError("unsupported PaddleOCR language") from exc
    root = paddle_model_path(language)
    if not paddle_model_is_provisioned(language, root.parent):
        raise RuntimeError(f"PaddleOCR local artifact is not provisioned for {language}")
    return PaddleOCR(text_detection_model_name="PP-OCRv5_server_det", text_detection_model_dir=str(root / "detection"), text_recognition_model_name=recognition, text_recognition_model_dir=str(root / "recognition"), use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, text_det_limit_side_len=960, text_det_limit_type="min", enable_mkldnn=False)


def _pixel_ceiling(limits: dict[str, int] | None) -> int:
    """I6-55: PIL's decompression-bomb ceiling for this request.

    Installed before ``Image.open`` so the declared-dimension bound — not a
    stale global — governs every decode.  The explicit guards below remain
    the authoritative policy checks.
    """
    values = limits or {}
    return int(values.get("maxImageDimensionPx", 16_000)) ** 2


def _image_guards(image: Any, limits: dict[str, int] | None, provider_ref: str) -> None:
    """I6-55 decompression guards, applied before any pixel decode.

    Bounds declared dimensions (``maxImageDimensionPx``), frame count
    (``maxImageFrames``), and the decoded memory estimate
    (``maxDecodedImageBytes``, approximated as w*h*bands*frames — a
    conservative lower bound for multi-byte-per-band modes).
    """
    values = limits or {}
    max_dimension = int(values.get("maxImageDimensionPx", 16_000))
    max_frames = int(values.get("maxImageFrames", 4))
    max_decoded = int(values.get("maxDecodedImageBytes", 512 * 1024 * 1024))
    width, height = image.size
    if width <= 0 or height <= 0 or width > max_dimension or height > max_dimension:
        raise WorkerError("LIMIT_EXCEEDED", provider_ref=provider_ref)
    frames = int(getattr(image, "n_frames", 1) or 1)
    if frames > max_frames:
        raise WorkerError("LIMIT_EXCEEDED", provider_ref=provider_ref)
    channels = max(1, len(image.getbands()))
    if width * height * channels * frames > max_decoded:
        raise WorkerError("LIMIT_EXCEEDED", provider_ref=provider_ref)


def _quad_box(value: Any, width: int, height: int) -> dict[str, float] | None:
    if isinstance(value, dict):
        value = value.get("rec_polys", value.get("dt_polys", value.get("bbox")))
    try:
        points = list(value)
        if len(points) == 4 and all(hasattr(point, "__len__") and len(point) == 2 for point in points):
            xs = [float(point[0]) for point in points]
            ys = [float(point[1]) for point in points]
            left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        elif len(points) == 4:
            left, top, right, bottom = map(float, points)
        else:
            return None
        return normalized_box(left / width, top / height, (right - left) / width, (bottom - top) / height)
    except (TypeError, ValueError, IndexError, WorkerError):
        return None


def _legibility_factor(image: Any, polygon: Any) -> float:
    """Contrast-based legibility factor for an OCR region.

    OCR recognition confidence does not reflect ink legibility: clean
    low-contrast text scores high while downstream consumers treat the
    confidence as a review signal. The factor blends the measured foreground/
    background luminance separation of the region's pixels into the emitted
    confidence so faded or low-contrast strokes honestly read lower.
    """
    try:
        points = np.asarray(polygon, dtype=np.float64)
        if points.ndim != 2 or points.shape[0] != 4:
            return 1.0
        left = int(max(0, np.floor(points[:, 0].min())))
        right = int(min(image.shape[1], np.ceil(points[:, 0].max())))
        top = int(max(0, np.floor(points[:, 1].min())))
        bottom = int(min(image.shape[0], np.ceil(points[:, 1].max())))
        if right - left < 2 or bottom - top < 2:
            return 1.0
        crop = image[top:bottom, left:right].astype(np.float64)
        luminance = 0.2126 * crop[..., 0] + 0.7152 * crop[..., 1] + 0.0722 * crop[..., 2]
        ink = float(np.percentile(luminance, 10))
        background = float(np.percentile(luminance, 90))
        if background <= ink + 1.0:
            return 1.0
        darkness = (background - ink) / max(background, 1.0)
        return 0.7 + 0.3 * min(1.0, darkness / 0.8)
    except Exception:
        return 1.0


def map_paddle_regions(regions: list[dict[str, Any]], width: int, height: int, language: str) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    for index, region in enumerate(regions, 1):
        text = region.get("text", region.get("rec_texts"))
        score = region.get("score", region.get("rec_scores"))
        box = _quad_box(region.get("polygon", region.get("dt_poly", region.get("bbox"))), width, height)
        if isinstance(text, list):
            text = text[0] if text else ""
        if isinstance(score, list):
            score = score[0] if score else None
        if not isinstance(text, str) or not text or box is None:
            continue
        line: dict[str, Any] = {"lineId": f"p1-b{index}-l1", "text": text, "boundingRegion": box, "languageTag": language}
        if isinstance(score, (int, float)) and math.isfinite(score) and 0 <= score <= 1:
            line["confidence"] = float(score)
        blocks.append({"blockId": f"p1-b{index}", "kind": "TEXT", "boundingRegion": box, "lines": [line], "languageTag": language})
    model_ref, model_version, _ = _LANGUAGE_MODELS[language]
    identity = {**IDENTITY_BASE, "modelRef": model_ref, "modelVersion": model_version}
    return {"pages": [{"pageNumber": 1, "blocks": blocks, "tables": [], "languageTag": language}], "providerProvenance": identity, "languageTag": language, "quality": {}}


class PaddleOcrParser:
    provider_ref = "ghatana.paddleocr"

    def __init__(self, ocr_factory: Callable[[str], Any] = _default_ocr, admitted_languages: tuple[str, ...] = ("en", "ne")) -> None:
        if any(language not in _LANGUAGE_MODELS for language in admitted_languages):
            raise ValueError("unsupported PaddleOCR language")
        self._ocr_factory = ocr_factory
        self._admitted_languages = admitted_languages
        self._models: dict[str, Any] = {}

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": ["image/png", "image/jpeg"], "supportsCoordinates": True, "supportsTables": False, "supportsLanguages": True, "supportedLanguages": list(self._admitted_languages)}

    @staticmethod
    def model_path(language: str, cache_root: Path | None = None) -> Path:
        return paddle_model_path(language, cache_root)

    @staticmethod
    def model_is_provisioned(language: str, cache_root: Path | None = None) -> bool:
        return paddle_model_is_provisioned(language, cache_root)

    def artifact_models(self) -> tuple[tuple[str, str], ...]:
        """Distinct physical (modelRef, modelVersion) artifacts this instance needs."""
        return tuple(sorted({(model_ref, model_version) for model_ref, model_version, _ in (_LANGUAGE_MODELS[language] for language in self._admitted_languages)}))

    def identity(self) -> dict[str, str]:
        return {**IDENTITY_BASE, "modelRef": "PP-OCRv5-en", "modelVersion": "PP-OCRv5-local-en"}

    def language_model_identities(self) -> tuple[dict[str, str], ...]:
        """Expose the exact admitted model selected for each language."""
        return tuple(
            {
                "language": language,
                "modelRef": _LANGUAGE_MODELS[language][0],
                "modelVersion": _LANGUAGE_MODELS[language][1],
            }
            for language in self._admitted_languages
        )

    def warm(self) -> "PaddleOcrParser":
        for language in self._admitted_languages:
            self._model(language)
        return self

    def _model(self, language: str) -> Any:
        if language not in self._models:
            self._models[language] = self._ocr_factory(language)
        return self._models[language]

    def parse(self, data: bytes, *, media_type: str, language: str | None, deadline: Deadline, token: CancellationToken, limits: dict[str, int] | None = None) -> dict[str, Any]:
        if media_type not in {"image/png", "image/jpeg"}:
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        if language not in self._admitted_languages:
            raise WorkerError("UNSUPPORTED_LANGUAGE", provider_ref=self.provider_ref)
        try:
            Image.MAX_IMAGE_PIXELS = _pixel_ceiling(limits)
            image = Image.open(io.BytesIO(data))
            _image_guards(image, limits, self.provider_ref)
            actual_format = (image.format or "").lower()
            expected_formats = {"image/png": {"png"}, "image/jpeg": {"jpeg", "jpg"}}
            if actual_format not in expected_formats[media_type]:
                raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
            image.verify()
            image = Image.open(io.BytesIO(data))
            _image_guards(image, limits, self.provider_ref)
            image = image.convert("RGB")
            width, height = image.size
        except Image.DecompressionBombError as exc:
            raise WorkerError("LIMIT_EXCEEDED", provider_ref=self.provider_ref) from exc
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise WorkerError("PROVIDER_FAILED", provider_ref=self.provider_ref) from exc
        token.raise_if_cancelled()
        deadline.require_remaining()
        try:
            image_array = np.asarray(image)
            raw = self._model(language).predict(image_array)
            regions: list[dict[str, Any]] = []
            for item in raw or []:
                payload = item if isinstance(item, dict) else getattr(item, "json", {})
                if isinstance(payload, dict) and isinstance(payload.get("res"), dict):
                    payload = payload["res"]
                if not isinstance(payload, dict):
                    continue
                candidate = payload.get("regions", payload.get("res", []))
                if isinstance(candidate, list):
                    regions.extend(candidate)
                texts = payload.get("rec_texts", [])
                scores = payload.get("rec_scores", [])
                polygons = payload.get("rec_polys", payload.get("dt_polys", []))
                if isinstance(texts, list) and isinstance(polygons, list):
                    regions.extend({"text": text, "score": scores[index] if index < len(scores) else None, "polygon": polygons[index]} for index, text in enumerate(texts) if index < len(polygons))
                if not regions and {"text", "bbox"}.issubset(payload):
                    regions.append(payload)
            for region in regions:
                score = region.get("score")
                if isinstance(score, (int, float)) and math.isfinite(score):
                    polygon = region.get("polygon")
                    if polygon is not None:
                        region["score"] = min(1.0, max(0.0, score * _legibility_factor(image_array, polygon)))
            return map_paddle_regions(regions, width, height, language)
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("PROVIDER_FAILED", provider_ref=self.provider_ref) from exc
