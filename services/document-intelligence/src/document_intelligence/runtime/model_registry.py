from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from pathlib import Path
from types import MappingProxyType
from collections.abc import Mapping
from typing import Any, Callable

from ..errors import WorkerError
from .model_loading import ModelLoadPolicy, validate_model_artifact


def _freeze_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze_value(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_value(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_freeze_value(item) for item in value)
    return value


def _thaw_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_thaw_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted(_thaw_value(item) for item in value)
    return value


@dataclass
class ModelEntry:
    provider_ref: str
    provider_version: str
    model_ref: str
    model_version: str
    factory: Callable[[], Any]
    capabilities: dict[str, Any]
    instance: Any = None
    loaded: bool = False
    ready: bool = False
    error: str | None = None
    artifact_root: Path | None = None
    artifact_keys: tuple[str, ...] = ()
    language_model_identities: tuple[dict[str, str], ...] = ()
    load_policy: ModelLoadPolicy = field(default_factory=ModelLoadPolicy)
    _frozen: bool = field(default=False, init=False, repr=False)

    def __setattr__(self, name: str, value: Any) -> None:
        if getattr(self, "_frozen", False):
            raise RuntimeError("model material is immutable after startup readiness")
        object.__setattr__(self, name, value)

    def freeze(self) -> None:
        object.__setattr__(self, "capabilities", _freeze_value(self.capabilities))
        object.__setattr__(self, "language_model_identities", tuple(_freeze_value(item) for item in self.language_model_identities))
        object.__setattr__(self, "_frozen", True)

    def _release_after_shutdown(self) -> None:
        """Drop runtime objects after shutdown without reopening material mutation."""
        object.__setattr__(self, "instance", None)
        object.__setattr__(self, "loaded", False)
        object.__setattr__(self, "ready", False)

    def load(self) -> Any:
        if self.loaded:
            if not self.ready:
                raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=self.provider_ref)
            return self.instance
        if self._frozen:
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=self.provider_ref)
        self.loaded = True
        try:
            if self.artifact_root is not None and self.artifact_keys:
                for key in self.artifact_keys:
                    artifact = self.artifact_root / key
                    if not _artifact_ready(artifact):
                        raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=self.provider_ref)
                    validate_model_artifact(artifact, self.load_policy)
            self.instance = self.factory()
            self.ready = True
            return self.instance
        except WorkerError:
            self.error = "model artifact is unavailable or unsafe"
            self.ready = False
            raise
        except Exception:
            self.error = "model initialization failed"
            self.ready = False
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=self.provider_ref)

    def identity(self) -> dict[str, str]:
        return {"providerRef": self.provider_ref, "providerVersion": self.provider_version, "modelRef": self.model_ref, "modelVersion": self.model_version}

    def artifact_digest(self, key: str) -> str | None:
        if self.artifact_root is None or key not in self.artifact_keys:
            return None
        return _artifact_digest(self.artifact_root / key)


def _artifact_digest(path: Path) -> str | None:
    if not path.is_dir() or (path / "PROVISIONING_REQUIRED").exists() or not (path / ".artifact.sha256").is_file():
        return None
    try:
        files = [item for item in sorted(path.rglob("*")) if item.is_file() and item.name not in {"PROVISIONING_REQUIRED", ".artifact.sha256"}]
        if not files:
            return None
        digest = hashlib.sha256()
        for item in files:
            digest.update(str(item.relative_to(path)).encode("utf-8")); digest.update(item.read_bytes())
        observed = digest.hexdigest()
        return observed if observed == (path / ".artifact.sha256").read_text().strip() else None
    except OSError:
        return None


def _artifact_ready(path: Path) -> bool:
    return _artifact_digest(path) is not None


class ModelRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, ModelEntry] = {}
        self._accepted: dict[str, dict[str, Any]] = {}
        self._frozen = False

    def __setattr__(self, name: str, value: Any) -> None:
        if getattr(self, "_frozen", False) and name in {"_entries", "_accepted", "_frozen"}:
            raise RuntimeError("provider material registry is immutable after startup readiness")
        object.__setattr__(self, name, value)

    def _require_mutable(self) -> None:
        if self._frozen:
            raise RuntimeError("provider material registry is immutable after startup readiness")

    def freeze(self) -> None:
        for entry in self._entries.values():
            entry.freeze()
        self._entries = MappingProxyType(dict(self._entries))
        self._accepted = _freeze_value(self._accepted)
        object.__setattr__(self, "_frozen", True)

    def _release_after_shutdown(self) -> None:
        for entry in tuple(self._entries.values()):
            entry._release_after_shutdown()
        object.__setattr__(self, "_entries", MappingProxyType({}))
        object.__setattr__(self, "_accepted", MappingProxyType({}))

    def register(self, key: str, entry: ModelEntry) -> None:
        self._require_mutable()
        if key in self._entries:
            raise ValueError(f"model already registered: {key}")
        self._entries[key] = entry

    def get(self, key: str) -> ModelEntry:
        try:
            return self._entries[key]
        except KeyError as exc:
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True) from exc

    def load_required(self, keys: list[str]) -> None:
        self._require_mutable()
        for key in keys:
            self.get(key).load()

    def ready(self, provider_ref: str | None = None) -> bool:
        values = self._entries.values() if provider_ref is None else (entry for entry in self._entries.values() if entry.provider_ref == provider_ref)
        return all(entry.ready for entry in values)

    def accept_capabilities(self, accepted: list[dict[str, Any]]) -> None:
        """Accept the legacy grouped provider catalog shape."""
        self._require_mutable()
        promoted: dict[str, dict[str, Any]] = {}
        provider_refs = {entry.provider_ref for entry in self._entries.values()}
        for item in accepted:
            if not isinstance(item, dict) or set(item) != {"providerRef", "capabilities"} or item.get("providerRef") not in provider_refs or not isinstance(item.get("capabilities"), dict):
                raise ValueError("invalid accepted capability catalog")
            promoted[item["providerRef"]] = item["capabilities"]
        self._accepted = promoted

    def accept_capability_artifact(self, artifact: dict[str, Any]) -> None:
        """Load only evidence-derived capability records from a canonical artifact.

        ``capabilities[].state == QUALIFIED`` is a dimensional measurement, not
        an admission: a PRE_FROZEN campaign may produce QUALIFIED leaves while
        ``promotable`` remains false.  The single consumer-facing promotion
        authority is ``accepted[]``, and it is consumed only when the artifact
        reports ``qualificationStatus == "PASS"`` and ``promotable is True``.
        """
        self._require_mutable()
        if not isinstance(artifact, dict) or artifact.get("qualificationStatus") not in {"PASS", "FAIL", "NOT_RUN", "NOT_QUALIFIED", "NOT_EVALUATED"}:
            raise ValueError("invalid capability artifact")
        if artifact["qualificationStatus"] != "PASS" or artifact.get("promotable") is not True:
            self._accepted = {}
            return
        provider_refs = {entry.provider_ref for entry in self._entries.values()}
        promoted: dict[str, dict[str, Any]] = {}
        grouped = artifact.get("accepted", [])
        if not isinstance(grouped, list):
            raise ValueError("invalid accepted capability list")
        for item in grouped:
            if not isinstance(item, dict):
                raise ValueError("invalid accepted capability record")
            provider_ref = item.get("providerRef")
            if not isinstance(provider_ref, str) or provider_ref not in provider_refs:
                raise ValueError("accepted capability references an unknown provider")
            capability_id = item.get("capabilityId") or item.get("capability")
            if not isinstance(capability_id, str) or not capability_id or capability_id.startswith("language."):
                raise ValueError("accepted capability must be precise")
            record = promoted.setdefault(provider_ref, {"capabilityIds": [], "languages": [], "features": [], "mediaTypes": []})
            record["capabilityIds"].append(capability_id)
            if isinstance(item.get("language"), str) and item["language"] not in record["languages"]:
                record["languages"].append(item["language"])
            feature = item.get("feature")
            if isinstance(feature, str) and feature not in record["features"]:
                record["features"].append(feature)
            media_types = item.get("mediaTypes", [])
            if isinstance(media_types, list):
                record["mediaTypes"].extend(value for value in media_types if isinstance(value, str))
        for record in promoted.values():
            for key in ("capabilityIds", "languages", "features", "mediaTypes"):
                record[key] = sorted(set(record[key]))
        self._accepted = promoted

    def accept_authority_records(self, records: list[dict[str, Any]]) -> None:
        """Project frozen Increment-3 authority records into admission state."""
        self._require_mutable()
        promoted: dict[str, dict[str, Any]] = {}
        for item in records:
            provider_ref = item.get("providerRef")
            if not isinstance(provider_ref, str):
                raise ValueError("invalid provider authority record")
            record = promoted.setdefault(provider_ref, {
                "languages": [],
                "mediaTypes": [],
                "supportedValueTypes": [],
                "capabilityIds": [],
                "features": [],
            })
            record["languages"].extend(item.get("languages", []))
            record["mediaTypes"].extend(item.get("mediaTypes", []))
            record["supportedValueTypes"].extend(item.get("valueTypes", []))
            record["capabilityIds"].extend(item.get("capabilityIds", []))
            record["features"].extend(item.get("features", []))
            for field in (
                "maxDimensions",
                "supportsTables",
                "supportsCoordinates",
                "supportsLanguages",
                "supportsConfidenceScores",
                "supportsMultipleCardinality",
            ):
                if item.get(field) is not None:
                    record[field] = item[field]
        for record in promoted.values():
            for field in ("languages", "mediaTypes", "supportedValueTypes", "capabilityIds", "features"):
                record[field] = sorted(set(record[field]))
        self._accepted = promoted

    def accepted_capabilities(self, provider_ref: str) -> dict[str, Any] | None:
        accepted = self._accepted.get(provider_ref)
        return _thaw_value(accepted) if accepted is not None else None

    def admitted_provider_refs(self, enabled: tuple[str, ...] | None = None) -> list[str]:
        allowed = set(enabled) if enabled is not None else None
        return sorted(provider_ref for provider_ref in self._accepted if allowed is None or provider_ref in allowed)

    def admitted_catalog(self, enabled: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        allowed = set(enabled) if enabled is not None else None
        catalog: list[dict[str, Any]] = []
        for entry in sorted(self._entries.values(), key=lambda item: item.provider_ref + item.model_ref):
            accepted = self._accepted.get(entry.provider_ref)
            if accepted is None or (allowed is not None and entry.provider_ref not in allowed):
                continue
            item = {**entry.identity(), **_thaw_value(accepted), "promotionStatus": "ACCEPTED", "loaded": entry.loaded, "ready": entry.ready}
            if "languages" in accepted:
                item["supportedLanguages"] = list(accepted["languages"])
            languages = set(accepted.get("languages", []))
            identities = [
                dict(identity)
                for identity in entry.language_model_identities
                if identity.get("language") in languages
            ]
            if identities:
                item["languageModelIdentities"] = sorted(identities, key=lambda value: value["language"])
            catalog.append(item)
        return catalog

    def catalog(self) -> list[dict[str, Any]]:
        return [{**entry.identity(), **_thaw_value(self._accepted.get(entry.provider_ref, {})), "promotionStatus": "ACCEPTED" if entry.provider_ref in self._accepted else "UNPROMOTED", "loaded": entry.loaded, "ready": entry.ready} for entry in sorted(self._entries.values(), key=lambda item: item.provider_ref + item.model_ref)]

    def entries(self) -> list[ModelEntry]:
        return list(self._entries.values())

    def runtime_asset_roots(self, provider_ref: str) -> list[dict[str, Any]]:
        """Expose verified content digests for language-specific model assets, never filesystem paths."""
        rows: list[dict[str, Any]] = []
        for entry in self._entries.values():
            if entry.provider_ref != provider_ref:
                continue
            for identity in entry.language_model_identities:
                model_ref = identity.get("modelRef")
                model_version = identity.get("modelVersion")
                language = identity.get("language")
                if not isinstance(model_ref, str) or not isinstance(model_version, str) or not isinstance(language, str):
                    continue
                key = f"{entry.provider_ref}__{model_ref}__{model_version}".replace("/", "_")
                digest = entry.artifact_digest(key)
                rows.append({
                    "language": language,
                    "providerRef": entry.provider_ref,
                    "providerVersion": entry.provider_version,
                    "modelRef": model_ref,
                    "modelVersion": model_version,
                    "artifactSha256": digest,
                    "assetRootSha256": digest,
                    "ready": digest is not None,
                })
        return sorted(rows, key=lambda row: row["language"])
