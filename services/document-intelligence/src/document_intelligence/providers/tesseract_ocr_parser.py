from __future__ import annotations

import csv
import io
import os
import shutil
from pathlib import Path
from typing import Any, Callable

from PIL import Image, UnidentifiedImageError

from ..errors import WorkerError
from ..mapping.parsed_document import normalized_box
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.subprocess_runner import CompletedSubprocess, run_bounded_subprocess

IDENTITY = {"providerRef": "ghatana.tesseractocr", "providerVersion": "0.1.0", "modelRef": "tesseract-5", "modelVersion": "local-traineddata"}
_LANG = {"en": "eng", "ne": "nep", "hi": "hin", "mr": "mar"}
_WORKER_ROOT = Path(__file__).resolve().parents[3]


def _provisioned_runtime() -> tuple[str, Path, Path] | None:
    """Return (executable, library_dir, tessdata_dir) for the worker-provisioned runtime."""
    override = os.getenv("DOCUMENT_INTELLIGENCE_TESSERACT_RUNTIME")
    root = Path(override) if override else _WORKER_ROOT / ".models" / "tesseract-runtime"
    binary = root / "usr/bin/tesseract"
    library = root / "usr/lib/x86_64-linux-gnu"
    tessdata = root / "usr/share/tesseract-ocr/5/tessdata"
    if binary.is_file() and tessdata.is_dir():
        return str(binary), library, tessdata
    return None


def _pixel_ceiling(limits: dict[str, int] | None) -> int:
    """I6-55: PIL's decompression-bomb ceiling for this request.

    Installed before ``Image.open`` so the declared-dimension bound — not a
    stale global — governs every decode.  The explicit guards below remain
    the authoritative policy checks.
    """
    values = limits or {}
    return int(values.get("maxImageDimensionPx", 16_000)) ** 2


def _image_guards(image: Any, limits: dict[str, int] | None, provider_ref: str) -> None:
    """I6-55 decompression guards, applied before the payload reaches the
    native OCR subprocess.

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


class TesseractOcrParser:
    provider_ref = "ghatana.tesseractocr"

    def __init__(self, runner: Callable[..., CompletedSubprocess] = run_bounded_subprocess, executable: str | None = None, tessdata_dir: Path | None = None) -> None:
        self._runner = runner
        provisioned = _provisioned_runtime() if executable is None and runner is run_bounded_subprocess else None
        self._executable = executable or (provisioned[0] if provisioned else shutil.which("tesseract"))
        self._library_dir = provisioned[1] if provisioned else None
        self._tessdata_dir = tessdata_dir or (provisioned[2] if provisioned else None)

    def _subprocess_env(self) -> dict[str, str] | None:
        env: dict[str, str] = {}
        if self._library_dir is not None:
            env["LD_LIBRARY_PATH"] = str(self._library_dir)
        if self._tessdata_dir is not None:
            env["TESSDATA_PREFIX"] = str(self._tessdata_dir)
        return env or None

    def identity(self) -> dict[str, str]: return dict(IDENTITY)

    def artifact_cache_keys(self) -> tuple[str, ...]:
        """The provisioned runtime tree is the model artifact; its cache key
        is recorded as `cacheKey` in the model manifest."""
        return ("tesseract-runtime",)

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": ["image/png", "image/jpeg"], "supportsCoordinates": True, "supportsTables": False,
                "supportsLanguages": True, "supportedLanguages": list(self.available_languages())}

    def available_languages(self) -> tuple[str, ...]:
        if not self._executable:
            return ()
        argv = [self._executable]
        if self._tessdata_dir is not None:
            argv += ["--tessdata-dir", str(self._tessdata_dir)]
        argv.append("--list-langs")
        try:
            env = dict(os.environ)
            env.update(self._subprocess_env() or {})
            result = self._runner(
                argv,
                deadline=Deadline(10_000, margin_ms=0),
                token=CancellationToken(),
                max_output_bytes=1024 * 1024,
                env=env,
            )
        except (OSError, WorkerError, ValueError):
            return ()
        if result.returncode != 0:
            return ()
        available = set(result.stdout.decode("utf-8", "replace").split())
        return tuple(language for language, traineddata in _LANG.items() if traineddata in available)

    def warm(self) -> "TesseractOcrParser":
        if self._runner is run_bounded_subprocess and set(self.available_languages()) != set(_LANG):
            raise RuntimeError("Tesseract EN/NE/HI/MR traineddata is not provisioned")
        return self

    def parse(self, data: bytes, *, media_type: str, language: str | None, limits: dict[str, int], deadline: Deadline, token: CancellationToken) -> dict[str, Any]:
        if media_type not in {"image/png", "image/jpeg"}: raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        if language not in _LANG: raise WorkerError("UNSUPPORTED_LANGUAGE", provider_ref=self.provider_ref)
        token.raise_if_cancelled()
        deadline.require_remaining()
        try:
            Image.MAX_IMAGE_PIXELS = _pixel_ceiling(limits)
            image = Image.open(io.BytesIO(data)); _image_guards(image, limits, self.provider_ref); width, height = image.size; image.verify()
        except Image.DecompressionBombError as exc:
            raise WorkerError("LIMIT_EXCEEDED", provider_ref=self.provider_ref) from exc
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise WorkerError("PROVIDER_FAILED", provider_ref=self.provider_ref) from exc
        token.raise_if_cancelled()
        deadline.require_remaining()
        argv = [self._executable or "tesseract"]
        if self._tessdata_dir is not None:
            argv += ["--tessdata-dir", str(self._tessdata_dir)]
        argv += ["stdin", "stdout", "-l", _LANG[language], "tsv"]
        result = self._runner(argv, input_data=data,
                              deadline=deadline, token=token, max_output_bytes=min(limits.get("maxTextCharacters", 2_000_000) * 4, 16 * 1024 * 1024), env=self._subprocess_env())
        if result.returncode != 0: raise WorkerError("PROVIDER_FAILED", retryable=True, provider_ref=self.provider_ref)
        try:
            rows = csv.DictReader(io.StringIO(result.stdout.decode("utf-8", "strict")), delimiter="\t")
            blocks = []
            for index, row in enumerate(rows, 1):
                text = row.get("text", "").strip()
                confidence = float(row.get("conf", "-1"))
                if not text or confidence < 0: continue
                left, top, w, h = (int(row[key]) for key in ("left", "top", "width", "height"))
                box = normalized_box(left / width, top / height, w / width, h / height)
                line = {"lineId": f"p1-b{index}-l1", "text": text, "boundingRegion": box, "confidence": min(confidence / 100, 1.0), "languageTag": language}
                blocks.append({"blockId": f"p1-b{index}", "kind": "TEXT", "boundingRegion": box, "lines": [line], "languageTag": language})
        except (KeyError, TypeError, ValueError, UnicodeError, csv.Error, WorkerError) as exc:
            raise WorkerError("INVALID_PROVIDER_OUTPUT", provider_ref=self.provider_ref) from exc
        return {"pages": [{"pageNumber": 1, "blocks": blocks, "tables": [], "languageTag": language}], "providerProvenance": self.identity(), "languageTag": language, "quality": {}}
