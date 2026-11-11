# Media Common Library — Mandatory Surface Closure Matrix

**Scope:** `libs/common` (`:services:media:libs:common`), with its direct dependency on `libs/java/common` inspected for ownership and ABI impact. This is a path-scoped review for `media.dev.shared-engine-consolidation`; it is not a review or convergence claim for all shared engines, all four service auth paths, native models, or provider admission.

**Sources reviewed:** root `AGENTS.md`; no nested `AGENTS.md` or `.github` instruction files; `libs/common/README.md`; `docs/surfaces/libs-common/README.md`; `libs/java/common/README.md`; `docs/surfaces/libs-java-common/README.md`; task register entry; `libs/common/build.gradle.kts`; `ContextAwareBoundedExecutor.java` and all direct production/test callers; current unit/in-process tests. `libs/common/README.md` was created as a root entrypoint and points to the existing surface source document.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | Root `AGENTS.md`; source instructions search found no nested `AGENTS.md` or `.github` guidance. | Keep shared behavior bounded and fail closed; preserve service ownership and ABI. | Follow repo guidance; no status or release work. |
| Recursive inventory | reviewed-no-gap | `libs/common/src/main/java/**`, `libs/common/src/test/java/**`, module build file, both common-surface docs. | `ContextAwareBoundedExecutor` is an existing common/resilience primitive; direct uses are gRPC/service tests and modality services. | Keep inventory/test selectors current. |
| Surface kind/build unit | reviewed-no-gap | `libs/common/build.gradle.kts`; Gradle unit `:services:media:libs:common`. | Java shared library with public package API. | Verify module and directly affected consumers. |
| Ownership/boundary/placement | reviewed-no-gap | `docs/surfaces/libs-common/README.md`; dependency on `:services:media:libs:java:common`; production callsites. | Shared executor owns context propagation and cancellation classification, not service provider finality. | Preserve service-to-library dependency direction. |
| Vision/non-goals/consumers | reviewed-no-gap | `libs/common/README.md`; `docs/surfaces/libs-common/README.md`; `libs/java/common` relationship docs. | Shared transport/resilience behavior is in scope; modality effects, rights authority, and provider qualification stay with services/owners. | Do not infer product authority from the helper. |
| Architecture/design | repaired-locally | `ContextAwareBoundedExecutor.submit`, `Submission.result`, and private `SubmissionResult` in `libs/common/src/main/java/com/ghatana/audio/video/common/resilience/ContextAwareBoundedExecutor.java`; active-worker hostile-mutator regression test. | The prior shared outcome allowed external completion while worker effects could continue. | Internal outcome now has submission-only completion methods; consumer mutators reject, while cancellation preserves the dispatch fence and typed UNKNOWN handling. |
| Documentation/examples | implemented | New `libs/common/README.md` links to `docs/surfaces/libs-common/README.md` and describes scope, APIs, config, usage, tests, and evidence limits. | The module had no root README entrypoint; source-of-truth detail already existed under `docs/surfaces`. | Keep module entrypoint and canonical surface doc aligned. |
| Requirements/current-state alignment | repaired-locally | `media.dev.shared-engine-consolidation` acceptance; `ContextAwareBoundedExecutor` implementation and current consumers. | Current callers observe the operation result; the API no longer permits an unrelated caller to publish a fabricated terminal result. | Keep broader owner, installed-consumer, auth-parity, and host/model qualification evidence open. |
| Gap/backlog classification | reviewed-no-gap | Current task contract and direct consumer search. | The mutability defect blocks correct outcome reporting; this is not a new convenience feature. | Repair in scope; leave broader ownership/qualification follow-ups open. |
| Feature completeness | repaired-locally | `Submission.result()` retains `CompletableFuture<T>`; all direct consumers found use observation (`whenComplete`) or routed cancellation. | Consumer completion, obtrusion, async completion, and timeout mutators are rejected; actual worker success/failure remains observable. | Keep public descriptor and classified cancellation behavior unchanged. |
| Correctness | repaired-locally | Owner-only completion methods and active-worker adversarial test. | External code cannot cause early success/failure unrelated to callable outcome while bounded work continues. | Preserve the single terminal outcome owner and run cancellation classification tests. |
| API/contracts/config | reviewed-no-gap | Public nested `Submission<T>` and `CompletableFuture<T> result()`; no relevant configuration. | Keep the method descriptor and cancellation behavior for ABI/source compatibility. | Reject direct completion/timeout mutators explicitly; do not change return type in this increment. |
| Generated/source-of-truth parity | not-applicable | `libs/common` source/build inventory; this Java helper is handwritten and no generated mirror exists. | No generator or wire schema represents this class. | No generated-file change. |
| Naming | reviewed-no-gap | `ContextAwareBoundedExecutor`, `Submission`, and `SubmissionResult`. | Names identify bounded dispatch and outcome; no rename is needed. | Preserve names and public nesting. |
| Duplication | reviewed-no-gap | Search across `libs/common`, `libs/java/common`, `modules`, and `adapters`. | No second helper with the same submission/cancellation contract was found. | Do not add a parallel executor abstraction. |
| Organization/placement | reviewed-no-gap | `libs/common/.../resilience/ContextAwareBoundedExecutor.java`. | Context/deadline/cancellation behavior belongs in common resilience. | Keep the implementation in this owner module. |
| Cohesion/coupling | reviewed-no-gap | Imports and direct callsites. | The helper owns dispatch state; callers observe typed outcomes and translate them at service boundaries. | No new service or global-state dependency. |
| Tests/coverage | repaired-locally | `ContextAwareBoundedExecutorTest`; `VisionCircuitBreakerResilienceTest`; direct cancellation/deadline selectors for STT, TTS, Vision, and Multimodal listed under verification results. | Added hostile result-mutator coverage. The Vision circuit tests previously expected empty successful detections although `CircuitBreakerVisionEngine` documents and implements retryable `InferenceError` on OPEN; they also reused a 200ms reset window outside the dedicated recovery test. | Retain the documented unavailable outcome, assert no delegate call on OPEN, and use a longer default fixture window with 200ms only for HALF_OPEN recovery. |
| Compatibility/migration/deprecation | reviewed-no-gap | All production callsites use future observation; public return descriptor can stay unchanged. | Rejecting consumer mutation tightens undocumented unsafe behavior while preserving the declared type and read/cancel usage. | No consumer migration expected; verify direct dependents. |
| Affected-scope verification | verified-locally | Full `:services:media:libs:common:test`; direct STT/TTS/Vision/Multimodal cancellation, deadline, finality, and service selectors listed under verification results. | Public descriptor and cancellation route remain stable across direct service consumers. | Use the recorded selectors for any future helper ABI or cancellation change. |
| Evidence Generator integration | not-applicable | Task is a local shared-library code correction; `AGENTS.md` says not to perform formal closure/evidence work. | Unit/in-process tests are sufficient engineering evidence for this behavioral defect; no convergence score is being requested. | Do not write `.evidence/**` or assert formal convergence. |
| Missing Evidence Generator capabilities | not-applicable | No repository-native collector claims caller mutability or executor result provenance. | This path has a directly executable regression test and no formal evidence gate in scope. | Do not add a generic collector for a one-method contract. |
| Security | repaired-locally | Mutable result API before fix; constant-message mutation rejection and active-worker hostile-mutator regression after fix. | A consumer can no longer forge the service-observed outcome or induce false success/failure/retry from an in-flight effect. | Keep the message request-free and preserve cancellation as the only public state-changing route. |
| Privacy/data governance/compliance | reviewed-no-gap | Helper does not inspect or log request content; `libs/common` security/context boundaries. | No new content handling or retention path is introduced. | Keep payloads and secrets out of helper diagnostics. |
| Observability/diagnostics | reviewed-no-gap | Typed gRPC outcomes and bounded helper messages in source/tests. | A rejected consumer mutation should be explicit and contain no request data. | Use a constant safe unsupported-mutation message. |
| Reliability/resilience/operability | repaired-locally | `Submission` lifecycle fence plus private owner completion; `VisionCircuitBreakerResilienceTest` open and half-open cases. | Outcome classification is correct only if the caller cannot publish a competing terminal state. The old circuit tests asserted false success for OPEN and used a short reset for those assertions. | Preserve single-writer completion; assert retryable unavailability without delegate dispatch and keep the short reset only in dedicated recovery coverage. |
| Performance/scalability | reviewed-no-gap | Constant-time result publication; bounded worker ownership is unchanged. | A small read-only view adds no queue or blocking work. | Measure no benchmark unless focused tests reveal a hot-path regression. |
| Accessibility/internationalization | not-applicable | Non-UI Java infrastructure helper. | No user-facing localized content. | N/A. |
| AI/ML applicability | not-applicable | Executor transports callables and contains no model logic. | Deterministic infrastructure behavior is appropriate. | No model integration. |
| Build/dependency/release readiness | reviewed-no-gap | `libs/common/build.gradle.kts`; no dependency or public descriptor change planned. | The module test task is the owning build unit. | Compile and test owning module and direct consumers. |
| Dependency/supply-chain/licensing | reviewed-no-gap | Existing gRPC and platform dependencies in `libs/common/build.gradle.kts`. | No dependency change is required. | Preserve current locked dependencies. |
| Repeatability/reproducibility | reviewed-no-gap | Latch-controlled in-process test design; focused Gradle selectors. | Mutator rejection and worker completion are deterministic without external models/services. | Record profile, command, pass/fail/skip, and current test reports. |
| Convergence/stability | blocked | Open `media.dev.shared-engine-consolidation`; other task requirements include shared ownership, four-service auth parity, cancellation/retry, and native leak qualification. | This local fix cannot prove all shared-engine task acceptance. | Keep task OPEN; continue with owner/installed-consumer evidence and real host qualification separately. |

