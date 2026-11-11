# Mandatory Surface Closure Matrix: STT streaming and captions

Date: 2026-11-10
Scope: `modules/speech/stt-service` local slice of `media.dev.stt-streaming-and-caption`; launcher and `providers/aws-postgresql` are read-only consumer/context inputs.
Surface kind: Java Gradle gRPC service module, owning build unit `:services:media:modules:speech:stt-service`.
Decision: `not-converged-actionable`. This is an implementation audit, not a task-state change, Evidence Generator score, provider admission, or qualification.

## Scope and source inputs

The shared task `media.dev.stt-streaming-and-caption` remains OPEN. Its acceptance requires the 12 STT RPCs, real audio, partial/final results, gap/restart behavior, corrected caption parent exact match, and revoked-rights handling. The record makes `media.dev.stt-model-and-quality`, `media.dev.canonical-job-reconciliation`, and `media.dev.stream-session-authority` prerequisites. Its current progress says the active stream RPC rejects before chunk consumption without trusted canonical session/consent admission. Those sources and the root [AGENTS.md](../../../AGENTS.md) prohibit inventing rights, consent, admission, or provider evidence.

Inspected source: `modules/speech/stt-service/README.md`, `build.gradle.kts`, `src/main/proto/stt_service.proto`, all non-build files under `src/main` and `src/test`, especially `SttGrpcService.streamTranscribe`, `SttStreamSequenceValidator`, `SttGrpcStreamingSemanticsTest`, and `SttStreamSequenceValidatorTest`. The subtree had no pre-existing diff. `launcher/src/main/java/com/ghatana/media/launcher/MediaCaptionRuntime.java` and `providers/aws-postgresql` remain outside this task agent's write scope.

The README records provider dispositions as `NOT_ADMITTED`, explains the missing stream-session/consent boundary, inventories all RPCs and capability intents, distinguishes local fixture tests from real model qualification, and documents focused Gradle commands. The repo's `docs/EVIDENCE.md` assigns convergence artifacts and score authority to the Lifecycle-owned generator and prohibits hand-authored `.evidence/**` receipts.

## Findings

### F-01 — canonical stream session and attempt admission unavailable in this module

- **Priority:** P1; **Areas:** requirements/current-state, feature completeness, security, privacy, reliability.
- **Classification:** blocked current-state gap; dependencies are explicit in the OPEN task.
- **Where:** `SttGrpcService.streamTranscribe`; task prerequisites in `docs/development/remaining-work.json` under `media.dev.stt-streaming-and-caption`.
- **Problem/root cause:** this RPC returns `FAILED_PRECONDITION` before accepting audio because this module has no admitted trusted session/consent authority, durable canonical stream session, or provider-attempt fence to bind work and terminal output.
- **Production-ready fix:** integrate the source-owned session authority, rights/purpose decision, and canonical provider-attempt fence only through their owning contracts; retain fail-before-consume if any decision is missing, stale, revoked, or indeterminate. No synthetic consent/session or provider result is acceptable.
- **Acceptance:** authenticated stream binds one canonical session and attempt; rejected/unavailable/revoked authority has zero chunk/provider/persistence effects; exact source/clock and immutable transcript/caption lineage survive restart and replay.
- **Path-scoped tests/evidence:** stream authorization and zero-effect tests; session/attempt idempotency and fencing; revoke/lost-ACK/restart integration; exact source-clock and caption-parent readback; owner-native authority evidence plus JUnit and scope fingerprint.
- **Evidence Generator enhancement:** path-scoped STT collector/gates are not available in this checkout; see F-02 and the companion evidence plan.
- **Convergence impact:** prevents active streaming and caption flow completion; local validators cannot close it.

### F-02 — no repository-local Evidence Generator route for this path

