"""/v1/runtime-assets projects the admitted language surface, not a hard-coded pair.

The frozen Increment-3 authority admits PaddleOCR for en/ne; the Increment-4A
profile admits en/ne/hi/mr. The endpoint derives its expected surface from the
accepted authority record, reports verified artifact digests only, and
summarizes internal dependencies (e.g. the Tesseract fallback) without
exposing paths.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from document_intelligence.app import create_app
from document_intelligence.config import WorkerSettings
from document_intelligence.lifecycle import WorkerRuntime


def _fabricate_artifact(root: Path, key: str, payload: bytes = b"pinned model bytes") -> str:
    directory = root / key
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "weights.bin").write_bytes(payload)
    digest = hashlib.sha256(b"weights.bin" + payload).hexdigest()
    (directory / ".artifact.sha256").write_text(digest)
    return digest


def _paddle_artifact_key(model_ref: str, model_version: str) -> str:
    return f"ghatana.paddleocr__{model_ref}__{model_version}".replace("/", "_")


async def _runtime_assets(tmp_path: Path, languages: tuple[str, ...], accepted_languages: list[str], internal: tuple[str, ...] = ()) -> dict:
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path, enabled_languages=languages)
    runtime = WorkerRuntime.create(settings)
    paddle = runtime.models.get("ghatana.paddleocr")
    for identity in paddle.language_model_identities:
        _fabricate_artifact(tmp_path, _paddle_artifact_key(identity["modelRef"], identity["modelVersion"]))
    runtime.models.accept_authority_records([{
        "providerRef": "ghatana.paddleocr",
        "languages": accepted_languages,
        "mediaTypes": ["image/png", "image/jpeg"],
        "valueTypes": [],
        "capabilityIds": [],
        "features": [],
    }])
    runtime.internal_dependencies = internal
    for dependency in internal:
        entry = runtime.models.get(dependency)
        entry.loaded = True
        entry.ready = True
    runtime.health.ready = True
    app = create_app(settings, runtime)
    endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/v1/runtime-assets")
    result = await endpoint()
    return json.loads(result.body) if hasattr(result, "body") else result


@pytest.mark.asyncio
async def test_increment3_surface_reports_two_verified_languages(tmp_path) -> None:
    body = await _runtime_assets(tmp_path, ("en", "ne"), ["en", "ne"])
    assert body["providerRef"] == "ghatana.paddleocr"
    assert body["status"] == "ready"
    assert [row["language"] for row in body["languageModels"]] == ["en", "ne"]
    assert all(row["ready"] and row["artifactSha256"] for row in body["languageModels"])
    assert body["internalDependencies"] == []
    assert all("path" not in row for row in body["languageModels"])


@pytest.mark.asyncio
async def test_increment4a_surface_reports_four_verified_languages_and_internal_dependencies(tmp_path) -> None:
    body = await _runtime_assets(tmp_path, ("en", "ne", "hi", "mr"), ["en", "hi", "mr", "ne"], ("ghatana.tesseractocr",))
    assert body["status"] == "ready"
    assert [row["language"] for row in body["languageModels"]] == ["en", "hi", "mr", "ne"]
    assert body["internalDependencies"] == [{"providerRef": "ghatana.tesseractocr", "ready": True}]


@pytest.mark.asyncio
async def test_missing_admitted_language_asset_is_not_ready(tmp_path) -> None:
    """An authority admitting hi/mr while only en/ne assets exist is not ready."""
    body = await _runtime_assets(tmp_path, ("en", "ne"), ["en", "hi", "mr", "ne"])
    assert body["status"] == "not_ready"
    assert [row["language"] for row in body["languageModels"]] == ["en", "ne"]


@pytest.mark.asyncio
async def test_unverified_asset_digest_is_not_ready(tmp_path) -> None:
    settings = WorkerSettings(temp_root=tmp_path, model_cache_root=tmp_path, enabled_languages=("en", "ne"))
    runtime = WorkerRuntime.create(settings)
    paddle = runtime.models.get("ghatana.paddleocr")
    for identity in paddle.language_model_identities:
        _fabricate_artifact(tmp_path, _paddle_artifact_key(identity["modelRef"], identity["modelVersion"]))
    # Corrupt one pinned artifact after the recorded digest.
    key = _paddle_artifact_key(paddle.language_model_identities[0]["modelRef"], paddle.language_model_identities[0]["modelVersion"])
    (tmp_path / key / "weights.bin").write_bytes(b"tampered")
    runtime.models.accept_authority_records([{
        "providerRef": "ghatana.paddleocr",
        "languages": ["en", "ne"],
        "mediaTypes": ["image/png"],
        "valueTypes": [],
        "capabilityIds": [],
        "features": [],
    }])
    runtime.health.ready = True
    app = create_app(settings, runtime)
    endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/v1/runtime-assets")
    body = await endpoint()
    assert body["status"] == "not_ready"
    assert any(row["ready"] is False for row in body["languageModels"])
