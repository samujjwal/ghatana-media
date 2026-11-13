from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "models/increment4a/model-manifest.yaml"
ENVIRONMENT = ROOT / "evaluation/increment4a/environment.yaml"


def _verifier():
    spec = importlib.util.spec_from_file_location("verify_models_authority", ROOT / "scripts/verify_models.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_increment4a_catalog_records_observed_and_unavailable_material_separately() -> None:
    manifest = yaml.safe_load(MANIFEST.read_text())
    environment = yaml.safe_load(ENVIRONMENT.read_text())
    artifacts = manifest["artifacts"]
    models = manifest["models"]

    assert {item["cacheKey"] for item in artifacts} == {
        "ghatana.docling__docling-standard-pdf-pipeline__pinned-docling-runtime",
        "ghatana.paddleocr__PP-OCRv5-en__PP-OCRv5-local-en",
        "ghatana.paddleocr__PP-OCRv5-devanagari-shared__PP-OCRv5-local-devanagari-shared",
        "ghatana.gliner__urchade_gliner_multi-v2.1__443d26d",
        "ghatana.minilm__sentence-transformers_all-MiniLM-L6-v2__1110a24",
        "office-renderer",
    }
    fonts = [item for item in artifacts if item["artifactId"] == "office-renderer.fonts"]
    assert len(fonts) == 1
    assert fonts[0]["cacheKey"] == "office-renderer"
    assert fonts[0]["verification"] == "VERIFIED"
    deva = [item for item in artifacts if item["artifactId"] == "paddleocr.devanagari.shared"]
    assert len(deva) == 1
    assert deva[0]["sharedLanguages"] == ["ne", "hi", "mr"]
    assert deva[0]["verification"] == "VERIFIED"

    for language in ("ne", "hi", "mr"):
        entry = next(item for item in models if item.get("language") == language)
        assert entry["requirement"] == "MODEL_ARTIFACT"
        assert entry["status"] == "VERIFIED"
        assert entry["modelRef"] == "PP-OCRv5-devanagari-shared"
        assert entry["artifactSha256"] == deva[0]["artifactSha256"]
    for provider in ("ghatana.docling-pptx", "ghatana.docling-xlsx"):
        entry = next(item for item in models if item["providerRef"] == provider)
        assert entry["requirement"] == "RUNTIME_BACKEND"
        assert entry["runtimeDependency"] == "docling==2.128.0"
    docx = next(item for item in models if item["providerRef"] == "ghatana.docling-docx")
    assert docx["requirement"] == "RUNTIME_BACKEND"
    assert docx["artifactId"] == "office-renderer.fonts"
    assert docx["artifactSha256"] == fonts[0]["artifactSha256"]
    assert docx["provisioning"]["script"] == "scripts/provision_increment4a_assets.py"
    for role in ("latin", "devanagari"):
        record = docx["fontAssets"][role]
        path = ROOT / record["path"]
        assert path.is_file()
        assert hashlib.sha256(path.read_bytes()).hexdigest() == record["sha256"]
    gliner = next(item for item in artifacts if item["artifactId"] == "gliner.multilingual.local")
    assert gliner["modelRevision"] == "443d26d"
    assert gliner["artifactSha256"] == "9189d9ca6306f4eebed71045999eed850e23bfe69788468d7b5321e419cbd18a"
    assert "gliner==0.2.29" in gliner["revisionEvidence"]["runtime"]

    tesseract = next(item for item in models if item["providerRef"] == "ghatana.tesseractocr")
    assert tesseract["status"] == "VERIFIED"
    assert tesseract["requirement"] == "RUNTIME_ASSET"
    assert tesseract["cacheKey"] == "tesseract-runtime"
    assert tesseract["executable"]["available"] is True
    assert tesseract["executable"]["version"] == "5.3.4"
    assert all(item["available"] is True for item in tesseract["traineddata"].values())
    assert environment["authorityFingerprints"]["modelManifestSha256"] == hashlib.sha256(MANIFEST.read_bytes()).hexdigest()


def test_model_verifier_fails_closed_on_marker_or_tree_hash_tampering(tmp_path: Path) -> None:
    verifier = _verifier()
    cache = tmp_path / ".models"
    target = cache / "provider__model__revision-1"
    target.mkdir(parents=True)
    payload = target / "weights.bin"
    payload.write_bytes(b"authoritative bytes")
    digest = verifier.tree_digest(target)
    (target / ".artifact.sha256").write_text(digest + "\n")
    manifest = tmp_path / "model-manifest.yaml"
    manifest.write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "test.v1",
                "models": [
                    {
                        "providerRef": "provider",
                        "modelRef": "model",
                        "modelRevision": "revision-1",
                        "artifactSha256": digest,
                    }
                ],
            }
        )
    )

    assert verifier.verify_manifest(manifest, cache) == []
    payload.write_bytes(b"tampered bytes")
    issues = verifier.verify_manifest(manifest, cache)
    assert any(issue.startswith("INVALID_ARTIFACT_MARKER") for issue in issues)
    assert any(issue.startswith("INVALID_DECLARED_MODEL_DIGEST") for issue in issues)


