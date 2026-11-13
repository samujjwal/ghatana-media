from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

_PROFILE_VERSION = "document-intelligence.profile.v1"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$")
_KNOWN_PROVIDERS = frozenset(
    {
        "ghatana.docling",
        "ghatana.paddleocr",
        "ghatana.gliner",
        "ghatana.minilm",
        "ghatana.hybrid-pdf",
        "ghatana.docling-docx",
        "ghatana.docling-pptx",
        "ghatana.docling-xlsx",
        "ghatana.tesseractocr",
        "ghatana.resilient-parser",
    }
)


@dataclass(frozen=True)
class WorkerProfile:
    profile_id: str
    enabled_providers: tuple[str, ...]
    allowed_media_types: tuple[str, ...]
    candidate_languages: tuple[str, ...]
    model_manifest_path: Path
    routing_policy_path: Path
    provider_authority_path: Path | None = None
    provider_authority_sha256: str | None = None
    model_manifest_sha256: str | None = None


def _strings(value: Any, field: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"profile {field} must be a non-empty string list")
    result = tuple(value)
    if len(set(result)) != len(result):
        raise ValueError(f"profile {field} contains duplicates")
    return result


def _path(root: Path, value: Any, field: str, *, required: bool = True) -> Path | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ValueError(f"profile {field} must be a repository-relative path")
    path = (root / value).resolve()
    if root != path and root not in path.parents:
        raise ValueError(f"profile {field} escapes the repository")
    if not path.is_file():
        raise ValueError(f"profile {field} does not exist")
    return path


def load_worker_profile(path: Path) -> WorkerProfile:
    profile_path = path.resolve()
    if not profile_path.is_file():
        raise ValueError("worker profile does not exist")
    try:
        raw = yaml.safe_load(profile_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError("worker profile is malformed") from exc
    allowed = {"schemaVersion", "profileId", "enabledProviders", "mediaTypes", "candidateLanguages", "modelManifest", "modelManifestSha256", "routingPolicy", "providerAuthority", "providerAuthoritySha256"}
    required = allowed - {"providerAuthority", "providerAuthoritySha256", "modelManifestSha256"}
    if not isinstance(raw, dict) or set(raw) - allowed or not required.issubset(raw) or raw["schemaVersion"] != _PROFILE_VERSION:
        raise ValueError("worker profile shape is invalid")
    profile_id = raw["profileId"]
    if not isinstance(profile_id, str) or not _IDENTIFIER.fullmatch(profile_id):
        raise ValueError("profile identifier is invalid")
    providers = _strings(raw["enabledProviders"], "enabledProviders")
    if any(not _IDENTIFIER.fullmatch(provider) or provider not in _KNOWN_PROVIDERS for provider in providers):
        raise ValueError("profile contains an unknown provider")
    media_types = _strings(raw["mediaTypes"], "mediaTypes")
    if any(item.strip() != item or "/" not in item or item.lower() != item for item in media_types):
        raise ValueError("profile contains an invalid media type")
    languages = _strings(raw["candidateLanguages"], "candidateLanguages")
    if any(not re.fullmatch(r"[a-z]{2,3}", language) for language in languages):
        raise ValueError("profile contains a non-canonical language tag")
    root = profile_path.parent.parent
    model_manifest = _path(root, raw["modelManifest"], "modelManifest")
    routing_policy = _path(root, raw["routingPolicy"], "routingPolicy")
    authority_sha = raw.get("providerAuthoritySha256")
    if authority_sha is not None and (not isinstance(authority_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", authority_sha)):
        raise ValueError("profile providerAuthoritySha256 must be a SHA-256 hex digest")
    authority_path = _path(root, raw.get("providerAuthority"), "providerAuthority", required=False)
    if (authority_path is None) != (authority_sha is None):
        raise ValueError("profile providerAuthority and providerAuthoritySha256 must be declared together")
    model_sha = raw.get("modelManifestSha256")
    if profile_id == "increment4a" and model_sha is None:
        raise ValueError("increment4a profile must pin modelManifestSha256")
    if model_sha is not None and (not isinstance(model_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", model_sha)):
        raise ValueError("profile modelManifestSha256 must be a SHA-256 hex digest")
    return WorkerProfile(
        profile_id,
        providers,
        media_types,
        languages,
        model_manifest,
        routing_policy,
        authority_path,
        authority_sha,
        model_sha,
    )
