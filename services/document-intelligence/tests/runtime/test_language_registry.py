from pathlib import Path

import pytest

from document_intelligence.runtime.language_registry import load_language_registry


def test_language_registry_admits_candidates_but_not_unknown(tmp_path: Path):
    path = tmp_path / "languages.yaml"
    path.write_text("schemaVersion: document-intelligence.language-registry.v1\nlanguages:\n  hi:\n    targetState: CANDIDATE\ndefaultState: NOT_EVALUATED\n", encoding="utf-8")
    registry = load_language_registry(path)
    assert registry.admitted("hi")
    assert registry.state("fr") == "NOT_EVALUATED"
    assert not registry.admitted("fr")


def test_language_registry_rejects_unknown_state(tmp_path: Path):
    path = tmp_path / "languages.yaml"
    path.write_text("schemaVersion: document-intelligence.language-registry.v1\nlanguages:\n  hi:\n    targetState: MADE_UP\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_language_registry(path)