## Finding COM-01 — consumer can forge a worker outcome

- **Priority:** P1; **areas:** correctness, security, reliability.
- **Where:** `libs/common/src/main/java/com/ghatana/audio/video/common/resilience/ContextAwareBoundedExecutor.java`, `Submission.result()` and the private `SubmissionResult`.
- **Problem:** the same `CompletableFuture` is both the executor's terminal result and a public mutable object. A caller can complete it before work actually exits; the task still runs but observers see a false terminal result.
- **Root cause:** the dispatch/cancellation state is fenced, but result publication authority is not separated from result observation.
- **Production-ready fix:** retain the public `CompletableFuture<T>` descriptor and cancellation routing while preventing consumer `complete`, `completeExceptionally`, `obtrude*`, `completeAsync`, `orTimeout`, and `completeOnTimeout` from mutating the executor-owned outcome. Internal completion must bypass only the consumer-facing mutation guard.
- **Acceptance criteria:** hostile attempts cannot publish early success/failure or cancel the worker's terminal classification; actual callable success/failure remains observable; direct result cancellation still routes through `Submission.cancel` and preserves queued/no-effect versus started-effect UNKNOWN semantics.
- **Path-scoped tests:** new `ContextAwareBoundedExecutorTest` with a held worker and each mutator; existing `RpcDeadlineServerInterceptorTest` and `RpcDeadlineGrpcStackIntegrationTest` for timeout/cancel/retry behavior.
- **Path-scoped evidence:** full `:services:media:libs:common:test`; direct STT/TTS/Vision consumers affected by public helper semantics; no external provider or model execution.
- **Evidence Generator enhancement:** none for this local behavioral contract; no convergence scoring is claimed.
- **Classification:** current-state correctness/security gap.
- **Convergence impact:** closes one shared cancellation-result integrity defect only; does not complete `media.dev.shared-engine-consolidation` or qualify native/provider behavior.

