# Native Model Lifecycle — Mandatory Surface Closure Matrix

**Scope:** `libs/java/common/src/main/java/com/ghatana/media/common/lifecycle/NativeModelLifecycle.java` and its direct JUnit test. This is one file-scoped review for the local disposer-failure lifecycle contract under `media.dev.shared-engine-consolidation`. It is not an audit of all model engines, provider admission, or service authentication.

**Sources inspected:** root `AGENTS.md`; no nested `AGENTS.md` or `.github` instruction files; `libs/java/common/README.md`; `docs/surfaces/libs-java-common/README.md`; `docs/development/remaining-work.json`; `NativeModelLifecycle.java`; `NativeModelLifecycleTest.java`; direct production consumers and current common-module test/build evidence.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | `AGENTS.md`, source plan, no nested guidance | Lane-A engineering is allowed; task/admission status must remain distinct. | Preserve all current dirty state and statuses. |
| Recursive inventory | reviewed-no-gap | Exact implementation file and direct `NativeModelLifecycleTest` | File-scope boundary has one owning test class. | No unrelated pool or provider files added. |
| Surface kind/build unit | reviewed-no-gap | `libs/java/common`, `:services:media:libs:java:common` | Public Java lifecycle helper in the common module. | Focused JUnit, then owning module check. |
| Ownership/boundary/placement | reviewed-no-gap | `docs/surfaces/libs-java-common/README.md`; Whisper/Piper call sites | Shared Media owns only the native-use lease fence; model/provider policy stays with modality owners. | Keep shared helper generic. |
| Vision/non-goals/consumers | implemented | Existing surface README; expanded class intent comment | The file-level comment previously stated purpose only. | Name consumers, non-goals, and change policy in the file. |
| Architecture/design | reviewed-no-gap | Fair `ReentrantReadWriteLock`, per-thread lease count, idempotent `Lease.close`, one-shot `close` | Active calls drain before disposer; close by lease owner fails promptly. | Make disposer-failure terminal behavior explicit and test it. |
| Documentation/examples | implemented | `libs/java/common/README.md`, `docs/surfaces/libs-java-common/README.md`, in-file intent | Shared docs already describe one-shot disposal but did not spell out thrown-disposer behavior. | Add the exact behavior to file intent; no runnable native model example is appropriate without licensed model input. |
| Requirements/current-state alignment | gap-found | Surface README states one-shot disposal; source marks `closed` before invoking disposer; tests lacked this adverse case. | Correct runtime behavior existed but its safety contract had no regression. | Add focused exception/closed-state test. |
| Gap/backlog classification | gap-found | Local lifecycle contract and test inventory | Current-state test-coverage gap, not a new engine feature. | Implement the missing regression only. |
| Feature completeness | reviewed-no-gap | `NativeModelLifecycle` acquire/close/lease paths | Supported scope is lifecycle fencing, not model loading or disposal recovery. | Keep the helper small and one-authority. |
| Correctness | gap-found | `close` marks closed before `disposer.run()` and unlocks in `finally` | A thrown disposer must propagate while preventing future use and avoiding unsafe second disposal. | Assert propagation, rejected later acquire, and no second disposer call. |
| API/contracts/config | reviewed-no-gap | Public constructor, `acquire`, `Lease`, and `close` signatures | No API or configuration change is needed. | Preserve signatures and binary compatibility. |
| Generated/source-of-truth parity | not-applicable | Handwritten source; no generated binding | No generated representation owns this helper. | None. |
| Naming | reviewed-no-gap | `NativeModelLifecycle`, `Lease`, `close` | Names match the lifecycle boundary. | No rename. |
| Duplication | reviewed-no-gap | Search of the scoped package and direct call sites | No duplicate native-use lease fence identified in scope. | Do not add another abstraction. |
| Organization/placement | reviewed-no-gap | `com.ghatana.media.common.lifecycle` | Shared lifecycle code is correctly placed in the common library. | No relocation. |
| Cohesion/coupling | reviewed-no-gap | Class dependencies are JDK concurrency primitives only. | One cohesive state machine with no provider dependencies. | Keep provider-specific disposal outside. |
| Tests/coverage | gap-found | `NativeModelLifecycleTest` covers nesting, ownership, fairness, drain, one-shot success; no throwing-disposer test | Missing adverse regression for the documented one-shot safety contract. | Add one focused test. |
| Compatibility/migration/deprecation | reviewed-no-gap | Existing public method signatures and module ABI | No migration or deprecation needed. | Verify public API check in module `check`. |
| Affected-scope verification | gap-found | Owning module task and existing common-module evidence | New test must execute in both focused selector and module verification. | Evidence plan below. |
| Evidence Generator integration | reviewed-no-gap | This local helper has no registered Evidence Generator collector in its source docs. | JUnit/module test is the owning engineering evidence; no lifecycle score is claimed. | Keep result in task engineering notes only. |
| Missing Evidence Generator capabilities | not-applicable | No repository-native collector is specified for this file-scope unit. | No missing collector is needed to prove this local regression. | No artifact or collector added. |
| Security | reviewed-no-gap | Failed/uncertain native disposal must not reopen use. | Close remains fail-closed if disposer throws. | Regression guards the no-reuse behavior. |
| Privacy/data governance/compliance | not-applicable | Helper handles no user data or identity. | No privacy state is owned here. | None. |
| Observability/diagnostics | reviewed-no-gap | Disposer exceptions propagate to the caller. | No new diagnostics channel is defined by the current contract. | Preserve original thrown exception. |
| Reliability/resilience/operability | gap-found | One-shot state transition plus disposer exception path | Retrying unknown partial native destruction could double-close a native handle. | Explicitly preserve terminal closed state and test at-most-once invocation. |
| Performance/scalability | reviewed-no-gap | One fair read lock per active use; no change planned. | The test change adds no hot-path work. | No benchmark change required. |
| Accessibility/internationalization | not-applicable | Backend Java concurrency helper. | No user interface or localized string contract. | None. |
| AI/ML applicability | not-applicable | Helper fences native resources without selecting models or evaluating inference. | Model quality and admission remain modality-owner concerns. | None. |
| Build/dependency/release readiness | reviewed-no-gap | Existing Gradle module and dependency graph | No dependency or release artifact changes. | Run owning module `check`; do not claim release readiness. |
| Dependency/supply-chain/licensing | reviewed-no-gap | JDK-only implementation and existing JUnit dependencies | No new supply-chain or model-license inputs. | No dependency change. |
| Repeatability/reproducibility | gap-found | Deterministic counter/exception test seam is sufficient | Failure behavior needs stable assertions. | Assert exact invocation count and closed-state result. |
| Convergence/stability | reviewed-no-gap | This path-scoped audit is not a convergence score. | No whole-module or product convergence claim follows. | Keep `media.dev.shared-engine-consolidation` OPEN. |

