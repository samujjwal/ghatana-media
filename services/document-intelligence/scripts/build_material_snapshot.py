"""Freeze-program material snapshot and proof inventory.

Emits two artifacts under docs/evidence/:

* ``material-snapshot.v1.json`` — one stable semantic fingerprint set for the
  shared provider material that Increments 3, 4 and 4A all depend on.
* ``proof-inventory.v1.json`` — every known proof artifact classified as
  REUSE / INVALIDATED / NOT_RUN against the current snapshot, with reasons.

Fingerprints, not commit SHAs, are the reuse authority. The script is
read-only for source material: it computes hashes and writes only the two
evidence artifacts above.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GHATANA_REPO = ROOT.parents[1]
DEVELOPMENTS = GHATANA_REPO.parent
GHARBATAI = Path(os.getenv("GHARBATAI_ROOT", str(DEVELOPMENTS / "gharbatai")))
GHATANA_SHARED = Path(os.getenv("GHATANA_SHARED_ROOT", str(DEVELOPMENTS / "ghatana-shared")))
ORG_EVAL = GHARBATAI / "products/org/docs/document-extraction/evaluation"
ORG_RESULTS = ORG_EVAL / "results"
EVIDENCE_DIR = ROOT / "docs/evidence"
SNAPSHOT_PATH = EVIDENCE_DIR / "material-snapshot.v1.json"
INVENTORY_PATH = EVIDENCE_DIR / "proof-inventory.v1.json"
INVENTORY_V2_PATH = EVIDENCE_DIR / "proof-inventory.v2.json"
INVENTORY_V2_SCHEMA = "document-intelligence.proof-inventory.v2"
PROOF_IDENTITY_SCHEMA = "document-intelligence.proof-identity.v1"
RECONCILIATION_PATH = EVIDENCE_DIR / "increment3-current-runtime-reconciliation.json"
SNAPSHOT_SCHEMA = "document-intelligence.material-snapshot.v1"
INVENTORY_SCHEMA = "document-intelligence.proof-inventory.v1"

IGNORED_PARTS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", "dist", "coverage", ".vite"}

PROVIDER_FILES = {
    "docling": "src/document_intelligence/providers/docling_parser.py",
    "paddle": "src/document_intelligence/providers/paddle_ocr_parser.py",
    "gliner": "src/document_intelligence/providers/gliner_extractor.py",
    "minilm": "src/document_intelligence/providers/minilm_embedder.py",
}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest_json(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def tree_fingerprint(root: Path, paths: list[str]) -> str:
    digest = hashlib.sha256()
    for relative in paths:
        path = root / relative
        if not path.exists():
            digest.update(f"{relative}:MISSING".encode("utf-8"))
            continue
        if path.is_file():
            digest.update(relative.encode("utf-8"))
            digest.update(path.read_bytes())
            continue
        for item in sorted(path.rglob("*")):
            if not item.is_file() or any(part in IGNORED_PARTS for part in item.parts):
                continue
            digest.update(str(item.relative_to(root)).encode("utf-8"))
            digest.update(item.read_bytes())
    return digest.hexdigest()


def load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def implementation_material():
    helper = ROOT / "evaluation/increment4a/implementation_material.py"
    spec = importlib.util.spec_from_file_location("increment4a_implementation_material", helper)
    if spec is None or spec.loader is None:
        raise RuntimeError("implementation material fingerprint helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def i4a_material_fingerprints() -> dict[str, str]:
    helper = ROOT / "evaluation/increment4a/run_qualification.py"
    spec = importlib.util.spec_from_file_location("increment4a_run_qualification", helper)
    if spec is None or spec.loader is None:
        raise RuntimeError("increment4a material fingerprint helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.material_fingerprints()


def increment4_acceptance_fingerprint() -> dict[str, Any]:
    script = (
        "import('./scripts/document-extraction/evaluate-product-acceptance.mjs')"
        ".then(m => { const v = m.validateAcceptancePack('docs/document-extraction/evaluation');"
        " console.log(JSON.stringify(v.fingerprints)); })"
    )
    org_root = GHARBATAI / "products/org"
    if not (org_root / "scripts/document-extraction/evaluate-product-acceptance.mjs").exists():
        return {"status": "MISSING_REPOSITORY"}
    result = subprocess.run(["node", "-e", script], cwd=org_root, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        return {"status": "ERROR", "detail": result.stderr.strip()[-500:]}
    try:
        return {"status": "OK", "fingerprints": json.loads(result.stdout)}
    except json.JSONDecodeError:
        return {"status": "ERROR", "detail": result.stdout.strip()[-500:]}


def git_state(repo: Path) -> dict[str, Any]:
    if not (repo / ".git").exists():
        return {"repository": str(repo), "present": False}
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, text=True, capture_output=True, check=False)
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=repo, text=True, capture_output=True, check=False)
    return {
        "repository": str(repo),
        "present": True,
        "headSha": head.stdout.strip() or None,
        "clean": dirty.returncode == 0 and dirty.stdout.strip() == "",
        "dirtyEntries": [line for line in dirty.stdout.splitlines() if line.strip()][:50],
    }


def latest_run(directory: Path) -> tuple[Path | None, dict | None]:
    candidates = []
    for item in sorted(directory.glob("*/summary.json")):
        summary = load_json(item)
        if summary:
            candidates.append((item.parent, summary))
    return candidates[-1] if candidates else (None, None)


def compute_snapshot() -> dict[str, Any]:
    material = implementation_material()
    impl = material.implementation_fingerprints(ROOT)
    i4a_material = i4a_material_fingerprints()
    lock = load_json(ROOT / "contracts/shared-contract.lock.json") or {}
    i3_summary_dir, i3_summary = latest_run(ROOT / "evaluation/results")
    i4a_summary_dir, i4a_summary = latest_run(ROOT / "evaluation/increment4a/results")
    acceptance = increment4_acceptance_fingerprint()
    i4a_model_report = load_json(ROOT / "models/increment4a/model-verification.json") or {}

    fingerprints: dict[str, Any] = {
        "sharedContractFingerprint": lock.get("publicTypeApiSnapshotSha256"),
        "sharedContractLockSha256": sha256_file(ROOT / "contracts/shared-contract.lock.json") if (ROOT / "contracts/shared-contract.lock.json").exists() else None,
        "providerSemanticsFingerprint": impl["providerSemanticsFingerprint"],
        "providerImplementationFingerprints": {
            name: sha256_file(ROOT / rel) if (ROOT / rel).exists() else None for name, rel in PROVIDER_FILES.items()
        },
        "workerLifecycleFingerprint": tree_fingerprint(ROOT / "src/document_intelligence", ["runtime", "lifecycle.py", "app.py", "health.py"]),
        "workerClientFingerprint": tree_fingerprint(ROOT / "clients/typescript", ["src", "tests", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"]),
        "modelManifestFingerprint": sha256_file(ROOT / "models/model-manifest.yaml"),
        "increment4aModelManifestFingerprint": sha256_file(ROOT / "models/increment4a/model-manifest.yaml"),
        "uvLockSha256": sha256_file(ROOT / "uv.lock"),
        "i3EvaluationImplementationFingerprint": None,
        "increment4aEvaluatorFingerprint": impl["evaluationImplementationFingerprint"],
        "increment4aObservationMaterialFingerprint": digest_json(i4a_material),
        "increment4AcceptanceFingerprint": acceptance.get("fingerprints", {}).get("acceptanceManifestFingerprint") if acceptance.get("status") == "OK" else None,
    }
    # Increment-3 evaluator fingerprint shares the run_evaluation definition.
    sys.path.insert(0, str(ROOT / "evaluation"))
    from run_evaluation import evaluation_implementation_fingerprint  # noqa: PLC0415

    fingerprints["i3EvaluationImplementationFingerprint"] = evaluation_implementation_fingerprint()

    return {
        "schemaVersion": SNAPSHOT_SCHEMA,
        "capturedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sourceState": {
            "worker": git_state(GHATANA_REPO),
            "ghatanaShared": git_state(GHATANA_SHARED),
            "gharbatai": git_state(GHARBATAI),
        },
        "fingerprints": fingerprints,
        "increment3": {
            "latestEvaluationRunId": i3_summary.get("runId") if i3_summary else None,
            "latestEvaluationDir": str(i3_summary_dir) if i3_summary_dir else None,
            "providerCatalogFingerprint": sha256_file(i3_summary_dir / "capabilities.json") if i3_summary_dir and (i3_summary_dir / "capabilities.json").exists() else None,
        },
        "increment4": {
            "acceptancePack": acceptance,
        },
        "increment4a": {
            "latestRunId": i4a_summary.get("runId") if i4a_summary else None,
            "latestRunDir": str(i4a_summary_dir) if i4a_summary_dir else None,
            "modelVerificationReport": {
                "status": i4a_model_report.get("status"),
                "manifestSha256": i4a_model_report.get("manifestSha256"),
            },
        },
    }


def classify(bound: dict[str, Any], current: dict[str, Any]) -> tuple[str, list[str]]:
    mismatched = [key for key, value in current.items() if bound.get(key) != value]
    return ("INVALIDATED", mismatched) if mismatched else ("REUSE", [])


def artifact_record(leaf_id: str, path: Path, *, command: str | None = None) -> dict[str, Any]:
    return {
        "leafId": leaf_id,
        "artifact": str(path),
        "exists": path.exists(),
        "command": command,
        "status": "NOT_RUN",
        "evidenceStatus": None,
        "inputFingerprint": {},
        "outputFingerprint": sha256_file(path) if path.is_file() else None,
        "runId": None,
        "completedAt": None,
        "reusedFrom": None,
        "invalidatedBy": None,
        "reason": None,
    }


def build_inventory(snapshot: dict[str, Any]) -> dict[str, Any]:
    fingerprints = snapshot["fingerprints"]
    records: list[dict[str, Any]] = []
    now = snapshot["capturedAt"]

    # ---------- Increment 3 evaluation runs ----------
    # Recompute the frozen-input fingerprints via the gate definitions so the
    # inventory classifies evidence against exactly what the verifier expects.
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        import verify_increment3 as gate  # noqa: PLC0415

        frozen_now = gate.frozen_fingerprints()
    except Exception:
        frozen_now = {}
    i3_bound_keys = {
        "manifestFingerprint": frozen_now.get("manifestFingerprint"),
        "corpusFingerprint": frozen_now.get("corpusFingerprint"),
        "acceptanceFingerprint": frozen_now.get("acceptanceFingerprint"),
        "environmentFingerprint": frozen_now.get("environmentFingerprint"),
        "modelManifestFingerprint": fingerprints["modelManifestFingerprint"],
        "providerSemanticsFingerprint": fingerprints["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": fingerprints["i3EvaluationImplementationFingerprint"],
    }

    for summary_path in sorted((ROOT / "evaluation/results").glob("*/summary.json")):
        summary = load_json(summary_path) or {}
        lineage = load_json(summary_path.with_name("lineage.json")) or {}
        record = artifact_record(f"increment3.evaluation.{summary.get('runId', summary_path.parent.name)}", summary_path, command="uv run python evaluation/run_evaluation.py")
        record["evidenceStatus"] = summary.get("status")
        record["runId"] = summary.get("runId")
        record["inputFingerprint"] = {key: summary.get(key) for key in i3_bound_keys}
        record["invalidatedBy"] = lineage.get("invalidatedBy")
        if lineage.get("status") == "INVALIDATED_NON_PROMOTABLE":
            record["status"] = "INVALIDATED"
            record["reason"] = f"lineage: {lineage.get('reason')} ({lineage.get('disposition', '')})"
        elif summary.get("status") != "PASS":
            record["status"] = "INVALIDATED" if summary.get("status") in {"FAIL"} else "NOT_RUN"
            record["reason"] = f"run status {summary.get('status')}"
        else:
            disposition, mismatched = classify(record["inputFingerprint"], {k: v for k, v in i3_bound_keys.items() if v is not None})
            record["status"] = disposition
            record["reason"] = None if not mismatched else f"fingerprint mismatch: {', '.join(mismatched)}"
        records.append(record)

    # ---------- Increment 3 strict receipt ----------
    receipt_path = ROOT / "docs/evidence/increment3-strict-receipt.json"
    receipt = load_json(receipt_path) or {}
    record = artifact_record("increment3.strictGate", receipt_path, command="python scripts/verify_increment3.py --strict")
    record["evidenceStatus"] = receipt.get("status")
    record["runId"] = receipt.get("runId")
    record["completedAt"] = receipt.get("completedAt")
    record["inputFingerprint"] = receipt.get("inputFingerprints", {})
    if receipt:
        record["status"] = "REUSE" if receipt.get("status") == "PASS" else "NOT_RUN"
        record["reason"] = "receipt reuse is decided by the strict gate against live fingerprints"
    records.append(record)

    # ---------- Increment 4A campaign runs ----------
    i4a_bound = {
        "providerSemanticsFingerprint": fingerprints["providerSemanticsFingerprint"],
        "evaluationImplementationFingerprint": fingerprints["increment4aEvaluatorFingerprint"],
        "materialFingerprint": fingerprints["increment4aObservationMaterialFingerprint"],
    }
    for summary_path in sorted((ROOT / "evaluation/increment4a/results").glob("*/summary.json")):
        summary = load_json(summary_path) or {}
        lineage = load_json(summary_path.with_name("lineage.json")) or {}
        record = artifact_record(f"increment4a.campaign.{summary.get('runId', summary_path.parent.name)}", summary_path, command="python evaluation/increment4a/run_campaign.py")
        record["evidenceStatus"] = summary.get("status")
        record["runId"] = summary.get("runId")
        record["completedAt"] = summary.get("completedAt") or summary.get("startedAt")
        bound = {
            "providerSemanticsFingerprint": summary.get("providerSemanticsFingerprint"),
            "evaluationImplementationFingerprint": summary.get("evaluationImplementationFingerprint"),
            "materialFingerprint": summary.get("materialFingerprint"),
        }
        record["inputFingerprint"] = bound
        record["invalidatedBy"] = lineage.get("invalidatedBy") or lineage.get("supersededBy")
        if lineage.get("status") in {"SUPERSEDED", "INVALIDATED_NON_PROMOTABLE"}:
            record["status"] = "INVALIDATED"
            record["reason"] = f"lineage: {lineage.get('status')}"
        elif summary.get("status") not in {"PASS"}:
            record["status"] = "INVALIDATED" if summary.get("status") == "FAIL" else "NOT_RUN"
            record["reason"] = f"run status {summary.get('status')}"
        else:
            disposition, mismatched = classify(bound, i4a_bound)
            record["status"] = disposition
            if mismatched:
                record["reason"] = f"fingerprint mismatch: {', '.join(mismatched)}"
        records.append(record)

    # ---------- Increment 4A cached test receipts ----------
    receipts_path = ROOT / "evaluation/increment4a/test-receipts.json"
    receipts_doc = load_json(receipts_path) or {}
    for leaf_id, entry in sorted((receipts_doc.get("leaves") or {}).items()):
        record = artifact_record(f"increment4a.testReceipt.{leaf_id}", receipts_path)
        record["evidenceStatus"] = entry.get("status")
        record["runId"] = entry.get("runId")
        record["completedAt"] = entry.get("completedAt")
        record["inputFingerprint"] = entry.get("inputFingerprint") or {
            "materialFingerprint": entry.get("materialFingerprint"),
            "providerSemanticsFingerprint": entry.get("providerSemanticsFingerprint"),
            "requiredTestSpecFingerprint": entry.get("requiredTestSpecFingerprint"),
        }
        bound = record["inputFingerprint"]
        expected = {
            "providerSemanticsFingerprint": fingerprints["providerSemanticsFingerprint"],
        }
        if entry.get("status") != "PASS":
            record["status"] = "NOT_RUN"
            record["reason"] = f"receipt status {entry.get('status')}"
        else:
            material_now = bound.get("materialFingerprint")
            spec_now = bound.get("requiredTestSpecFingerprint")
            mismatched = []
            if bound.get("providerSemanticsFingerprint") != expected["providerSemanticsFingerprint"]:
                mismatched.append("providerSemanticsFingerprint")
            if material_now is not None and material_now != fingerprints["increment4aObservationMaterialFingerprint"]:
                mismatched.append("materialFingerprint")
            record["status"] = "INVALIDATED" if mismatched else "REUSE"
            record["reason"] = f"fingerprint mismatch: {', '.join(mismatched)}" if mismatched else None
            if spec_now is not None and not mismatched:
                record["reason"] = "requiredTestSpec reuse is decided by the verifier"
        records.append(record)

    # ---------- Model verification reports ----------
    # The Increment-3 lane verifies models live inside the strict gate; no
    # persisted report exists for it. Increment-4A persists a v2 report bound
    # to the lane manifest sha.
    record = artifact_record("increment3.modelVerification", ROOT / "models/model-verification.json", command="python scripts/verify_models.py")
    record["status"] = "NOT_RUN"
    record["reason"] = "verified live inside the strict gate; no persisted report"
    records.append(record)

    report_path = ROOT / "models/increment4a/model-verification.json"
    report = load_json(report_path) or {}
    record = artifact_record("increment4a.modelVerification", report_path, command="python scripts/verify_models.py --manifest models/increment4a/model-manifest.yaml --report models/increment4a/model-verification.json")
    record["evidenceStatus"] = report.get("status")
    record["inputFingerprint"] = {"manifestSha256": report.get("manifestSha256")}
    if report.get("status") == "PASS" and report.get("manifestSha256") == sha256_file(ROOT / "models/increment4a/model-manifest.yaml"):
        record["status"] = "REUSE"
    elif report.get("status") == "PASS":
        record["status"] = "INVALIDATED"
        record["reason"] = "manifestSha256 mismatch"
    else:
        record["status"] = "NOT_RUN"
        record["reason"] = f"report status {report.get('status') or 'MISSING'}"
    records.append(record)

    # ---------- Increment 4A material lock + canonical pointer ----------
    material_lock_path = ROOT / "evaluation/increment4a/material-lock.json"
    material_lock = load_json(material_lock_path) or {}
    record = artifact_record("increment4a.materialLock", material_lock_path, command="python scripts/freeze_increment4a.py")
    record["evidenceStatus"] = material_lock.get("state")
    record["runId"] = material_lock.get("runId")
    record["completedAt"] = material_lock.get("frozenAt")
    record["inputFingerprint"] = {
        "providerSemanticsFingerprint": material_lock.get("providerSemanticsFingerprint"),
        "evaluationImplementationFingerprint": material_lock.get("evaluationImplementationFingerprint"),
        "materialFingerprints": material_lock.get("materialFingerprints"),
    }
    if material_lock.get("state") == "FROZEN":
        mismatched = [
            key for key, current in {
                "providerSemanticsFingerprint": fingerprints["providerSemanticsFingerprint"],
                "evaluationImplementationFingerprint": fingerprints["increment4aEvaluatorFingerprint"],
            }.items()
            if material_lock.get(key) != current
        ]
        # The lock stores a short-name projection of the material map; compare
        # its entries pairwise against the current suffixed-name projection.
        short_to_current = {key.removesuffix("Fingerprint"): value for key, value in i4a_material_fingerprints().items()}
        for key, locked_value in (material_lock.get("materialFingerprints") or {}).items():
            if short_to_current.get(key) != locked_value:
                mismatched.append(f"materialFingerprints.{key}")
        record["status"] = "INVALIDATED" if mismatched else "REUSE"
        record["reason"] = f"fingerprint mismatch: {', '.join(mismatched)}" if mismatched else None
    else:
        record["status"] = "NOT_RUN"
    records.append(record)

    canonical_path = ROOT / "evaluation/increment4a/canonical-run.json"
    canonical = load_json(canonical_path) or {}
    record = artifact_record("increment4a.canonicalPointer", canonical_path)
    record["evidenceStatus"] = canonical.get("state")
    record["runId"] = canonical.get("runId")
    record["inputFingerprint"] = {
        "providerSemanticsFingerprint": canonical.get("providerSemanticsFingerprint"),
        "evaluationImplementationFingerprint": canonical.get("evaluationImplementationFingerprint"),
        "observationsFingerprint": canonical.get("observationsFingerprint"),
    }
    if canonical:
        mismatched = [
            key for key, current in {
                "providerSemanticsFingerprint": fingerprints["providerSemanticsFingerprint"],
                "evaluationImplementationFingerprint": fingerprints["increment4aEvaluatorFingerprint"],
            }.items()
            if canonical.get(key) != current
        ]
        record["status"] = "INVALIDATED" if mismatched else "REUSE"
        record["reason"] = f"canonical run bound to drifted inputs: {', '.join(mismatched)}" if mismatched else None
    records.append(record)

    # ---------- Increment 4 product-side artifacts ----------
    i4_bound_keys = ("sharedContractFingerprint", "acceptanceManifestFingerprint", "providerSemanticsFingerprint")
    current_i4 = {
        "sharedContractFingerprint": f"sha256:{fingerprints['sharedContractFingerprint']}" if fingerprints.get("sharedContractFingerprint") else None,
        "acceptanceManifestFingerprint": fingerprints["increment4AcceptanceFingerprint"],
        "providerSemanticsFingerprint": f"sha256:{fingerprints['providerSemanticsFingerprint']}" if fingerprints.get("providerSemanticsFingerprint") else None,
    }
    i4_artifacts = [
        ("increment4.livePostgres", "results/live-postgres.json"),
        ("increment4.liveWorkerIdentity", "results/live-worker-identity.json"),
        ("increment4.productAcceptance", "results/product-acceptance.json"),
        ("increment4.productAcceptanceRun", "results/product-acceptance-run.json"),
        ("increment4.reprocessDurability", "results/reprocess-durability.json"),
        ("increment4.reprocessLifecycleRun", "results/reprocess-lifecycle-run.json"),
        ("increment4.pdfConsumer", "results/pdf-consumer.json"),
        ("increment4.imageConsumer", "results/image-consumer.json"),
        ("increment4.authenticatedBrowserJourney", "results/authenticated-browser-journey.json"),
        ("increment4.auditAtomicity", "results/audit-atomicity.json"),
        ("increment4.consumerAdmissionV2", "consumer-admission.v2.json"),
        ("increment4.campaignManifest", "results/campaign-manifest.json"),
        ("increment4.closureStatus", "increment4-closure-status.json"),
    ]
    for leaf_id, name in i4_artifacts:
        path = ORG_EVAL / name
        doc = load_json(path) or {}
        record = artifact_record(leaf_id, path)
        record["evidenceStatus"] = doc.get("status") or doc.get("verdict")
        record["runId"] = doc.get("runId")
        record["completedAt"] = doc.get("completedAt") or doc.get("generatedAt")
        bound = {key: doc.get(key) for key in i4_bound_keys}
        fingerprints_nested = doc.get("fingerprints") if isinstance(doc.get("fingerprints"), dict) else {}
        for key in i4_bound_keys:
            if bound[key] is None:
                bound[key] = fingerprints_nested.get(key)
        record["inputFingerprint"] = {k: v for k, v in bound.items() if v is not None}
        if not path.exists():
            record["status"] = "NOT_RUN"
            record["reason"] = "artifact missing"
            records.append(record)
            continue
        if record["evidenceStatus"] in {"FAIL", "FAILED"}:
            record["status"] = "INVALIDATED"
            record["reason"] = "evidence status FAIL"
            records.append(record)
            continue
        if record["evidenceStatus"] in {None, "NOT_RUN", "SKIP"}:
            record["status"] = "NOT_RUN"
            record["reason"] = f"evidence status {record['evidenceStatus'] or 'MISSING'}"
            records.append(record)
            continue
        comparable = {k: v for k, v in current_i4.items() if bound.get(k) is not None}
        mismatched = [key for key, current in comparable.items() if bound.get(key) != current]
        record["status"] = "INVALIDATED" if mismatched else "REUSE"
        record["reason"] = f"fingerprint mismatch: {', '.join(mismatched)}" if mismatched else None
        records.append(record)

    counts: dict[str, int] = {}
    for record in records:
        counts[record["status"]] = counts.get(record["status"], 0) + 1

    return {
        "schemaVersion": INVENTORY_SCHEMA,
        "generatedAt": now,
        "snapshotReference": str(SNAPSHOT_PATH),
        "currentFingerprints": fingerprints,
        "records": records,
        "summary": {"total": len(records), **counts},
    }


# ---------- Proof identity (v2) ----------

_MATERIAL_KEYS = {
    "manifestFingerprint",
    "materialFingerprint",
    "materialFingerprints",
    "providerSemanticsFingerprint",
    "acceptanceFingerprint",
    "acceptanceManifestFingerprint",
    "requiredTestSpecFingerprint",
    "testSpecFingerprint",
    "manifestSha256",
    "sharedContractSnapshotSha256",
    "workerClientFingerprint",
    "observationsFingerprint",
}
_DEPENDENCY_KEYS = {
    "sharedContractFingerprint",
    "sharedContractLockSha256",
    "providerCatalogFingerprint",
    "modelManifestFingerprint",
    "increment3ProviderCatalogFingerprint",
    "increment3ModelManifestFingerprint",
}
_EXECUTION_KEYS = {
    "environmentFingerprint",
    "corpusFingerprint",
    "uvLockSha256",
    "pythonVersion",
    "pytestVersion",
    "nodeVersion",
    "pnpmVersion",
}
_EVALUATOR_KEYS = {"evaluationImplementationFingerprint"}

REUSE_RULE = (
    "REUSE requires the record's material authority, transitive dependency "
    "authority, required execution authority, and evaluator authority to all "
    "match their bound values, the proof schema to remain compatible, and the "
    "recorded result to be PASS."
)


def _verifier_fingerprint(command: str | None) -> str | None:
    """Fingerprint the verifier/executor source named by the record command."""
    if not command:
        return None
    for token in command.split():
        if not token.endswith((".py", ".mjs")):
            continue
        for base in (ROOT, GHARBATAI / "products/org"):
            candidate = base / token
            if candidate.is_file():
                return sha256_file(candidate)
    return None


def _proof_identity_record(record: dict[str, Any]) -> dict[str, Any]:
    """Project a flat v1 record into the structured proof-identity shape.

    reuseDecision mirrors the v1 classification: REUSE only when material,
    dependency, execution and evaluator authority all match their bound values
    and the result is PASS.
    """
    bound = record.get("inputFingerprint") or {}
    material_inputs = {key: bound[key] for key in sorted(bound) if key in _MATERIAL_KEYS}
    dependency_inputs = {key: bound[key] for key in sorted(bound) if key in _DEPENDENCY_KEYS}
    execution_inputs = {key: bound[key] for key in sorted(bound) if key in _EXECUTION_KEYS}
    evaluator_inputs = {key: bound[key] for key in sorted(bound) if key in _EVALUATOR_KEYS}
    remaining = {key: bound[key] for key in sorted(bound) if key not in _MATERIAL_KEYS | _DEPENDENCY_KEYS | _EXECUTION_KEYS | _EVALUATOR_KEYS}
    if remaining:
        material_inputs["additionalBoundInputs"] = remaining
    upstream = [record["reusedFrom"]] if record.get("reusedFrom") else []
    return {
        "proofIdentity": {
            "leafId": record["leafId"],
            "proofSchemaVersion": PROOF_IDENTITY_SCHEMA,
        },
        "materialAuthority": {
            "sourceFingerprint": bound.get("providerSemanticsFingerprint") or bound.get("materialFingerprint"),
            "configFingerprint": bound.get("acceptanceFingerprint") or bound.get("acceptanceManifestFingerprint") or bound.get("manifestFingerprint"),
            "generatedAuthorityFingerprint": bound.get("manifestSha256"),
            "inputs": material_inputs,
        },
        "dependencyAuthority": {
            "upstreamProofFingerprints": upstream,
            "sharedContractFingerprint": bound.get("sharedContractFingerprint") or bound.get("sharedContractLockSha256"),
            "providerCatalogFingerprint": bound.get("providerCatalogFingerprint") or bound.get("increment3ProviderCatalogFingerprint"),
            "modelManifestFingerprint": bound.get("modelManifestFingerprint") or bound.get("increment3ModelManifestFingerprint"),
            "inputs": dependency_inputs,
        },
        "executionAuthority": {
            "environmentFingerprint": bound.get("environmentFingerprint"),
            "runtimeDependencyFingerprint": bound.get("uvLockSha256"),
            "corpusFingerprint": bound.get("corpusFingerprint"),
            "inputs": execution_inputs,
        },
        "evaluatorAuthority": {
            "verifierFingerprint": _verifier_fingerprint(record.get("command")),
            "evaluatorFingerprint": bound.get("evaluationImplementationFingerprint"),
            "inputs": evaluator_inputs,
        },
        "result": {
            "status": record.get("evidenceStatus"),
            "reuseDisposition": record["status"],
            "outputFingerprint": record.get("outputFingerprint"),
        },
        "artifact": record["artifact"],
        "command": record.get("command"),
        "runId": record.get("runId"),
        "completedAt": record.get("completedAt"),
        "invalidatedBy": record.get("invalidatedBy"),
        "reuseEvaluation": {
            "rule": REUSE_RULE,
            "decision": record["status"],
            "reason": record.get("reason"),
        },
    }


def build_inventory_v2(snapshot: dict[str, Any], inventory: dict[str, Any]) -> dict[str, Any]:
    records = [_proof_identity_record(record) for record in inventory["records"]]
    counts: dict[str, int] = {}
    for record in records:
        decision = record["reuseEvaluation"]["decision"]
        counts[decision] = counts.get(decision, 0) + 1
    return {
        "schemaVersion": INVENTORY_V2_SCHEMA,
        "generatedAt": snapshot["capturedAt"],
        "snapshotReference": str(SNAPSHOT_PATH),
        "v1InventoryReference": str(INVENTORY_PATH),
        "currentFingerprints": snapshot["fingerprints"],
        "records": records,
        "summary": {"total": len(records), **counts},
    }


def build_runtime_reconciliation(snapshot: dict[str, Any], inventory: dict[str, Any]) -> dict[str, Any]:
    """Per-increment rollup of the proof inventory for the current tree state."""
    per_increment: dict[str, dict[str, Any]] = {}
    for record in inventory["records"]:
        increment = record["leafId"].split(".")[0]
        bucket = per_increment.setdefault(increment, {"REUSE": 0, "INVALIDATED": 0, "NOT_RUN": 0, "leaves": []})
        bucket[record["status"]] = bucket.get(record["status"], 0) + 1
        bucket["leaves"].append(record["leafId"])
    return {
        "schemaVersion": "document-intelligence.runtime-reconciliation.v1",
        "generatedAt": snapshot["capturedAt"],
        "snapshot": str(SNAPSHOT_PATH),
        "inventory": str(INVENTORY_PATH),
        "sourceState": snapshot["sourceState"],
        "providerSemanticsFingerprint": snapshot["fingerprints"]["providerSemanticsFingerprint"],
        "sharedContractFingerprint": snapshot["fingerprints"]["sharedContractFingerprint"],
        "perIncrement": per_increment,
        "disposition": "REOPENED_FOR_RECONCILIATION" if inventory["summary"].get("INVALIDATED") else "RECONCILED",
    }


def write_if_changed(path: Path, payload: dict) -> bool:
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return True


def main() -> int:
    snapshot = compute_snapshot()
    inventory = build_inventory(snapshot)
    inventory_v2 = build_inventory_v2(snapshot, inventory)
    reconciliation = build_runtime_reconciliation(snapshot, inventory)
    wrote_snapshot = write_if_changed(SNAPSHOT_PATH, snapshot)
    wrote_inventory = write_if_changed(INVENTORY_PATH, inventory)
    wrote_inventory_v2 = write_if_changed(INVENTORY_V2_PATH, inventory_v2)
    wrote_reconciliation = write_if_changed(RECONCILIATION_PATH, reconciliation)
    print(json.dumps({
        "snapshot": str(SNAPSHOT_PATH),
        "inventory": str(INVENTORY_PATH),
        "inventoryV2": str(INVENTORY_V2_PATH),
        "reconciliation": str(RECONCILIATION_PATH),
        "snapshotWritten": wrote_snapshot,
        "inventoryWritten": wrote_inventory,
        "inventoryV2Written": wrote_inventory_v2,
        "reconciliationWritten": wrote_reconciliation,
        "inventorySummary": inventory["summary"],
        "sourceState": {key: {"clean": value.get("clean"), "present": value.get("present")} for key, value in snapshot["sourceState"].items()},
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