## Finding COM-02 — circuit-breaker tests disagree with the owner contract

- **Priority:** P2; **areas:** tests/coverage, reliability/resilience/operability.
- **Where:** `libs/common/src/test/java/com/ghatana/audio/video/common/resilience/VisionCircuitBreakerResilienceTest.java`, default reset timeout and OPEN-circuit assertions.
- **Problem:** the old tests expected an empty successful result even though `CircuitBreakerVisionEngine` explicitly defines OPEN as retryable unavailability; a 200ms reset was also shared with tests asserting OPEN.
- **Root cause:** test expectations did not follow the owner implementation, and fixture timing did not isolate stable OPEN assertions from HALF_OPEN recovery.
- **Production-ready fix:** assert `InferenceError.isRetryable()` and exactly three delegate calls on OPEN, retaining the rejection metrics check; use a 30s default fixture window and configure 200ms only in the explicit recovery test. No production fallback or weakened assertion.
- **Acceptance criteria:** OPEN assertions verify typed retryable unavailability without delegate invocation; rejection metrics remain covered; the HALF_OPEN probe still proves the breaker closes after recovery.
- **Path-scoped tests:** isolated `VisionCircuitBreakerResilienceTest` and full `:services:media:libs:common:test`.
- **Path-scoped evidence:** isolated class selector plus full module result; zero failures/errors.
- **Evidence Generator enhancement:** none; this is a deterministic unit-test fixture correction.
- **Classification:** current-state test reliability gap.
- **Convergence impact:** stabilizes common-library verification only; no circuit-breaker production semantics or provider admission changes.

