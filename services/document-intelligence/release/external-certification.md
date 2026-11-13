# External Certification — Preparation Package (I6-48)

**Status: preparation manifest only.** This document enumerates the authority
artifacts an external certifier needs to audit the document-intelligence
worker. It does **not** assert, imply, or claim any certification — no
external assessment has been performed or scheduled. The `release.external-certification`
capability remains `NOT_QUALIFIED` / `consumerAdmission: DENIED` with
`futureOwner: DEFERRED_TO_EXTERNAL_CERTIFICATION` until a real certification
campaign produces evidence.

All paths are relative to the service root (`services/document-intelligence/`).

## Authority artifacts

| Artifact | Path | Fingerprint role |
| --- | --- | --- |
| Freeze-set closure authority | `docs/evidence/document-intelligence-freeze-set.v1.json` | Binds the sealed increment3/4/4A evidence: run-manifest sha256s, material-scope file hashes, leaf-dependency catalog digest, and cross-check statuses. The certifier verifies every `status: PASS` and re-digests the named files. |
| Strict receipts | `docs/evidence/increment3-strict-receipt.json`; run manifests under `evaluation/results/*/run-manifest.json` and `evaluation/increment4a/results/*/run-manifest.json` | Each `run-manifest.json` carries `manifestFingerprint` (sha256 over the manifest with that field omitted) plus per-artifact `sha256:` digests. A directory without `status: COMPLETE` is unpublished debris, not evidence. |
| Capability registry | `capabilities/document-intelligence-capabilities.yaml` | Authority for admission: `QUALIFIED + ALLOWED` ⇔ advertised; non-qualified ⇔ `DENIED` with `futureOwner`. Verified by `scripts/check_capability_registry.py` against accepted/excluded authority artifacts. |
| Accepted/excluded authority | `capabilities/increment4a.accepted.json`, `capabilities/increment4a.runtime-authority.json` | Evidence side of the registry check: which capability ids accepted authority artifacts advertise and which are explicitly excluded. |
| Proof graph | `verification/document-intelligence-proof-graph.yaml` | Leaf/dependency authority: which evidence leaves exist and what each depends on; the certifier replays `scripts/check_proof_graph.py`. |
| Material scopes | `docs/evidence/increment*-material-scope.v1.json` | Declares which files may invalidate behavioral evidence (semanticMaterial, executionEnvironment) versus evidence/status files that never may. Verified by `scripts/check_material_scopes.py`. |
| Offline bundle manifest | `deployment/sbom/offline-bundle-manifest.v1.json` | `manifestFingerprint` binds every model/native asset sha256, the uv.lock digest, application-source digests, and policy-ref digests. Regenerate with `deployment/build_offline_bundle.py --check`. |
| SBOM | `deployment/sbom/sbom.v1.json` | CycloneDX-lite component inventory (uv.lock packages, model artifacts, native packages) — each pinned by version and/or SHA-256. Verified by `deployment/sbom.py --check`. |
| Package receipt | `deployment/sbom/package-receipt.v1.json` | `packageFingerprint` over sorted (path, sha256) pairs proves reproducible packaging; `receiptFingerprint` covers the receipt minus that field. |
| Deployment policies | `deployment/deployment-gates.v1.yaml`, `deployment/activation.v1.yaml`, `deployment/vulnerability-policy.v1.yaml`, `deployment/operational-envelope.v1.yaml` | Declared gate list, progressive activation + rollback plan, severity policy, and operational envelope. Their file digests are bound inside the offline-bundle manifest `policyRefs`. |
| Release-readiness manifest | `release/readiness/readiness-manifest.v1.json` | `manifestFingerprint` binds per-gate receipt fingerprints, capabilityAdmission sets, and the sbom/bundle/envelope fingerprints. Verified by `scripts/build_release_readiness.py --check`; `status: READY` requires every required gate PASS. |
| Vulnerability report | output of `scripts/check_vulnerabilities.py --scan <scan.json>` | `policyFingerprint` binds the severity policy; any BLOCKED finding fails the gate. |

## Verification order for a certifier

1. Re-run `scripts/check_material_scopes.py` — scope coverage and disjointness.
2. Re-run `scripts/check_capability_registry.py` — admission consistency.
3. Re-run `deployment/sbom.py --check` and `deployment/build_offline_bundle.py --check` — asset inventory integrity.
4. Re-run `scripts/build_release_readiness.py --check` — gate receipts unmodified, fingerprints bound, required gates PASS.
5. Spot-verify any `sha256:` value against the named file bytes.

## Explicit non-claims

- No external certification exists today; this package is the evidence set a
  certifier would consume.
- `campaignEvidenceComplete` gates release readiness on increment6 campaign
  receipts that are produced by the qualification wave, not by this document.
- Nothing here modifies sealed increment3/4/4A authority; the preparation
  package is additive.
