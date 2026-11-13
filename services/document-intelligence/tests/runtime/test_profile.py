from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from document_intelligence.config import (
    FROZEN_INCREMENT3_MODEL_MANIFEST_SHA256,
    WorkerSettings,
    _FROZEN_INCREMENT3_MODEL_MANIFEST,
    _FROZEN_INCREMENT3_PROVIDER_AUTHORITY,
)
from document_intelligence.runtime.provider_authority import FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256
from document_intelligence.profile import load_worker_profile


def material(tmp_path: Path) -> tuple[Path, Path]:
    (tmp_path / "models").mkdir()
    (tmp_path / "routing").mkdir()
    model = tmp_path / "models" / "manifest.yaml"
    route = tmp_path / "routing" / "routing.yaml"
    model.write_text("models: []\n", encoding="utf-8")
    route.write_text("routes: {}\n", encoding="utf-8")
    return model, route


def profile_text(**overrides: str) -> str:
    values = {
        "profile": "increment4a",
        "providers": "  - ghatana.docling",
        "media": "  - application/pdf",
        "languages": "  - en",
        "model": "models/manifest.yaml",
        "modelHash": "0" * 64,
        "routing": "routing/routing.yaml",
    }
    values.update(overrides)
    return f"""schemaVersion: document-intelligence.profile.v1
profileId: {values['profile']}
enabledProviders:
{values['providers']}
mediaTypes:
{values['media']}
candidateLanguages:
{values['languages']}
modelManifest: {values['model']}
modelManifestSha256: "{values['modelHash']}"
routingPolicy: {values['routing']}
"""


def write_profile(tmp_path: Path, content: str) -> Path:
    directory = tmp_path / "profiles"
    directory.mkdir(exist_ok=True)
    path = directory / "profile.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def test_missing_and_malformed_profiles_fail(tmp_path):
    with pytest.raises(ValueError, match="does not exist"):
        load_worker_profile(tmp_path / "missing.yaml")
    path = write_profile(tmp_path, "[invalid")
    with pytest.raises(ValueError, match="malformed"):
        load_worker_profile(path)


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"providers": "  - ghatana.unknown"}, "unknown provider"),
        ({"media": "  - application/pdf\n  - application/pdf"}, "duplicates"),
        ({"languages": "  - en\n  - en"}, "duplicates"),
        ({"profile": "../bad"}, "identifier"),
        ({"model": "missing.yaml"}, "does not exist"),
    ],
)
def test_invalid_profile_material_fails(tmp_path, override, message):
    material(tmp_path)
    with pytest.raises(ValueError, match=message):
        load_worker_profile(write_profile(tmp_path, profile_text(**override)))


def test_increment3_defaults_without_profile(monkeypatch):
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH", raising=False)
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_PROFILE_ID", raising=False)
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_ENABLED_LANGUAGES", raising=False)
    settings = WorkerSettings.from_env()
    assert settings.profile is None
    assert settings.allowed_media_types == ("application/pdf", "image/png", "image/jpeg")
    assert settings.request_languages == ("en", "ne")
    assert settings.expected_provider_authority_path == _FROZEN_INCREMENT3_PROVIDER_AUTHORITY
    assert settings.expected_provider_authority_sha256 == FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256
    assert settings.selected_profile_id == "default"
    assert settings.profile_identity_explicit is False
    assert settings.model_manifest_path == _FROZEN_INCREMENT3_MODEL_MANIFEST
    assert settings.expected_model_manifest_sha256 == FROZEN_INCREMENT3_MODEL_MANIFEST_SHA256
    assert settings.expected_provider_catalog_fingerprint == FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256


def test_default_profile_identity_can_be_explicitly_selected(monkeypatch):
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH", raising=False)
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_PROFILE_ID", "default")
    settings = WorkerSettings.from_env()
    assert settings.selected_profile_id == "default"
    assert settings.profile_identity_explicit is True
    assert settings.profile is None


def test_profile_identity_selection_must_match_configured_profile(tmp_path, monkeypatch):
    material(tmp_path)
    profile = write_profile(tmp_path, profile_text())
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH", str(profile))
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_PROFILE_ID", "default")
    with pytest.raises(ValueError, match="does not match"):
        WorkerSettings.from_env()

    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH")
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_PROFILE_ID", "increment4a")
    with pytest.raises(ValueError, match="requires a matching configured profile"):
        WorkerSettings.from_env()


def test_default_identity_does_not_allow_an_invented_yaml_profile(tmp_path, monkeypatch):
    material(tmp_path)
    profile = write_profile(tmp_path, profile_text(profile="default"))
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH", str(profile))
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_PROFILE_ID", raising=False)
    with pytest.raises(ValueError, match="existing no-profile configuration"):
        WorkerSettings.from_env()


def test_expected_authority_override_cannot_replace_frozen_increment3(monkeypatch, tmp_path):
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH", raising=False)
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_EXPECTED_PROVIDER_AUTHORITY", str(tmp_path / "alternate.json"))
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_EXPECTED_PROVIDER_AUTHORITY_SHA256", "f" * 64)
    with pytest.raises(ValueError, match="selected frozen/profile pin"):
        WorkerSettings.from_env()


def test_expected_authority_override_cannot_replace_profile_pin(tmp_path, monkeypatch):
    material(tmp_path)
    pinned = tmp_path / "authority.json"
    pinned.write_text('{"accepted":[]}', encoding="utf-8")
    pinned_sha = hashlib.sha256(pinned.read_bytes()).hexdigest()
    profile = write_profile(
        tmp_path,
        profile_text() + f"providerAuthority: {pinned.name}\nproviderAuthoritySha256: {pinned_sha}\n",
    )
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH", str(profile))
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_EXPECTED_PROVIDER_AUTHORITY", str(tmp_path / "alternate.json"))
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_EXPECTED_PROVIDER_AUTHORITY_SHA256", pinned_sha)
    with pytest.raises(ValueError, match="selected frozen/profile pin"):
        WorkerSettings.from_env()


def test_increment4a_profile_controls_request_surface(tmp_path, monkeypatch):
    material(tmp_path)
    path = write_profile(
        tmp_path,
        profile_text(
            providers="  - ghatana.docling\n  - ghatana.docling-docx",
            media="  - application/pdf\n  - application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            languages="  - en\n  - hi\n  - mr",
        ),
    )
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH", str(path))
    settings = WorkerSettings.from_env()
    assert settings.profile is not None
    assert settings.selected_profile_id == "increment4a"
    assert settings.profile_identity_explicit is True
    assert settings.enabled_providers == ("ghatana.docling", "ghatana.docling-docx")
    assert settings.request_languages == ("en", "hi", "mr")
    assert settings.allowed_media_types[-1].endswith("wordprocessingml.document")


def test_increment4a_profile_requires_model_manifest_pin(tmp_path):
    material(tmp_path)
    content = profile_text().replace("modelManifestSha256: \"" + "0" * 64 + "\"\n", "")
    with pytest.raises(ValueError, match="must pin modelManifestSha256"):
        load_worker_profile(write_profile(tmp_path, content))
