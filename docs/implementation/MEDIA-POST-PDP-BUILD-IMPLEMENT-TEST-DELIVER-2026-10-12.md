# Historical Ghatana Media Build handoff (2026-10-12)

> **Deferred planning record only.** Discovery is not complete on the live source-pinned phase records. This handoff, its post-PDP queues, and its Build/Delivery instructions are not active. Continue from the earliest unfinished phase in the [canonical PDP source index](../../.product-experience/README.md); do not enter Build until the Discovery barrier passes.

> **Historical October 15 planning update:** the linked Build blueprint and machine coverage prepared Plan Implementation only at that cut. They do not schedule current work or establish the Discovery barrier.

> **Discovery currentness hold (2026-10-13):** The four historical PDP development records still say `DEV_COMPLETE` with **zero outstanding definition-meaning tasks**, but the currently required per-surface source/currentness barrier is not yet validated. Under `AGENTS.md`, do not enter Build until [the approved reconciliation/Discovery exit plan](MEDIA-DISCOVERY-SOURCE-CURRENTNESS-EXIT-PLAN-2026-10-13.md) reaches PASS. This is source-currentness verification and binding, **not** revival of the withdrawn PDP-D01…D15 backlog. [Delegated review and decisions](../../.product-experience/reviews/2026-10-13-pdp0-discovery-delegated-review.md).

**Historical owner correction (October 12, 2026):** the phase records at that cut reported all four PDPs as `DEV_COMPLETE`. Current phase status is determined by the live records linked from the PDP source index.

**Scope:** Actual product implementation, runtime integration, clients, testing, deployability and delivery. Existing [47-task post-PDP ledger](post-pdp-task-dispositions-2026-10-12.md) remains the implementation/release tracking population; do not create another PDP backlog. The former [15 remaining PDP tasks](MEDIA-PDP-0-3-DEV-ONLY-REMAINING-2026-10-12.md) are withdrawn/reclassified. [Controlling owner review](../../.product-experience/reviews/2026-10-12-delegated-pdp-dev-owner-review.md).

## Rules

1. **Do not reopen finished PDPs** because a route, real provider, UI, dependency, deployment, package publication, migration, evidence record, or independent audit is unfinished. Implement to the frozen PDP source meaning.
2. **Fix implementation defects in Build.** A real new product requirement or contradictory *normative* contract is handled as a separately approved, versioned change request naming exact affected IDs, not a permanent task in an already complete phase.
3. **Truthful admission.** `CONTRACT_PREVIEW` / `LOCAL_SIMULATION` / `NOT_ADMITTED` are never shipped as working product claims. A real workflow must produce an observed authorized outcome or explicit denied/unknown status.
4. **Source ownership.** `ghatana-media` owns Media product definitions and clients; the current runtime remains `ghatana/services/media` until approved cutover. Do not duplicate it or move Shared/Document Intelligence/AI Inference generic functionality into Media.
5. **No GitHub CI general gate.** Use focused local tests and one unfiltered integration run per stable implementation slice. Public contract, rights, licensing and deployment approvals are required only for the real external effects/production claims they authorize, not for definition completion.

## Execution sequence

| Batch | What to build | Where / method | Done when |
| --- | --- | --- | --- |
| B0 — stabilize implementation | Integrate actual worktree changes, resolve conflicts and `AbstractTypedAgent` compile failure; no `-x compileJava` qualification | `ghatana/services/media/` canonical Java modules; `ghatana-media/libs/` and apps; keep unrelated changes intact | Committed source pair builds; affected tests and unfiltered Node/Gradle suites run without exclusions; record actual failures honestly |
| B1 — first real vertical | **J-01 workspace → J-02 governed upload → J-20 durable job observation** | Real Media UI/client, trusted identity/consent, quarantined immutable artifact, job attempts/outbox/reconciliation and status UI | Authorized result, denied/stale/unknown/recovery tests, no accidental provider replay, exact version provenance |
| B2 — usable speech | **J-03 artifact → STT → versioned transcript → caption correction** | `libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx`, typed client, canonical runtime speech/store modules | Real admitted profile gives immutable results; absent profile, rights or source gives typed `NOT_ADMITTED` with no dispatch |
| B3 — capability expansion | Implement vision/multimodal/creation/composition and other capability families one governed vertical at a time | Actual API/gRPC/SDK/CLI/Event/Agent consumer + bounded provider + result/quality/recovery tests; no framework duplication | Each selected capability has a usable interface, a real result or explicit unavailable state, and adverse-path tests |
| B4 — integration & operations | Public channel parity, identity/tenant scope, security/privacy, accessibility, observability, retention and crash/load/restore | Build and test accepted public adapters; measure alerting and multi-tenant behavior in a qualified environment | Supported channels pass real integration tests, logs expose no raw media, operational errors are diagnosed |
| B5 — delivery and release | Source transfer/compatibility, staging/canary, consumer verification and rollback | `ghatana-media/migration/` and actual deployment systems; preserve 2,817 `NOT_AUTHORIZED` candidate rows until source-owner cutover approval | Exactly one authoritative runtime writer, compatible consumer behavior, production qualifications and actual release approval |

## Two former PDP findings reclassified into Build

- **BUILD-UI-TOPOLOGY-01:** during real UI integration, correct `.product-experience/surfaces/media-physical-topology.v1.json` mapping for the React `@ghatana/ai-voice-ui-react` GUI package. This is build-time package/consumer metadata, **not unfinished PDP-2 design**.
- **BUILD-AGENT-MAPPING-01:** when integrating Agent Tool execution, record the actual observed source under `libs/common/src/main/java/com/ghatana/audio/video/tools/` as the legacy/support handler. Preserve canonical logical contracts and `NOT_ADMITTED` execution until the real adapter exists. This is **not unfinished PDP-1 or PDP-3 definition**.

## Milestone and reporting

The next milestone is one **authenticated artifact → versioned durable job → safe reconciliation → observable result** workflow, followed by J-03 transcript/caption delivery. Report working and tested user journeys/capabilities, implementation failures and release constraints; **never report “remaining PDP tasks” against the four completed definition cuts**.

Independent specialist assessments, Shared/Platform public owner approvals, Lifecycle issuance, source migration and production authorization remain real *downstream* requirements where applicable. Nothing here manufactures those decisions or makes them definition-stage work.