- **Priority:** P1; **Areas:** Evidence Generator integration, missing capabilities, repeatability, convergence.
- **Classification:** blocked evidence gap, external owner route required.
- **Where:** `docs/EVIDENCE.md`; repository inventory/search found no `tools/` tree, `discover-evidence-tools.mjs`, or Media-local canonical path-scope generator.
- **Problem/root cause:** focused Gradle/JUnit runs can prove local behavior but cannot produce owner-authoritative scope fingerprints, schemas/gates, score provenance, repeatability, or convergence artifacts.
- **Production-ready fix:** route this normalized scope and actual local outputs through the Lifecycle-owned Evidence Generator, or have its owner add a path-scoped collector. Keep schemas, gates, score, provenance, and `.evidence/**` writes there.
- **Acceptance:** generator emits current-scope fingerprint, affected units/selected tests, collector results, schema/gate results, score inputs/provenance, same-input repeatability, and missing-evidence disposition; stale/wrong-scope/manual artifacts fail closed.
- **Path-scoped tests/evidence:** owner-side collector/schema/enforcer tests and a generator run for the normalized STT scope. Local Gradle commands are input evidence only.
- **Convergence impact:** no formal convergence claim is possible from this checkout's local tests or this human-authored matrix/plan.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| `prompt-repo-guidance` | reviewed-no-gap | `AGENTS.md`; task register; no nested STT `AGENTS.md` found | Explicit Media engineering lane and no-fabrication boundary apply. | Keep changes in the STT module/tests/docs. |
| `recursive-inventory` | reviewed-no-gap | `find modules/speech/stt-service` excluding build; Java, proto, resource, OCI worker, tests, README, Gradle | Complete source/test inventory reviewed; generated build outputs excluded. | Scope is bounded to the task's STT-owned files. |
| `surface-kind-build-unit` | reviewed-no-gap | `build.gradle.kts`; settings registration | Java gRPC service; `:services:media:modules:speech:stt-service`. | Run this unit's tests for local verification. |
| `ownership-boundary-placement` | reviewed-no-gap | STT README, proto, `SttGrpcService`, runtime contract imports | Media owns STT service; shared SPI/runtime contracts and launcher caption orchestration retain their owners. | Do not move caption/session authorities into this module. |
| `vision-non-goals-consumers` | reviewed-no-gap | STT README purpose/provider boundary; task `where` | Service offers STT RPC boundary; no live provider/admission claimed. Launcher and persistence are consumers. | Preserve separation between SPI implementation and qualified provider. |
| `architecture-design` | reviewed-no-gap | README runtime/provider boundary; gRPC service, sequence validator, auth types | RPC validates and fails closed before stream session/provider work; validator is local bounded helper, not durable resume. | Wire only to owning session/attempt contracts when available. |
| `documentation-examples` | implemented | `modules/speech/stt-service/README.md` purpose/design boundary and streaming request example; `stt_service.proto` field definitions | Added the missing contract-faithful example and explicit module ownership/non-goals/design summary. It labels the request as non-executable while streaming remains NOT_ADMITTED. | Keep the example aligned with the proto and admission state. |
| `requirements-current-state` | reviewed-no-gap | `remaining-work.json` task and progress; STT README RPC/capability inventories | Current NOT_ADMITTED state and required flow are represented; task remains OPEN. | Preserve task acceptance and dependency boundaries. |
| `gap-backlog-classification` | reviewed-no-gap | Task prerequisites; `streamTranscribe`; validator/tests | Session authority and admitted provider are required current-state gaps blocked on dependencies; enhanced local heuristics are backlog. | No feature or authority simulation added. |
| `feature-completeness` | blocked | task acceptance; `streamTranscribe`; validator/test suites | Unary RPC coverage exists; active stream, durable resume/finality, and exact caption commit flow are not complete. | Resolve prerequisites, then close the exact task acceptance. |
| `correctness` | reviewed-no-gap | `SttStreamSequenceValidator` plus tests | Validates monotonic/contiguous sequence, sample-rate consistency, bounded even PCM, timestamps, five-minute clock/duration, and non-mutating rejection. No safe defect identified in inspected local validator. | Keep fail-closed handler behavior. |
| `api-contracts-config` | reviewed-no-gap | `stt_service.proto`; README RPC inventory; descriptor contract tests listed in README | Existing 12-method gRPC/proto boundary is documented; no contract change proposed. | Preserve message identity/field numbers. |
| `generated-source-of-truth-parity` | reviewed-no-gap | `src/main/proto/stt_service.proto`; protobuf Gradle plugin; `SttProtoContractTest` | Proto is source of truth; generated Java is build output. No generated files edited. | Re-run owning Gradle generation/compile via module test. |
| `naming` | reviewed-no-gap | source/package/class names and test naming | STT/service/stream terms align with module responsibility and RPC names. | No rename indicated. |
| `duplication` | reviewed-no-gap | STT source inventory and shared SPI references | Sequence validation is localized; shared stream runtime remains separate. No duplicate canonical session store found in this module. | Do not introduce a second session/job store. |
| `organization-placement` | reviewed-no-gap | source packages (`grpc`, `streaming`, `service`, `provider`) and resource/proto locations | Code is organized by service responsibility; caption persistence remains in launcher/provider. | Keep session authority integration at owning boundary. |
| `cohesion-coupling` | reviewed-no-gap | STT README SPI/provider boundary; module dependencies | gRPC service composes SPI and media auth abstractions; no new cross-module coupling required for local review. | No local code change justified. |
| `tests-coverage` | reviewed-no-gap | STT test inventory; validator and streaming semantics tests | Adverse sequence/bounds and fail-closed stream semantics have local tests; real provider, durable restart, revoke/caption integration remain absent by design/dependency. | Run scoped module tests; later add integration tests with real authority contracts. |
| `compatibility-migration-deprecation` | reviewed-no-gap | proto contract test inventory; README contract statement | No public schema or migration change proposed. | Keep proto identities stable. |
| `affected-scope-verification` | reviewed-no-gap | module build file, test ownership, proto tests | Module test is the minimal complete local check for this audit; see evidence plan for broader checks required after runtime wiring. | Run `:services:media:modules:speech:stt-service:test`. |
| `evidence-generator-integration` | blocked | `docs/EVIDENCE.md`; repository tool inventory | No canonical generator command is available here. | Obtain Lifecycle-owned generator route. |
| `missing-evidence-generator-capabilities` | blocked | No local `tools/`, discovery script, or path collector | Need STT changed-path fingerprint, selected test/affected-unit manifest, stream/caption authority/finality gate, repeatability and provenance artifacts. | Proposed enhancement: `EG-MEDIA-STT-STREAMING-CAPTION-PATH-SCOPE-001`, subject to Evidence Generator owner acceptance. |
| `security` | reviewed-no-gap | auth and stream admission branches in `SttGrpcService`; README identity/privacy section | No trusted session/consent means fail-before-consume; request consent field is not treated as trusted authority. | Do not relax admission. |
| `privacy-data-governance-compliance` | reviewed-no-gap | README identity/privacy boundary; privacy tests in module inventory | Tenant/subject auth and log privacy have dedicated checks; lawful audio/model authority and consent remain unestablished. | Do not open private audio or infer rights/consent. |
| `observability-diagnostics` | reviewed-no-gap | tracing/error paths in `SttGrpcService`; README test inventory | RPC tracing and typed failures exist; failed session admission is surfaced without processing content. | Add no new claims from fixture metrics. |
| `reliability-resilience-operability` | blocked | sequence validator; README says resume/finality unqualified | Local retries of rejected candidate are safe; durable reconnect, backpressure, restart and terminal reconciliation are unavailable without session/provider owner contracts. | Keep unavailable paths typed and fail closed. |
| `performance-scalability` | reviewed-no-gap | bounded chunk/duration logic; fixture load test named in README | Local byte/duration caps bound helper work; fixture transport is not a provider SLO. | No performance claim beyond fixture tests. |
| `accessibility-internationalization` | not-applicable | Headless gRPC API; README lists locale/model limitations | No GUI surface; locale/word PTS still belong to output semantics and are not qualified. | Assess locale behavior with admitted provider later. |
| `ai-ml-applicability` | reviewed-no-gap | README SPI/provider distinction and capability inventory | ASR requires a model/provider; none is admitted, and deterministic validator remains separate from inference. | Do not fabricate model, corpus, quality, or rights. |
| `build-dependency-release-readiness` | reviewed-no-gap | module Gradle build and root settings | Owning build unit and generated proto source path identified; no dependency/build edits proposed. | Module test recompiles the owning unit. |
| `dependency-supply-chain-licensing` | blocked | README provider dispositions; task/model-quality dependency | No authorized model/export package is admitted; code dependency state does not qualify model licenses. | Keep model dispatch blocked pending rights-reviewed package and owner evidence. |
| `repeatability-reproducibility` | blocked | deterministic validator tests; no path Evidence Generator | Unit fixtures are deterministic, but no normalized scope fingerprint or owner-native repeatability result exists. | Capture exact run output; request generator repeatability artifacts. |
| `convergence-stability` | blocked | F-01/F-02; task remains OPEN | Canonical session, provider effect/finality, durable caption readback, and evidence owner route remain blockers. | Revisit after declared prerequisites; no task state/status mutation. |

## Final closure decision

`not-converged-actionable`. No safe STT-local production gap was found: the live stream path is intentionally denied until required trusted session/consent/provider authority exists, and local validator checks already reject malformed or over-budget candidates without advancing the cursor. No code or test change is justified without those missing owner inputs. The actionable local documentation gap is the missing concrete stream example; the owner-side evidence route is absent. No test was run as part of this matrix document; see the ordered companion evidence plan. No task, phase, admission, qualification, closure, or release state was changed.
