# Transactional Event Outbox — Mandatory Surface Closure Matrix and Evidence Plan

Date: 2026-11-10<br>
Scope: `modules/infrastructure/messaging` and `providers/aws-postgresql`; launcher and runtime-contracts are excluded because they have concurrent owners.<br>
Task: `media.dev.transactional-event-outbox` (OPEN; no canonical task state is changed here).

## Surface definition and task basis

Both surfaces are provider/adapter modules with independent Gradle test units.
The messaging module is governed by its root README; provider ownership,
migration lineage, configuration boundary, and test intent are documented in
`providers/aws-postgresql/README.md`. The transactional event requirement and
acceptance cases are in `docs/development/remaining-work.json` at the task ID
above. Root guidance is `AGENTS.md`; runtime lifecycle types are in
`runtime-contracts`; Shared messaging owns generic claim/publication mechanics.

The current implementation has two append families that must remain distinct:
V011/V014 (`media_lifecycle_outbox`) and V016/V018
(`media_processing_lifecycle_outbox`). V011/V014 is used by
`PostgresqlMediaOutboxPublicationSource`; V016/V018 is used by
`PostgresqlMediaLifecycleOutboxSource`. Owner/platform resolution of event
identity/version remapping, durable Event Plane receipts, and safe family drain
is outside this local repair. This review does not change migrations, family
routing, production admission, or canonical status.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | `AGENTS.md`, task register, root build/test instructions | Development lane permits local engineering; no lifecycle-state mutation. | Preserve scope and authority boundary. |
| Recursive inventory | reviewed-no-gap | `rg --files modules/infrastructure/messaging providers/aws-postgresql`; source, tests, build scripts, and Flyway resources | Adapter and provider code are separated; no generated source in the outbox path. | Keep changes to outbox source, its test, and this report. |
| Surface kind/build unit | reviewed-no-gap | Both `build.gradle.kts`; root Gradle project paths | Java adapter module and PostgreSQL provider module. | Run exact selectors in both units. |
| Ownership/boundary/placement | reviewed-no-gap | `modules/infrastructure/messaging/README.md`, provider README, runtime SPI, Shared imports | Shared owns generic publisher; Media owns event binding; PostgreSQL owns durable rows. | Do not edit Shared, launcher, or runtime-contracts. |
| Vision/non-goals/consumers | reviewed-no-gap | Both module READMEs; event relay/consumer APIs | Documented consumer and non-goal boundaries; no broker or terminal-finality claim. | Keep delivery, consumption, and effect separate. |
| Architecture/design | reviewed-no-gap | `MediaLifecycleOutboxRelay`, `MediaLifecycleEventConsumer`, PostgreSQL source classes | Distinct append/claim/ack/projection boundaries; claims are fenced. | Bind all denormalized event identity, including occurrence time, to durable row. |
| Documentation/examples | implemented | Both module READMEs | Previously missing provider entrypoint and explicit messaging vision/requirements/design/evidence sections have been inferred and added. | Keep examples non-production and truthful. |
| Requirements/current-state alignment | reviewed-no-gap | Task row `media.dev.transactional-event-outbox`; migration/source/test files | Lost ACK, double-consumer, partition, crash, and readback cases are represented; family mapping remains unresolved. | Add timestamp parity regression; preserve external blockers. |
| Gap/backlog classification | reviewed-no-gap | Current source and task acceptance | Payload timestamp mismatch is a current correctness gap; platform receipt/family migration are owner blockers, not local backlog. | Fix the current gap only. |
| Feature completeness | reviewed-no-gap | Relay, consumer, provider sources and existing tests | Local append/claim/retry/delivery semantics exist; durable consumer receipt and event-family reconciliation are incomplete by design. | Do not claim overall task closure. |
| Correctness | gap-found | `PostgresqlMediaLifecycleOutboxSource.validatePayloadMatchesClaim`; `PostgresqlMediaJobStore.insertOutbox`; V016 `created_at`; source test | Payload `occurredAt` is not compared to persisted `created_at`; an altered payload timestamp can be published while row identity checks pass. | Compare epoch-millisecond occurrence time to persisted row value before publish; prove no publisher call on mismatch. |
| API/contracts/config | reviewed-no-gap | Runtime lifecycle SPI, relay constants, provider system properties | Existing contracts and bounds remain; no API/config change planned. | Preserve public signatures. |
| Generated/source-of-truth parity | reviewed-no-gap | Flyway V011/V014/V016/V018 and provider source queries | Migrations are authoritative and append-only; this change uses existing `created_at`. | No migration or generated artifact edit. |
| Naming | reviewed-no-gap | Outbox source, claim record, test names, migration identifiers | Names distinguish the two legacy families. | Keep current names; do not imply family unification. |
| Duplication | reviewed-no-gap | Both source classes and migration families | The dual implementation is historical and semantically unresolved; no consolidation is safe. | Preserve and report mapping blocker. |
| Organization/placement | reviewed-no-gap | Messaging adapter and provider package paths | Timestamp row validation belongs in the provider source that owns the row. | Keep fix in provider source and provider regression. |
| Cohesion/coupling | reviewed-no-gap | Source class dependencies and module build files | Provider source owns DB claim/validation; adapter binds Shared delivery. | No new abstraction. |
| Tests/coverage | reviewed-no-gap | `PostgresqlMediaLifecycleOutboxSourceTest`, `PostgresqlMediaOutboxPublicationSourceTest`, `MediaLifecycleOutboxRelayTest`, `MediaLifecycleEventConsumerTest` | Existing tests exercise claims, retries, identity, duplicates, partitions/order, lost ACK, and readback distinctions. | Add altered occurrence timestamp regression; run all four focused selectors. |
| Compatibility/migration/deprecation | reviewed-no-gap | V011/V014/V016/V018, historical migration snapshot, provider README | No schema change is required; historical family bridge/drain is unresolved. | No migration rewrite or production claim. |
| Affected-scope verification | reviewed-no-gap | Module test task configuration and selected source/test paths | Focused provider and messaging selectors cover changed behavior and adjacent envelope parity. | Run selectors below; no full repository suite. |
| Evidence Generator integration | blocked | Repository `scripts/conformance/evidence-definitions/**`; no path-scoped outbox collector discovered | No registered native outbox scope fingerprint/closure artifact command was found. | Run available tests; record exact Evidence Generator enhancement need. |
| Missing Evidence Generator capabilities | blocked | Same evidence definitions and scope inventory | Missing path-scoped artifact for outbox identity, tests, migration/API parity, security, and repeatability. | Enhancement task: add native outbox scope collector/artifact and schema gate. |
| Security | reviewed-no-gap | Row/payload identity validation, tenant-bound keys, fenced claim updates | Timestamp mismatch can misstate occurrence order and ABI; exact fix is in correctness row. No secret or content exposure found in the event path. | Validate before publisher invocation. |
| Privacy/data governance/compliance | reviewed-no-gap | Content-free lifecycle model, classification field, tenant row binding | Payload model is sanitized and intended to be content-free; provider row tenant is checked. | No data-classification expansion. |
| Observability/diagnostics | reviewed-no-gap | Provider attempt/error columns, relay diagnostics SPI, module README | Local failures are typed/counted; durable operations remain inspectable. | Retain safe error code and retry state. |
| Reliability/resilience/operability | reviewed-no-gap | Claim expiry/fencing, retry/backoff/dead-letter logic, lost ACK tests | At-least-once delivery and unknown broker outcomes remain explicit. | Verify timestamp mismatch follows persisted retry path without external publish. |
| Performance/scalability | reviewed-no-gap | Bounded batch inputs and indexed eligibility query | Batch is capped; SQL uses eligible index/ordering. No performance regression from a row-field comparison. | No load campaign for this narrow validation branch. |
| Accessibility/internationalization | not-applicable | Non-UI Java persistence and adapter modules | No user interface or localized user text. | N/A for this scope. |
| AI/ML applicability | not-applicable | Deterministic lifecycle event transport | No inference or model behavior belongs in outbox delivery. | Keep transport deterministic. |
| Build/dependency/release readiness | reviewed-no-gap | Gradle module files and existing dependency graph | No new dependency/export/version change. | Compile/test only affected units. |
| Dependency/supply-chain/licensing | reviewed-no-gap | Existing dependency declarations; no dependency changes | No new third-party dependency. | No license or lockfile impact. |
| Repeatability/reproducibility | blocked | H2 test setup and module Gradle tasks | Focused tests are repeatable; native scoped evidence fingerprint/repeatability artifact is absent. | Repeat selectors; request evidence collector enhancement. |
| Convergence/stability | blocked | Matrix, task acceptance, family and receipt boundaries | Local timestamp mismatch is repairable; event-family semantics, durable platform receipt, and scoped evidence remain external/native blockers. | Final disposition remains not-converged-actionable. |

