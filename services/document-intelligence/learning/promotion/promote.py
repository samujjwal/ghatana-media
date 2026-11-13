"""Governed promotion and rollback for learning candidates (I5-26..I5-28).

Promotion publishes a NEW authority revision — it never mutates an existing
frozen manifest:

    <authority_root>/revisions/<revisionId>/authority.json   immutable revision
    <authority_root>/active.json                             pointer (rebindable)
    <authority_root>/receipts/<promotionId>.json             promotion-receipt.v1

Rollback re-selects an earlier already-qualified revision; it never rebuilds
older artifacts from mutable inputs.

Promotion requires ALL of:
  candidate state EVALUATED or APPROVED_FOR_SHADOW
  candidate evaluation record with regressionResult == PASS
  explicit authorization (authorizedBy + authorizationRef)
  materialFingerprintAtDecision == the caller-attested current fingerprint
  no revocation marker (I5-40): candidates bound to revoked feedback events
  are ineligible
  tenant scope (I5-38): a TENANT_LOCAL candidate cannot promote to a
  non-tenant-scoped authority; shared/global authority requires
  SYNTHETIC_PUBLIC or MULTI_TENANT_EXPLICITLY_AUTHORIZED +
  scopeAuthorizationRef
  evaluated == promoted (I5-41): the evaluation must bind the same artifact
  fingerprint that is being promoted
"""
from __future__ import annotations

from pathlib import Path

from ..candidates import registry, revocation
from ..tenant_scope import assert_promotable_scope
from ..util import atomic_write_json, digest, load_json, validate

RECEIPT_SCHEMA = "promotion-receipt.v1.schema.json"


def _active_path(authority_root: Path) -> Path:
    return authority_root / "active.json"


def current_active(authority_root: Path) -> dict | None:
    path = _active_path(authority_root)
    return load_json(path) if path.exists() else None


def _revision_dir(authority_root: Path, revision_fingerprint: str) -> Path:
    return authority_root / "revisions" / revision_fingerprint.replace(":", "_")


def _write_receipt(authority_root: Path, receipt: dict) -> Path:
    validate(receipt, RECEIPT_SCHEMA)
    path = authority_root / "receipts" / f"{receipt['promotionId'].replace(':', '_')}.json"
    if path.exists():
        existing = load_json(path)
        if existing != receipt:
            raise ValueError(f"promotion receipt conflict at {path}")
        return path
    atomic_write_json(path, receipt)
    return path


def _validate_authorization(authorization: dict) -> None:
    if not isinstance(authorization, dict):
        raise ValueError("promotion requires an authorization object")
    for key in ("authorizedBy", "authorizedAt", "authorizationRef"):
        if not isinstance(authorization.get(key), str) or not authorization[key]:
            raise ValueError(f"promotion authorization requires {key}")


def _set_active(authority_root: Path, revision_fingerprint: str, receipt: dict) -> None:
    atomic_write_json(
        _active_path(authority_root),
        {
            "schemaVersion": "document-intelligence.authority-pointer.v1",
            "activeRevisionFingerprint": revision_fingerprint,
            "receiptFingerprint": receipt["receiptFingerprint"],
        },
    )


def _assert_evaluated_equals_promoted(manifest: dict) -> None:
    """I5-41: the evaluation must bind the artifact being promoted."""
    artifact_fingerprint = (manifest.get("artifactRef") or {}).get("artifactFingerprint")
    evaluated = (manifest.get("evaluation") or {}).get("evaluatedArtifactFingerprint")
    if manifest["candidateKind"] == "MODEL":
        if not evaluated:
            raise ValueError(
                "MODEL promotion requires evaluation.evaluatedArtifactFingerprint"
            )
        model = manifest.get("model") or {}
        dataset_fp = manifest.get("dependencies", {}).get("datasetFingerprint")
        if model.get("datasetFingerprint") and dataset_fp and model["datasetFingerprint"] != dataset_fp:
            raise ValueError(
                "model.datasetFingerprint does not match dependencies.datasetFingerprint"
            )
        asset_hashes = model.get("modelAssetHashes")
        dep_assets = manifest.get("dependencies", {}).get("modelAssetFingerprints")
        if asset_hashes and dep_assets and asset_hashes != dep_assets:
            raise ValueError(
                "model.modelAssetHashes do not match dependencies.modelAssetFingerprints"
            )
    if evaluated and artifact_fingerprint and evaluated != artifact_fingerprint:
        raise ValueError(
            "evaluated artifact fingerprint differs from the promoted artifact — "
            "promotion must prove evaluated == promoted"
        )


