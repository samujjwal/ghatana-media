from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .limits import Limits
from .profile import WorkerProfile, load_worker_profile
from .runtime.provider_authority import (
    FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256,
    FROZEN_INCREMENT3_PROVIDER_CATALOG_FINGERPRINT,
)
from .runtime.determinism import DeterminismEnvelope

_INCREMENT3_MEDIA_TYPES = ("application/pdf", "image/png", "image/jpeg")
_WORKER_ROOT = Path(__file__).resolve().parents[2]
_FROZEN_INCREMENT3_PROVIDER_AUTHORITY = _WORKER_ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"
_FROZEN_INCREMENT3_MODEL_MANIFEST = _WORKER_ROOT / "models/model-manifest.yaml"
FROZEN_INCREMENT3_MODEL_MANIFEST_SHA256 = "df2c11968b21c4cfe5c7ae6e8be8eb1764a950a12e5be355f475b9ba4511e2c4"


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


@dataclass(frozen=True)
class WorkerSettings:
    host: str = "127.0.0.1"
    port: int = 8765
    offline: bool = True
    allow_remote: bool = False
    model_cache_root: Path = Path(".models")
    model_manifest_path: Path = _FROZEN_INCREMENT3_MODEL_MANIFEST
    expected_model_manifest_sha256: str | None = FROZEN_INCREMENT3_MODEL_MANIFEST_SHA256
    expected_provider_authority_path: Path = _FROZEN_INCREMENT3_PROVIDER_AUTHORITY
    expected_provider_authority_sha256: str = FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256
    expected_provider_catalog_fingerprint: str | None = FROZEN_INCREMENT3_PROVIDER_CATALOG_FINGERPRINT
    temp_root: Path = Path("/tmp/document-intelligence")
    temp_retention_seconds: int = 3600
    shutdown_timeout_seconds: float = 10.0
    enabled_providers: tuple[str, ...] = (
        "ghatana.docling",
        "ghatana.paddleocr",
        "ghatana.gliner",
        "ghatana.minilm",
    )
    enabled_languages: tuple[str, ...] = ("en", "ne")
    allowed_media_types: tuple[str, ...] = _INCREMENT3_MEDIA_TYPES
    profile: WorkerProfile | None = None
    selected_profile_id: str = "default"
    profile_identity_explicit: bool = False
    determinism_envelope: DeterminismEnvelope = field(default_factory=DeterminismEnvelope.from_environment)
    limits: Limits = field(default_factory=Limits)

    @property
    def request_languages(self) -> tuple[str, ...]:
        return self.enabled_languages

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        profile_path = os.getenv("DOCUMENT_INTELLIGENCE_PROFILE_PATH")
        requested_profile_id = os.getenv("DOCUMENT_INTELLIGENCE_PROFILE_ID")
        profile = load_worker_profile(Path(profile_path)) if profile_path else None
        if profile is not None and profile.profile_id == "default":
            raise ValueError("the default profile identity is the existing no-profile configuration")
        selected_profile_id = profile.profile_id if profile is not None else "default"
        if requested_profile_id is not None:
            if not requested_profile_id or (profile is None and requested_profile_id != "default"):
                raise ValueError("selected profile id requires a matching configured profile")
            if requested_profile_id != selected_profile_id:
                raise ValueError("selected profile id does not match the configured profile")
        profile_identity_explicit = profile is not None or requested_profile_id is not None
        raw_providers = os.getenv("DOCUMENT_INTELLIGENCE_ENABLED_PROVIDERS")
        providers = profile.enabled_providers if profile else (tuple(p.strip() for p in raw_providers.split(",") if p.strip()) if raw_providers else cls.enabled_providers)
        raw_languages = os.getenv("DOCUMENT_INTELLIGENCE_ENABLED_LANGUAGES")
        languages = profile.candidate_languages if profile else (tuple(p.strip().lower() for p in raw_languages.split(",") if p.strip()) if raw_languages else cls.enabled_languages)
        media_types = profile.allowed_media_types if profile else cls.allowed_media_types
        offline = os.getenv("DOCUMENT_INTELLIGENCE_OFFLINE", "true").lower() == "true"
        if offline:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        expected_provider_authority_path = (
            profile.provider_authority_path
            if profile is not None and profile.provider_authority_path is not None
            else _FROZEN_INCREMENT3_PROVIDER_AUTHORITY
        )
        expected_provider_authority_sha256 = (
            profile.provider_authority_sha256
            if profile is not None and profile.provider_authority_sha256 is not None
            else FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256
        )
        authority_path_override = os.getenv("DOCUMENT_INTELLIGENCE_EXPECTED_PROVIDER_AUTHORITY")
        authority_sha_override = os.getenv("DOCUMENT_INTELLIGENCE_EXPECTED_PROVIDER_AUTHORITY_SHA256")
        if authority_path_override is not None and Path(authority_path_override).resolve() != expected_provider_authority_path.resolve():
            raise ValueError("provider authority override conflicts with the selected frozen/profile pin")
        if authority_sha_override is not None and authority_sha_override != expected_provider_authority_sha256:
            raise ValueError("provider authority digest override conflicts with the selected frozen/profile pin")
        settings = cls(
            host=os.getenv("DOCUMENT_INTELLIGENCE_HOST", "127.0.0.1"),
            port=_int_env("DOCUMENT_INTELLIGENCE_PORT", 8765),
            offline=offline,
            allow_remote=os.getenv("DOCUMENT_INTELLIGENCE_ALLOW_REMOTE", "false").lower() == "true",
            model_cache_root=Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", ".models")),
            model_manifest_path=profile.model_manifest_path if profile is not None else _FROZEN_INCREMENT3_MODEL_MANIFEST,
            expected_model_manifest_sha256=(profile.model_manifest_sha256 if profile is not None else FROZEN_INCREMENT3_MODEL_MANIFEST_SHA256),
            expected_provider_authority_path=expected_provider_authority_path,
            expected_provider_authority_sha256=expected_provider_authority_sha256,
            expected_provider_catalog_fingerprint=expected_provider_authority_sha256,
            temp_root=Path(os.getenv("DOCUMENT_INTELLIGENCE_TEMP_ROOT", "/tmp/document-intelligence")),
            temp_retention_seconds=_int_env("DOCUMENT_INTELLIGENCE_TEMP_RETENTION_SECONDS", 3600),
            shutdown_timeout_seconds=float(os.getenv("DOCUMENT_INTELLIGENCE_SHUTDOWN_TIMEOUT_SECONDS", "10")),
            enabled_providers=providers,
            enabled_languages=languages,
            allowed_media_types=media_types,
            profile=profile,
            selected_profile_id=selected_profile_id,
            profile_identity_explicit=profile_identity_explicit,
            determinism_envelope=DeterminismEnvelope.from_environment(os.environ),
            limits=Limits(
                max_upload_bytes=_int_env("DOCUMENT_INTELLIGENCE_MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
                max_operation_timeout_ms=_int_env("DOCUMENT_INTELLIGENCE_MAX_OPERATION_TIMEOUT_MS", 120_000),
                max_metadata_bytes=_int_env("DOCUMENT_INTELLIGENCE_MAX_METADATA_BYTES", 64 * 1024),
                max_pages=_int_env("DOCUMENT_INTELLIGENCE_MAX_PAGES", 500),
                max_blocks=_int_env("DOCUMENT_INTELLIGENCE_MAX_BLOCKS", 100_000),
                max_lines=_int_env("DOCUMENT_INTELLIGENCE_MAX_LINES", 200_000),
                max_tables=_int_env("DOCUMENT_INTELLIGENCE_MAX_TABLES", 50_000),
                max_table_rows=_int_env("DOCUMENT_INTELLIGENCE_MAX_TABLE_ROWS", 200_000),
                max_table_cells=_int_env("DOCUMENT_INTELLIGENCE_MAX_TABLE_CELLS", 500_000),
                max_regions=_int_env("DOCUMENT_INTELLIGENCE_MAX_REGIONS", 1_000_000),
                max_text_characters=_int_env("DOCUMENT_INTELLIGENCE_MAX_TEXT_CHARACTERS", 2_000_000),
                max_candidates=_int_env("DOCUMENT_INTELLIGENCE_MAX_CANDIDATES", 16_000),
                max_evidence=_int_env("DOCUMENT_INTELLIGENCE_MAX_EVIDENCE", 32),
                max_evidence_spans=_int_env("DOCUMENT_INTELLIGENCE_MAX_EVIDENCE_SPANS", 256_000),
                max_embedding_dimensions=_int_env("DOCUMENT_INTELLIGENCE_MAX_EMBEDDING_DIMENSIONS", 16_384),
                max_serialized_response_bytes=_int_env("DOCUMENT_INTELLIGENCE_MAX_SERIALIZED_RESPONSE_BYTES", 32 * 1024 * 1024),
                max_queue=_int_env("DOCUMENT_INTELLIGENCE_MAX_QUEUE", 32),
                max_office_archive_members=_int_env("DOCUMENT_INTELLIGENCE_MAX_OFFICE_ARCHIVE_MEMBERS", 10_000),
                max_office_uncompressed_bytes=_int_env("DOCUMENT_INTELLIGENCE_MAX_OFFICE_UNCOMPRESSED_BYTES", 256 * 1024 * 1024),
                max_office_member_bytes=_int_env("DOCUMENT_INTELLIGENCE_MAX_OFFICE_MEMBER_BYTES", 64 * 1024 * 1024),
                max_office_compression_ratio=_int_env("DOCUMENT_INTELLIGENCE_MAX_OFFICE_COMPRESSION_RATIO", 100),
                max_pdf_objects=_int_env("DOCUMENT_INTELLIGENCE_MAX_PDF_OBJECTS", 200_000),
                max_pdf_streams=_int_env("DOCUMENT_INTELLIGENCE_MAX_PDF_STREAMS", 100_000),
                max_pdf_page_dimension_pt=_int_env("DOCUMENT_INTELLIGENCE_MAX_PDF_PAGE_DIMENSION_PT", 14_400),
                max_image_dimension_px=_int_env("DOCUMENT_INTELLIGENCE_MAX_IMAGE_DIMENSION_PX", 16_000),
                max_image_frames=_int_env("DOCUMENT_INTELLIGENCE_MAX_IMAGE_FRAMES", 4),
                max_decoded_image_bytes=_int_env("DOCUMENT_INTELLIGENCE_MAX_DECODED_IMAGE_BYTES", 512 * 1024 * 1024),
            ),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if not self.host or self.port < 1 or self.port > 65535:
            raise ValueError("bind host/port are invalid")
        if self.allow_remote:
            raise ValueError("remote provider access is forbidden in Increment 3")
        if self.temp_retention_seconds < 0 or self.shutdown_timeout_seconds <= 0:
            raise ValueError("runtime retention/shutdown settings are invalid")
        if not self.enabled_providers:
            raise ValueError("at least one provider must be enabled")
        if not self.allowed_media_types or len(set(self.allowed_media_types)) != len(self.allowed_media_types):
            raise ValueError("request media types must be unique and non-empty")
        if not self.enabled_languages or len(set(self.enabled_languages)) != len(self.enabled_languages):
            raise ValueError("request languages must be unique and non-empty")
        if self.profile is None and any(language not in {"en", "ne"} for language in self.enabled_languages):
            raise ValueError("only measured Increment 3 languages may be enabled without a profile")
        self.limits.validate()