## Finding OBE-1 — occurrence timestamp omitted from row/payload parity

- Priority: P1; area: correctness/security.
- Where: `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaLifecycleOutboxSource.java`, `validatePayloadMatchesClaim`; V016 row `created_at`; append path `PostgresqlMediaJobStore.insertOutbox`.
- Problem/root cause: append stores `event.occurredAt().toEpochMilli()` in `created_at`, but the relay claim does not read that column and parity validation omits `event.occurredAt()`.
- Fix: carry persisted `created_at` through the claim and reject payload occurrence time whose epoch-millisecond value differs before invoking the publisher.
- Acceptance: modified payload with a mismatching timestamp produces zero publisher calls, remains unpublished, increments retry state, and keeps original row time; matching payload continues to publish.
- Tests: `PostgresqlMediaLifecycleOutboxSourceTest`, plus `PostgresqlMediaOutboxPublicationSourceTest`, `MediaLifecycleOutboxRelayTest`, and `MediaLifecycleEventConsumerTest`.
- Evidence: focused Gradle selectors below; repository-native outbox Evidence Generator artifact remains unavailable and is tracked above.
- Classification/impact: current-state correctness gap. Fix closes local parity mismatch; does not close overall task or resolve owner/platform blockers.

## Evidence plan

Scope fingerprint inputs: the two module build files; outbox adapter/provider production classes; V011/V014/V016/V018 migrations; source tests and lifecycle consumer/relay tests; module READMEs; and this matrix. Record the current Git HEAD and dirty state at test execution because unrelated concurrent worktree changes exist.

