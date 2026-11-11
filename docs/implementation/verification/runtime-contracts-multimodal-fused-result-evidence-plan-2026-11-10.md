# Evidence plan: runtime-contracts multimodal fused result

Date: 2026-11-10<br>
Scope: `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java`, nested `MultimodalOperationSpec.fusedResult`; direct test `MultimodalOperationSpecTest`; direct consumers in multimodal-service and launcher restart reconciliation.<br>
Purpose: plan verification for findings F-01 through F-05 in the companion [Mandatory Surface Closure Matrix](runtime-contracts-multimodal-fused-result-mandatory-surface-closure-matrix-2026-11-10.md): internal child lineage, recovery authority, typed product-output boundary, deterministic bounded snapshots, and Evidence Generator support. This plan does not add a result schema, operation version, owner semantic, or status.

## Current evidence state

Focused local verification was run after the audit. The repository still has no local `tools/` directory, `discover-evidence-tools.mjs`, or path-scoped Evidence Generator command. `docs/EVIDENCE.md` assigns convergence artifacts and score authority to the Lifecycle-owned generator and prohibits hand-authoring `.evidence/**`.

The internal projection still does not carry child artifact/version identity, and the generic fused map is not the PDP-1 closed typed output; the legacy family still has no shared aggregate. Two local correctness findings are now implemented: canonical child projection/digest is deterministic and bounded, and restart recovery leaves an all-completed child set unresolved when no fresh authenticated owner-authority route is available. The 8,192-character child-map budget now includes timing; non-timing overflow fails closed, timing omission/type errors are explicit undetermined states, and the full durable child result is digested through a bounded streaming canonical encoder.

**Observed local verification (2026-11-10):** `MediaJobRequestFingerprintTest` 6/6 and `MultimodalOperationSpecTest` 21/21; `DelegatingMultimodalProviderTest` 34/34; `MediaRuntimeMultimodalRestartTest` 10/10; `MediaMultimodalParentChildRestartPostgresIT` 4/4. All reported zero failures, errors, and skips. `node --test tests/pdp1-output-producer-contract-mappings.test.mjs` passes 3/3, and `node scripts/check-product-definition-authority.mjs` validates 375 portable records and 30 journey definitions. The Postgres test initially failed two source-free calls because they omitted the authenticated principal; the calls now use the suite's exact tenant/principal fixture, and all four tests pass. This fixture does not admit a production provider or establish real source authority.

Existing tasks remain OPEN in `docs/development/remaining-work.json` under `media.dev.multimodal-child-orchestration` and `media.dev.multimodal-grounding-and-quality`; owner/source decisions remain separate.

## Scope and fingerprint

Owning Gradle unit: `:services:media:runtime-contracts`. Direct consumer units: `:services:media:modules:intelligence:multimodal-service` and `:services:media:launcher`. Source authorities: `.product-experience/pdp-1-domain-data/operations.yaml` exact multimodal typed output and family disposition. Do not expand to the whole repository absent an unexpected public consumer or build/dependency change.

For each eventual run, record:

1. `git rev-parse HEAD`, `git status --short`, Gradle/JDK versions, OS/architecture, and exact command line.
2. SHA-256 for the source, direct test, build file, scoped surface README, and this plan/matrix; include changed-file hashes and the source diff when implementation occurs:

   ```sh
   shasum -a 256 \
     runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java \
     runtime-contracts/src/test/java/com/ghatana/media/runtime/MultimodalOperationSpecTest.java \
     runtime-contracts/build.gradle.kts \
     launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java \
     launcher/src/test/java/com/ghatana/media/launcher/MediaRuntimeMultimodalRestartTest.java \
     .product-experience/pdp-1-domain-data/operations.yaml \
     docs/surfaces/runtime-contracts/README.md \
     docs/implementation/verification/runtime-contracts-multimodal-fused-result-mandatory-surface-closure-matrix-2026-11-10.md \
     docs/implementation/verification/runtime-contracts-multimodal-fused-result-evidence-plan-2026-11-10.md
   ```

3. Canonical scope ID: `media.runtime-contracts.multimodal-fused-result`; normalized scope paths are the files above plus direct consumer source/test paths listed below. This ID is a local plan label, not a Lifecycle authority or new task ID.
4. On repeat run, use the same source revision, environment, selectors, and plan. A changed fingerprint or environment starts a distinct comparison; do not aggregate its score with a prior run.

## Ordered local verification

Run only after the implementation and focused tests are present.