def promote(
    registry_root: Path,
    authority_root: Path,
    candidate_id: str,
    *,
    authorization: dict,
    material_fingerprint_current: str,
    at: str,
    authority_scope: str = "TENANT_LOCAL",
) -> dict:
    _validate_authorization(authorization)
    manifest = registry.get(registry_root, candidate_id)
    if manifest is None:
        raise ValueError(f"unknown candidate {candidate_id}")
    receipt_dir = authority_root / "receipts"
    for path in sorted(receipt_dir.glob("*.json")) if receipt_dir.is_dir() else ():
        existing = load_json(path)
        if existing.get("action") == "PROMOTE" and existing.get("candidateId") == candidate_id:
            return existing
    if manifest["state"] not in {"EVALUATED", "APPROVED_FOR_SHADOW"}:
        raise ValueError(f"candidate {candidate_id} is not promotable from state {manifest['state']}")
    if revocation.is_revoked(registry_root, candidate_id):
        raise ValueError(
            f"candidate {candidate_id} is ineligible: bound dataset contains revoked feedback events"
        )
    assert_promotable_scope(manifest, authority_scope)
    evaluation = manifest.get("evaluation") or {}
    if evaluation.get("regressionResult") != "PASS":
        raise ValueError("promotion requires regressionResult PASS")
    if not evaluation.get("candidateResultFingerprint"):
        raise ValueError("promotion requires a completed offline evaluation")
    _assert_evaluated_equals_promoted(manifest)
    if material_fingerprint_current != _material_fingerprint_of(manifest):
        raise ValueError("material fingerprint drifted since evaluation — re-evaluate before promoting")

    revision_fingerprint = digest(
        {
            "domain": "learning.authority-revision.v1",
            "candidateFingerprint": manifest["candidateFingerprint"],
            "dependencies": manifest["dependencies"],
        }
    )
    prior = current_active(authority_root)
    revision = {
        "schemaVersion": "document-intelligence.authority-revision.v1",
        "revisionFingerprint": revision_fingerprint,
        "candidateId": candidate_id,
        "candidateKind": manifest["candidateKind"],
        "dependencies": manifest["dependencies"],
        "artifactRef": manifest.get("artifactRef"),
        "supersedes": prior["activeRevisionFingerprint"] if prior else None,
        "publishedAt": at,
    }
    revision_dir = _revision_dir(authority_root, revision_fingerprint)
    if not revision_dir.exists():
        atomic_write_json(revision_dir / "authority.json", revision)

    receipt = {
        "schemaVersion": "document-intelligence.promotion-receipt.v1",
        "promotionId": digest(
            {"domain": "learning.promotion-id.v1", "candidateId": candidate_id, "revision": revision_fingerprint}
        ),
        "candidateId": candidate_id,
        "candidateFingerprint": manifest["candidateFingerprint"],
        "action": "PROMOTE",
        "authorization": authorization,
        "evaluationReceipt": {
            "result": "PASS",
            "evaluationFingerprint": evaluation["candidateResultFingerprint"],
            **(
                {"regressionBudgetRef": evaluation["regressionBudgetRef"]}
                if evaluation.get("regressionBudgetRef")
                else {}
            ),
            "regressionResult": "PASS",
        },
        "materialFingerprintAtDecision": material_fingerprint_current,
        "authorityRevision": {
            "revisionId": revision_fingerprint,
            "authorityFingerprint": revision_fingerprint,
            "supersedes": prior["activeRevisionFingerprint"] if prior else revision_fingerprint,
        },
    }
    receipt["receiptFingerprint"] = digest(receipt)
    existing_receipt = authority_root / "receipts" / f"{receipt['promotionId'].replace(':', '_')}.json"
    if existing_receipt.exists():
        # Promotion is a content-addressed decision.  Retrying a crashed or
        # duplicated request returns the existing receipt rather than trying a
        # second state transition.
        return load_json(existing_receipt)
    _write_receipt(authority_root, receipt)
    _set_active(authority_root, revision_fingerprint, receipt)
    registry.transition(
        registry_root,
        candidate_id,
        to_state="PROMOTED",
        at=at,
        actor_ref=authorization.get("authorizedBy"),
        reason=authorization.get("authorizationRef"),
    )
    return receipt


