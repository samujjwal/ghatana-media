"""Focused tests for the provisioned office-renderer font assets (R2-10/R2-11)."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "models/increment4a/model-manifest.yaml"


def _verify_models():
    spec = importlib.util.spec_from_file_location("verify_models_fonts", ROOT / "scripts/verify_models.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _verify_increment4a():
    spec = importlib.util.spec_from_file_location("verify_increment4a_fonts", ROOT / "scripts/verify_increment4a.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_renderer_resolves_provisioned_fonts_first(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from document_intelligence.providers.office_rendered_parser import _ReportlabRenderer

    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", raising=False)
    renderer = _ReportlabRenderer()
    latin = renderer._resolve_font(renderer._LATIN_FONT)
    devanagari = renderer._resolve_font(renderer._DEVANAGARI_FONT)
    assert latin == ROOT / ".models/office-renderer/fonts/DejaVuSans.ttf"
    assert devanagari == ROOT / ".models/office-renderer/fonts/NotoSansDevanagari-Regular.ttf"

    # An explicit cache root override wins over the default provisioned tree.
    override = tmp_path / "cache" / "office-renderer" / "fonts"
    override.mkdir(parents=True)
    (override / "DejaVuSans.ttf").write_bytes(b"latin")
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(tmp_path / "cache"))
    assert renderer._resolve_font(renderer._LATIN_FONT) == override / "DejaVuSans.ttf"
    # A missing pinned asset resolves to nothing and makes the renderer
    # unavailable, even if the legacy host-font opt-in is set.
    assert renderer._resolve_font(renderer._DEVANAGARI_FONT) is None
    assert not renderer.available()
    # The opt-in cannot add host directories to the qualified renderer's search.
    host = tmp_path / "host-fonts"
    host.mkdir()
    (host / "NotoSansDevanagari-Regular.ttf").write_bytes(b"devanagari")
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_OFFICE_RENDERER_HOST_FONTS", "1")
    assert renderer._font_dirs() == [tmp_path / "cache" / "office-renderer" / "fonts"]
    assert renderer._resolve_font(renderer._DEVANAGARI_FONT) is None
    assert not renderer.available()


def test_registered_font_names_use_provisioned_files() -> None:
    pytest.importorskip("reportlab")
    from document_intelligence.providers.office_rendered_parser import _ReportlabRenderer

    devanagari, latin = _ReportlabRenderer()._fonts()
    assert latin != "Helvetica"
    assert "Devanagari" in devanagari


def test_font_asset_verification_fails_closed(tmp_path: Path) -> None:
    verifier = _verify_models()
    font = tmp_path / "font.ttf"
    font.write_bytes(b"glyphs")
    digest = hashlib.sha256(b"glyphs").hexdigest()
    entry = {
        "providerRef": "test.provider",
        "fontAssets": {"latin": {"path": font.name, "sha256": digest}},
    }
    # The verifier resolves declared paths against the worker root; a path that
    # does not exist there must be reported, not silently skipped.
    issues: list[str] = []
    verifier._verify_font_assets(entry, issues)
    assert any("MISSING_FONT_ASSET" in issue for issue in issues)

    real = next((ROOT / ".models/office-renderer/fonts").glob("*.ttf"))
    issues = []
    verifier._verify_font_assets(
        {"providerRef": "test.provider", "fontAssets": {"latin": {"path": str(real.relative_to(ROOT)), "sha256": "0" * 64}}},
        issues,
    )
    assert any("FONT_ASSET_MISMATCH" in issue for issue in issues)

    issues = []
    verifier._verify_font_assets(
        {"providerRef": "test.provider", "fontAssets": {"latin": {"path": str(real.relative_to(ROOT)), "sha256": hashlib.sha256(real.read_bytes()).hexdigest()}}},
        issues,
    )
    assert issues == []


def test_manifest_font_assets_match_provisioned_files() -> None:
    import yaml

    manifest = yaml.safe_load(MANIFEST.read_text())
    entry = next(item for item in manifest["models"] if item["providerRef"] == "ghatana.docling-docx")
    assert set(entry["fontAssets"]) == {"latin", "devanagari"}
    for record in entry["fontAssets"].values():
        target = ROOT / record["path"]
        assert target.is_file()
        assert target.parent.name == "fonts"
        assert target.parent.parent == ROOT / ".models/office-renderer"
        assert hashlib.sha256(target.read_bytes()).hexdigest() == record["sha256"]


def _write_report(root: Path, report: dict) -> None:
    lane = root / "models/increment4a"
    lane.mkdir(parents=True, exist_ok=True)
    (lane / "model-manifest.yaml").write_text("manifest: true\n")
    (lane / "model-verification.json").write_text(json.dumps(report))


def test_model_assets_status_reconciles_report(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    verifier = _verify_increment4a()
    monkeypatch.setattr(verifier, "ROOT", tmp_path)
    monkeypatch.setattr(verifier, "_live_model_evidence_status", lambda: "PASS")
    assert verifier.model_assets_status() == "NOT_RUN"

    manifest_sha = hashlib.sha256(b"manifest: true\n").hexdigest()
    good = {
        "schemaVersion": "document-intelligence.model-verification.v2",
        "manifestSha256": manifest_sha,
        "status": "PASS",
        "issues": [],
        "artifacts": [{"status": "VERIFIED"}],
        "models": [{"status": "VERIFIED"}],
    }
    _write_report(tmp_path, good)
    assert verifier.model_assets_status() == "PASS"

    _write_report(tmp_path, {**good, "manifestSha256": "0" * 64})
    assert verifier.model_assets_status() == "STALE"

    _write_report(tmp_path, {**good, "status": "FAIL"})
    assert verifier.model_assets_status() == "FAIL"

    _write_report(tmp_path, {**good, "models": [{"status": "FAIL"}]})
    assert verifier.model_assets_status() == "FAIL"

    (tmp_path / "models/increment4a/model-verification.json").write_text("{")
    assert verifier.model_assets_status() == "FAIL"



def test_qualified_renderer_defaults_to_reportlab(monkeypatch: pytest.MonkeyPatch) -> None:
    from document_intelligence.providers import office_rendered_parser as module

    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_OFFICE_RENDERER", raising=False)
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_EXPERIMENTAL_OFFICE_RENDERER", raising=False)
    monkeypatch.setattr(module._ReportlabRenderer, "available", lambda self: True)
    monkeypatch.setattr(module._SofficeRenderer, "available", lambda self: True)
    assert module._default_renderer().name == "reportlab"


def test_renderer_auto_is_rejected_and_soffice_requires_explicit_experimental_override(monkeypatch: pytest.MonkeyPatch) -> None:
    from document_intelligence.errors import WorkerError
    from document_intelligence.providers import office_rendered_parser as module

    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_OFFICE_RENDERER", "auto")
    with pytest.raises(WorkerError) as auto:
        module._default_renderer()
    assert auto.value.code == "INVALID_REQUEST"

    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_OFFICE_RENDERER", "soffice")
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_EXPERIMENTAL_OFFICE_RENDERER", raising=False)
    with pytest.raises(WorkerError) as unapproved:
        module._default_renderer()
    assert unapproved.value.code == "PROVIDER_UNAVAILABLE"

    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_EXPERIMENTAL_OFFICE_RENDERER", "true")
    monkeypatch.setattr(module._SofficeRenderer, "available", lambda self: True)
    experimental = module._default_renderer()
    assert experimental.name == "soffice"
    assert module.OfficeRenderedParser(experimental).identity()["providerRef"] == "ghatana.docling-docx.experimental-soffice"


def test_missing_pinned_font_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from document_intelligence.errors import WorkerError
    from document_intelligence.providers.office_rendered_parser import _ReportlabRenderer

    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(tmp_path))
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_OFFICE_RENDERER_HOST_FONTS", "1")
    with pytest.raises(WorkerError) as rejected:
        _ReportlabRenderer()._fonts()
    assert rejected.value.code == "PROVIDER_UNAVAILABLE"
