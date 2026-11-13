"""Shared OCR evidence, identity, and minimum-verification authorities.

The worker has several durable artifacts produced by different stages.  This
module keeps the boundaries explicit: observations are immutable producer
output, evaluators and acceptance policies are separate authorities, and a
source/environment change is resolved to the minimum necessary proof rather
than automatically becoming a provider rerun.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Mapping


GOVERNANCE_PRODUCER_VERSION = "document-intelligence-governance/1"
RAW_OBSERVATION_SCHEMA = "document-intelligence.raw-observation.v1"
SOURCE_SNAPSHOT_SCHEMA = "document-intelligence.source-snapshot.v1"
ENVIRONMENT_SCHEMA = "document-intelligence.environment-authority.v1"


class GovernanceError(ValueError):
    """Fail-closed governance validation error."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _iso_timestamp(value: str, field: str) -> str:
    if not isinstance(value, str):
        raise GovernanceError(f"{field} must be an ISO-8601 timestamp")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GovernanceError(f"{field} must be an ISO-8601 timestamp") from exc
    return value


def _safe_payload(value: Any, path: str = "payload") -> None:
    """Reject obvious secrets and non-serializable/raw binary material."""

    if isinstance(value, bytes | bytearray):
        raise GovernanceError(f"{path} contains raw binary material")
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise GovernanceError(f"{path} contains a non-string key")
            if re.search(r"(?i)(password|passwd|secret|token|authorization|api[_ -]?key|credential)", key):
                raise GovernanceError(f"{path}.{key} is sensitive and cannot be retained")
            _safe_payload(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _safe_payload(child, f"{path}[{index}]")
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise GovernanceError(f"{path} contains an unsupported value")
    if isinstance(value, float) and (value != value or value in {float("inf"), float("-inf")}):
        raise GovernanceError(f"{path} contains a non-finite number")


@dataclass(frozen=True)
class Rescoreability:
    can_rescore_with_evaluator_change: bool
    can_reevaluate_acceptance_change: bool
    required_observation_schema_version: str = RAW_OBSERVATION_SCHEMA

    def to_record(self) -> dict[str, Any]:
        return {
            "canRescoreWithEvaluatorChange": self.can_rescore_with_evaluator_change,
            "canReevaluateAcceptanceChange": self.can_reevaluate_acceptance_change,
            "requiredObservationSchemaVersion": self.required_observation_schema_version,
        }


@dataclass(frozen=True)
class RawObservation:
    """Immutable, non-sensitive provider observation sufficient for rescoring."""

    observation_id: str
    captured_at: str
    producer_authority: str
    provider_ref: str
    model_identity: Mapping[str, Any]
    payload: Mapping[str, Any]
    rescoreability: Rescoreability
    producer_version: str = GOVERNANCE_PRODUCER_VERSION

    def to_record(self) -> dict[str, Any]:
        if not self.observation_id or not self.producer_authority or not self.provider_ref:
            raise GovernanceError("raw observation identity is required")
        _iso_timestamp(self.captured_at, "capturedAt")
        _safe_payload(self.model_identity, "modelIdentity")
        _safe_payload(self.payload)
        record: dict[str, Any] = {
            "schemaVersion": RAW_OBSERVATION_SCHEMA,
            "producerVersion": self.producer_version,
            "observationId": self.observation_id,
            "capturedAt": self.captured_at,
            "producerAuthority": self.producer_authority,
            "providerRef": self.provider_ref,
            "modelIdentity": dict(self.model_identity),
            "payload": dict(self.payload),
            "rescoreability": self.rescoreability.to_record(),
        }
        record["observationFingerprint"] = fingerprint(record)
        return record

    @classmethod
    def from_record(cls, record: Mapping[str, Any]) -> "RawObservation":
        required = {
            "schemaVersion",
            "producerVersion",
            "observationId",
            "capturedAt",
            "producerAuthority",
            "providerRef",
            "modelIdentity",
            "payload",
            "rescoreability",
            "observationFingerprint",
        }
        if set(record) != required or record.get("schemaVersion") != RAW_OBSERVATION_SCHEMA:
            raise GovernanceError("unknown or incomplete raw-observation schema")
        expected = dict(record)
        actual = expected.pop("observationFingerprint")
        if actual != fingerprint(expected):
            raise GovernanceError("raw observation fingerprint mismatch")
        metadata = record["rescoreability"]
        if not isinstance(metadata, Mapping) or set(metadata) != {
            "canRescoreWithEvaluatorChange",
            "canReevaluateAcceptanceChange",
            "requiredObservationSchemaVersion",
        }:
            raise GovernanceError("raw observation rescoreability metadata is invalid")
        if metadata["requiredObservationSchemaVersion"] != RAW_OBSERVATION_SCHEMA:
            raise GovernanceError("raw observation requires an unsupported schema")
        return cls(
            str(record["observationId"]),
            str(record["capturedAt"]),
            str(record["producerAuthority"]),
            str(record["providerRef"]),
            dict(record["modelIdentity"]),
            dict(record["payload"]),
            Rescoreability(
                bool(metadata["canRescoreWithEvaluatorChange"]),
                bool(metadata["canReevaluateAcceptanceChange"]),
                str(metadata["requiredObservationSchemaVersion"]),
            ),
            str(record["producerVersion"]),
        )


class VerificationAction(StrEnum):
    REUSE_PASS = "REUSE_PASS"
    RECONCILE = "RECONCILE"
    RE_SCORE = "RE_SCORE"
    FOCUSED_PROOF = "FOCUSED_PROOF"
    PROVIDER_EXECUTION = "PROVIDER_EXECUTION"


def minimum_necessary_verification(
    *,
    dependency_changed: bool,
    behavioral_change: bool,
    raw_observation_compatible: bool,
    focused_proof_sufficient: bool,
    observation_can_rescore: bool = True,
    observation_can_reevaluate_acceptance: bool = True,
) -> VerificationAction:
    """Resolve the plan's no-rerun ladder without inferring from filenames."""

    if not dependency_changed:
        return VerificationAction.REUSE_PASS
    if not behavioral_change:
        return VerificationAction.RECONCILE
    if raw_observation_compatible and observation_can_reevaluate_acceptance:
        return VerificationAction.RE_SCORE
    if raw_observation_compatible and observation_can_rescore:
        return VerificationAction.RE_SCORE
    if focused_proof_sufficient:
        return VerificationAction.FOCUSED_PROOF
    return VerificationAction.PROVIDER_EXECUTION


class EnvironmentTier(StrEnum):
    PORTABLE = "PORTABLE"
    PYTHON_RUNTIME_BOUND = "PYTHON_RUNTIME_BOUND"
    NATIVE_RUNTIME_BOUND = "NATIVE_RUNTIME_BOUND"
    HARDWARE_CLASS_BOUND = "HARDWARE_CLASS_BOUND"
    ACCELERATOR_BOUND = "ACCELERATOR_BOUND"
    PACKAGE_BOUND = "PACKAGE_BOUND"


_TIER_KEYS: dict[EnvironmentTier, tuple[str, ...]] = {
    EnvironmentTier.PORTABLE: ("locale", "timezone", "unicodeNormalization", "threadCount", "floatingPointTolerance", "batching"),
    EnvironmentTier.PYTHON_RUNTIME_BOUND: ("pythonAbi",),
    EnvironmentTier.NATIVE_RUNTIME_BOUND: ("nativeLibraries", "systemBinaries"),
    EnvironmentTier.HARDWARE_CLASS_BOUND: ("runtimeClass", "cpuClass"),
    EnvironmentTier.ACCELERATOR_BOUND: ("accelerator", "cudaVersion", "gpuBackend"),
    EnvironmentTier.PACKAGE_BOUND: ("packageLock", "providerPackage"),
}


def environment_authority(observations: Mapping[str, Any], tiers: set[EnvironmentTier] | frozenset[EnvironmentTier]) -> dict[str, Any]:
    """Hash only declared environment tiers; unrelated host details are ignored."""

    selected = sorted({EnvironmentTier(tier) for tier in tiers}, key=lambda tier: tier.value)
    values = {
        tier.value: {key: observations[key] for key in _TIER_KEYS[tier] if key in observations}
        for tier in selected
    }
    record: dict[str, Any] = {
        "schemaVersion": ENVIRONMENT_SCHEMA,
        "producerVersion": GOVERNANCE_PRODUCER_VERSION,
        "authorityTiers": [tier.value for tier in selected],
        "values": values,
    }
    record["environmentFingerprint"] = fingerprint(record)
    return record


def canonical_filesystem_identity(path: Path | str, repo_root: Path | str, approved_roots: tuple[Path | str, ...] = ()) -> dict[str, str]:
    """Return a machine-independent identity and reject symlink escapes."""

    root = Path(repo_root).resolve()
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = root / candidate
    target = candidate.resolve(strict=False)
    roots = (root, *(Path(item).resolve() for item in approved_roots))
    if not any(target == approved or approved in target.parents for approved in roots):
        raise GovernanceError(f"filesystem identity escapes approved roots: {path}")
    try:
        relative = target.relative_to(root).as_posix()
    except ValueError as exc:
        raise GovernanceError("semantic material must be repo-relative") from exc
    if not relative or relative.startswith("../") or relative == "..":
        raise GovernanceError("semantic material has an invalid relative identity")
    normalized = relative.casefold() if os.name == "nt" else relative
    return {"repoRelativePath": normalized, "resolvedTarget": target.as_posix()}


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_source_snapshot(root: Path | str, declared_paths: tuple[str, ...], *, generated_current: bool = True) -> dict[str, Any]:
    """Capture only declared semantic material plus scoped Git dirtiness."""

    repo_root = Path(root).resolve()
    files: list[dict[str, Any]] = []
    declared_identities: set[str] = set()
    for value in declared_paths:
        path = (repo_root / value).resolve(strict=False)
        if path.is_dir():
            candidates = sorted(item for item in path.rglob("*") if item.is_file())
        else:
            candidates = [path]
        for item in candidates:
            identity = canonical_filesystem_identity(item, repo_root)
            declared_identities.add(identity["repoRelativePath"])
            if not item.is_file():
                raise GovernanceError(f"declared semantic file is missing: {value}")
            files.append({
                "repoRelativePath": identity["repoRelativePath"],
                "sha256": _file_digest(item),
                "size": item.stat().st_size,
            })
    files.sort(key=lambda item: item["repoRelativePath"])
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all", "--"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GovernanceError("source snapshot could not inspect tracked state") from exc
    dirty_owned: list[str] = []
    for line in result.stdout.splitlines():
        if len(line) < 4:
            continue
        candidate = (repo_root / line[3:]).resolve(strict=False)
        try:
            identity = canonical_filesystem_identity(candidate, repo_root)["repoRelativePath"]
        except GovernanceError:
            continue
        if identity in declared_identities:
            dirty_owned.append(identity)
    record: dict[str, Any] = {
        "schemaVersion": SOURCE_SNAPSHOT_SCHEMA,
        "producerVersion": GOVERNANCE_PRODUCER_VERSION,
        "repoRootIdentity": repo_root.name.casefold(),
        "files": files,
        "dirtyOwnedFiles": sorted(set(dirty_owned)),
        "generatedCurrent": bool(generated_current),
    }
    record["snapshotFingerprint"] = fingerprint(record)
    return record


def compose_profiles(base: Mapping[str, Any], extension: Mapping[str, Any] | None = None, overrides: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Compose base + extension + explicit overrides with frozen precedence."""

    result = dict(base)
    base_providers = list(base.get("providers", []))
    if len(base_providers) != len(set(base_providers)):
        raise GovernanceError("base profile contains duplicate provider IDs")
    if extension is not None:
        extension_providers = list(extension.get("providers", []))
        if len(extension_providers) != len(set(extension_providers)):
            raise GovernanceError("extension profile contains duplicate provider IDs")
        if set(base_providers) & set(extension_providers):
            raise GovernanceError("profile extension duplicates a base provider ID")
        result.update({key: value for key, value in extension.items() if key != "providers"})
        result["providers"] = base_providers + extension_providers
    if overrides is not None:
        declared = overrides.get("providerOverrides", {})
        if not isinstance(declared, Mapping):
            raise GovernanceError("providerOverrides must be an explicit mapping")
        unknown = set(declared) - set(result.get("providers", []))
        if unknown:
            raise GovernanceError(f"profile override references unknown providers: {sorted(unknown)}")
        for key, value in overrides.items():
            if key != "providerOverrides":
                result[key] = value
        result["providerOverrides"] = {key: declared[key] for key in sorted(declared)}
    result["composition"] = {"base": True, "extension": extension is not None, "explicitOverrides": overrides is not None}
    result["profileFingerprint"] = fingerprint({key: value for key, value in result.items() if key != "profileFingerprint"})
    return result


__all__ = [
    "ENVIRONMENT_SCHEMA",
    "EnvironmentTier",
    "GOVERNANCE_PRODUCER_VERSION",
    "GovernanceError",
    "RAW_OBSERVATION_SCHEMA",
    "RawObservation",
    "Rescoreability",
    "SOURCE_SNAPSHOT_SCHEMA",
    "VerificationAction",
    "build_source_snapshot",
    "canonical_filesystem_identity",
    "canonical_json",
    "compose_profiles",
    "environment_authority",
    "fingerprint",
    "minimum_necessary_verification",
]