def rollback(
    registry_root: Path,
    authority_root: Path,
    target_revision_fingerprint: str,
    *,
    authorization: dict,
    at: str,
) -> dict:
    """Re-select an earlier already-qualified authority revision (I5-28)."""
    _validate_authorization(authorization)
    revision_dir = _revision_dir(authority_root, target_revision_fingerprint)
    if not revision_dir.exists():
        raise ValueError(f"no qualified revision {target_revision_fingerprint} to roll back to")
    revision = load_json(revision_dir / "authority.json")
    prior = current_active(authority_root)
    receipt = {
        "schemaVersion": "document-intelligence.promotion-receipt.v1",
        "promotionId": digest(
            {
                "domain": "learning.rollback-id.v1",
                "target": target_revision_fingerprint,
                "authorizationRef": authorization.get("authorizationRef"),
            }
        ),
        "candidateId": revision["candidateId"],
        "candidateFingerprint": digest(revision),
        "action": "ROLLBACK",
        "authorization": authorization,
        "evaluationReceipt": {
            "result": "PASS",
            "evaluationFingerprint": revision_fingerprint_of(revision_dir),
        },
        "materialFingerprintAtDecision": revision["dependencies"].get(
            "baseAuthorityFingerprint", target_revision_fingerprint
        ),
        "authorityRevision": {
            "revisionId": target_revision_fingerprint,
            "authorityFingerprint": target_revision_fingerprint,
            "supersedes": prior["activeRevisionFingerprint"] if prior else target_revision_fingerprint,
        },
    }
    receipt["receiptFingerprint"] = digest(receipt)
    existing_receipt = authority_root / "receipts" / f"{receipt['promotionId'].replace(':', '_')}.json"
    if existing_receipt.exists():
        return load_json(existing_receipt)
    _write_receipt(authority_root, receipt)
    _set_active(authority_root, target_revision_fingerprint, receipt)
    if prior is not None:
        prior_dir = _revision_dir(authority_root, prior["activeRevisionFingerprint"])
        if prior_dir.exists():
            prior_revision = load_json(prior_dir / "authority.json")
            superseded_candidate = registry.get(registry_root, prior_revision["candidateId"])
            if superseded_candidate is not None and superseded_candidate["state"] == "PROMOTED":
                registry.transition(
                    registry_root,
                    prior_revision["candidateId"],
                    to_state="SUPERSEDED",
                    at=at,
                    actor_ref=authorization.get("authorizedBy"),
                    reason="authority revision rolled back",
                )
    return receipt


def revision_fingerprint_of(revision_dir: Path) -> str:
    return digest(load_json(revision_dir / "authority.json"))


def _material_fingerprint_of(manifest: dict) -> str:
    deps = manifest.get("dependencies", {})
    for key in ("materialFingerprint", "baseAuthorityFingerprint", "datasetFingerprint"):
        if isinstance(deps.get(key), str):
            return deps[key]
    return ""


def activate_qualified(
    authority_root: Path,
    revision_fingerprint: str,
    *,
    release_ref: str,
    activated_at: str,
) -> dict:
    """Bind a qualified revision to an explicit release activation decision.

    Qualification/promotion publishes immutable candidate authority.  This
    separate pointer is the worker-side hook for I5-53/I6 release machinery;
    calling promotion alone does not imply that a product deployment has
    activated the revision.
    """
    if not release_ref:
        raise ValueError("release_ref is required for activation")
    revision_dir = _revision_dir(authority_root, revision_fingerprint)
    authority_path = revision_dir / "authority.json"
    if not authority_path.exists():
        raise ValueError(f"no qualified revision {revision_fingerprint}")
    pointer = {
        "schemaVersion": "document-intelligence.qualified-activation.v1",
        "revisionFingerprint": revision_fingerprint,
        "releaseRef": release_ref,
        "activatedAt": activated_at,
    }
    pointer["activationFingerprint"] = digest(pointer)
    atomic_write_json(authority_root / "activation.json", pointer)
    return pointer
