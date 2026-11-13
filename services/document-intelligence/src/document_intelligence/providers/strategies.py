from __future__ import annotations

from typing import Any, Mapping, Sequence

from ..errors import WorkerError
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline

_RETRYABLE_CODES = frozenset({"PROVIDER_BUSY", "PROVIDER_UNAVAILABLE", "PROVIDER_FAILED", "TIMEOUT"})


def merge_parsed_documents(primary: dict[str, Any], secondary: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
    """Deterministically merge pages, suppressing exact duplicate text/regions."""
    by_page: dict[int, dict[str, Any]] = {}
    for source in (primary, secondary):
        for page in source.get("pages", []):
            number = int(page.get("pageNumber", 0))
            target = by_page.setdefault(number, {"pageNumber": number, "blocks": [], "tables": []})
            seen = {(line.get("text"), repr(line.get("boundingRegion"))) for block in target["blocks"] for line in block.get("lines", [])}
            for block in page.get("blocks", []):
                lines = [line for line in block.get("lines", []) if (line.get("text"), repr(line.get("boundingRegion"))) not in seen]
                if lines:
                    copied = dict(block); copied["lines"] = lines
                    copied["blockId"] = f"p{number}-b{len(target['blocks']) + 1}"
                    for i, line in enumerate(lines, 1): line["lineId"] = f"{copied['blockId']}-l{i}"
                    target["blocks"].append(copied)
                    seen.update((line.get("text"), repr(line.get("boundingRegion"))) for line in lines)
            if source is primary:
                target["tables"].extend(page.get("tables", []))
    return {"pages": [by_page[key] for key in sorted(by_page)], "providerProvenance": identity, "quality": {}}


class HybridPdfParser:
    provider_ref = "ghatana.hybrid-pdf"
    is_strategy = True

    def __init__(self, primary: str = "ghatana.docling", ocr: str = "ghatana.tesseractocr", minimum_text_characters: int = 32) -> None:
        self.primary, self.ocr, self.minimum_text_characters = primary, ocr, minimum_text_characters

    def identity(self) -> dict[str, str]:
        return {"providerRef": self.provider_ref, "providerVersion": "0.1.0", "modelRef": "hybrid-pdf-v1", "modelVersion": "policy-v1"}

    def capabilities(self) -> dict[str, Any]: return {"mediaTypes": ["application/pdf"], "supportsTables": True, "supportsCoordinates": True}
    def warm(self) -> "HybridPdfParser": return self

    async def parse(self, data: bytes, *, media_type: str, language: str | None, limits: Mapping[str, int], deadline: Deadline, token: CancellationToken, executor: Any, call_stack: tuple[str, ...]) -> dict[str, Any]:
        if media_type != "application/pdf": raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        primary = await executor.parse(self.primary, data, media_type=media_type, language=language, limits=limits, deadline=deadline, token=token, call_stack=call_stack)
        chars = sum(len(line.get("text", "")) for page in primary.get("pages", []) for block in page.get("blocks", []) for line in block.get("lines", []))
        # OCR invocation is policy-controlled. A PDF-capable OCR child may be supplied by composition/tests.
        if chars >= self.minimum_text_characters: return {**primary, "providerProvenance": self.identity()}
        secondary = await executor.parse(self.ocr, data, media_type=media_type, language=language, limits=limits, deadline=deadline, token=token, call_stack=call_stack)
        return merge_parsed_documents(primary, secondary, self.identity())


class ResilientParser:
    provider_ref = "ghatana.resilient-parser"
    is_strategy = True

    def __init__(self, routes: Mapping[str, Sequence[str]], *, max_attempts: int = 2, minimum_remaining_budget_ms: int = 1000) -> None:
        self.routes = {key: tuple(value) for key, value in routes.items()}
        self.max_attempts = max_attempts
        self.minimum_remaining_budget_ms = minimum_remaining_budget_ms

    def identity(self) -> dict[str, str]:
        return {"providerRef": self.provider_ref, "providerVersion": "0.1.0", "modelRef": "governed-fallback", "modelVersion": "policy-v1"}
    def capabilities(self) -> dict[str, Any]: return {"mediaTypes": sorted(self.routes)}
    def warm(self) -> "ResilientParser": return self

    async def parse(self, data: bytes, *, media_type: str, language: str | None, limits: Mapping[str, int], deadline: Deadline, token: CancellationToken, executor: Any, call_stack: tuple[str, ...]) -> dict[str, Any]:
        providers = self.routes.get(media_type, ())
        if not providers: raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        last: WorkerError | None = None
        for provider in providers[:self.max_attempts]:
            token.raise_if_cancelled()
            if deadline.remaining_ms() < self.minimum_remaining_budget_ms:
                if last is not None: raise last
                raise WorkerError("TIMEOUT", retryable=True, provider_ref=self.provider_ref)
            try:
                # The original absolute deadline, token, and call stack are deliberately preserved.
                result = await executor.parse(provider, data, media_type=media_type, language=language, limits=limits, deadline=deadline, token=token, call_stack=call_stack)
                quality = dict(result.get("quality", {}))
                warnings = list(quality.get("warnings", []))
                warnings.append(f"selectedProviderRef:{provider}")
                quality["warnings"] = warnings
                return {**result, "providerProvenance": self.identity(), "quality": quality}
            except WorkerError as exc:
                if exc.code in {"CANCELLED", "INVALID_REQUEST", "INVALID_PROVIDER_OUTPUT", "LIMIT_EXCEEDED", "UNSUPPORTED_MEDIA_TYPE", "UNSUPPORTED_LANGUAGE"} or exc.code not in _RETRYABLE_CODES:
                    raise
                last = exc
        if last is not None: raise last
        raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=self.provider_ref)


# Compatibility aliases.  Keep the historical module and its public merge
# helper, but make all worker composition use the routing-backed Increment-4A
# strategy implementation.
from ..strategies.hybrid_pdf import HybridPdfStrategy as _HybridPdfStrategy, merge_parsed_documents as _merge_parsed_documents
from ..strategies.resilient_parser import ResilientParser as _ResilientParser

HybridPdfParser = _HybridPdfStrategy
ResilientParser = _ResilientParser
merge_parsed_documents = _merge_parsed_documents
