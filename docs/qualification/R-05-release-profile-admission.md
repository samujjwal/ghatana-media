# R-05 release profile and admission record

**Profile selected:** `ghatana-media.internal-validation-only` version 1  
**Selection scope:** internal, noncommercial validation, as authorized by the October 8, 2026 owner execution plan.  
**Current result:** profile definition exists; no immutable release candidate is bound and no production gate is admitted.

The machine-readable profile is [internal-validation-only.json](../../config/release/internal-validation-only.json). It permits local source validation, deterministic contract/fixture tests, isolated non-production integration tests, and internal evidence review. It disables public distribution, commercial use, external deployment, consumer cutover, codecs, models/weights, external providers, external effects, and release-only dependencies by default.

The profile is not a product release candidate. Its source revision, build digest, and SBOM digest are intentionally null until an immutable candidate is built. A test passing under this profile cannot establish provider admission, model or codec qualification, external licensing, Lifecycle evidence, deployment readiness, or phase acceptance.

## Production profile admission checklist

Create a separate versioned production profile only after each selected capability has evidence tied to the exact immutable build and deployment configuration. The release owner must record the evidence reference and decision for every applicable gate below; an inapplicable gate requires a reason and accountable owner.

| Gate | Required evidence before admission | Current status |
|---|---|---|
| Source and build provenance | Immutable source revision, reproducible build record, artifact digest, and signed provenance | `NOT_ADMITTED` |
| Shipped inventory | Complete runtime SBOM covering source packages, native binaries, models, fonts, and assets | `NOT_ADMITTED` |
| Rights and licenses | Artifact-specific license terms and authorized distribution decision; patent review where applicable | `NOT_ADMITTED` |
| Codec profiles | Exact codec/container behavior, malformed-input/security, performance/hardware, and rights qualification | `NOT_ADMITTED` |
| Models and weights | Exact model/weight and dataset identity, modality/language/quality results, safety and rights review | `NOT_ADMITTED` |
| Providers and integrations | Versioned public contracts, admitted provider identity, authenticated negative/positive integration outcomes | `NOT_ADMITTED` |
| Security and privacy | Deployment threat model, tenant isolation, retention/erasure, secrets, and external-effect controls | `NOT_ADMITTED` |
| Runtime operations | Target environment, resource bounds, durability/failure behavior, telemetry, throughput and SLO evidence | `NOT_ADMITTED` |
| Consumers and compatibility | Named consumer inventory, versioned migration plan, parity evidence, rollback procedure and test | `NOT_ADMITTED` |
| Deployment and cutover | Environment-specific deployment result, operational owner, rollback authority, and explicit cutover approval | `NOT_ADMITTED` |
| Independent certification | Signed review for each required specialist, accessibility, domain, security, or legal acceptance | `NOT_ADMITTED` |

No profile may promote a dependency from `NOT_ADMITTED` based on a declaration, local unit test, package presence, or owner policy text alone. Production admission requires a new authorized release decision over the completed evidence. This page records the gate contract and current gaps; it records no approval or qualification result.
