# Delivery export destination acknowledgment — evidence plan

**Status:** planned local verification; no canonical Evidence Generator run is registered for this Media module scope. This plan is not a score, receipt, owner acknowledgment, or task-status change.

## Exact scope and source fingerprint

- **Surface:** `modules/production/delivery` (`:services:media:modules:production:delivery`).
- **Task:** `media.dev.delivery-export-destination-ack` (still OPEN in `docs/development/REMAINING-WORK.md`).
- **Implementation/test inputs:** `modules/production/delivery/build.gradle.kts`, `README.md`, `docs/README.md`, `src/main/java/com/ghatana/media/production/delivery/{DeliveryOperationStore,InMemoryDeliveryOperationStore,MediaDeliveryEngine}.java`, and `src/test/java/com/ghatana/media/production/delivery/MediaDeliveryEngineTest.java`.
- **Owning requirements context:** the task section in `docs/development/REMAINING-WORK.md`, the delivery entries under `.product-experience/pdp-1-domain-data/`, and the relevant module paths. These are context inputs, not edited status records.
- **Scope fingerprint command:**

```bash
find modules/production/delivery -type f \
  ! -path '*/build/*' -print0 | sort -z | xargs -0 shasum -a 256
```

The command intentionally fingerprints only this module's source, test, build metadata, and documentation. The matrix and this evidence plan are review outputs and are excluded to avoid self-reference. Record the complete per-file output with any native evidence run; do not treat a manual digest as canonical provenance.

Observed local input hashes for this review:

| Input | SHA-256 |
|---|---|
| `modules/production/delivery/README.md` | `6eb53ec7ed0662fd01d5bc56a8b8b2652a63693550f2b786dc18afcce74b029b` |
| `modules/production/delivery/build.gradle.kts` | `b015ef64cca880590fe92b82e6ef4e7b95aa0e29936893b2bbae45d614a5700d` |
| `modules/production/delivery/docs/README.md` | `4128679658b535f8f4b53653b389c2c8a7791463e444baef44cbaa36766ac8f7` |
| `DeliveryOperationStore.java` | `d2bdaeaea6492b71cc997c7a229406de63065cc17f022cc6f09f2866181b23e4` |
| `InMemoryDeliveryOperationStore.java` | `80c70503bfc1b22ab39f1265d16a723f33ccf4f58c792d11b8431790dea9e258` |
| `MediaDeliveryEngine.java` | `7895a8ec188f868768a2a3690816a047130c686e312526636adc8dc3ea7f5de2` |
| `MediaDeliveryEngineTest.java` | `ebbff9b74cbe2f314e23ccba15ba769418dbda1303160321d75111e8472ea841` |

These are local per-file input hashes, not a canonical Evidence Generator fingerprint or convergence artifact.

## Selected local checks

Run from the Media repository root:

```bash
./gradlew :services:media:modules:production:delivery:test --rerun-tasks --no-daemon --console=plain
./gradlew :services:media:modules:production:delivery:check --rerun-tasks --no-daemon --console=plain
git diff --check -- modules/production/delivery docs/implementation/verification/delivery-export-destination-ack-mandatory-surface-closure-matrix-2026-11-10.md docs/implementation/verification/delivery-export-destination-ack-evidence-plan-2026-11-10.md
```

The focused Gradle test task compiles the module and runs the entire `MediaDeliveryEngineTest` class. It is sufficient for local coordinator behavior because only the delivery module source/test/docs are in scope. The test selector covers exact request scope and duplicate enqueue, fail-closed unsupported destination/store, authorization revocation/currentness, wrong destination and checksum, lost acknowledgment and reconcile-before-resume, state/fence transitions, restart/readback, and receipt validation. It does not execute production provider, launcher, or external destination behavior.

## Required artifacts and provenance

Local run records should include command, exit code, Gradle test XML/HTML output location, executed test count, skip/failure/error counts, input scope fingerprint, and environment/runtime identity. Current test artifacts are Gradle's module `build/test-results/test/TEST-com.ghatana.media.production.delivery.MediaDeliveryEngineTest.xml` and `build/reports/tests/test/`; those generated files are observations only and are not checked in or promoted manually.

Observed in this review: the focused Gradle command exited successfully; the XML reports 45 tests, 0 skips, 0 failures, and 0 errors. `git diff --check` exited successfully for the delivery module and its two verification documents. Gradle emitted an existing Kotlin/JVM target compatibility warning (Java 27 vs Kotlin 26 in build logic) and deprecation notice; neither blocked this module test run.

The initial module check reported 21 public types without ownership entries. The coordinator mapped the package family to existing `MEDIA-REQ-CAP-ARTIFACT` in root `config/intentional-public-api.json`, then reran both production module checks serially. Delivery tests pass 45/45 and `:services:media:modules:production:delivery:check` now PASSES with all 21 API types aligned. The earlier check failure is resolved locally; no verifier was bypassed. Checkstyle style warnings are non-fatal. This does not establish destination acceptance or production delivery.

Canonical convergence additionally needs an owning Lifecycle Evidence Generator producer binding and schema-backed artifacts for: source/scope fingerprint, affected unit, selected tests/commands, compile/test results, contract/boundary review, docs/examples, feature completeness, security/operability, repeatability, missing evidence, gates, score inputs/provenance, and convergence result. No delivery-specific producer/collector/scope registration was found in the current Media or Lifecycle source trees. The plugin `discover-evidence-tools.mjs` is a locator only and cannot generate canonical evidence. Do not fabricate or hand-write `.evidence/**` records.

## Canonical evidence blockers and owner work

1. Lifecycle Evidence Generator owner must register this exact path-scoped Media surface, collectors, schemas, provenance policy, and owner-ACK gate. The gate must reject local fixture receipts as external acceptance evidence.
2. Delivery contract owner must define the immutable result reference, trusted request fingerprint, exact target/artifact version/destination binding, acknowledgment authority, and evidence references.
3. Runtime/provider owner must supply durable production wiring and an admitted destination that authenticates readback, enforces stale dispatch fences, deduplicates exact chunk identities, and reconciles lost acknowledgment without duplicate effects.
4. Once those prerequisites exist, execute focused engine/store tests and admitted destination restart/failure tests, then run two canonical runs at the same semantic scope to prove repeatability. Compare scope, selected tests, schema validation, score inputs, gates, and resulting provenance through the native validator.

## Coverage mapping and non-selected work

| Review area group | Local proof | Additional canonical proof |
|---|---|---|
| Scope/build/tests/correctness/repeatability | Gradle module test plus exact module fingerprint and output files | EG artifacts with input and tool fingerprints, test trace and repeatability result |
| API/boundary/docs/generated parity | Source and docs review; no generated source in module | EG contract/docs/boundary collector and schema validation |
| Security/privacy/reliability | Local fail-closed and fixture regressions | Owner-authenticated authority plus real destination fence/replay/failure evidence |
| Performance/observability | Bounded artifact/chunk constants; runtime metrics are not owned by this library | Admitted destination measurements and host-level observability evidence; applicability explicitly N/A where appropriate |
| Feature completeness/convergence | Open task and explicit missing-gate record | Owner ACK proof, production adapter admission and canonical gate results |

Not selected: repository-wide Gradle tests, launcher/provider build/test tasks, production dispatch, destination network activity, qualification/status mutation, commit or publication. They are out of this local module review and would require their owners' contracts/admission. No convergence score or task completion is claimed from the selected local checks.