## Evidence plan

1. Add deterministic adversarial tests proving every external terminal mutator is rejected without completing the owner future.
2. Run the full common-library test suite with `DEV_SOURCE_COMPOSITE` and current cached dependencies.
3. Run direct STT/TTS/Vision/Multimodal helper consumer selectors for cancellation/deadline behavior where their modules own those callsites.
4. Run the isolated circuit-breaker test class and full common module suite to confirm retryable OPEN semantics, rejection metrics, half-open recovery, and stable reset-window behavior.
5. Check module surface docs, test command references, and `git diff --check`.
6. Report exact results and retain task state OPEN for unaddressed shared ownership, four-service auth parity, retries under cancellation, and real native leak/provider/host qualification.

## Verification results

- Isolated `VisionCircuitBreakerResilienceTest`: PASS, 5/5 tests.
- Full `:services:media:libs:common:test`: PASS, 278 tests, 0 failures, 0 errors, 0 skipped.
- Direct consumers in one selector run: STT `SttBoundedProviderDispatchTest` PASS (10); TTS `TtsUnaryBoundedDispatchTest` PASS (14); Vision `VisionGrpcDeadlineProviderIntegrationTest` PASS (1); Multimodal `MultimodalGrpcServiceTest` (56), `MultimodalGrpcServiceInProcessIntegrationTest` (8), and `CanonicalOperationsFinalityTest` (11) PASS (75 combined).
- Multimodal cancellation/deadline selectors: `MediaCanonicalOperationExecutorTest`, `MultimodalGrpcFinalitySurfaceTest`, `MultimodalGrpcProductionWrapperMatrixTest`, and `MultimodalGrpcServiceTracingTest` PASS (68 total).
- `pnpm check:surface-docs`: PASS, 59 surface READMEs / 577 cited types. `git diff --check`: PASS after removing trailing whitespace from the edited Vision test source.
- All Gradle runs used offline `DEV_SOURCE_COMPOSITE` profile and `FULL` composite scope; provider/model inference was not invoked.

## Final closure decision

`not-converged-actionable`. The result-integrity gap is local and repairable. Broader shared-engine ownership, installed-consumer compatibility, four-service auth, cancellation/retry qualification, and native leak/host evidence remain open and outside this repair slice.
