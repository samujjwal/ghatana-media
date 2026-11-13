from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import fp  # noqa: E402
from learning.candidates import registry  # noqa: E402
from learning.promotion import promote  # noqa: E402

AT = "2026-09-21T00:00:00Z"
AUTH = {"authorizedBy": "governance-board", "authorizedAt": AT, "authorizationRef": "change-42"}


def _deps() -> dict:
    return {
        "baseAuthorityFingerprint": fp("base"),
        "datasetFingerprint": fp("dataset"),
        "evaluatorImplementationFingerprint": fp("evaluator"),
    }


def _register(root: Path) -> dict:
    return registry.register(
        root,
        kind="EXTRACTION_POLICY",
        artifact={"proposedChanges": {"fieldAliases": {"a": "b"}}},
        dependencies=_deps(),
        created_at=AT,
    )


def test_register_is_deterministic_and_idempotent(tmp_path: Path):
    first = _register(tmp_path)
    second = _register(tmp_path)
    assert first["candidateId"] == second["candidateId"]
    assert first["state"] == "CANDIDATE"


def test_dependency_change_creates_new_identity(tmp_path: Path):
    first = _register(tmp_path)
    changed = _deps()
    changed["datasetFingerprint"] = fp("dataset-2")
    second = registry.register(
        tmp_path,
        kind="EXTRACTION_POLICY",
        artifact={"proposedChanges": {}},
        dependencies=changed,
        created_at=AT,
    )
    assert first["candidateId"] != second["candidateId"]


def test_illegal_transition_rejected(tmp_path: Path):
    manifest = _register(tmp_path)
    with pytest.raises(ValueError, match="illegal"):
        registry.transition(tmp_path, manifest["candidateId"], to_state="PROMOTED", at=AT)


def test_transition_writes_receipt(tmp_path: Path):
    manifest = _register(tmp_path)
    registry.transition(tmp_path, manifest["candidateId"], to_state="EVALUATED", at=AT)
    loaded = registry.get(tmp_path, manifest["candidateId"])
    assert loaded["state"] == "EVALUATED"
    assert loaded["transitions"][-1]["receiptFingerprint"].startswith("sha256:")


def _evaluated_candidate(root: Path) -> dict:
    manifest = _register(root)
    manifest["evaluation"] = {
        "evaluationSetFingerprint": fp("evalset"),
        "baselineResultFingerprint": fp("baseline"),
        "candidateResultFingerprint": fp("candresult"),
        "regressionBudgetRef": "learning.regression-budget.v1",
        "regressionResult": "PASS",
        "evaluatedAt": AT,
    }
    from learning.util import atomic_write_json

    atomic_write_json(
        root / "candidates" / manifest["candidateId"].replace(":", "_") / "manifest.json", manifest
    )
    registry.transition(root, manifest["candidateId"], to_state="EVALUATED", at=AT)
    return manifest


def test_promotion_requires_evaluation_pass(tmp_path: Path):
    registry_root = tmp_path / "registry"
    authority_root = tmp_path / "authority"
    manifest = _register(registry_root)
    with pytest.raises(ValueError, match="not promotable"):
        promote.promote(
            registry_root,
            authority_root,
            manifest["candidateId"],
            authorization=AUTH,
            material_fingerprint_current=fp("base"),
            at=AT,
        )


def test_promotion_publishes_new_revision(tmp_path: Path):
    registry_root = tmp_path / "registry"
    authority_root = tmp_path / "authority"
    manifest = _evaluated_candidate(registry_root)
    receipt = promote.promote(
        registry_root,
        authority_root,
        manifest["candidateId"],
        authorization=AUTH,
        material_fingerprint_current=fp("base"),
        at=AT,
    )
    assert receipt["action"] == "PROMOTE"
    assert receipt["evaluationReceipt"]["result"] == "PASS"
    assert registry.get(registry_root, manifest["candidateId"])["state"] == "PROMOTED"
    active = promote.current_active(authority_root)
    assert active["activeRevisionFingerprint"] == receipt["authorityRevision"]["authorityFingerprint"]


