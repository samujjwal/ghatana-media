"""External candidate-model registration hook (I5-18).

This module is the entry point for models trained *outside* the worker: it
binds the externally produced model assets, training dataset, and training
implementation fingerprints into a ``candidate-manifest.v1`` record of kind
``MODEL``. It never trains anything and never mutates active authority —
the manifest is registered in state CANDIDATE and must pass governed
evaluation and promotion like any other candidate.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "learning"))

from learning.candidates.registry import candidate_id_for, register  # noqa: E402
from learning.util import digest, validate  # noqa: E402

MANIFEST_SCHEMA = "candidate-manifest.v2.schema.json"
MANIFEST_SCHEMA_VERSION = "document-intelligence.candidate-manifest.v2"
MANIFEST_FINGERPRINT_DOMAIN = "learning.candidate-manifest.v1"
MODEL_REPRODUCIBILITY_KEYS = (
    "trainingCodeFingerprint",
    "datasetFingerprint",
    "baseModelFingerprint",
    "dependencyLockFingerprint",
    "tokenizerFingerprint",
    "seed",
    "hyperparameters",
    "runtime",
    "nativeLibraries",
    "deterministic",
)


def _parse_asset_hash(item: str) -> tuple[str, str]:
    key, sep, value = item.partition("=")
    if not sep or not key:
        raise ValueError(f"--model-asset expects NAME=sha256:..., got {item!r}")
    return key, value


def build_model_candidate_manifest(
    *,
    base_model: str,
    model_asset_hashes: dict[str, str],
    reproducibility: dict,
    training_dataset_fingerprint: str | None = None,
    training_implementation_fingerprint: str | None = None,
    base_authority_fingerprint: str,
    evaluator_implementation_fingerprint: str,
    created_at: str,
    registry_root: Path | None = None,
    license_provenance: dict | None = None,
    tenant_scope: str = "TENANT_LOCAL",
    tenant_ref: str | None = None,
    scope_authorization_ref: str | None = None,
) -> dict:
    """Build (and optionally register) a candidate-manifest.v2 for kind MODEL.

    ``reproducibility`` carries the complete I5-41 binding:
    trainingCodeFingerprint, datasetFingerprint, baseModelFingerprint,
    dependencyLockFingerprint, tokenizerFingerprint, seed, hyperparameters,
    runtime, nativeLibraries, deterministic.

    With ``registry_root`` the manifest is registered through the governed
    candidate registry (write-once, receipted). Without it the equivalent
    manifest is constructed and validated in memory — same candidateId and
    candidateFingerprint semantics as ``registry.register``.
    """
    if not model_asset_hashes:
        raise ValueError("model_asset_hashes must be non-empty")
    if tenant_scope == "MULTI_TENANT_EXPLICITLY_AUTHORIZED" and not scope_authorization_ref:
        raise ValueError(
            "MULTI_TENANT_EXPLICITLY_AUTHORIZED requires scope_authorization_ref"
        )
    missing = [key for key in MODEL_REPRODUCIBILITY_KEYS if key not in reproducibility]
    if missing:
        raise ValueError(f"MODEL reproducibility binding incomplete: {missing}")
    if (
        training_dataset_fingerprint is not None
        and reproducibility["datasetFingerprint"] != training_dataset_fingerprint
    ):
        raise ValueError(
            "--training-dataset-fingerprint differs from "
            "reproducibility.datasetFingerprint — one dataset identity only"
        )
    dataset_fingerprint = reproducibility["datasetFingerprint"]

    model_section: dict = {
        "baseModel": base_model,
        "modelAssetHashes": dict(model_asset_hashes),
        **{key: reproducibility[key] for key in MODEL_REPRODUCIBILITY_KEYS},
    }
    if license_provenance is not None:
        model_section["licenseProvenance"] = dict(license_provenance)
    if training_dataset_fingerprint is not None:
        model_section["trainingDatasetFingerprint"] = training_dataset_fingerprint
    if training_implementation_fingerprint is not None:
        model_section["trainingImplementationFingerprint"] = (
            training_implementation_fingerprint
        )

    dependencies: dict = {
        "baseAuthorityFingerprint": base_authority_fingerprint,
        "evaluatorImplementationFingerprint": evaluator_implementation_fingerprint,
        "modelAssetFingerprints": dict(model_asset_hashes),
        # Always bind the governed training dataset: revocation propagation
        # (learning.candidates.revocation) reads this key.
        "datasetFingerprint": dataset_fingerprint,
    }
    if training_implementation_fingerprint is not None:
        dependencies["trainingImplementationFingerprint"] = (
            training_implementation_fingerprint
        )

    artifact = {"model": model_section}

    if registry_root is not None:
        return register(
            registry_root,
            kind="MODEL",
            artifact=artifact,
            dependencies=dependencies,
            model=model_section,
            created_at=created_at,
            tenant_scope=tenant_scope,
            tenant_ref=tenant_ref,
            scope_authorization_ref=scope_authorization_ref,
        )

    candidate_id = candidate_id_for("MODEL", dependencies)
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "candidateId": candidate_id,
        "candidateKind": "MODEL",
        "state": "CANDIDATE",
        "createdAt": created_at,
        "tenantScope": tenant_scope,
        **({"tenantRef": tenant_ref} if tenant_ref else {}),
        **(
            {"scopeAuthorizationRef": scope_authorization_ref}
            if scope_authorization_ref
            else {}
        ),
        "artifactRef": {
            "artifactFingerprint": digest(artifact),
            "artifactKind": "MODEL",
        },
        "model": model_section,
        "dependencies": dependencies,
        "transitions": [],
        "candidateFingerprint": digest(
            {
                "domain": MANIFEST_FINGERPRINT_DOMAIN,
                "candidateId": candidate_id,
                "candidateKind": "MODEL",
                "artifact": artifact,
                "dependencies": dependencies,
                "model": model_section,
            }
        ),
    }
    validate(manifest, MANIFEST_SCHEMA)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-model", required=True)
    parser.add_argument(
        "--model-asset",
        action="append",
        required=True,
        metavar="NAME=sha256:...",
        help="Model asset fingerprint (repeatable).",
    )
    parser.add_argument(
        "--reproducibility",
        required=True,
        help="JSON object with the I5-41 reproducibility binding "
        "(trainingCodeFingerprint, datasetFingerprint, baseModelFingerprint, "
        "dependencyLockFingerprint, tokenizerFingerprint, seed, "
        "hyperparameters, runtime, nativeLibraries, deterministic).",
    )
    parser.add_argument("--training-dataset-fingerprint")
    parser.add_argument("--training-implementation-fingerprint")
    parser.add_argument("--base-authority-fingerprint", required=True)
    parser.add_argument("--evaluator-implementation-fingerprint", required=True)
    parser.add_argument("--created-at", required=True)
    parser.add_argument("--registry-root", type=Path)
    parser.add_argument("--tenant-scope", default="TENANT_LOCAL")
    parser.add_argument("--tenant-ref")
    parser.add_argument("--scope-authorization-ref")
    parser.add_argument(
        "--license-provenance",
        help="JSON object recording model licenses, data-use restrictions, and redistribution constraints",
    )
    args = parser.parse_args(argv)

    manifest = build_model_candidate_manifest(
        base_model=args.base_model,
        model_asset_hashes=dict(_parse_asset_hash(i) for i in args.model_asset),
        reproducibility=json.loads(args.reproducibility),
        training_dataset_fingerprint=args.training_dataset_fingerprint,
        training_implementation_fingerprint=args.training_implementation_fingerprint,
        base_authority_fingerprint=args.base_authority_fingerprint,
        evaluator_implementation_fingerprint=args.evaluator_implementation_fingerprint,
        created_at=args.created_at,
        registry_root=args.registry_root,
        tenant_scope=args.tenant_scope,
        tenant_ref=args.tenant_ref,
        scope_authorization_ref=args.scope_authorization_ref,
        license_provenance=json.loads(args.license_provenance) if args.license_provenance else None,
    )
    print(
        json.dumps(
            {
                "candidateId": manifest["candidateId"],
                "candidateFingerprint": manifest["candidateFingerprint"],
                "state": manifest["state"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
