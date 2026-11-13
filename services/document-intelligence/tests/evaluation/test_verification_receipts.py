from __future__ import annotations

import importlib.util
import hashlib
import json
import socket
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def _free_port() -> int:
    """RUN-01: never hardcode a port — allocate an OS-chosen free port."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _verifier():
    spec = importlib.util.spec_from_file_location("verify_increment4a_receipts", ROOT / "scripts/verify_increment4a.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _live_model_evidence_fixture(tmp_path: Path, monkeypatch):
    verifier = _verifier()
    root = tmp_path / "worker"
    lane = root / "evaluation/increment4a"
    lane.mkdir(parents=True)
    (root / "models/increment4a").mkdir(parents=True)
    cache_root = root / "model-cache"
    cache = cache_root / "provider__model__r1"
    cache.mkdir(parents=True)
    asset = cache / "weights.bin"
    asset.write_bytes(b"verified model bytes")
    asset_tree = hashlib.sha256()
    asset_tree.update(b"weights.bin")
    asset_tree.update(asset.read_bytes())
    asset_digest = asset_tree.hexdigest()
    (cache / ".artifact.sha256").write_text(asset_digest + "\n", encoding="utf-8")

    (root / "uv.lock").write_bytes(b"fixture lock bytes\n")
    runtime_snapshot = {
        "pythonVersion": "3.12.3",
        "uvVersion": "0.12.16",
        "uvLockSha256": hashlib.sha256((root / "uv.lock").read_bytes()).hexdigest(),
        "packages": {"pytest": "8.4.2"},
        "packagesFingerprint": "packages-frozen",
        "platformFingerprint": "platform-frozen",
        "hardwareFingerprint": "hardware-frozen",
    }
    manifest = {
        "increment": "4A",
        "runtime": {
            "packages": {"pytest": "8.4.2"},
            "uvLockSha256": runtime_snapshot["uvLockSha256"],
        },
        "artifacts": [{
            "availability": "AVAILABLE",
            "verification": "VERIFIED",
            "cacheKey": "provider__model__r1",
            "artifactSha256": asset_digest,
        }],
        "models": [{
            "providerRef": "provider",
            "modelRef": "model",
            "modelRevision": "r1",
            "artifactSha256": asset_digest,
            "status": "VERIFIED",
        }],
    }
    manifest_path = root / "models/increment4a/model-manifest.yaml"
    manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=True), encoding="utf-8")
    environment = {"runtime": {
        "python": runtime_snapshot["pythonVersion"],
        "uv": runtime_snapshot["uvVersion"],
        "uvLockSha256": runtime_snapshot["uvLockSha256"],
        "packages": runtime_snapshot["packages"],
        "packagesFingerprint": runtime_snapshot["packagesFingerprint"],
        "platformFingerprint": runtime_snapshot["platformFingerprint"],
        "hardwareFingerprint": runtime_snapshot["hardwareFingerprint"],
    }}
    environment_path = lane / "environment.yaml"
    environment_path.write_text(yaml.safe_dump(environment, sort_keys=True), encoding="utf-8")
    model_verification = {
        "schemaVersion": "document-intelligence.model-verification.v2",
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "cacheRoot": "model-cache",
        "status": "PASS",
        "issues": [],
        "artifacts": [{"status": "VERIFIED"}],
        "models": [{"status": "VERIFIED"}],
    }
    report_path = root / "models/increment4a/model-verification.json"
    (root / "models/increment4a").mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(model_verification), encoding="utf-8")

    model_verifier = verifier._load_model_verifier()
    model_verifier.ROOT = root
    monkeypatch.setattr(model_verifier, "_runtime_snapshot", lambda _packages: (runtime_snapshot, []))

    def verify_live(manifest_path: Path, current_cache_root: Path, _environment_path: Path):
        issues: list[str] = []
        model_verifier._verify_cache_entry(
            cache_root=current_cache_root,
            cache_name="provider__model__r1",
            expected_digest=asset_digest,
            issues=issues,
        )
        return issues

    monkeypatch.setattr(model_verifier, "verify_manifest", verify_live)
    monkeypatch.setattr(verifier, "ROOT", root)
    monkeypatch.setattr(verifier, "LANE", lane)
    monkeypatch.setattr(verifier, "_load_model_verifier", lambda: model_verifier)
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", raising=False)
    return verifier, report_path, asset, runtime_snapshot


def test_receipt_only_reuses_pass_with_all_three_matching_fingerprints(tmp_path: Path, monkeypatch) -> None:
    verifier = _verifier()
    monkeypatch.setattr(verifier, "TEST_RECEIPTS_PATH", tmp_path / "receipts.json")
    verifier._write_test_receipts({"docxReal": {
        "status": "PASS",
        "materialFingerprint": "material-a",
        "providerSemanticsFingerprint": "provider-a",
        "requiredTestSpecFingerprint": "tests-a",
    }})
    receipt = verifier._load_test_receipts()["docxReal"]
    assert receipt["status"] == "PASS"
    assert receipt["materialFingerprint"] == "material-a"
    assert receipt["providerSemanticsFingerprint"] == "provider-a"
    assert receipt["requiredTestSpecFingerprint"] == "tests-a"

    verifier.TEST_RECEIPTS_PATH.write_text("{")
    assert verifier._load_test_receipts() == {}


def test_receipt_context_is_unavailable_when_model_evidence_is_stale(monkeypatch) -> None:
    verifier = _verifier()
    monkeypatch.setattr(verifier, "model_assets_status", lambda: "STALE")
    assert verifier._current_receipt_context() == (None, None)


def test_model_report_must_match_current_manifest_and_live_asset_bytes(tmp_path: Path, monkeypatch) -> None:
    verifier, report_path, asset, _ = _live_model_evidence_fixture(tmp_path, monkeypatch)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert verifier.model_assets_status() == "STALE"  # Old-schema report lacks live evidence bindings.
    assert verifier._current_receipt_context() == (None, None)
    report["schemaVersion"] = "document-intelligence.model-verification.v1"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert verifier.model_assets_status() == "STALE"
    report["schemaVersion"] = "document-intelligence.model-verification.v2"

    model_verifier = verifier._load_model_verifier()
    manifest = yaml.safe_load((verifier.ROOT / "models/increment4a/model-manifest.yaml").read_text())
    report["assetFingerprints"] = model_verifier.declared_asset_fingerprints(manifest)
    report["runtimeEvidence"] = model_verifier.runtime_evidence_snapshot(manifest["runtime"])
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert verifier.model_assets_status() == "PASS"

    asset.write_bytes(b"mutated after model verification")
    assert verifier.model_assets_status() == "STALE"
    assert verifier._current_receipt_context() == (None, None)


def test_stale_model_report_and_package_drift_invalidate_live_evidence(tmp_path: Path, monkeypatch) -> None:
    verifier, report_path, _asset, runtime_snapshot = _live_model_evidence_fixture(tmp_path, monkeypatch)
    model_verifier = verifier._load_model_verifier()
    manifest = yaml.safe_load((verifier.ROOT / "models/increment4a/model-manifest.yaml").read_text())
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["assetFingerprints"] = model_verifier.declared_asset_fingerprints(manifest)
    report["runtimeEvidence"] = model_verifier.runtime_evidence_snapshot(manifest["runtime"])
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert verifier.model_assets_status() == "PASS"

    report["manifestSha256"] = "0" * 64
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert verifier.model_assets_status() == "STALE"
    assert verifier._current_receipt_context() == (None, None)

    manifest_path = verifier.ROOT / "models/increment4a/model-manifest.yaml"
    report["manifestSha256"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    report_path.write_text(json.dumps(report), encoding="utf-8")
    changed_runtime = {**runtime_snapshot, "packages": {"pytest": "8.4.3"}, "packagesFingerprint": "packages-drifted"}
    monkeypatch.setattr(model_verifier, "_runtime_snapshot", lambda _packages: (changed_runtime, []))
    assert verifier.model_assets_status() == "STALE"
    assert verifier._current_receipt_context() == (None, None)


@pytest.mark.parametrize(
    ("environment_field", "replacement"),
    [
        ("python", None),
        ("python", ""),
        ("python", "3.12.4"),
        ("uv", None),
        ("uv", ""),
        ("uv", "0.12.17"),
    ],
)
def test_environment_runtime_version_pins_are_required_and_exact(
    tmp_path: Path,
    monkeypatch,
    environment_field: str,
    replacement: str | None,
) -> None:
    verifier, report_path, _asset, _ = _live_model_evidence_fixture(tmp_path, monkeypatch)
    model_verifier = verifier._load_model_verifier()
    manifest_path = verifier.ROOT / "models/increment4a/model-manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["assetFingerprints"] = model_verifier.declared_asset_fingerprints(manifest)
    report["runtimeEvidence"] = model_verifier.runtime_evidence_snapshot(manifest["runtime"])
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert verifier.model_assets_status() == "PASS"

    environment_path = verifier.LANE / "environment.yaml"
    environment = yaml.safe_load(environment_path.read_text(encoding="utf-8"))
    if replacement is None:
        environment["runtime"].pop(environment_field)
    else:
        environment["runtime"][environment_field] = replacement
    environment_path.write_text(yaml.safe_dump(environment, sort_keys=True), encoding="utf-8")
    assert verifier.model_assets_status() == "STALE"


def test_required_test_spec_fingerprint_tracks_each_leaf_source(tmp_path: Path, monkeypatch) -> None:
    verifier = _verifier()
    monkeypatch.setattr(verifier, "PYTEST_NODE_MAP", {"leaf": ("tests/test_leaf.py::test_one",)})
    test_file = tmp_path / "tests/test_leaf.py"
    test_file.parent.mkdir()
    test_file.write_text("def test_one(): pass\n")
    before = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    test_file.write_text("def test_one(): assert True\n")
    after = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    assert before != after


def test_required_test_spec_fingerprint_tracks_pytest_config_and_runner(tmp_path: Path, monkeypatch) -> None:
    verifier = _verifier()
    monkeypatch.setattr(verifier, "PYTEST_NODE_MAP", {"leaf": ("tests/test_leaf.py::test_one",)})
    test_file = tmp_path / "tests/test_leaf.py"
    test_file.parent.mkdir()
    test_file.write_text("def test_one(): pass\n")
    runner_file = tmp_path / "verify_increment4a.py"
    runner_file.write_text("runner = 'first'\n")
    monkeypatch.setattr(verifier, "VERIFIER_SOURCE_PATH", runner_file)
    model_verifier_file = tmp_path / "verify_models.py"
    model_verifier_file.write_text("model_verifier = 'first'\n")
    monkeypatch.setattr(verifier, "MODEL_VERIFIER_SOURCE_PATH", model_verifier_file)
    config_file = tmp_path / "tests/conftest.py"
    config_file.write_text("pytest_plugins = []\n")

    before = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    config_file.write_text("pytest_plugins = ['plugin']\n")
    after_config = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    assert before != after_config

    runner_file.write_text("runner = 'changed'\n")
    after_runner = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    assert after_config != after_runner

    model_verifier_file.write_text("model_verifier = 'changed'\n")
    after_model_verifier = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    assert after_runner != after_model_verifier


def test_required_test_spec_fingerprint_tracks_relevant_execution_environment(tmp_path: Path, monkeypatch) -> None:
    verifier = _verifier()
    monkeypatch.setattr(verifier, "PYTEST_NODE_MAP", {"leaf": ("tests/test_leaf.py::test_one",)})
    test_file = tmp_path / "tests/test_leaf.py"
    test_file.parent.mkdir()
    test_file.write_text("def test_one(): pass\n")
    monkeypatch.delenv("DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL", raising=False)
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", "/models/a")

    before = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", "/models/b")
    after = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    assert before != after

    before_live_url = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL", f"http://127.0.0.1:{_free_port()}")
    after_live_url = verifier.required_test_spec_fingerprint(tmp_path, "leaf")
    assert before_live_url == after_live_url


def test_source_change_during_test_run_does_not_create_pass_receipt(tmp_path: Path, monkeypatch) -> None:
    verifier = _verifier()
    monkeypatch.setattr(verifier, "PYTEST_NODE_MAP", {"leaf": ("tests/test_leaf.py::test_one",)})
    monkeypatch.setattr(verifier, "TEST_RECEIPTS_PATH", tmp_path / "receipts.json")
    monkeypatch.setattr(verifier, "_current_receipt_context", lambda: ("material-a", "provider-a"))
    monkeypatch.setattr(verifier, "_junit_cases", lambda _path: {"tests.test_leaf::test_one": object()})
    monkeypatch.setattr(verifier, "pytest_leaf_status", lambda _cases, _leaf: "PASS")
    test_file = tmp_path / "tests/test_leaf.py"
    test_file.parent.mkdir()
    test_file.write_text("def test_one(): pass\n")

    def run_and_edit(_root: Path, _junit: Path, _leaves: tuple[str, ...]) -> None:
        test_file.write_text("def test_one(): assert True\n")

    monkeypatch.setattr(verifier, "run_required_pytest", run_and_edit)
    statuses = verifier.run_required_pytest_cached(tmp_path, tmp_path / "pytest.xml")

    assert statuses == {"leaf": "NOT_RUN"}
    assert verifier._load_test_receipts() == {}


def test_cached_leaf_becomes_not_run_if_its_source_changes_during_other_leaf_run(tmp_path: Path, monkeypatch) -> None:
    verifier = _verifier()
    leaf_map = {
        "cached": ("tests/test_cached.py::test_cached",),
        "stale": ("tests/test_stale.py::test_stale",),
    }
    monkeypatch.setattr(verifier, "PYTEST_NODE_MAP", leaf_map)
    monkeypatch.setattr(verifier, "TEST_RECEIPTS_PATH", tmp_path / "receipts.json")
    monkeypatch.setattr(verifier, "_current_receipt_context", lambda: ("material-a", "provider-a"))
    monkeypatch.setattr(verifier, "_junit_cases", lambda _path: {"tests.test_stale::test_stale": object()})
    monkeypatch.setattr(verifier, "pytest_leaf_status", lambda _cases, _leaf: "PASS")
    test_dir = tmp_path / "tests"
    test_dir.mkdir()
    cached_file = test_dir / "test_cached.py"
    cached_file.write_text("def test_cached(): pass\n")
    stale_file = test_dir / "test_stale.py"
    stale_file.write_text("def test_stale(): pass\n")
    cached_spec = verifier.required_test_spec_fingerprint(tmp_path, "cached")
    verifier._write_test_receipts({"cached": {
        "status": "PASS",
        "materialFingerprint": "material-a",
        "providerSemanticsFingerprint": "provider-a",
        "requiredTestSpecFingerprint": cached_spec,
    }})

    def run_and_edit_cached(_root: Path, _junit: Path, _leaves: tuple[str, ...]) -> None:
        cached_file.write_text("def test_cached(): assert True\n")

    monkeypatch.setattr(verifier, "run_required_pytest", run_and_edit_cached)
    statuses = verifier.run_required_pytest_cached(tmp_path, tmp_path / "pytest.xml")

    assert statuses == {"cached": "NOT_RUN", "stale": "PASS"}
    assert "cached" not in verifier._load_test_receipts()


@pytest.mark.parametrize("option", ["--junit", "--vitest-report", "--increment3-report"])
def test_strict_mode_rejects_unbound_external_test_reports(option: str, monkeypatch, capsys) -> None:
    verifier = _verifier()
    monkeypatch.setattr(sys, "argv", ["verify_increment4a.py", "--strict", option, "old-report.json"])

    with pytest.raises(SystemExit) as error:
        verifier.main()

    assert error.value.code == 2
    assert "unbound external evidence" in capsys.readouterr().err
