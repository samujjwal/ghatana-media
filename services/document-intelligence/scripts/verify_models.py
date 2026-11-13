#!/usr/bin/env python3
"""Verify model authority and local runtime evidence without network access.

The Increment-3 invocation remains the default and deliberately reads the
frozen Increment-3 manifest.  Increment-4A is verified explicitly with
``--manifest models/increment4a/model-manifest.yaml``; its unavailable entries
are errors, not successful skips.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "models/model-manifest.yaml"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _verify_runtime_lock_hash(runtime: Any, issues: list[str], source: str) -> None:
    """Require a runtime authority to pin the exact local uv.lock bytes."""
    lock_path = ROOT / "uv.lock"
    try:
        actual = sha256(lock_path)
    except OSError:
        _artifact_issue(issues, "MISSING_RUNTIME_LOCK", report_path(lock_path))
        return
    expected = runtime.get("uvLockSha256") if isinstance(runtime, dict) else None
    if not isinstance(expected, str) or expected != actual:
        _artifact_issue(issues, "RUNTIME_MISMATCH", f"{source}.uvLockSha256 expected={expected} actual={actual}")


def report_path(path: Path) -> str:
    """Render workspace paths portably without leaking local filesystem roots."""
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return f"<external>/{resolved.name}"


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def runtime_evidence_snapshot(runtime: dict[str, Any]) -> dict[str, Any]:
    """Return the live runtime identity used to verify model authorities."""
    packages = runtime.get("packages", {})
    if not isinstance(packages, dict):
        raise ValueError("runtime packages must be a mapping")
    observed, _ = _runtime_snapshot(sorted(packages))
    return {
        "pythonVersion": observed["pythonVersion"],
        "uvVersion": observed["uvVersion"],
        "uvLockSha256": sha256(ROOT / "uv.lock"),
        "packages": observed["packages"],
        "packagesFingerprint": observed["packagesFingerprint"],
        "platformFingerprint": observed["platformFingerprint"],
        "hardwareFingerprint": observed["hardwareFingerprint"],
    }


def declared_asset_fingerprints(manifest: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Describe the exact model/runtime assets covered by a verification report.

    These values are the frozen expected digests. A PASS report means the live
    verifier observed those bytes; strict receipt reuse rechecks them against
    the current cache before treating that report as current.
    """
    cache_trees: dict[str, str] = {}
    for artifact in manifest.get("artifacts", []) or []:
        if not isinstance(artifact, dict):
            continue
        key = artifact.get("cacheKey")
        digest = artifact.get("artifactSha256")
        if artifact.get("availability") == "AVAILABLE" and artifact.get("verification") == "VERIFIED":
            if isinstance(key, str) and key and isinstance(digest, str) and digest:
                cache_trees[key] = digest

    executables: dict[str, str] = {}
    traineddata: dict[str, str] = {}
    font_assets: dict[str, str] = {}
    for entry in manifest.get("models", []) or []:
        if not isinstance(entry, dict) or entry.get("status", "VERIFIED") != "VERIFIED":
            continue
        requirement = entry.get("requirement", "MODEL_ARTIFACT")
        if requirement == "MODEL_ARTIFACT":
            key = cache_key(entry)
            digest = entry.get("artifactSha256")
            if key and isinstance(digest, str) and digest:
                cache_trees[key] = digest
        elif requirement == "RUNTIME_ASSET":
            key = entry.get("cacheKey")
            digest = entry.get("artifactSha256")
            if isinstance(key, str) and key and isinstance(digest, str) and digest:
                cache_trees[key] = digest
            executable = entry.get("executable")
            if isinstance(executable, dict) and isinstance(executable.get("sha256"), str):
                executables[str(entry.get("providerRef", "unknown"))] = executable["sha256"]
            for language, record in (entry.get("traineddata") or {}).items():
                if isinstance(record, dict) and isinstance(record.get("sha256"), str):
                    traineddata[f"{entry.get('providerRef', 'unknown')}:{language}"] = record["sha256"]
        fonts = entry.get("fontAssets")
        if isinstance(fonts, dict):
            for role, record in fonts.items():
                if isinstance(record, dict) and isinstance(record.get("sha256"), str):
                    font_assets[f"{entry.get('providerRef', 'unknown')}:{role}"] = record["sha256"]

    return {
        "cacheTrees": dict(sorted(cache_trees.items())),
        "executables": dict(sorted(executables.items())),
        "traineddata": dict(sorted(traineddata.items())),
        "fontAssets": dict(sorted(font_assets.items())),
    }


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(
        item
        for item in root.rglob("*")
        if item.is_file() and item.name not in {"PROVISIONING_REQUIRED", ".artifact.sha256"}
    ):
        digest.update(str(path.relative_to(root)).encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def cache_key(entry: dict[str, Any]) -> str | None:
    revision = entry.get("modelRevision")
    if not isinstance(revision, str) or not revision:
        return None
    provider = entry.get("providerRef")
    model_ref = entry.get("modelRef")
    if not all(isinstance(value, str) and value for value in (provider, model_ref)):
        return None
    return f"{provider}__{model_ref}__{revision}".replace("/", "_")


def _artifact_issue(issues: list[str], prefix: str, message: str) -> None:
    issues.append(f"{prefix} {message}")


def _verify_cache_entry(
    *,
    cache_root: Path,
    cache_name: str,
    expected_digest: str | None,
    issues: list[str],
) -> None:
    target = cache_root / cache_name
    if not target.is_dir():
        _artifact_issue(issues, "MISSING_DECLARED_MODEL", cache_name)
        return
    if (target / "PROVISIONING_REQUIRED").exists():
        _artifact_issue(issues, "PROVISIONING_REQUIRED_MODEL", cache_name)
    files = [
        path
        for path in target.rglob("*")
        if path.is_file() and path.name not in {".artifact.sha256", "PROVISIONING_REQUIRED"}
    ]
    if not files:
        _artifact_issue(issues, "EMPTY_DECLARED_MODEL", cache_name)
        return
    marker = target / ".artifact.sha256"
    if not marker.is_file():
        _artifact_issue(issues, "MISSING_ARTIFACT_DIGEST", cache_name)
        return
    actual = tree_digest(target)
    recorded = marker.read_text(encoding="utf-8").strip()
    if recorded != actual:
        _artifact_issue(issues, "INVALID_ARTIFACT_MARKER", f"{cache_name} expected={actual} recorded={recorded}")
    if expected_digest is None:
        _artifact_issue(issues, "MISSING_DECLARED_ARTIFACT_HASH", cache_name)
    elif expected_digest != actual:
        _artifact_issue(issues, "INVALID_DECLARED_MODEL_DIGEST", f"{cache_name} expected={expected_digest} actual={actual}")


def _runtime_snapshot(package_names: list[str]) -> tuple[dict[str, Any], list[str]]:
    issues: list[str] = []
    packages: dict[str, str | None] = {}
    for name in package_names:
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    platform_snapshot = {
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "platform": platform.platform(),
        "pythonImplementation": platform.python_implementation(),
        "libc": list(platform.libc_ver()),
        "distribution": platform.freedesktop_os_release().get("PRETTY_NAME", "unknown"),
    }
    hardware_snapshot = {
        "architecture": platform.machine(),
        "cpuModel": next(
            (line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")),
            None,
        ),
        "logicalCpus": os.cpu_count(),
    }
    snapshot = {
        "pythonVersion": platform.python_version(),
        "uvVersion": _uv_version(),
        "packages": packages,
        "packagesFingerprint": canonical_sha256(packages),
        "platform": platform_snapshot,
        "platformFingerprint": canonical_sha256(platform_snapshot),
        "hardware": hardware_snapshot,
        "hardwareFingerprint": canonical_sha256(hardware_snapshot),
    }
    return snapshot, issues


def _uv_version() -> str | None:
    executable = shutil.which("uv")
    if executable is None:
        return None
    try:
        result = subprocess.run([executable, "--version"], check=False, capture_output=True, text=True)
    except OSError:
        return None
    if result.returncode != 0:
        return None
    parts = result.stdout.strip().split()
    return parts[1] if len(parts) > 1 and parts[0] == "uv" else None


def _verify_runtime(runtime: dict[str, Any], issues: list[str]) -> None:
    _verify_runtime_lock_hash(runtime, issues, "runtime")
    expected_packages = runtime.get("packages", {})
    if not isinstance(expected_packages, dict):
        _artifact_issue(issues, "INVALID_RUNTIME_DECLARATION", "packages must be a mapping")
        return
    actual, _ = _runtime_snapshot(sorted(expected_packages))
    if runtime.get("pythonVersion") != actual["pythonVersion"]:
        _artifact_issue(issues, "RUNTIME_MISMATCH", f"python expected={runtime.get('pythonVersion')} actual={actual['pythonVersion']}")
    if runtime.get("uvVersion") != actual["uvVersion"]:
        _artifact_issue(issues, "RUNTIME_MISMATCH", f"uv expected={runtime.get('uvVersion')} actual={actual['uvVersion']}")
    if runtime.get("packagesFingerprint") != actual["packagesFingerprint"]:
        _artifact_issue(issues, "RUNTIME_MISMATCH", "package fingerprint")
    for name, expected in expected_packages.items():
        if actual["packages"].get(name) != str(expected):
            _artifact_issue(issues, "RUNTIME_MISMATCH", f"{name} expected={expected} actual={actual['packages'].get(name)}")
    for field in ("platformFingerprint", "hardwareFingerprint"):
        if runtime.get(field) != actual[field]:
            _artifact_issue(issues, "RUNTIME_MISMATCH", field)
    for group in ("platform", "hardware"):
        expected_group = runtime.get(group, {})
        actual_group = actual[group]
        if isinstance(expected_group, dict):
            for name, expected in expected_group.items():
                if actual_group.get(name) != expected:
                    _artifact_issue(issues, "RUNTIME_MISMATCH", f"{group}.{name} expected={expected} actual={actual_group.get(name)}")


def _verify_runtime_backend(entry: dict[str, Any], runtime_packages: dict[str, Any], issues: list[str]) -> None:
    """A RUNTIME_BACKEND model is provisioned by the pinned package runtime."""
    dependency = entry.get("runtimeDependency")
    provider = entry.get("providerRef", "unknown")
    if not isinstance(dependency, str) or "==" not in dependency:
        _artifact_issue(issues, "MISSING_RUNTIME_DEPENDENCY", f"{provider}: runtimeDependency must be name==version")
        return
    name, _, version = dependency.partition("==")
    declared = runtime_packages.get(name)
    if declared != version:
        _artifact_issue(issues, "RUNTIME_DEPENDENCY_MISMATCH", f"{provider}: {name} expected={version} declared={declared}")


def _verify_runtime_asset(entry: dict[str, Any], issues: list[str]) -> None:
    """A RUNTIME_ASSET model is a provisioned executable plus data files."""
    provider = entry.get("providerRef", "unknown")
    executable = entry.get("executable")
    if not isinstance(executable, dict) or not isinstance(executable.get("command"), str):
        _artifact_issue(issues, "MISSING_RUNTIME_EXECUTABLE", f"{provider}: no executable declaration")
        return
    command = executable["command"]
    declared_path = executable.get("path")
    resolved = str(ROOT / declared_path) if isinstance(declared_path, str) and declared_path and (ROOT / declared_path).is_file() else shutil.which(command)
    if resolved is None:
        _artifact_issue(issues, "MISSING_RUNTIME_EXECUTABLE", f"{provider}: {command}")
    else:
        declared_sha = executable.get("sha256")
        if isinstance(declared_sha, str) and declared_sha and sha256(Path(resolved)) != declared_sha:
            _artifact_issue(issues, "RUNTIME_EXECUTABLE_MISMATCH", f"{provider}: {command}")
        declared_version = executable.get("version")
        if isinstance(declared_version, str) and declared_version:
            env = dict(os.environ)
            library_dir = Path(resolved).parent.parent / "lib" / "x86_64-linux-gnu"
            if library_dir.is_dir():
                env["LD_LIBRARY_PATH"] = f"{library_dir}:{env.get('LD_LIBRARY_PATH', '')}"
            try:
                probe = subprocess.run([resolved, "--version"], check=False, capture_output=True, text=True, timeout=10, env=env)
            except (OSError, subprocess.SubprocessError):
                probe = None
            if probe is None or declared_version not in f"{probe.stdout}\n{probe.stderr}":
                _artifact_issue(issues, "RUNTIME_EXECUTABLE_VERSION_MISMATCH", f"{provider}: {command}")
    traineddata = entry.get("traineddata")
    if isinstance(traineddata, dict):
        for language, record in traineddata.items():
            if not isinstance(record, dict) or record.get("available") is not True:
                _artifact_issue(issues, "MISSING_RUNTIME_TRAINEDDATA", f"{provider}: {language}")
                continue
            path = record.get("path")
            target = Path(path) if isinstance(path, str) and path else None
            if target is None or not target.is_file():
                _artifact_issue(issues, "MISSING_RUNTIME_TRAINEDDATA", f"{provider}: {language}")
                continue
            declared_sha = record.get("sha256")
            if isinstance(declared_sha, str) and declared_sha and sha256(target) != declared_sha:
                _artifact_issue(issues, "RUNTIME_TRAINEDDATA_MISMATCH", f"{provider}: {language}")


def _verify_font_assets(entry: dict[str, Any], issues: list[str]) -> None:
    """Declared font assets are provisioned files verified byte-for-byte."""
    provider = entry.get("providerRef", "unknown")
    fonts = entry.get("fontAssets")
    if not isinstance(fonts, dict) or not fonts:
        _artifact_issue(issues, "MISSING_FONT_ASSETS", f"{provider}: no fontAssets declaration")
        return
    for role, record in fonts.items():
        if not isinstance(record, dict):
            _artifact_issue(issues, "MISSING_FONT_ASSET", f"{provider}: {role}")
            continue
        path = record.get("path")
        target = ROOT / path if isinstance(path, str) and path else None
        if target is None or not target.is_file():
            _artifact_issue(issues, "MISSING_FONT_ASSET", f"{provider}: {role}")
            continue
        declared_sha = record.get("sha256")
        if not isinstance(declared_sha, str) or not declared_sha:
            _artifact_issue(issues, "MISSING_FONT_ASSET_DIGEST", f"{provider}: {role}")
        elif sha256(target) != declared_sha:
            _artifact_issue(issues, "FONT_ASSET_MISMATCH", f"{provider}: {role}")


def _verify_model_internal_authority(manifest: dict[str, Any], issues: list[str]) -> None:
    """Require a frozen Increment-4A manifest with current internal hashes."""
    authority = manifest.get("authority")
    if not isinstance(authority, dict):
        _artifact_issue(issues, "MISSING_MODEL_AUTHORITY", "Increment-4A authority block is required")
        return
    if authority.get("state") != "FROZEN":
        _artifact_issue(issues, "MODEL_AUTHORITY_NOT_FROZEN", str(authority.get("state")))
    inherited = authority.get("inheritedIncrement3")
    if not isinstance(inherited, dict) or inherited.get("modelManifest") != "models/model-manifest.yaml":
        _artifact_issue(issues, "INVALID_INHERITED_INCREMENT3_AUTHORITY", "model manifest path")
    else:
        inherited_path = ROOT / "models/model-manifest.yaml"
        actual = sha256(inherited_path) if inherited_path.is_file() else None
        if inherited.get("modelManifestSha256") != actual:
            _artifact_issue(issues, "INHERITED_INCREMENT3_MANIFEST_MISMATCH", f"expected={inherited.get('modelManifestSha256')} actual={actual}")
    expected_paths = {
        "qualificationSha256": ROOT / "evaluation/increment4a/qualification.yaml",
        "acceptanceSha256": ROOT / "evaluation/increment4a/acceptance.yaml",
        "languageRegistrySha256": ROOT / "models/increment4a/language-registry.yaml",
        "uvLockSha256": ROOT / "uv.lock",
        "pyprojectSha256": ROOT / "pyproject.toml",
    }
    fingerprints = authority.get("fingerprints")
    if not isinstance(fingerprints, dict):
        _artifact_issue(issues, "MISSING_MODEL_INTERNAL_FINGERPRINTS", "authority.fingerprints")
        return
    for name, path in expected_paths.items():
        expected = fingerprints.get(name)
        actual = sha256(path) if path.is_file() else None
        if not isinstance(expected, str) or expected != actual:
            _artifact_issue(issues, "MODEL_INTERNAL_FINGERPRINT_MISMATCH", f"{name} expected={expected} actual={actual}")


def _authority_paths() -> dict[str, Path]:
    return {
        "modelManifestSha256": ROOT / "models/increment4a/model-manifest.yaml",
        "increment3ModelManifestSha256": ROOT / "models/model-manifest.yaml",
        "increment3AcceptanceSha256": ROOT / "evaluation/acceptance.yaml",
        "increment3EnvironmentSha256": ROOT / "evaluation/environment.yaml",
        "increment3CorpusManifestSha256": ROOT / "evaluation/manifest.yaml",
        "increment4aQualificationSha256": ROOT / "evaluation/increment4a/qualification.yaml",
        "increment4aAcceptanceSha256": ROOT / "evaluation/increment4a/acceptance.yaml",
        "increment4aLanguageRegistrySha256": ROOT / "models/increment4a/language-registry.yaml",
        "uvLockSha256": ROOT / "uv.lock",
        "pyprojectSha256": ROOT / "pyproject.toml",
    }


def _verify_authority_fingerprints(environment_path: Path, issues: list[str]) -> None:
    if not environment_path.is_file():
        _artifact_issue(issues, "MISSING_AUTHORITY_ENVIRONMENT", str(environment_path))
        return
    try:
        environment = yaml.safe_load(environment_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as error:
        _artifact_issue(issues, "INVALID_AUTHORITY_ENVIRONMENT", str(error))
        return
    _verify_runtime_lock_hash(environment.get("runtime"), issues, "environment.runtime")
    fingerprints = environment.get("authorityFingerprints")
    if not isinstance(fingerprints, dict):
        _artifact_issue(issues, "MISSING_AUTHORITY_FINGERPRINTS", str(environment_path))
        return
    authority_paths = _authority_paths()
    missing = sorted(set(authority_paths) - set(fingerprints))
    for name in missing:
        _artifact_issue(issues, "MISSING_AUTHORITY_FINGERPRINT", name)
    for name, expected in fingerprints.items():
        path = authority_paths.get(name)
        if path is None:
            _artifact_issue(issues, "UNKNOWN_AUTHORITY_FINGERPRINT", name)
            continue
        if not path.is_file():
            _artifact_issue(issues, "MISSING_AUTHORITY_INPUT", str(path))
            continue
        actual = sha256(path)
        if not isinstance(expected, str) or len(expected) != 64 or expected.startswith("__") or expected != actual:
            _artifact_issue(issues, "AUTHORITY_FINGERPRINT_MISMATCH", f"{name} expected={expected} actual={actual}")


def verify_authority_only(
    manifest_path: Path,
    environment_path: Path | None = None,
) -> list[str]:
    """Check frozen Increment-4A authority hashes without inspecting assets.

    This deliberately omits model-cache scans, runtime package snapshots, and
    executable probes. It is suitable for the strict evidence gate to
    revalidate nested authority inputs after the full model report was made.
    """
    resolved_manifest = manifest_path if manifest_path.is_absolute() else ROOT / manifest_path
    try:
        manifest = yaml.safe_load(resolved_manifest.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as error:
        return [f"INVALID_MANIFEST {resolved_manifest}: {error}"]
    if not isinstance(manifest, dict) or manifest.get("increment") != "4A":
        return [f"INVALID_INCREMENT4A_AUTHORITY_MANIFEST {resolved_manifest}"]

    issues: list[str] = []
    _verify_model_internal_authority(manifest, issues)
    _verify_runtime_lock_hash(manifest.get("runtime"), issues, "runtime")
    authority = manifest.get("authority")
    if not isinstance(authority, dict):
        return issues
    if environment_path is None:
        environment_ref = authority.get("environmentFile", "evaluation/increment4a/environment.yaml")
        if not isinstance(environment_ref, str) or not environment_ref:
            _artifact_issue(issues, "INVALID_AUTHORITY_ENVIRONMENT_REFERENCE", str(environment_ref))
            return issues
        environment_path = ROOT / environment_ref
    elif not environment_path.is_absolute():
        environment_path = ROOT / environment_path
    _verify_authority_fingerprints(environment_path, issues)
    return issues


def verify_manifest(manifest_path: Path, cache_root: Path, environment_path: Path | None = None) -> list[str]:
    issues: list[str] = []
    try:
        manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as error:
        return [f"INVALID_MANIFEST {manifest_path}: {error}"]
    models = manifest.get("models")
    if not isinstance(models, list) or not models:
        return [f"INVALID_MANIFEST_MODELS {manifest_path}"]

    is_increment4a = (
        manifest.get("increment") == "4A"
        or manifest_path.resolve() == (ROOT / "models/increment4a/model-manifest.yaml").resolve()
    )
    expected_cache: set[str] = set()
    verified_cache: dict[str, str] = {}

    artifacts = manifest.get("artifacts", []) if is_increment4a else []
    if artifacts and not isinstance(artifacts, list):
        issues.append("INVALID_ARTIFACT_CATALOG")
        artifacts = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            issues.append("INVALID_ARTIFACT_CATALOG_ENTRY")
            continue
        cache_name = artifact.get("cacheKey")
        if not isinstance(cache_name, str) or not cache_name:
            issues.append("INVALID_ARTIFACT_CACHE_KEY")
            continue
        status = artifact.get("verification")
        if artifact.get("availability") != "AVAILABLE" or status != "VERIFIED":
            _artifact_issue(issues, "UNAVAILABLE_DECLARED_ARTIFACT", f"{artifact.get('artifactId', cache_name)}: {artifact.get('availability')}/{status}")
            continue
        expected_cache.add(cache_name)
        _verify_cache_entry(cache_root=cache_root, cache_name=cache_name, expected_digest=artifact.get("artifactSha256"), issues=issues)
        verified_cache[cache_name] = str(artifact.get("artifactSha256"))
        revision_evidence = artifact.get("revisionEvidence")
        if isinstance(revision_evidence, dict):
            if revision_evidence.get("modelRevision") != artifact.get("modelRevision"):
                _artifact_issue(issues, "REVISION_MISMATCH", str(artifact.get("artifactId", cache_name)))
            ref_path = revision_evidence.get("encoderRefPath")
            if ref_path:
                ref = cache_root / cache_name / str(ref_path)
                if not ref.is_file() or ref.read_text(encoding="utf-8").strip() != revision_evidence.get("encoderRevision"):
                    _artifact_issue(issues, "REVISION_MISMATCH", str(ref))

    runtime_packages = manifest.get("runtime", {}).get("packages", {}) if isinstance(manifest.get("runtime"), dict) else {}
    for entry in models:
        if not isinstance(entry, dict):
            issues.append("INVALID_MODEL_ENTRY")
            continue
        requirement = entry.get("requirement", "MODEL_ARTIFACT")
        status = entry.get("status", "VERIFIED")
        key = cache_key(entry)
        if status != "VERIFIED":
            if entry.get("artifactSha256") not in (None, ""):
                _artifact_issue(issues, "UNAVAILABLE_MODEL_HAS_HASH", key or str(entry.get("modelRef", "unknown")))
            _artifact_issue(issues, "UNAVAILABLE_DECLARED_MODEL", f"{key or entry.get('providerRef', 'unknown')}: {entry.get('availabilityReason', 'no reason recorded')}")
            continue
        if requirement == "STRATEGY":
            continue
        if requirement == "RUNTIME_BACKEND":
            _verify_runtime_backend(entry, runtime_packages, issues)
            backend_artifact_id = entry.get("artifactId")
            if is_increment4a and backend_artifact_id:
                artifact = next((item for item in artifacts if isinstance(item, dict) and item.get("artifactId") == backend_artifact_id), None)
                if artifact is None:
                    _artifact_issue(issues, "MISSING_ARTIFACT_REFERENCE", f"{entry.get('providerRef', 'unknown')} -> {backend_artifact_id}")
                elif entry.get("artifactSha256") != artifact.get("artifactSha256"):
                    _artifact_issue(issues, "ARTIFACT_REFERENCE_HASH_MISMATCH", str(entry.get("providerRef", "unknown")))
            if "fontAssets" in entry:
                _verify_font_assets(entry, issues)
            continue
        if requirement == "RUNTIME_ASSET":
            _verify_runtime_asset(entry, issues)
            asset_cache = entry.get("cacheKey")
            if isinstance(asset_cache, str) and asset_cache:
                expected_cache.add(asset_cache)
                _verify_cache_entry(cache_root=cache_root, cache_name=asset_cache, expected_digest=entry.get("artifactSha256"), issues=issues)
                verified_cache[asset_cache] = str(entry.get("artifactSha256"))
            continue
        if key is None:
            _artifact_issue(issues, "MISSING_MODEL_REVISION", str(entry.get("modelRef", "unknown")))
            continue
        expected_cache.add(key)
        artifact_id = entry.get("artifactId")
        if is_increment4a and artifact_id:
            artifact = next((item for item in artifacts if isinstance(item, dict) and item.get("artifactId") == artifact_id), None)
            if artifact is None:
                _artifact_issue(issues, "MISSING_ARTIFACT_REFERENCE", f"{key} -> {artifact_id}")
            elif entry.get("artifactSha256") != artifact.get("artifactSha256"):
                _artifact_issue(issues, "ARTIFACT_REFERENCE_HASH_MISMATCH", key)
        expected_digest = entry.get("artifactSha256")
        if key not in verified_cache:
            _verify_cache_entry(cache_root=cache_root, cache_name=key, expected_digest=expected_digest, issues=issues)
            verified_cache[key] = str(expected_digest)

    if is_increment4a:
        _verify_model_internal_authority(manifest, issues)
        runtime = manifest.get("runtime")
        if not isinstance(runtime, dict):
            issues.append("MISSING_RUNTIME_AUTHORITY")
        else:
            _verify_runtime(runtime, issues)
        authority = manifest.get("authority", {})
        environment_ref = environment_path or ROOT / str(authority.get("environmentFile", "evaluation/increment4a/environment.yaml"))
        _verify_authority_fingerprints(environment_ref, issues)

    if not cache_root.is_dir():
        issues.append(f"MISSING_MODEL_CACHE {cache_root}")
    elif not is_increment4a:
        # The shared cache is also populated by the Increment-4A manifest;
        # only the Increment-4A authority audits undeclared cache directories.
        pass
    else:
        undeclared = sorted(path.name for path in cache_root.iterdir() if path.is_dir() and path.name not in expected_cache)
        for name in undeclared:
            _artifact_issue(issues, "UNDECLARED_MODEL", name)
    return issues


def build_report(manifest_path: Path, cache_root: Path, environment_path: Path | None, issues: list[str]) -> dict[str, Any]:
    """Per-item verification results for the Increment-4A reconciler."""
    try:
        manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        manifest = {}

    def item_status(*tokens: str) -> str:
        return "FAIL" if any(any(token in issue for token in tokens) for issue in issues) else "VERIFIED"

    artifacts = []
    for artifact in manifest.get("artifacts", []) or []:
        if isinstance(artifact, dict):
            artifacts.append({
                "artifactId": artifact.get("artifactId"),
                "cacheKey": artifact.get("cacheKey"),
                "status": item_status(str(artifact.get("artifactId")), str(artifact.get("cacheKey"))),
            })
    models = []
    for entry in manifest.get("models", []) or []:
        if isinstance(entry, dict):
            models.append({
                "providerRef": entry.get("providerRef"),
                "modelRef": entry.get("modelRef"),
                "language": entry.get("language"),
                "requirement": entry.get("requirement", "MODEL_ARTIFACT"),
                "status": item_status(str(entry.get("providerRef")), str(entry.get("modelRef")), str(cache_key(entry))),
            })
    runtime = manifest.get("runtime", {})
    try:
        runtime_evidence = runtime_evidence_snapshot(runtime if isinstance(runtime, dict) else {})
    except (OSError, ValueError):
        runtime_evidence = None
    return {
        "schemaVersion": "document-intelligence.model-verification.v2",
        "manifest": report_path(manifest_path),
        "manifestSha256": sha256(manifest_path),
        "cacheRoot": report_path(cache_root),
        "status": "PASS" if not issues else "FAIL",
        "issues": [
            issue.replace(str(manifest_path), report_path(manifest_path)).replace(
                str(cache_root), report_path(cache_root)
            )
            for issue in issues
        ],
        "artifacts": artifacts,
        "models": models,
        "assetFingerprints": declared_asset_fingerprints(manifest),
        "runtimeEvidence": runtime_evidence,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--environment", type=Path, default=None)
    parser.add_argument("--cache-root", default=os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(ROOT / ".models")))
    parser.add_argument("--report", type=Path, default=None, help="write a machine-readable verification report")
    args = parser.parse_args()
    manifest_path = args.manifest if args.manifest.is_absolute() else ROOT / args.manifest
    environment_path = None if args.environment is None else (args.environment if args.environment.is_absolute() else ROOT / args.environment)
    issues = verify_manifest(manifest_path, Path(args.cache_root), environment_path)
    if args.report is not None:
        report_path = args.report if args.report.is_absolute() else ROOT / args.report
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(build_report(manifest_path, Path(args.cache_root), environment_path, issues), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if issues:
        for issue in issues:
            print(issue)
        print("FAIL")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