## Finding

**ID:** NML-01<br>
**Priority:** P2<br>
**Area:** Correctness, tests/coverage, reliability<br>
**Where:** `NativeModelLifecycle.close(Runnable)` and `NativeModelLifecycleTest`<br>
**Problem/root cause:** The code transitions to closed before disposal and propagates disposer failure, but tests did not lock the safety behavior. Re-running an uncertain native disposer can double-close a partially destroyed handle; allowing another acquire can use a partially destroyed model.<br>
**Production-ready fix:** Document and test the existing terminal close behavior. Do not add a retry path or change the public API.<br>
**Acceptance:** The first disposer exception is propagated unchanged; future `acquire()` fails with the configured closed message; another `close()` does not invoke the disposer again.<br>
**Path-scoped tests:** `NativeModelLifecycleTest.disposerFailureRemainsClosedAndIsNotRetried`; then the full `:services:media:libs:java:common:check`.<br>
**Path-scoped evidence:** exact Gradle task results with zero failures/errors; `git diff --check`.<br>
**Evidence Generator enhancement:** none; existing JUnit and Gradle check prove this local invariant.<br>
**Classification/convergence impact:** current-state test-coverage gap. This establishes one local native-lifecycle failure invariant only; shared engine consolidation remains OPEN pending other engineering and owner/provider gates.

## Evidence plan

1. `./gradlew --offline --no-daemon --no-parallel --max-workers=1 -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:libs:java:common:test --tests com.ghatana.media.common.lifecycle.NativeModelLifecycleTest --rerun-tasks`
2. `./gradlew --offline --no-daemon --no-parallel --max-workers=1 -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:libs:java:common:check --rerun-tasks`
3. `git diff --check`

## Final closure decision

`not-converged-actionable` — this matrix closes only the local disposer-failure regression. The task and all lifecycle/admission statuses remain unchanged.
