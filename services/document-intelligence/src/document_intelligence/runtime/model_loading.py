"""Fail-closed model artifact loading policy.

Model files are executable attack surfaces even when the worker never imports
candidate Python code.  This module keeps the policy at the one model
instantiation boundary: local, content-addressed artifacts may be inspected
and loaded, but pickle-like weights and remote-code configuration are rejected
unless an explicitly authorized runtime policy opts in.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


UNSAFE_SERIALIZATION_SUFFIXES = frozenset({".bin", ".pkl", ".pickle", ".pt", ".pth"})
SAFE_SERIALIZATION_SUFFIXES = frozenset(
    {
        ".onnx",
        ".pdiparams",
        ".pdmodel",
        ".safetensors",
        ".tflite",
        ".xml",
    }
)
_IGNORED_NAMES = frozenset({".artifact.sha256", "PROVISIONING_REQUIRED"})


@dataclass(frozen=True)
class ModelLoadPolicy:
    """Runtime policy for loading a verified model artifact tree."""

    allow_unsafe_serialization: bool = False
    require_local_files: bool = True
    allow_remote_code: bool = False


def _files(root: Path) -> tuple[Path, ...]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("model artifact root must be a regular directory")
    resolved_root = root.resolve()
    result: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.name in _IGNORED_NAMES:
            continue
        if path.is_symlink():
            raise ValueError("model artifacts may not contain symlinks")
        if path.is_file():
            if path.resolve().parent != resolved_root and resolved_root not in path.resolve().parents:
                raise ValueError("model artifact escapes its approved root")
            result.append(path)
    if not result:
        raise ValueError("model artifact tree is empty")
    return tuple(result)


def _config_requests_remote_code(path: Path) -> bool:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(value, dict):
        return False
    return value.get("trust_remote_code") is True or "auto_map" in value


def validate_model_artifact(root: Path | str, policy: ModelLoadPolicy | None = None) -> tuple[Path, ...]:
    """Validate a model tree before invoking a provider/model factory.

    Unsafe weight suffixes are allowed only when the caller explicitly opts in
    and the runtime is responsible for the authorization.  A safe sibling
    format (for example ``model.safetensors``) is sufficient for a tree that
    also contains a legacy ``pytorch_model.bin`` export; providers are still
    expected to request the safe format when constructing the model.
    """

    policy = policy or ModelLoadPolicy()
    artifact_root = Path(root)
    files = _files(artifact_root)
    unsafe = tuple(path for path in files if path.suffix.lower() in UNSAFE_SERIALIZATION_SUFFIXES)
    safe_weights = any(path.suffix.lower() in SAFE_SERIALIZATION_SUFFIXES for path in files)
    if unsafe and not policy.allow_unsafe_serialization and not safe_weights:
        names = ", ".join(path.name for path in unsafe[:3])
        raise ValueError(f"unsafe model serialization requires an authorized safe runtime: {names}")
    if policy.require_local_files and any(path.name in {".git", "refs", "blobs"} for path in files):
        raise ValueError("model artifact tree contains an unmanaged remote-cache entry")
    if not policy.allow_remote_code:
        for path in files:
            if path.suffix.lower() == ".json" and _config_requests_remote_code(path):
                raise ValueError("model configuration requests remote code")
    return files


__all__ = [
    "ModelLoadPolicy",
    "SAFE_SERIALIZATION_SUFFIXES",
    "UNSAFE_SERIALIZATION_SUFFIXES",
    "validate_model_artifact",
]
