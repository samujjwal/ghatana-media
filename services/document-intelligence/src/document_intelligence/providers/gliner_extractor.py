from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Callable

from ..errors import WorkerError
from ..mapping.candidates import map_entity
from ..mapping.evidence import project_lines
from ..mapping.gliner_labels import build_label_policy
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.model_loading import validate_model_artifact


IDENTITY = {"providerRef": "ghatana.gliner", "providerVersion": "0.1.0", "modelRef": "urchade/gliner_multi-v2.1", "modelVersion": "443d26d"}


def _default_model() -> Any:
    try:
        from gliner import GLiNER
    except ImportError as exc:
        raise RuntimeError("GLiNER is not provisioned") from exc
    path = Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", ".models")) / "ghatana.gliner__urchade_gliner_multi-v2.1__443d26d"
    validate_model_artifact(path)
    return GLiNER.from_pretrained(
        str(path),
        cache_dir=path / "hf-cache",
        local_files_only=True,
    )


class GlinerExtractor:
    provider_ref = "ghatana.gliner"

    def __init__(self, model_factory: Callable[[], Any] = _default_model, token_budget: int = 384, overlap: int = 48, admitted_languages: tuple[str, ...] = ("en", "ne", "hi", "mr")) -> None:
        self._model_factory = model_factory
        self._model: Any = None
        self.token_budget = token_budget
        self.overlap = overlap
        self.admitted_languages = admitted_languages

    def capabilities(self) -> dict[str, Any]:
        return {"supportedValueTypes": ["TEXT", "IDENTIFIER"], "supportsConfidenceScores": True, "supportsMultipleCardinality": True, "supportsLanguages": True, "supportedLanguages": list(self.admitted_languages)}

    def identity(self) -> dict[str, str]:
        return dict(IDENTITY)

    def warm(self) -> "GlinerExtractor":
        self._instance()
        return self

    def _instance(self) -> Any:
        if self._model is None:
            self._model = self._model_factory()
        return self._model

    def _chunks(self, text: str) -> list[tuple[int, int, str]]:
        if not text:
            return []
        words = list(re.finditer(r"\S+", text, re.UNICODE))
        chunks: list[tuple[int, int, str]] = []
        start_word = 0
        while start_word < len(words):
            end_word = min(len(words), start_word + self.token_budget)
            start_char = words[start_word].start()
            end_char = words[end_word - 1].end()
            chunks.append((start_char, end_char, text[start_char:end_char]))
            if end_word == len(words):
                break
            start_word = max(start_word + 1, end_word - self.overlap)
        return chunks

    def extract(self, parsed: dict[str, Any], fields: list[dict[str, Any]], *, deadline: Deadline, token: CancellationToken, language: str | None = None) -> dict[str, Any]:
        token.raise_if_cancelled()
        deadline.require_remaining()
        if language is not None and language not in self.admitted_languages:
            raise WorkerError("UNSUPPORTED_LANGUAGE", provider_ref=self.provider_ref)
        text, intervals = project_lines(parsed.get("pages", []))
        policy = build_label_policy(fields, language=language)
        field_types = {field["fieldId"]: (field["valueType"], field.get("cardinality", "SINGLE")) for field in fields if field.get("valueType") in {"TEXT", "IDENTIFIER"}}
        candidates: list[dict[str, Any]] = []
        seen: set[tuple[str, int, int, str]] = set()
        try:
            model = self._instance()
            for global_start, _global_end, chunk in self._chunks(text):
                token.raise_if_cancelled()
                deadline.require_remaining()
                raw_entities = model.predict_entities(chunk, list(policy.labels), threshold=0.0)
                for entity in raw_entities or []:
                    label = str(entity.get("label", ""))
                    field_id = policy.label_to_field.get(label.casefold())
                    if field_id is None or field_id not in field_types:
                        continue
                    start = global_start + int(entity.get("start", -1))
                    end = global_start + int(entity.get("end", -1))
                    score = float(entity.get("score", -1))
                    key = (field_id, start, end, text[start:end] if 0 <= start <= end <= len(text) else "")
                    if key in seen:
                        continue
                    mapped = map_entity(field_id, field_types[field_id][0], start, end, score, text, intervals, IDENTITY)
                    if mapped is not None:
                        seen.add(key)
                        candidates.append(mapped)
                        if len(candidates) >= 16_000:
                            break
            # Deterministic total order for selection: confidence first, then
            # document position (page, block, line, span), then raw value. Equal
            # scores never inherit model return order.
            candidates.sort(key=lambda candidate: (candidate["fieldId"], -candidate["confidence"], candidate["evidence"][0]["pageNumber"], candidate["evidence"][0].get("blockId", ""), candidate["evidence"][0].get("lineId", ""), candidate["evidence"][0].get("textSpan", {}).get("start", 0), candidate["evidence"][0].get("textSpan", {}).get("end", 0), candidate["value"]["value"]))
            selected: list[dict[str, Any]] = []
            field_counts: dict[str, int] = {}
            for candidate in candidates:
                field_id = candidate["fieldId"]
                limit = 32 if field_types[field_id][1] == "MULTIPLE" else 1
                if field_counts.get(field_id, 0) < limit:
                    selected.append(candidate)
                    field_counts[field_id] = field_counts.get(field_id, 0) + 1
            selected.sort(key=lambda candidate: (candidate["fieldId"], candidate["evidence"][0]["pageNumber"], candidate["evidence"][0].get("textSpan", {}).get("start", 0), candidate["value"]["value"]))
            return {"candidates": selected, "provider": IDENTITY}
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("PROVIDER_FAILED", provider_ref=self.provider_ref) from exc