def test_promotion_retry_is_idempotent_and_qualified_activation_is_separate(tmp_path: Path):
    registry_root = tmp_path / "registry"
    authority_root = tmp_path / "authority"
    manifest = _evaluated_candidate(registry_root)
    first = promote.promote(
        registry_root,
        authority_root,
        manifest["candidateId"],
        authorization=AUTH,
        material_fingerprint_current=fp("base"),
        at=AT,
    )
    retry = promote.promote(
        registry_root,
        authority_root,
        manifest["candidateId"],
        authorization=AUTH,
        material_fingerprint_current=fp("base"),
        at="2099-01-01T00:00:00Z",
    )
    assert retry == first
    activation = promote.activate_qualified(
        authority_root,
        first["authorityRevision"]["authorityFingerprint"],
        release_ref="release-2026-09-21",
        activated_at=AT,
    )
    assert activation["releaseRef"] == "release-2026-09-21"
    assert promote.current_active(authority_root)["activeRevisionFingerprint"] == first["authorityRevision"]["authorityFingerprint"]


def test_promotion_fails_on_stale_material(tmp_path: Path):
    registry_root = tmp_path / "registry"
    authority_root = tmp_path / "authority"
    manifest = _evaluated_candidate(registry_root)
    with pytest.raises(ValueError, match="material fingerprint"):
        promote.promote(
            registry_root,
            authority_root,
            manifest["candidateId"],
            authorization=AUTH,
            material_fingerprint_current=fp("different"),
            at=AT,
        )


def test_rollback_reselects_qualified_revision(tmp_path: Path):
    registry_root = tmp_path / "registry"
    authority_root = tmp_path / "authority"
    manifest = _evaluated_candidate(registry_root)
    first = promote.promote(
        registry_root,
        authority_root,
        manifest["candidateId"],
        authorization=AUTH,
        material_fingerprint_current=fp("base"),
        at=AT,
    )
    # Promote a second candidate, then roll back to the first revision.
    changed = _deps()
    changed["datasetFingerprint"] = fp("dataset-2")
    second_manifest = registry.register(
        registry_root,
        kind="EXTRACTION_POLICY",
        artifact={"proposedChanges": {}},
        dependencies=changed,
        created_at=AT,
    )
    second_manifest["evaluation"] = {
        "evaluationSetFingerprint": fp("evalset"),
        "baselineResultFingerprint": fp("baseline"),
        "candidateResultFingerprint": fp("candresult2"),
        "regressionResult": "PASS",
        "evaluatedAt": AT,
    }
    from learning.util import atomic_write_json

    atomic_write_json(
        registry_root
        / "candidates"
        / second_manifest["candidateId"].replace(":", "_")
        / "manifest.json",
        second_manifest,
    )
    registry.transition(registry_root, second_manifest["candidateId"], to_state="EVALUATED", at=AT)
    promote.promote(
        registry_root,
        authority_root,
        second_manifest["candidateId"],
        authorization=AUTH,
        material_fingerprint_current=fp("base"),
        at="2026-09-21T01:00:00Z",
    )
    rollback_receipt = promote.rollback(
        registry_root,
        authority_root,
        first["authorityRevision"]["authorityFingerprint"],
        authorization=AUTH,
        at="2026-09-21T02:00:00Z",
    )
    assert rollback_receipt["action"] == "ROLLBACK"
    active = promote.current_active(authority_root)
    assert (
        active["activeRevisionFingerprint"]
        == first["authorityRevision"]["authorityFingerprint"]
    )


def test_rollback_rejects_unknown_revision(tmp_path: Path):
    with pytest.raises(ValueError, match="no qualified revision"):
        promote.rollback(
            tmp_path / "registry",
            tmp_path / "authority",
            fp("missing"),
            authorization=AUTH,
            at=AT,
        )