def test_model_verifier_rejects_missing_revision_and_unavailable_declaration(tmp_path: Path) -> None:
    verifier = _verifier()
    manifest = tmp_path / "model-manifest.yaml"
    manifest.write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "test.v1",
                "models": [
                    {"providerRef": "provider", "modelRef": "missing-revision", "artifactSha256": None},
                    {
                        "providerRef": "provider",
                        "modelRef": "unavailable",
                        "modelRevision": "r1",
                        "status": "UNAVAILABLE",
                        "artifactSha256": None,
                    },
                ],
            }
        )
    )
    issues = verifier.verify_manifest(manifest, tmp_path / ".models")
    assert any(issue.startswith("MISSING_MODEL_REVISION") for issue in issues)
    assert any(issue.startswith("UNAVAILABLE_DECLARED_MODEL") for issue in issues)


def test_model_verification_report_paths_are_portable(tmp_path: Path) -> None:
    verifier = _verifier()
    external_cache = tmp_path / "private-model-cache"
    report = verifier.build_report(
        MANIFEST,
        external_cache,
        None,
        [f"MISSING_MODEL_CACHE {external_cache}"],
    )

    assert report["manifest"] == "models/increment4a/model-manifest.yaml"
    assert report["cacheRoot"] == "<external>/private-model-cache"
    assert report["issues"] == ["MISSING_MODEL_CACHE <external>/private-model-cache"]
    assert isinstance(report["runtimeEvidence"], dict)
    assert report["runtimeEvidence"]["uvLockSha256"] == hashlib.sha256((ROOT / "uv.lock").read_bytes()).hexdigest()
    assert report["assetFingerprints"] == verifier.declared_asset_fingerprints(
        yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    )


def _write_valid_authority_fixture(tmp_path: Path, monkeypatch) -> tuple[object, Path, Path]:
    verifier = _verifier()
    root = tmp_path / "worker"
    monkeypatch.setattr(verifier, "ROOT", root)

    authority_paths = verifier._authority_paths()
    for name, path in authority_paths.items():
        if name == "modelManifestSha256":
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"authority input for {name}\n", encoding="utf-8")

    manifest_path = authority_paths["modelManifestSha256"]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    internal_paths = {
        "qualificationSha256": root / "evaluation/increment4a/qualification.yaml",
        "acceptanceSha256": root / "evaluation/increment4a/acceptance.yaml",
        "languageRegistrySha256": root / "models/increment4a/language-registry.yaml",
        "uvLockSha256": root / "uv.lock",
        "pyprojectSha256": root / "pyproject.toml",
    }
    manifest = {
        "increment": "4A",
        "runtime": {"uvLockSha256": verifier.sha256(root / "uv.lock")},
        "authority": {
            "state": "FROZEN",
            "environmentFile": "evaluation/increment4a/environment.yaml",
            "inheritedIncrement3": {
                "modelManifest": "models/model-manifest.yaml",
                "modelManifestSha256": verifier.sha256(root / "models/model-manifest.yaml"),
            },
            "fingerprints": {name: verifier.sha256(path) for name, path in internal_paths.items()},
        },
    }
    manifest_path.write_text(yaml.safe_dump(manifest), encoding="utf-8")

    environment_path = root / "evaluation/increment4a/environment.yaml"
    environment_path.parent.mkdir(parents=True, exist_ok=True)
    environment_path.write_text(
        yaml.safe_dump({
            "state": "FROZEN",
            "runtime": {"uvLockSha256": verifier.sha256(root / "uv.lock")},
            "authorityFingerprints": {
                name: verifier.sha256(path) for name, path in authority_paths.items()
            },
        }),
        encoding="utf-8",
    )
    return verifier, manifest_path, environment_path


