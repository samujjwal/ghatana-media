"""I5-34/I5-36/I5-38/I5-39/I5-40/I5-41: tenant scope, revocation,
export/import, promotion scope guards, and MODEL reproducibility binding."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import fp, make_event, write_event_root  # noqa: E402
from learning.candidates import registry, revocation  # noqa: E402
from learning.datasets.build_dataset import build_dataset  # noqa: E402
from learning.datasets.export_dataset import (  # noqa: E402
    export_dataset,
    import_dataset,
    verify_export,
)
from learning.models.candidate_hook import build_model_candidate_manifest  # noqa: E402
from learning.promotion import promote  # noqa: E402
from learning.tenant_scope import TenantScopeError  # noqa: E402
from learning.util import atomic_write_json, digest  # noqa: E402

POLICY = yaml.safe_load(
    (ROOT / "learning/policies/dataset-policy.v1.yaml").read_text(encoding="utf-8")
)
AT = "2026-09-21T00:00:00Z"
AUTH = {"authorizedBy": "governance-board", "authorizedAt": AT, "authorizationRef": "change-42"}


def _events(n: int = 8) -> list[dict]:
    return [make_event(str(i)) for i in range(n)]


def _partitioned_root(tmp_path: Path, tenant: str, events: list[dict]) -> Path:
    return write_event_root(tmp_path / "events" / tenant / "root", events)


# --- I5-34: dataset tenant scope --------------------------------------------


def test_tenant_local_manifest_records_partition_tenant(tmp_path: Path):
    root = _partitioned_root(tmp_path, "org-a", _events())
    manifest = build_dataset(root, POLICY, tmp_path / "out", "ds", 1, AT)
    assert manifest["tenantScope"] == "TENANT_LOCAL"
    assert manifest["tenantRef"] == "org-a"


def test_tenant_local_requires_identity_for_unpartitioned_root(tmp_path: Path):
    root = write_event_root(tmp_path / "events" / "root", _events())
    with pytest.raises(TenantScopeError, match="tenant-ref"):
        build_dataset(root, POLICY, tmp_path / "out", "ds", 1, AT)


def test_tenant_ref_must_match_partition(tmp_path: Path):
    root = _partitioned_root(tmp_path, "org-a", _events())
    with pytest.raises(TenantScopeError, match="partition"):
        build_dataset(root, POLICY, tmp_path / "out", "ds", 1, AT, tenant_ref="org-b")


def _v2_event(event: dict, tenant: str) -> dict:
    event["schemaVersion"] = "document-intelligence.feedback-event.v2"
    event["tenantRef"] = tenant
    event["eventFingerprint"] = digest(
        {k: v for k, v in event.items() if k != "eventFingerprint"}
    )
    return event


def test_cross_tenant_event_rejected(tmp_path: Path):
    events = _events()
    _v2_event(events[0], "org-b")
    root = _partitioned_root(tmp_path, "org-a", events)
    with pytest.raises(TenantScopeError, match="outside the TENANT_LOCAL"):
        build_dataset(root, POLICY, tmp_path / "out", "ds", 1, AT)


def test_matching_tenant_event_accepted(tmp_path: Path):
    events = [_v2_event(e, "org-a") for e in _events(4)]
    root = _partitioned_root(tmp_path, "org-a", events)
    manifest = build_dataset(root, POLICY, tmp_path / "out", "ds", 1, AT)
    assert manifest["tenantRef"] == "org-a"
    assert len(manifest["source"]["acceptedEventIds"]) == 4


def test_multi_tenant_requires_authorization(tmp_path: Path):
    root = _partitioned_root(tmp_path, "org-a", _events())
    with pytest.raises(TenantScopeError, match="scopeAuthorizationRef"):
        build_dataset(
            root, POLICY, tmp_path / "out", "ds", 1, AT,
            tenant_scope="MULTI_TENANT_EXPLICITLY_AUTHORIZED",
        )
    manifest = build_dataset(
        root, POLICY, tmp_path / "out", "ds", 1, AT,
        tenant_scope="MULTI_TENANT_EXPLICITLY_AUTHORIZED",
        scope_authorization_ref="org.data-sharing-grant.v7",
    )
    assert manifest["tenantScope"] == "MULTI_TENANT_EXPLICITLY_AUTHORIZED"
    assert manifest["scopeAuthorizationRef"] == "org.data-sharing-grant.v7"


# --- I5-40: revocation -------------------------------------------------------


def _tombstone(event_id: str) -> dict:
    return {
        "schemaVersion": "document-intelligence.feedback-tombstone.v1",
        "eventId": event_id,
        "kind": "REVOKED",
        "reasonCode": "SUBJECT_ERASURE",
        "tombstonedAt": AT,
        "tombstoneFingerprint": fp(f"tombstone-{event_id[-8:]}"),
    }


def test_revocation_supersedes_recorded(tmp_path: Path):
    events = _events()
    root = _partitioned_root(tmp_path, "org-a", events)
    out = tmp_path / "out"
    first = build_dataset(root, POLICY, out, "ds", 1, AT)
    from learning.feedback.events import write_tombstone_artifact

    victim = events[0]["eventId"]
    write_tombstone_artifact(root, _tombstone(victim))
    second = build_dataset(root, POLICY, out, "ds", 2, AT)
    assert second["supersedes"]["priorRevision"] == 1
    assert second["supersedes"]["reason"] == "REVOCATION"
    assert second["supersedes"]["revokedEventIds"] == [victim]
    assert victim not in second["source"]["acceptedEventIds"]
    assert victim in first["source"]["acceptedEventIds"]


def test_revoked_candidate_blocked_from_promotion(tmp_path: Path):
    events = _events()
    root = _partitioned_root(tmp_path, "org-a", events)
    out = tmp_path / "out"
    dataset = build_dataset(root, POLICY, out, "ds", 1, AT)
    registry_root = tmp_path / "registry"
    manifest = registry.register(
        registry_root,
        kind="EXTRACTION_POLICY",
        artifact={"proposedChanges": {}},
        dependencies={
            "baseAuthorityFingerprint": fp("base"),
            "datasetFingerprint": dataset["datasetFingerprint"],
            "evaluatorImplementationFingerprint": fp("evaluator"),
        },
        created_at=AT,
    )
    from learning.feedback.events import write_tombstone_artifact

    write_tombstone_artifact(root, _tombstone(events[0]["eventId"]))
    marked = revocation.apply_revocations(
        registry_root, out, [root], at=AT
    )
    assert marked == [manifest["candidateId"]]
    assert revocation.is_revoked(registry_root, manifest["candidateId"])
    manifest["state"] = "EVALUATED"
    manifest["evaluation"] = {
        "evaluationSetFingerprint": fp("evalset"),
        "baselineResultFingerprint": fp("baseline"),
        "candidateResultFingerprint": fp("result"),
        "regressionResult": "PASS",
    }
    atomic_write_json(
        registry_root / "candidates" / manifest["candidateId"].replace(":", "_") / "manifest.json",
        manifest,
    )
    with pytest.raises(ValueError, match="ineligible"):
        promote.promote(
            registry_root,
            tmp_path / "authority",
            manifest["candidateId"],
            authorization=AUTH,
            material_fingerprint_current=fp("base"),
            at=AT,
        )


# --- I5-38: promotion tenant-scope guard -------------------------------------


def test_tenant_local_candidate_cannot_promote_to_shared_authority(tmp_path: Path):
    registry_root = tmp_path / "registry"
    manifest = registry.register(
        registry_root,
        kind="EXTRACTION_POLICY",
        artifact={"proposedChanges": {}},
        dependencies={
            "baseAuthorityFingerprint": fp("base"),
            "evaluatorImplementationFingerprint": fp("evaluator"),
        },
        created_at=AT,
    )
    manifest["state"] = "EVALUATED"
    manifest["evaluation"] = {
        "evaluationSetFingerprint": fp("evalset"),
        "baselineResultFingerprint": fp("baseline"),
        "candidateResultFingerprint": fp("result"),
        "regressionResult": "PASS",
    }
    atomic_write_json(
        registry_root / "candidates" / manifest["candidateId"].replace(":", "_") / "manifest.json",
        manifest,
    )
    with pytest.raises(TenantScopeError, match="cannot promote"):
        promote.promote(
            registry_root,
            tmp_path / "authority",
            manifest["candidateId"],
            authorization=AUTH,
            material_fingerprint_current=fp("base"),
            at=AT,
            authority_scope="SHARED_GLOBAL",
        )


# --- I5-41: MODEL reproducibility binding ------------------------------------

_REPRO = {
    "trainingCodeFingerprint": fp("training-code"),
    "datasetFingerprint": fp("dataset"),
    "baseModelFingerprint": fp("base-model"),
    "dependencyLockFingerprint": fp("deps-lock"),
    "tokenizerFingerprint": fp("tokenizer"),
    "seed": 42,
    "hyperparameters": {"epochs": 3, "lr": 0.0001},
    "runtime": "python3.12/torch2.14",
    "nativeLibraries": ["cuda-12.4", "openblas-0.3"],
    "deterministic": True,
}


def test_model_candidate_requires_full_reproducibility_binding():
    with pytest.raises(ValueError, match="reproducibility"):
        build_model_candidate_manifest(
            base_model="ghatana.extractor-base",
            model_asset_hashes={"weights.safetensors": fp("weights")},
            reproducibility={"seed": 42},
            base_authority_fingerprint=fp("base"),
            evaluator_implementation_fingerprint=fp("evaluator"),
            created_at=AT,
        )


def test_model_candidate_binds_dataset_into_dependencies(tmp_path: Path):
    manifest = build_model_candidate_manifest(
        base_model="ghatana.extractor-base",
        model_asset_hashes={"weights.safetensors": fp("weights")},
        reproducibility=dict(_REPRO),
        base_authority_fingerprint=fp("base"),
        evaluator_implementation_fingerprint=fp("evaluator"),
        created_at=AT,
        registry_root=tmp_path / "registry",
    )
    assert manifest["schemaVersion"] == "document-intelligence.candidate-manifest.v2"
    assert manifest["model"]["datasetFingerprint"] == _REPRO["datasetFingerprint"]
    assert manifest["dependencies"]["datasetFingerprint"] == _REPRO["datasetFingerprint"]
    assert manifest["dependencies"]["modelAssetFingerprints"]["weights.safetensors"] == fp("weights")


def test_model_hook_rejects_dataset_fingerprint_conflict():
    with pytest.raises(ValueError, match="datasetFingerprint"):
        build_model_candidate_manifest(
            base_model="ghatana.extractor-base",
            model_asset_hashes={"weights.safetensors": fp("weights")},
            reproducibility=dict(_REPRO),
            training_dataset_fingerprint=fp("other-dataset"),
            base_authority_fingerprint=fp("base"),
            evaluator_implementation_fingerprint=fp("evaluator"),
            created_at=AT,
        )


# --- I5-39: export/import -----------------------------------------------------


def test_export_import_roundtrip_preserves_fingerprint(tmp_path: Path):
    root = _partitioned_root(tmp_path, "org-a", _events())
    out = tmp_path / "out"
    manifest = build_dataset(root, POLICY, out, "ds", 1, AT)
    export = export_dataset(
        out / "ds" / "r1",
        tmp_path / "exports",
        authorization_ref="org.export-grant.v1",
        exported_at=AT,
    )
    export_dir = tmp_path / "exports" / "ds" / "r1"
    assert verify_export(export_dir)["datasetFingerprint"] == manifest["datasetFingerprint"]
    imported = import_dataset(export_dir, tmp_path / "imported")
    assert imported["datasetFingerprint"] == manifest["datasetFingerprint"]
    with pytest.raises(ValueError, match="already exists"):
        import_dataset(export_dir, tmp_path / "imported")


def test_export_requires_authorization_for_tenant_local(tmp_path: Path):
    root = _partitioned_root(tmp_path, "org-a", _events())
    out = tmp_path / "out"
    build_dataset(root, POLICY, out, "ds", 1, AT)
    with pytest.raises(TenantScopeError, match="authorization"):
        export_dataset(out / "ds" / "r1", tmp_path / "exports", exported_at=AT)


def test_import_rejects_tampered_export(tmp_path: Path):
    root = _partitioned_root(tmp_path, "org-a", _events())
    out = tmp_path / "out"
    build_dataset(root, POLICY, out, "ds", 1, AT)
    export_dataset(
        out / "ds" / "r1",
        tmp_path / "exports",
        authorization_ref="org.export-grant.v1",
        exported_at=AT,
    )
    export_dir = tmp_path / "exports" / "ds" / "r1"
    (export_dir / "train.jsonl").write_text("{}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="digest mismatch"):
        verify_export(export_dir)
