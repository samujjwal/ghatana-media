# Audio-Video Observability Mandatory Surface Closure Matrix — 2026-11-10

## Scope and review basis

Scope: `audio-video-observability/` and module-owned gRPC health, metrics, tracing, and test-only resource profiling. Build unit: `:services:media:audio-video-observability`. This engineering review does not establish task acceptance, lifecycle convergence, deployment, provider admission, modality quality, production resource limits, or release readiness.

Reviewed: root `AGENTS.md`; module `README.md`; `docs/OPERATIONS.md`, `docs/TESTING.md`, `docs/EVIDENCE.md`; task `media.dev.service-observability` in `docs/development/remaining-work.json`; Wave 2 OBS dispositions in `docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md`; all recursively inventoried module source/test/build files; and current dirty changes in `AudioVideoHealthService`, `MediaResourceProfileHarness`, their tests, and README. No nested `AGENTS.md`, module-local generated source, or module-owned convergence Evidence Generator was found.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | `AGENTS.md`; convergence skill instructions; no nested module guidance | Development implementation is allowed; formal admission and production claims remain separate. | Preserve those boundaries. |
| Recursive inventory | reviewed-no-gap | Recursive `rg --files audio-video-observability` inventory: 4 main Java sources, 13 test Java sources, build file, README | One Java module; no generated source or nested build unit. | Keep edits in this module and direct tests. |
| Surface kind/build unit | reviewed-no-gap | `audio-video-observability/build.gradle.kts` and README | Reusable Java support module. | Run its focused Gradle selectors. |
| Ownership/boundary/placement | reviewed-no-gap | README boundary; `MediaWorkflowMetrics`; `AudioVideoHealthService`; task `where` | Owns aggregate metrics, gRPC health, tracing and test-only resource fixture; does not own provider, canonical render/job store, or generic telemetry. | Producer effects stay with owning runtime services. |
| Vision/non-goals/consumers | reviewed-no-gap | README “Purpose, consumers and boundary”; task row | Consumers are STT/TTS/Vision/Multimodal and launcher; no GUI or model inference. | Do not infer provider readiness or quality. |
| Architecture/design | implemented | `AudioVideoHealthService.check/watch/currentStatus`; official [gRPC Health protocol](https://github.com/grpc/grpc-proto/blob/master/grpc/health/v1/health.proto) | F1 preserves empty-service overall health, returns NOT_FOUND for unmatched Check names, and emits SERVICE_UNKNOWN for unmatched Watch names. F2 retains only a fixed overall/configured/unknown classification per watch. | Keep protocol behavior and bounded subscription state covered by tests. |
| Documentation/examples | implemented | `audio-video-observability/README.md` health request semantics and example | README now documents overall, configured, and unknown service behavior. | Keep the example aligned with health tests. |
| Requirements/current-state alignment | gap-found | `media.dev.service-observability` task; OBS-07/08 dispositions | Local health/provider/capture metrics exist; canonical render producer, deployed alert delivery, real provider-quality and named-host quota evidence remain missing. | F1/F2 are locally repaired; preserve remaining owner gates without promotion. |
| Gap/backlog classification | gap-found | Task acceptance and current metric producers | F1 and F2 were current-state correctness/resource gaps. Render/deployed alert/host evidence remain current task gaps requiring owning runtime/operations evidence. | F1/F2 are repaired; retain external gates for their owners. |
| Feature completeness | gap-found | `recordCaptureFrame` and provider-profile APIs; launcher runtime call sites; no canonical render producer | Capture/provider paths exist; this module has no canonical render producer or deployed alert evaluator. | Keep missing producers explicitly absent. |
| Correctness | implemented | `AudioVideoHealthServiceTest.namedCheckUsesConfiguredServiceIdentity`, `unknownWatchRemainsServiceUnknown`, `watchSubscriptionsDoNotRetainCallerServiceNames` | Unrelated Check no longer receives false SERVING; unknown Watch stays SERVICE_UNKNOWN across shutdown without retaining caller text. | Retain protocol and lifetime-boundary tests. |
| API/contracts/config | implemented | `HealthCheckRequest.service`; F1 implementation and public in-process probe | Check and Watch now honor service identity; no config/schema change or request-string echo was introduced. | Preserve empty-name overall health. |
| Generated/source-of-truth parity | reviewed-no-gap | Dependency-generated `io.grpc.health.v1`; repository proto files define separate modality business-health messages | No local generated artifacts to edit. | Consume dependency API as-is. |
| Naming | reviewed-no-gap | Source/test names and bounded metric vocabularies | Names identify health/provider/capture/resource concepts. | If counted, SERVICE_UNKNOWN is a fixed status label. |
| Duplication | reviewed-no-gap | Runtime metrics vs test-only resource harness; Shared observability dependency | Runtime probes and local fixture have separate roles; no duplicate telemetry engine found. | Do not add a second render abstraction. |
| Organization/placement | reviewed-no-gap | Runtime source paths and test-only `performance/MediaResourceProfileHarness` | Fixture is correctly isolated in test sources. | Keep it test-only. |
| Cohesion/coupling | reviewed-no-gap | Four production source classes and module dependencies | Health, metrics, tracing and instrumentation are separated; no modality internals imported. | Keep service matching within health service. |
| Tests/coverage | implemented | `AudioVideoHealthServiceTest` and `AudioVideoHealthGrpcPublicProbeTest.unknownNamedCheckReturnsNotFoundAndUnknownWatchReturnsServiceUnknown` | Direct and public in-process tests prove Check NOT_FOUND, Watch SERVICE_UNKNOWN, no identity echo, and enum-only retained request classification. | Retain protocol, privacy, and lifecycle coverage. |
| Compatibility/migration/deprecation | reviewed-no-gap | Existing Health RPC and fixed metric identities/rules | No persisted schema or metric rename is needed; empty service remains overall status. | Preserve metric names and overall-check behavior. |
| Affected-scope verification | implemented | Full module DEV_SOURCE_COMPOSITE test and surface-doc selector results below | Whole module and docs are rerun after F1/F2, including inherited health/resource edits. | Reuse unchanged passing evidence; rerun after material source changes. |
| Evidence Generator integration | blocked | `docs/EVIDENCE.md` says Lifecycle Evidence Generator is the convergence authority | Local tests cannot create canonical convergence or formal acceptance evidence. | Retain JUnit/logs as engineering evidence only. |
| Missing Evidence Generator capabilities | blocked | `docs/EVIDENCE.md`; Wave 2 evidence-packet verifier is not a convergence generator | No module-owned collector creates lifecycle scope fingerprint, score, or receipt. | Route exact source unit through Lifecycle owner’s generator; do not hand-author `.evidence/**`. |
| Security | implemented | Check bounds/timeouts; 128-watch cap; `WatchSubscription.requestedService` enum; hostile-name retention test | F1/F2 compare caller input then discard it; unknown values are not returned or metric-tagged. | Keep only fixed classifications in long-lived subscriptions. |
| Privacy/data governance/compliance | implemented | README label policy; provider-label/health-redaction tests; subscription field-type regression | The long-lived watch set no longer retains arbitrary caller service names. | Keep raw request fields out of subscription state. |
| Observability/diagnostics | gap-found | `MediaWorkflowMetrics`, health counters, alert fixture and rules | Local health/provider/capture signals exist; real runtime render and deployed alert delivery are not evidenced. | Keep unknown and NOT_MEASURED distinct; require typed producer before render telemetry. |
| Reliability/resilience/operability | gap-found | Bounded health executor/deadline/watchers; enum-only Watch identity; sampled profile fixture | Subscription memory is bounded independently of untrusted service-name length; deployed retry/alert recovery and worker hard resource limits are not proven here. | Preserve this local bound; continue owner evidence gates. |
| Performance/scalability | gap-found | 64 checks, 128 watchers, 5 s maximum; enum-only retained Watch state; fixture 1/16/64, 512 operations, 30 s; 10/250 ms sample intervals | Long-lived request identity is constant-size; profile samples remain local controls, not provider throughput or qualified host quotas, and may miss short spikes. | Preserve sampled metric names and require named-host qualification. |
| Accessibility/internationalization | not-applicable | Headless Java library; README identifies no GUI; diagnostics are control-character bounded | No UI is owned. Unicode-safe diagnostics remain covered separately. | No interface work in this scope. |
| AI/ML applicability | not-applicable | No inference code; README binds model quality to provider evidence | Module does not execute models. | Consume source-owned observations only. |
| Build/dependency/release readiness | reviewed-no-gap | Module Gradle build and composite scopes | Existing build boundary is intact; no release claim is made. | Use repository-configured source-composite focused selectors. |
| Dependency/supply-chain/licensing | reviewed-no-gap | Build file and version catalog | Uses pinned repository gRPC, Micrometer, OpenTelemetry and Shared observability dependencies; no new dependency needed. | No dependency change. |
| Repeatability/reproducibility | gap-found | Focused Gradle selectors; test fixture; no local canonical fingerprint | Tests support local engineering validation; lifecycle repeatability artifacts are absent from this module. | Record exact command/profile/host and defer canonical repeatability proof to owner. |
| Convergence/stability | blocked | Task is OPEN with producer, deployment, provider, host-resource and lifecycle-evidence gates | Module fixes cannot close service-observability as a whole. | Fix F1 and continue owner-backed gates without changing formal task state. |

## Finding and pre-edit evidence plan

### F1 — Health RPCs ignore requested service identity

- **Priority/areas:** P1; architecture/design, correctness, API/contracts, tests/coverage.
- **Location:** `audio-video-observability/src/main/java/com/ghatana/audiovideo/observability/AudioVideoHealthService.java`, `check`, `watch`, `currentStatus`.
- **Problem/root cause:** `HealthCheckRequest.service` is ignored. A ready server reports SERVING for an unrelated service. A misconfigured client can therefore receive false-positive readiness.
- **Classification:** Current-state correctness gap; the README already claims standard gRPC health behavior.
- **Production-ready fix:** Empty service remains overall server health; nonempty service must match the configured health name; unmatched Check returns gRPC NOT_FOUND; unmatched Watch emits SERVICE_UNKNOWN and remains open. Never return request text or make it a metric label.
- **Acceptance:** Empty service behavior stays compatible; the configured name reports actual readiness; unrelated Check fails with NOT_FOUND; unrelated Watch emits SERVICE_UNKNOWN; metric cardinality remains bounded.
- **Tests:** `AudioVideoHealthServiceTest`, `AudioVideoHealthGrpcPublicProbeTest`.
- **Implementation:** `AudioVideoHealthService` retains configured service identity and applies the gRPC Check/Watch unknown-service contract; README shows the supported behavior.
- **Local evidence:** `./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:audio-video-observability:test --no-daemon --no-parallel --max-workers=2 --console=plain` passed **176/176**, 31 suites, zero skips/failures/errors after F1/F2. `pnpm check:surface-docs` passed (59 READMEs, 577 cited types); `git diff --check` and the 33-unique-row matrix check passed.
- **Evidence Generator:** No local collector; canonical proof must use Lifecycle’s owner-operated generator per `docs/EVIDENCE.md`.
- **Convergence impact:** Removes a false-positive health response but does not qualify providers or close the task.

### F2 — Long-lived Watch subscriptions retained arbitrary request names

- **Priority/areas:** P1; security, privacy/data governance, reliability/operability, performance/scalability.
- **Location:** `AudioVideoHealthService.watch` and retained fields in private `WatchSubscription`.
- **Problem/root cause:** The 128-subscriber count cap did not bound retained bytes because each subscription held the caller-controlled `HealthCheckRequest.service` string for the stream lifetime.
- **Classification:** Current-state resource and data-minimization gap within the requested bounded-health surface.
- **Production-ready fix:** Classify each request as `OVERALL`, `CONFIGURED`, or `UNKNOWN` before registration; retain only the enum in `WatchSubscription`. Compare raw input once; never log, echo, or tag it.
- **Acceptance:** A long unknown service name still gets SERVICE_UNKNOWN; it is absent from output and no `String` field is retained by a Watch subscription; overall/configured behavior and close semantics remain unchanged.
- **Tests:** `AudioVideoHealthServiceTest.unknownWatchRemainsServiceUnknown` and `watchSubscriptionsDoNotRetainCallerServiceNames`; public-probe unknown Watch test.
- **Local evidence:** Same full module command passed **176/176**, 31 suites, zero skips/failures/errors after F2; `pnpm check:surface-docs` passed (59 READMEs, 577 cited types); `git diff --check` passed. JUnit XML aggregation independently confirmed 176 tests.
- **Evidence Generator:** Lifecycle-owned convergence remains external; no module collector was added.
- **Convergence impact:** Makes the existing subscriber-count bound meaningful for service-name storage; does not prove host quotas or close the task.

## Task-level gates outside this module’s authority

- A typed canonical render producer and runtime outcome mapping are absent. Test-only preview output must not be represented as runtime render health.
- Real provider-quality observations, deployed scrape/alert delivery, named-host load, and cgroup/worker-enforced quotas remain unproven. The profile harness is test-only and its sampled maxima may miss short spikes.
- Lifecycle-owned scope fingerprint, score and receipt are not produced by this module. Gradle tests and alert fixtures do not replace them.

## Closure decision

`not-converged-actionable` — F1/F2 are implemented and fully verified locally. The task remains open for canonical render/provider evidence, deployed alert delivery, admitted host limits, and Lifecycle-owned convergence evidence.