@pytest.mark.parametrize("scenario", ["missing", "stale", "mismatched"])
def test_runtime_uv_lock_hash_reconciliation_fails_closed(
    tmp_path: Path,
    monkeypatch,
    scenario: str,
) -> None:
    verifier, manifest_path, environment_path = _write_valid_authority_fixture(tmp_path, monkeypatch)
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    environment = yaml.safe_load(environment_path.read_text(encoding="utf-8"))
    if scenario == "missing":
        manifest["runtime"].pop("uvLockSha256")
        environment["runtime"].pop("uvLockSha256")
    elif scenario == "stale":
        manifest["runtime"]["uvLockSha256"] = "0" * 64
        environment["runtime"]["uvLockSha256"] = "0" * 64
    else:
        environment["runtime"]["uvLockSha256"] = "0" * 64
    manifest_path.write_text(yaml.safe_dump(manifest), encoding="utf-8")
    environment_path.write_text(yaml.safe_dump(environment), encoding="utf-8")

    issues = verifier.verify_authority_only(manifest_path, environment_path)
    assert any(issue.startswith("RUNTIME_MISMATCH") and "uvLockSha256" in issue for issue in issues)


def test_authority_only_verification_checks_hashes_without_runtime_or_cache_scan(
    tmp_path: Path,
    monkeypatch,
) -> None:
    verifier, manifest_path, environment_path = _write_valid_authority_fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(verifier, "_runtime_snapshot", lambda _packages: (_ for _ in ()).throw(AssertionError("runtime snapshot called")))
    monkeypatch.setattr(verifier, "_verify_cache_entry", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("cache scan called")))

    assert verifier.verify_authority_only(manifest_path, environment_path) == []

    (verifier.ROOT / "pyproject.toml").write_text("changed after freeze\n", encoding="utf-8")
    issues = verifier.verify_authority_only(manifest_path, environment_path)
    assert any(issue.startswith("MODEL_INTERNAL_FINGERPRINT_MISMATCH pyprojectSha256") for issue in issues)
    assert any(issue.startswith("AUTHORITY_FINGERPRINT_MISMATCH pyprojectSha256") for issue in issues)


def test_authority_only_verification_rejects_missing_environment_pin_and_manifest_authority(
    tmp_path: Path,
    monkeypatch,
) -> None:
    verifier, manifest_path, environment_path = _write_valid_authority_fixture(tmp_path, monkeypatch)
    environment = yaml.safe_load(environment_path.read_text(encoding="utf-8"))
    del environment["authorityFingerprints"]["increment3ModelManifestSha256"]
    environment_path.write_text(yaml.safe_dump(environment), encoding="utf-8")

    issues = verifier.verify_authority_only(manifest_path, environment_path)
    assert "MISSING_AUTHORITY_FINGERPRINT increment3ModelManifestSha256" in issues

    manifest_path.write_text(yaml.safe_dump({"increment": "4A"}), encoding="utf-8")
    issues = verifier.verify_authority_only(manifest_path, environment_path)
    assert any(issue.startswith("MISSING_MODEL_AUTHORITY") for issue in issues)


def test_standard_increment4a_manifest_cannot_skip_checks_by_dropping_authority(
    tmp_path: Path,
    monkeypatch,
) -> None:
    verifier, manifest_path, environment_path = _write_valid_authority_fixture(tmp_path, monkeypatch)
    manifest_path.write_text(
        yaml.safe_dump({
            "models": [{
                "providerRef": "provider",
                "modelRef": "model",
                "modelRevision": "r1",
                "status": "UNAVAILABLE",
                "availabilityReason": "fixture",
                "artifactSha256": None,
            }],
        }),
        encoding="utf-8",
    )

    issues = verifier.verify_manifest(manifest_path, tmp_path / ".models", environment_path)
    assert any(issue.startswith("MISSING_MODEL_AUTHORITY") for issue in issues)
