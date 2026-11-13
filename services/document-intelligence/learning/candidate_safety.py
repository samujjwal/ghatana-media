"""Candidate artifact admission policy (OCR-I5-37).

Candidate artifacts are inspected before they enter the registry.  The safe
default admits declarative JSON/YAML and tensor formats whose loaders do not
execute arbitrary Python.  Pickle-like formats are rejected unless a caller
explicitly supplies a separately authorized sandbox policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class CandidateArtifactError(ValueError):
    pass


SAFE_CANDIDATE_SUFFIXES = frozenset({
    ".json",
    ".yaml",
    ".yml",
    ".onnx",
    ".safetensors",
    ".tflite",
    ".pdmodel",
    ".pdiparams",
})
UNSAFE_CANDIDATE_SUFFIXES = frozenset({
    ".pkl",
    ".pickle",
    ".pt",
    ".pth",
    ".joblib",
    ".dill",
})


@dataclass(frozen=True)
class CandidateArtifactPolicy:
    allow_unsafe_serialization: bool = False
    sandbox_authorization: str | None = None


def validate_candidate_artifact(path: Path | str, policy: CandidateArtifactPolicy | None = None) -> dict[str, str]:
    policy = policy or CandidateArtifactPolicy()
    artifact = Path(path)
    if not artifact.is_file() or artifact.is_symlink():
        raise CandidateArtifactError("candidate artifact must be a regular local file")
    suffix = artifact.suffix.lower()
    if suffix in UNSAFE_CANDIDATE_SUFFIXES and not (policy.allow_unsafe_serialization and policy.sandbox_authorization):
        raise CandidateArtifactError("unsafe candidate serialization requires explicit sandbox authorization")
    if suffix not in SAFE_CANDIDATE_SUFFIXES and suffix not in UNSAFE_CANDIDATE_SUFFIXES:
        raise CandidateArtifactError(f"candidate artifact format is not admitted: {suffix or '<none>'}")
    return {
        "format": suffix[1:],
        "loaderPolicy": "SANDBOX_AUTHORIZED_UNSAFE" if suffix in UNSAFE_CANDIDATE_SUFFIXES else "SAFE_DECLARATIVE",
    }


__all__ = [
    "CandidateArtifactError",
    "CandidateArtifactPolicy",
    "SAFE_CANDIDATE_SUFFIXES",
    "UNSAFE_CANDIDATE_SUFFIXES",
    "validate_candidate_artifact",
]
