from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any, Callable

from ..errors import WorkerError
from ..mapping.embeddings import canonical_projection, validate_projection
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.model_loading import validate_model_artifact


IDENTITY = {"providerRef": "ghatana.minilm", "providerVersion": "0.1.0", "modelRef": "sentence-transformers/all-MiniLM-L6-v2", "modelVersion": "1110a24"}


def _default_model() -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise RuntimeError("SentenceTransformers is not provisioned") from exc
    path = Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", ".models")) / "ghatana.minilm__sentence-transformers_all-MiniLM-L6-v2__1110a24"
    validate_model_artifact(path)
    return SentenceTransformer(
        str(path),
        local_files_only=True,
        trust_remote_code=False,
        model_kwargs={"use_safetensors": True},
    )


class MiniLmEmbedder:
    provider_ref = "ghatana.minilm"

    def __init__(self, model_factory: Callable[[], Any] = _default_model) -> None:
        self._model_factory = model_factory
        self._model: Any = None

    def capabilities(self) -> dict[str, Any]:
        return {"maxDimensions": 384, "modelRef": IDENTITY["modelRef"]}

    def identity(self) -> dict[str, str]:
        return dict(IDENTITY)

    def warm(self) -> "MiniLmEmbedder":
        self._instance()
        return self

    def _instance(self) -> Any:
        if self._model is None:
            self._model = self._model_factory()
        return self._model

    def embed(self, descriptor: dict[str, Any], *, deadline: Deadline, token: CancellationToken) -> dict[str, Any]:
        token.raise_if_cancelled()
        deadline.require_remaining()
        validate_projection(descriptor)
        projection = canonical_projection(descriptor)
        try:
            model = self._instance()
            if hasattr(model, "eval"):
                model.eval()
            encoded = model.encode([projection], normalize_embeddings=False, convert_to_numpy=True)
            vector = encoded[0].tolist() if hasattr(encoded[0], "tolist") else list(encoded[0])
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("PROVIDER_FAILED", provider_ref=self.provider_ref) from exc
        if len(vector) != 384 or any(not isinstance(item, (float, int)) or not math.isfinite(item) for item in vector):
            raise WorkerError("INVALID_PROVIDER_OUTPUT", provider_ref=self.provider_ref)
        return {"model": IDENTITY, "dimensions": 384, "values": [float(item) for item in vector]}