| Order | Command | Proves | Matrix areas |
|---|---|---|---|
| 1 | `./gradlew :services:media:runtime-contracts:compileJava` | Contract compiles against existing types; no API/import/build break. | surface-kind-build-unit, api-contracts-config, build-dependency-release-readiness |
| 2 | `./gradlew :services:media:runtime-contracts:test --tests com.ghatana.media.runtime.MultimodalOperationSpecTest` | Internal child lineage only after its representation is owner-compatible; exact clock grounding; malformed/out-of-duration abstention; canonical key iteration; over-budget behavior fails closed; deterministic replay equality. | requirements-current-state, feature-completeness, correctness, tests-coverage, reliability-resilience-operability, repeatability-reproducibility |
| 3 | `./gradlew :services:media:modules:intelligence:multimodal-service:compileJava` | Direct live provider consumer compiles against additive result output. | ownership-boundary-placement, api-contracts-config, generated-source-of-truth-parity, cohesion-coupling |
| 4 | `./gradlew :services:media:modules:intelligence:multimodal-service:test --tests com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProviderTest` | Live child-result composition/replay compatibility and no false finality regression. | correctness, tests-coverage, compatibility-migration-deprecation, security, reliability-resilience-operability |
| 5 | `./gradlew :services:media:launcher:compileJava` | Direct restart reconciler compiles against the internal projection and any existing authority interface used by recovery. | ownership-boundary-placement, api-contracts-config, build-dependency-release-readiness, security |
| 6 | `./gradlew :services:media:launcher:test --tests com.ghatana.media.launcher.MediaRuntimeMultimodalRestartTest` | Exact source/child binding, completed children remaining UNKNOWN without a fresh authenticated authority route, no redispatch, and replay preservation. A positive current-authority recovery path remains unavailable and unverified. | compatibility-migration-deprecation, tests-coverage, security, privacy-data-governance-compliance, reliability-resilience-operability, repeatability-reproducibility |
| 7 | `node --test tests/pdp1-output-producer-contract-mappings.test.mjs` | Re-read existing PDP-1 closed typed output and producer mappings; this does not define or admit a family aggregate. | requirements-current-state, api-contracts-config, generated-source-of-truth-parity, compatibility-migration-deprecation |

Step 7 is a source-contract check, not runtime evidence or permission to construct a new family output. The legacy family explicitly has no shared aggregate contract; stop before product-output implementation if an exact capability operation, result artifact/version persistence path, or owner decision is missing. If source-level verification reveals additional direct dependents or public serialization constraints, extend the affected set before treating these commands as sufficient. Full repository tests are not selected by default; use them only if a wider build/dependency contract changes or the affected consumers cannot be resolved.

## Expected local artifacts

Retain generated outputs from the commands, never fabricate them:

- JUnit XML and Gradle logs for the focused contract and consumer tests, including pass/fail/error/skip totals.
- Compiler output for the three owning/direct-consumer units.
- Exact source diff and changed-file list; SHA-256 scope fingerprint and environment metadata above.
- A fixture assertion record showing internal child source identity equals exact bound `ProcessingJob`/spec values, plus identical same-input reconstruction. This must not be accepted as the PDP-1 product result.
- A launcher record proving completed persisted children remain unresolved and are not redispatched when startup lacks a fresh authenticated principal/current authority route. Current allow/revoke/stale/unavailable recovery fixtures are not implemented because no owner-authorized restart route exists in this boundary.
- A typed-output boundary report distinguishing the generic internal fused map from `.product-experience/pdp-1-domain-data/operations.yaml#media.typed-output.source-grounded-cross-modal-result-with-provenance-and-uncertainty`; a product artifact needs its own persisted artifact/version identity and closed envelope.
- A bounded-snapshot record using equivalent maps with reversed insertion order and over-budget fields; output/digest must be repeatable, and dropped fields must not masquerade as a complete successful projection.
- Direct consumer assertions only if internal behavior changes; preserve v1 spec compatibility and source-clock semantics.

These local artifacts establish only internal deterministic code behavior against local fixtures. They do not establish current real source authorization, real provider effects, source-owner clock/frame-map authority, rights/consent, licensing, calibration, production admission, a shared multimodal family aggregate, or external qualification.

## Evidence Generator and owner gates

Proposed missing capability: `EG-MEDIA-RUNTIME-CONTRACTS-MULTIMODAL-FUSED-RESULT-PATH-SCOPE-001`. The owning Lifecycle Evidence Generator should accept this normalized scope and local test outputs, then produce the source fingerprint, selected-test/affected-unit manifest, collector records, typed-output/finality and current-authority gate inputs, schema-validation result, score inputs and provenance, gate results, same-input repeatability result, missing-evidence report, and convergence decision. Its schema, score, receipts, and `.evidence/**` output must remain generator-owned. It must not treat child artifact/version references as a materialized product result.

No canonical Evidence Generator command or artifact directory is available in this checkout. The plan cannot be treated as evidence-generator execution or convergence proof until the owner route and exact command/run ID are supplied. Keep the following open:

- Owner-native generator route, collectors, schemas and gates for this scope.
- Current authority recheck semantics and evidence for restart recovery, owned by the existing PDP/source-authorization boundary; no synthetic or stale consent may be introduced.
- Exact capability-specific output contract and persisted result artifact/version mapping. The legacy family defines no shared aggregate result; product meaning belongs to PDP-1/source owners and is outside this runtime-contracts implementation slice.
- Deterministic completeness semantics for the bounded internal child snapshot. Do not add truncation or partial-result fields until their owner contract exists.
- Real rights-bound, admitted STT/Vision child results and authentic provider evidence.
- Owner-authorized exact frame mapping and clock mapping.
- Rights/consent authority, calibration/quality evidence, production admission, and durable qualified parent receipt/readback.

Do not run or record release, acceptance, task completion, or convergence status from these local commands alone.
