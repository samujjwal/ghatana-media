#!/usr/bin/env python3
"""Cross-increment freeze-set manifest and read-only reconciliation.

Builds ``docs/evidence/document-intelligence-freeze-set.v1.json`` — the final
artifact that binds Increment 3, Increment 4, and Increment 4A into one sealed
authority — and reconciles it with ``--check``.

``--check`` executes zero provider tests and zero product campaigns: it only
re-reads artifacts, recomputes fingerprints, and validates references.  Any
drift marks the check FAIL and identifies the stale authority.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
GHATANA_REPO = ROOT.parents[1]
DEVELOPMENTS = GHATANA_REPO.parent
GHARBATAI = DEVELOPMENTS / "gharbatai"
ORG_EVAL = GHARBATAI / "products/org/docs/document-extraction/evaluation"
EVIDENCE_DIR = ROOT / "docs/evidence"
FREEZE_SET_PATH = EVIDENCE_DIR / "document-intelligence-freeze-set.v1.json"
FREEZE_SET_SCHEMA = "document-intelligence.freeze-set.v1"

sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "evaluation"))
sys.path.insert(0, str(ROOT / "evaluation" / "increment4a"))

import build_material_snapshot as snapshot  # noqa: E402
import build_provider_runtime_stability as stability  # noqa: E402
import build_native_runtime_supplement as native_runtime  # noqa: E402
import build_run_publication as run_publication  # noqa: E402
import check_leaf_dependencies as leaf_dependencies  # noqa: E402
import check_material_scopes as material_scopes  # noqa: E402
from implementation_material import implementation_fingerprints  # noqa: E402
from run_qualification import material_fingerprints  # noqa: E402

I3_RUN_ID = "20260922T001622Z-26884d8e"
I3_AUTHORITY_RUN = "20260919T022904Z-cf9e659f"
I3_CAPABILITIES = ROOT / "evaluation/results" / I3_AUTHORITY_RUN / "capabilities.json"
I3_SUMMARY = ROOT / "evaluation/results" / I3_RUN_ID / "summary.json"
I3_RECONCILIATION = EVIDENCE_DIR / "increment3-reconciliation.json"
I3_STRICT_RECEIPT = EVIDENCE_DIR / "increment3-strict-receipt.json"
SHARED_CONTRACT_LOCK = ROOT / "contracts/shared-contract.lock.json"
I4A_LANE = ROOT / "evaluation/increment4a"
I4A_CANONICAL = I4A_LANE / "canonical-run.json"
I4A_LOCK = I4A_LANE / "material-lock.json"
I4A_RECEIPTS = I4A_LANE / "test-receipts.json"
I4A_ACCEPTED = ROOT / "capabilities/increment4a.accepted.json"
I4A_RUNTIME_AUTHORITY = ROOT / "capabilities/increment4a.runtime-authority.json"
I4A_PROFILE = ROOT / "profiles/increment4a.yaml"
I4A_MODEL_MANIFEST = ROOT / "models/increment4a/model-manifest.yaml"
I3_MODEL_MANIFEST = ROOT / "models/model-manifest.yaml"
CROSS_PROFILE_RECEIPT = EVIDENCE_DIR / "cross-profile-regression.v1.json"
STABILITY_MARKER = EVIDENCE_DIR / "provider-runtime-stability.json"
INVENTORY_V1 = EVIDENCE_DIR / "proof-inventory.v1.json"

I4_ARTIFACTS = {
    "consumerAdmission": ORG_EVAL / "consumer-admission.v2.json",
    "closureStatus": ORG_EVAL / "increment4-closure-status.json",
    "strictReport": ORG_EVAL / "results/increment4-strict-report.json",
    "campaignManifest": ORG_EVAL / "results/campaign-manifest.json",
    "acceptancePack": ORG_EVAL / "acceptance.yaml",
    "manifestPack": ORG_EVAL / "manifest.yaml",
    "measuredRun": ORG_EVAL / "results/product-acceptance-run.json",
    "liveWorkerIdentity": ORG_EVAL / "results/live-worker-identity.json",
    "livePostgres": ORG_EVAL / "results/live-postgres.json",
}

# Evidence/docs/scripts produced by this seal may be uncommitted while the
# freeze set is being assembled; anything else dirty in scope fails the drift
# check.
SEAL_ARTIFACTS_WORKER = {
    "services/document-intelligence/docs/evidence/provider-runtime-stability.json",
    "services/document-intelligence/docs/evidence/cross-profile-regression.v1.json",
    "services/document-intelligence/docs/evidence/document-intelligence-freeze-set.v1.json",
    "services/document-intelligence/docs/evidence/document-intelligence-development-freeze-set.v2.json",
    "services/document-intelligence/docs/evidence/document-intelligence-implementation-lock.v1.json",
    "services/document-intelligence/docs/evidence/proof-inventory.v2.json",
    "services/document-intelligence/docs/evidence/material-snapshot.v1.json",
    "services/document-intelligence/docs/evidence/proof-inventory.v1.json",
    "services/document-intelligence/docs/evidence/increment3-current-runtime-reconciliation.json",
    "services/document-intelligence/docs/evidence/increment3-material-scope.v1.json",
    "services/document-intelligence/docs/evidence/increment4-material-scope.v1.json",
    "services/document-intelligence/docs/evidence/increment4a-material-scope.v1.json",
    "services/document-intelligence/docs/evidence/leaf-dependencies.v1.json",
    "services/document-intelligence/docs/evidence/native-runtime-supplement.v1.json",
    "services/document-intelligence/evaluation/results/20260919T022904Z-cf9e659f/run-manifest.json",
    "services/document-intelligence/evaluation/results/20260922T001622Z-26884d8e/run-manifest.json",
    "services/document-intelligence/evaluation/increment4a/results/20260922T071420Z/run-manifest.json",
    "services/document-intelligence/scripts/build_provider_runtime_stability.py",
    "services/document-intelligence/scripts/run_cross_profile_regression.py",
    "services/document-intelligence/scripts/build_freeze_set.py",
    "services/document-intelligence/scripts/build_material_snapshot.py",
    "services/document-intelligence/scripts/build_native_runtime_supplement.py",
    "services/document-intelligence/scripts/build_run_publication.py",
    "services/document-intelligence/scripts/check_leaf_dependencies.py",
    "services/document-intelligence/scripts/check_material_scopes.py",
    "services/document-intelligence/tests/integration/test_profile_isolation.py",
}
SEAL_ARTIFACTS_GHARBATAI = {
    "products/org/scripts/document-extraction/build-campaign-manifest.mjs",
    "products/org/scripts/document-extraction/product-implementation.mjs",
    "products/org/scripts/document-extraction/verify-live-document-intelligence-authority.mjs",
    "products/org/scripts/document-extraction/run-increment4-acceptance.mjs",
    "products/org/scripts/document-extraction/verify-increment4.mjs",
    "products/org/docs/document-extraction/evaluation/results/campaign-manifest.json",
    "products/org/docs/document-extraction/evaluation/results/README.md",
    "products/org/docs/document-extraction/evaluation/results/increment4-strict-report.json",
    "products/org/docs/document-extraction/evaluation/increment4-closure-status.json",
}
I4_SCOPE_PREFIXES = (
    "products/org/scripts/document-extraction/",
    "products/org/docs/document-extraction/",
    "products/org/apps/api/src/modules/document-extraction/",
)
WORKER_PREFIX = "services/document-intelligence/"

# Records that are the active authority and must classify REUSE.  Historical
# superseded/invalidated runs remain in the inventory as non-promotable
# history and are not required.
REQUIRED_REUSE_LEAVES = {
    f"increment3.evaluation.{I3_RUN_ID}",
    "increment3.strictGate",
    "increment4a.campaign.20260922T071420Z",
    "increment4a.materialLock",
    "increment4a.canonicalPointer",
    "increment4a.modelVerification",
    "increment4.livePostgres",
    "increment4.liveWorkerIdentity",
    "increment4.productAcceptance",
    "increment4.productAcceptanceRun",
    "increment4.reprocessDurability",
    "increment4.reprocessLifecycleRun",
    "increment4.pdfConsumer",
    "increment4.imageConsumer",
    "increment4.authenticatedBrowserJourney",
    "increment4.auditAtomicity",
    "increment4.consumerAdmissionV2",
    "increment4.campaignManifest",
    "increment4.closureStatus",
}
# Leaves whose NOT_RUN state is by design and covered by another authority.
NON_BLOCKING_NOT_RUN = {"increment3.modelVerification"}


def _scope_covers(entries: list[str], worker_path: str) -> bool:
    """Match a worker-relative path against material-scope entries."""
    for entry in entries:
        if entry.startswith(("runtime:", "worker:")) or " " in entry:
            continue
        pattern = entry.rstrip("/")
        if worker_path == pattern or worker_path.startswith(pattern + "/"):
            return True
        if "*" in entry and fnmatch.fnmatch(worker_path, entry):
            return True
    return False


def _additive_scope_entries() -> list[str]:
    """Return the declared I5/I6 worker paths allowed to be dirty in v1.

    I5/I6 are active additive increments. Their scope authorities, rather
    than a second hand-maintained allowlist, define which implementation,
    environment, and status paths may remain uncommitted while the frozen v1
    authority is being assembled.
    """
    entries: list[str] = []
    for increment in ("increment5", "increment6"):
        document = load_json(material_scopes.SCOPE_FILES[increment]) or {}
        declared = document.get("scopes") or {}
        for scope_name in material_scopes.SCOPE_NAMES:
            entries.extend(list((declared.get(scope_name) or {}).get("includes") or []))
    return entries


def _frozen_worker_fingerprint_files() -> set[str]:
    """Enumerate explicit frozen worker files that additive scopes cannot mask."""
    import yaml  # noqa: PLC0415

    files: set[str] = set()
    implementation_spec = yaml.safe_load(
        (ROOT / "evaluation/increment4a/implementation-material.yaml").read_text(encoding="utf-8")
    )
    for entries in ((implementation_spec or {}).get("sourceSets") or {}).values():
        files |= material_scopes._expand_worker_paths(list(entries or []))
    # Increment-3 evaluator/environment inputs are frozen independently of
    # the additive I5/I6 scopes. Fingerprint checks remain the authority; this
    # set only makes the dirty-path classification fail closed and explainable.
    files |= material_scopes._expand_worker_paths(
        [
            "evaluation/manifest.yaml",
            "evaluation/acceptance.yaml",
            "evaluation/environment.yaml",
            "evaluation/run_evaluation.py",
            "evaluation/metrics.py",
            "evaluation/generate_corpus.py",
            "models/model-manifest.yaml",
            "models/increment4a/model-manifest.yaml",
            "models/increment4a/language-registry.yaml",
            "uv.lock",
            "pyproject.toml",
        ]
    )
    return files


def _classify_worker_dirty_path(path: str) -> tuple[str, str]:
    """Classify one repository-relative worker path for the v1 dirty gate."""
    if path in SEAL_ARTIFACTS_WORKER:
        return "allowed", "seal-artifact"
    if not path.startswith(WORKER_PREFIX):
        return "drift", "outside-worker-prefix"
    worker_path = path[len(WORKER_PREFIX):]
    if worker_path in _frozen_worker_fingerprint_files():
        return "drift", "frozen-worker-fingerprint-input"
    if _scope_covers(_additive_scope_entries(), worker_path):
        return "allowed", "increment5-or-increment6-scope"
    return "drift", "unclassified-worker-path"


def sha256_file(path: Path) -> str | None:
    return snapshot.sha256_file(path) if path.is_file() else None


def load_json(path: Path) -> dict[str, Any] | None:
    return snapshot.load_json(path)


def digest_json(value: Any) -> str:
    return snapshot.digest_json(value)


def rel(path: Path) -> str:
    return str(path)


def check_increment3() -> dict[str, Any]:
    errors: list[str] = []
    reconciliation = load_json(I3_RECONCILIATION) or {}
    receipt = load_json(I3_STRICT_RECEIPT) or {}
    summary = load_json(I3_SUMMARY) or {}
    lock = load_json(SHARED_CONTRACT_LOCK) or {}

    if reconciliation.get("status") != "RECONCILED":
        errors.append("increment3 reconciliation is not RECONCILED")
    if reconciliation.get("providerRequalification", {}).get("successorStatus") != "PASS":
        errors.append("increment3 provider requalification is not PASS")
    if reconciliation.get("providerRequalification", {}).get("successorRunId") != I3_RUN_ID:
        errors.append("increment3 reconciliation successor run does not match the canonical requalification run")
    if reconciliation.get("execution", {}).get("strictReconciler", {}).get("status") != "PASS":
        errors.append("increment3 strict reconciler is not PASS")
    if receipt.get("schemaVersion") != "increment3.strict-receipt.v1" or receipt.get("status") != "PASS":
        errors.append("increment3 strict receipt is missing or not PASS")
    executed = receipt.get("executedLeaves") or {}
    failing = [leaf for leaf, status in executed.items() if status != "PASS"]
    if failing:
        errors.append(f"increment3 strict receipt has non-PASS leaves: {failing}")

    receipt_current = False
    try:
        import verify_increment3 as gate  # noqa: PLC0415

        contract_snapshot = gate.capture_shared_snapshot()
        receipt_current = receipt.get("inputFingerprints") == gate.strict_input_fingerprints(contract_snapshot)
    except Exception as exc:  # pragma: no cover - reconciliation reports the reason
        errors.append(f"increment3 strict input fingerprints could not be recomputed: {exc}")
    if not receipt_current:
        errors.append("increment3 strict receipt inputs do not match the current tree")

    if summary.get("runId") != I3_RUN_ID or summary.get("status") != "PASS":
        errors.append("canonical increment3 requalification summary is not PASS for the expected run")
    impl = implementation_fingerprints(ROOT)
    if summary.get("providerSemanticsFingerprint") != impl["providerSemanticsFingerprint"]:
        errors.append("canonical increment3 summary provider semantics differ from current source")
    if not I3_CAPABILITIES.is_file():
        errors.append("frozen increment3 provider catalog is missing")
    if not lock.get("publicTypeApiSnapshotSha256"):
        errors.append("shared contract lock lacks publicTypeApiSnapshotSha256")

    authority_fingerprint = digest_json(
        {
            "reconciliation": sha256_file(I3_RECONCILIATION),
            "strictReceipt": sha256_file(I3_STRICT_RECEIPT),
            "providerCatalog": sha256_file(I3_CAPABILITIES),
            "sharedContractLock": sha256_file(SHARED_CONTRACT_LOCK),
            "canonicalSummary": sha256_file(I3_SUMMARY),
        }
    )
    return {
        "state": "FROZEN",
        "developmentState": "DEVELOPMENT_COMPLETE",
        "authorityFingerprint": authority_fingerprint,
        "strictReceipt": {
            "path": rel(I3_STRICT_RECEIPT),
            "sha256": sha256_file(I3_STRICT_RECEIPT),
            "status": receipt.get("status"),
            "runId": receipt.get("runId"),
            "receiptInputsCurrent": receipt_current,
        },
        "canonicalRun": I3_RUN_ID,
        "providerCatalogSha256": sha256_file(I3_CAPABILITIES),
        "errors": errors,
        "status": "FAIL" if errors else "PASS",
    }


def check_increment4() -> dict[str, Any]:
    errors: list[str] = []
    docs: dict[str, Any] = {}
    shas: dict[str, str | None] = {}
    for name, path in I4_ARTIFACTS.items():
        docs[name] = load_json(path) or {}
        shas[name] = sha256_file(path)
        if not path.is_file():
            errors.append(f"increment4 artifact missing: {name} ({path})")

    admission = docs.get("consumerAdmission") or {}
    if admission.get("result") != "ADMITTED" or admission.get("status") != "PASS":
        errors.append("consumer-admission.v2 is not ADMITTED/PASS")
    for key, pin in (admission.get("evidenceArtifacts") or {}).items():
        target = ORG_EVAL / str(pin.get("path", ""))
        if not target.is_file():
            errors.append(f"consumer-admission pin {key} points at a missing file")
        elif f"sha256:{sha256_file(target)}" != pin.get("sha256"):
            errors.append(f"consumer-admission pin {key} sha256 does not match the artifact on disk")

    closure = docs.get("closureStatus") or {}
    if closure.get("status") != "CLEAR":
        errors.append("increment4 closure status is not CLEAR")
    for key in ("failedLeafCount", "blockingLeafCount", "skippedLeafCount", "notRunLeafCount"):
        if closure.get(key) != 0:
            errors.append(f"increment4 closure {key} = {closure.get(key)!r}")

    report = docs.get("strictReport") or {}
    if report.get("result") != "ADMITTED":
        errors.append("increment4 strict report is not ADMITTED")
    summary = report.get("summary") or {}
    for key in ("failed", "skipped", "blockedOrNotRun", "unmappedFailures"):
        if summary.get(key) != 0:
            errors.append(f"increment4 strict report summary.{key} = {summary.get(key)!r}")
    if summary.get("passed") != summary.get("total") or not summary.get("total"):
        errors.append("increment4 strict report does not cover every check")

    manifest = docs.get("campaignManifest") or {}
    if manifest.get("schemaVersion") != "org.document-extraction.increment4.campaign-manifest.v1":
        errors.append("increment4 campaign manifest missing or wrong schema")
    else:
        for name, entry in (manifest.get("artifacts") or {}).items():
            target = ORG_EVAL / str(entry.get("path", ""))
            if not target.is_file():
                errors.append(f"campaign manifest artifact {name} missing on disk")
            elif f"sha256:{sha256_file(target)}" != entry.get("sha256"):
                errors.append(f"campaign manifest artifact {name} sha256 drifted")

    measured = docs.get("measuredRun") or {}
    if measured.get("status") != "MEASURED" or measured.get("profileId") != "default":
        errors.append("increment4 measured run is not a default-profile MEASURED run")

    authority_fingerprint = digest_json(
        {
            "consumerAdmission": shas.get("consumerAdmission"),
            "closureStatus": shas.get("closureStatus"),
            "strictReport": shas.get("strictReport"),
            "campaignManifest": shas.get("campaignManifest"),
            "acceptancePack": shas.get("acceptancePack"),
            "manifestPack": shas.get("manifestPack"),
        }
    )
    fingerprints = measured.get("fingerprints") or {}
    return {
        "state": "FROZEN",
        "developmentState": "DEVELOPMENT_COMPLETE",
        "authorityFingerprint": authority_fingerprint,
        "campaignManifest": {"path": rel(I4_ARTIFACTS["campaignManifest"]), "sha256": shas.get("campaignManifest")},
        "consumerAdmission": {
            "path": rel(I4_ARTIFACTS["consumerAdmission"]),
            "sha256": shas.get("consumerAdmission"),
            "result": admission.get("result"),
        },
        "campaignRunId": manifest.get("campaignRunId") or measured.get("runId"),
        "strictReport": {"summary": summary},
        "boundFingerprints": {
            "sharedContractFingerprint": fingerprints.get("sharedContractFingerprint"),
            "increment3ProviderCatalogFingerprint": fingerprints.get("increment3ProviderCatalogFingerprint"),
            "increment3ModelManifestFingerprint": fingerprints.get("increment3ModelManifestFingerprint"),
            "liveEnvironmentFingerprint": fingerprints.get("liveEnvironmentFingerprint"),
        },
        "errors": errors,
        "status": "FAIL" if errors else "PASS",
    }


def check_increment4a() -> dict[str, Any]:
    errors: list[str] = []
    canonical = load_json(I4A_CANONICAL) or {}
    lock = load_json(I4A_LOCK) or {}
    receipts = load_json(I4A_RECEIPTS) or {}
    accepted = load_json(I4A_ACCEPTED) or {}
    authority = load_json(I4A_RUNTIME_AUTHORITY) or {}
    profile = yaml.safe_load(I4A_PROFILE.read_text(encoding="utf-8")) if I4A_PROFILE.is_file() else {}
    model_manifest = yaml.safe_load(I4A_MODEL_MANIFEST.read_text(encoding="utf-8")) if I4A_MODEL_MANIFEST.is_file() else {}

    if canonical.get("state") != "ACTIVE" or not canonical.get("runId"):
        errors.append("increment4a canonical run is not ACTIVE")
    impl = implementation_fingerprints(ROOT)
    material_now = material_fingerprints()
    material_now_short = {key.removesuffix("Fingerprint"): value for key, value in material_now.items()}
    material_fingerprint_now = digest_json(material_now)

    if canonical.get("providerSemanticsFingerprint") != impl["providerSemanticsFingerprint"]:
        errors.append("canonical run providerSemanticsFingerprint drifted from current source")
    if canonical.get("evaluationImplementationFingerprint") != impl["evaluationImplementationFingerprint"]:
        errors.append("canonical run evaluationImplementationFingerprint drifted from current source")
    if canonical.get("materialFingerprint") != material_fingerprint_now:
        errors.append("canonical run materialFingerprint drifted from current evaluation material")

    if lock.get("state") != "FROZEN":
        errors.append("increment4a material lock is not FROZEN")
    if lock.get("providerSemanticsFingerprint") != impl["providerSemanticsFingerprint"]:
        errors.append("material lock providerSemanticsFingerprint drifted")
    if lock.get("evaluationImplementationFingerprint") != impl["evaluationImplementationFingerprint"]:
        errors.append("material lock evaluationImplementationFingerprint drifted")
    for key, locked in (lock.get("materialFingerprints") or {}).items():
        if material_now_short.get(key) != locked:
            errors.append(f"material lock entry {key} drifted")

    receipt_rows = (receipts.get("receipts") or {})
    stale_receipts = []
    for leaf, entry in receipt_rows.items():
        if entry.get("status") != "PASS":
            stale_receipts.append(f"{leaf}:status={entry.get('status')}")
            continue
        if entry.get("providerSemanticsFingerprint") != impl["providerSemanticsFingerprint"]:
            stale_receipts.append(f"{leaf}:providerSemanticsFingerprint")
        if entry.get("materialFingerprint") != canonical.get("materialFingerprint"):
            stale_receipts.append(f"{leaf}:materialFingerprint")
    if stale_receipts:
        errors.append(f"increment4a stale/non-pass receipts: {stale_receipts[:8]}")
    if not receipt_rows:
        errors.append("increment4a test receipts are missing")

    canonical_run_id = canonical.get("runId")
    if accepted.get("sourceRunId") != canonical_run_id:
        errors.append("accepted capabilities are not bound to the active canonical run")
    if authority.get("baselineAuthoritySha256") != sha256_file(I3_CAPABILITIES):
        errors.append("increment4a runtime authority does not extend the frozen increment3 provider catalog")
    profile_pins = (profile.get("authority") or profile) if isinstance(profile, dict) else {}
    if profile_pins.get("providerAuthoritySha256") != sha256_file(I4A_RUNTIME_AUTHORITY):
        errors.append("increment4a profile does not pin the committed runtime authority")
    if profile_pins.get("modelManifestSha256") != sha256_file(I4A_MODEL_MANIFEST):
        errors.append("increment4a profile does not pin the committed model manifest")
    manifest_authority = (model_manifest.get("authority") or {}) if isinstance(model_manifest, dict) else {}
    manifest_runtime = (model_manifest.get("runtime") or {}) if isinstance(model_manifest, dict) else {}
    uv_lock_pin = manifest_authority.get("uvLockSha256") or (manifest_authority.get("fingerprints") or {}).get("uvLockSha256") or manifest_runtime.get("uvLockSha256")
    if uv_lock_pin != sha256_file(ROOT / "uv.lock"):
        errors.append("increment4a model manifest does not pin the current uv.lock")

    authority_fingerprint = digest_json(
        {
            "canonicalRun": sha256_file(I4A_CANONICAL),
            "materialLock": sha256_file(I4A_LOCK),
            "testReceipts": sha256_file(I4A_RECEIPTS),
            "accepted": sha256_file(I4A_ACCEPTED),
            "runtimeAuthority": sha256_file(I4A_RUNTIME_AUTHORITY),
            "profile": sha256_file(I4A_PROFILE),
            "modelManifest": sha256_file(I4A_MODEL_MANIFEST),
        }
    )
    return {
        "state": "FROZEN",
        "developmentState": "DEVELOPMENT_COMPLETE",
        "releaseActivationState": "NOT_ACTIVATED",
        "authorityFingerprint": authority_fingerprint,
        "canonicalRun": canonical_run_id,
        "providerSemanticsFingerprint": impl["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": impl["evaluationImplementationFingerprint"],
        "materialFingerprint": material_fingerprint_now,
        "receiptCount": len(receipt_rows),
        "errors": errors,
        "status": "FAIL" if errors else "PASS",
    }


def check_shared(i3: dict[str, Any], i4: dict[str, Any], i4a: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    lock = load_json(SHARED_CONTRACT_LOCK) or {}
    shared_contract = lock.get("publicTypeApiSnapshotSha256")
    canonical_provider = sha256_file(I3_CAPABILITIES)
    i3_model_manifest = sha256_file(I3_MODEL_MANIFEST)
    i4a_model_manifest = sha256_file(I4A_MODEL_MANIFEST)
    uv_lock = sha256_file(ROOT / "uv.lock")

    stability_result = stability.check()
    if stability_result.get("providerRuntimeStability") != "PASS":
        errors.append(f"provider runtime stability marker is not STABLE: {stability_result.get('mismatchedFingerprints') or stability_result.get('reason')}")

    i4_bound = i4.get("boundFingerprints") or {}
    if i4_bound.get("sharedContractFingerprint") and i4_bound["sharedContractFingerprint"] != f"sha256:{shared_contract}":
        errors.append("increment4 sharedContractFingerprint does not match the worker lock")
    if i4_bound.get("increment3ProviderCatalogFingerprint") and i4_bound["increment3ProviderCatalogFingerprint"] != f"sha256:{canonical_provider}":
        errors.append("increment4 provider-catalog pin does not match the frozen increment3 catalog")
    if i4_bound.get("increment3ModelManifestFingerprint") and i4_bound["increment3ModelManifestFingerprint"] != f"sha256:{i3_model_manifest}":
        errors.append("increment4 model-manifest pin does not match the frozen increment3 manifest")

    return {
        "sharedContractFingerprint": shared_contract,
        "sharedContractLockSha256": sha256_file(SHARED_CONTRACT_LOCK),
        "canonicalProviderFingerprint": canonical_provider,
        "modelAuthorityFingerprint": {
            "increment3": i3_model_manifest,
            "increment4a": i4a_model_manifest,
        },
        "runtimeDependencyFingerprint": uv_lock,
        "providerRuntimeStability": {
            "path": rel(STABILITY_MARKER),
            "sha256": sha256_file(STABILITY_MARKER),
            "state": "STABLE" if stability_result.get("providerRuntimeStability") == "PASS" else "STALE",
        },
        "errors": errors,
        "status": "FAIL" if errors else "PASS",
    }


def _git_dirty(repo: Path, prefixes: tuple[str, ...]) -> list[str]:
    if not (repo / ".git").exists():
        return []
    args = ["git", "status", "--porcelain", "--", *prefixes]
    result = subprocess.run(args, cwd=repo, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        return [f"<git status failed: {result.stderr.strip()[-200:]}>"]
    return [line[3:].strip().split(" -> ")[-1] for line in result.stdout.splitlines() if line.strip()]


def check_cross(i3: dict[str, Any], i4: dict[str, Any], i4a: dict[str, Any], shared: dict[str, Any]) -> dict[str, Any]:
    checks: dict[str, Any] = {}

    i4_bound = i4.get("boundFingerprints") or {}
    i4_ok = (
        i4_bound.get("sharedContractFingerprint") == f"sha256:{shared['sharedContractFingerprint']}"
        and i4_bound.get("increment3ProviderCatalogFingerprint") == f"sha256:{shared['canonicalProviderFingerprint']}"
        and i4_bound.get("increment3ModelManifestFingerprint") == f"sha256:{shared['modelAuthorityFingerprint']['increment3']}"
    )
    checks["i4ConsumesExactI3Authority"] = {"status": "PASS" if i4_ok else "FAIL", "bound": i4_bound}

    receipt = load_json(CROSS_PROFILE_RECEIPT) or {}
    receipt_fps = receipt.get("fingerprints") or {}
    profile_ok = (
        receipt.get("status") == "PASS"
        and receipt_fps.get("providerSemanticsFingerprint") == i4a.get("providerSemanticsFingerprint")
        and receipt_fps.get("canonicalProviderAuthoritySha256") == shared["canonicalProviderFingerprint"]
        and receipt_fps.get("increment4aRuntimeAuthoritySha256") == sha256_file(I4A_RUNTIME_AUTHORITY)
        and sha256_file(I3_CAPABILITIES) == shared["canonicalProviderFingerprint"]
    )
    checks["defaultProfileUnaffectedByI4A"] = {
        "status": "PASS" if profile_ok else "FAIL",
        "receipt": rel(CROSS_PROFILE_RECEIPT),
        "receiptStatus": receipt.get("status"),
        "detail": "cross-profile regression receipt must be PASS and bound to current provider/model authority",
    }

    i4a_extends = i4a["status"] == "PASS"
    checks["i4aExtendsAcceptedI3Authority"] = {
        "status": "PASS" if i4a_extends else "FAIL",
        "detail": "runtime-authority baselineAuthoritySha256, profile pins, canonical binding verified in the increment4a section",
    }

    stale_refs: list[str] = []
    if not i3.get("strictReceipt", {}).get("receiptInputsCurrent"):
        stale_refs.append("increment3.strictReceipt")
    inventory = load_json(INVENTORY_V1) or {}
    by_leaf = {record.get("leafId"): record for record in inventory.get("records", [])}
    for leaf in sorted(REQUIRED_REUSE_LEAVES):
        if by_leaf.get(leaf, {}).get("status") != "REUSE":
            stale_refs.append(f"{leaf}:{by_leaf.get(leaf, {}).get('status') or 'MISSING'}")
    for leaf, record in by_leaf.items():
        if record.get("status") == "NOT_RUN" and leaf not in NON_BLOCKING_NOT_RUN:
            stale_refs.append(f"{leaf}:NOT_RUN")
    checks["noStaleReceiptReferences"] = {"status": "PASS" if not stale_refs else "FAIL", "stale": stale_refs}

    drift: list[str] = []
    for path in _git_dirty(GHATANA_REPO, (WORKER_PREFIX,)):
        classification, _reason = _classify_worker_dirty_path(path)
        if classification != "allowed":
            drift.append(f"ghatana:{path}")
    for path in _git_dirty(GHARBATAI, I4_SCOPE_PREFIXES):
        if path not in SEAL_ARTIFACTS_GHARBATAI:
            drift.append(f"gharbatai:{path}")
    checks["noInScopeMaterialDrift"] = {
        "status": "PASS" if not drift else "FAIL",
        "unexpectedDirtyPaths": drift,
        "note": "fingerprinted sources are covered by the stability/material-lock checks; git scope covers residual path drift",
    }

    blocking: list[str] = []
    for section_name, section in (("increment3", i3), ("increment4", i4), ("increment4a", i4a)):
        if section.get("status") != "PASS":
            blocking.append(section_name)
    checks["noUnknownOrNotRunBlockingLeaves"] = {"status": "PASS" if not blocking else "FAIL", "blocking": blocking}

    scopes = material_scopes.check()
    checks["materialScopesDeclared"] = {
        "status": "PASS" if str(scopes.get("materialScopes", "")).startswith("PASS") else "FAIL",
        "errors": scopes.get("errors") or [],
        "detail": "semantic/environment/evidence scopes must be disjoint and cover every fingerprinted file",
    }

    deps = leaf_dependencies.check()
    checks["leafDependencyCoverage"] = {
        "status": "PASS" if deps.get("leafDependencies") == "PASS" else "FAIL",
        "evaluatedLeaves": deps.get("evaluatedLeaves"),
        "errors": deps.get("errors") or [],
        "detail": "every seal-counted leaf must bind its declared dependsOn set and exclude doesNotDependOn keys",
    }

    native = native_runtime.check()
    checks["nativeRuntimeBound"] = {
        "status": "PASS" if native.get("nativeRuntimeSupplement") == "PASS" else "FAIL",
        "staleIdentities": native.get("staleIdentities") or [],
        "detail": "wheel-bundled native libraries and system executables must match recorded identities",
    }

    publication = run_publication.check()
    checks["runPublicationComplete"] = {
        "status": "PASS" if publication.get("runPublication") == "PASS" else "FAIL",
        "failingRuns": publication.get("failingRuns") or [],
        "detail": "canonical run directories must carry a COMPLETE manifest whose digests match disk",
    }

    product_impl = (docs_i4_product_implementation() or {})
    drifted = list(product_impl.get("driftedAreas") or [])
    stale_leaves = list(product_impl.get("staleLeaves") or [])
    checks["i4ProductImplementationCurrent"] = {
        "status": "PASS" if product_impl and not drifted else "FAIL",
        "driftedAreas": drifted,
        "staleLeaves": stale_leaves,
        "detail": "the product implementation bound by the Increment-4 campaign must equal the current source; post-campaign drift stales the dependent leaves",
    }
    return checks


def docs_i4_product_implementation() -> dict[str, Any] | None:
    manifest = load_json(I4_ARTIFACTS["campaignManifest"]) or {}
    return manifest.get("productImplementation")


def build() -> dict[str, Any]:
    i3 = check_increment3()
    i4 = check_increment4()
    i4a = check_increment4a()
    shared = check_shared(i3, i4, i4a)
    cross = check_cross(i3, i4, i4a, shared)
    blocking_fail = sum(
        1 for section in (i3, i4, i4a, shared) if section["status"] != "PASS"
    ) + sum(1 for check in cross.values() if check["status"] != "PASS")
    closure_integrity = {
        "materialScopeFiles": {
            name: sha256_file(path) for name, path in material_scopes.SCOPE_FILES.items()
        },
        "leafDependenciesCatalogSha256": sha256_file(leaf_dependencies.CATALOG_PATH),
        "nativeRuntimeSupplementSha256": sha256_file(native_runtime.SUPPLEMENT_PATH),
        "runManifestSha256": {
            name: result.get("manifestSha256")
            for name, result in (run_publication.check().get("runs") or {}).items()
        },
    }
    return {
        "schemaVersion": FREEZE_SET_SCHEMA,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "increments": {"increment3": i3, "increment4": i4, "increment4a": i4a},
        "shared": shared,
        "crossChecks": cross,
        "closureIntegrity": closure_integrity,
        "releaseActivation": "NOT_ACTIVATED",
        "sealArtifacts": {
            "worker": sorted(SEAL_ARTIFACTS_WORKER),
            "gharbatai": sorted(SEAL_ARTIFACTS_GHARBATAI),
        },
        "seal": {
            "state": "SEALED" if blocking_fail == 0 else "OPEN",
            "blocking": {
                "fail": blocking_fail,
                "unknown": 0,
                "requiredNotRun": len(stale_not_run()),
                "staleReceipts": len((cross.get("noStaleReceiptReferences") or {}).get("stale") or []),
                "authorityMismatch": 0 if blocking_fail == 0 else blocking_fail,
            },
        },
    }


def stale_not_run() -> list[str]:
    inventory = load_json(INVENTORY_V1) or {}
    return [
        record["leafId"]
        for record in inventory.get("records", [])
        if record.get("status") == "NOT_RUN" and record.get("leafId") not in NON_BLOCKING_NOT_RUN
    ]


def _strip_volatile(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _strip_volatile(item) for key, item in value.items() if key not in {"generatedAt", "declaredAt"}}
    if isinstance(value, list):
        return [_strip_volatile(item) for item in value]
    return value


def check() -> int:
    if not FREEZE_SET_PATH.is_file():
        print(json.dumps({"freezeSet": "FAIL", "reason": "MANIFEST_MISSING", "path": str(FREEZE_SET_PATH)}, indent=2))
        return 2
    existing = load_json(FREEZE_SET_PATH) or {}
    current = build()
    same = _strip_volatile(existing) == _strip_volatile(current)
    report = {
        "freezeSet": "PASS" if same and current["seal"]["state"] == "SEALED" else "FAIL",
        "manifest": str(FREEZE_SET_PATH),
        "sealState": current["seal"]["state"],
        "manifestStale": not same,
        "sections": {
            "increment3": current["increments"]["increment3"]["status"],
            "increment4": current["increments"]["increment4"]["status"],
            "increment4a": current["increments"]["increment4a"]["status"],
            "shared": current["shared"]["status"],
            "crossChecks": {name: check_result["status"] for name, check_result in current["crossChecks"].items()},
        },
        "errors": {
            "increment3": current["increments"]["increment3"]["errors"],
            "increment4": current["increments"]["increment4"]["errors"],
            "increment4a": current["increments"]["increment4a"]["errors"],
            "shared": current["shared"]["errors"],
        },
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["freezeSet"] == "PASS" else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read-only reconciliation; writes nothing")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = build()
    FREEZE_SET_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    tmp = FREEZE_SET_PATH.with_name(FREEZE_SET_PATH.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(FREEZE_SET_PATH)
    print(json.dumps({
        "freezeSet": "BUILT",
        "manifest": str(FREEZE_SET_PATH),
        "sealState": manifest["seal"]["state"],
        "increment3": manifest["increments"]["increment3"]["status"],
        "increment4": manifest["increments"]["increment4"]["status"],
        "increment4a": manifest["increments"]["increment4a"]["status"],
        "shared": manifest["shared"]["status"],
        "crossChecks": {name: check_result["status"] for name, check_result in manifest["crossChecks"].items()},
        "errors": {
            "increment3": manifest["increments"]["increment3"]["errors"],
            "increment4": manifest["increments"]["increment4"]["errors"],
            "increment4a": manifest["increments"]["increment4a"]["errors"],
            "shared": manifest["shared"]["errors"],
        },
    }, indent=2, sort_keys=True))
    return 0 if manifest["seal"]["state"] == "SEALED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