Run these exact focused checks after the repair:

```bash
./gradlew :services:media:providers:aws-postgresql:test --tests com.ghatana.media.provider.aws.PostgresqlMediaLifecycleOutboxSourceTest
./gradlew :services:media:providers:aws-postgresql:test --tests com.ghatana.media.provider.aws.PostgresqlMediaOutboxPublicationSourceTest
./gradlew :services:media:modules:infrastructure:messaging:test --tests com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleOutboxRelayTest --tests com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleEventConsumerTest
```

Expected evidence: Gradle task/test counts for each selector; the new mismatch
regression proving zero publisher calls and durable retry state; existing
lost-ACK, fencing, retry/dead-letter, idempotent projection, ordering, and
terminal-readback distinction tests; and unchanged V011/V016 migration files.
No repository-native path-scoped Evidence Generator command or artifact is
registered for this surface, so no convergence score is asserted. Full suite,
live broker, production PostgreSQL/LocalStack qualification, Event Plane durable
receipt, event-family migration/drain, launcher wiring, admission, production
cutover, canonical task status, and lifecycle claims are intentionally outside
this verification slice.

## Pre-repair decision

`not-converged-actionable`. The single local current-state gap above is safe to
repair without an owner decision. The broader task remains open pending the
owner/platform decisions and evidence capabilities named in this matrix.

## Post-repair verification

The local finding is implemented in the provider source and regression test;
the matrix above remains the original audit record. All focused commands passed:

| Command | Result |
|---|---|
| `./gradlew :services:media:providers:aws-postgresql:test --tests com.ghatana.media.provider.aws.PostgresqlMediaLifecycleOutboxSourceTest` | PASS, 4 tests; includes timestamp mismatch rejection, zero publisher calls, persisted retry attempt, and unpublished row. |
| `./gradlew :services:media:providers:aws-postgresql:test --tests com.ghatana.media.provider.aws.PostgresqlMediaOutboxPublicationSourceTest` | PASS, 9 tests; append transaction, claim fencing, ordered publication, lost ACK/restart, and persisted attempt behavior. |
| `./gradlew :services:media:modules:infrastructure:messaging:test --tests com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleOutboxRelayTest --tests com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleEventConsumerTest` | PASS, 22 tests; relay lost ACK/partition/lease and consumer authorization, identity, ordering, idempotency, and finality separation. |

No canonical task or lifecycle status was changed. This does not establish a
repository-native convergence score because the outbox-scoped Evidence
Generator collector/schema/gate is absent. The two event-family semantics and
safe migration/drain, durable Event Plane receipt, live broker/provider
qualification, and production admission remain exact blockers; therefore the
task is still not complete.
