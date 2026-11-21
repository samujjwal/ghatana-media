# Media engineering contracts and work-start decisions

This is a current source-level owner disposition for feature development, not a production admission, legal rights grant or lifecycle closure. Source reviewed: `f889bb5e50d45bdde4cfedf711e89a954a3e1706`. Relevant contract code: `8f48957ed02ccffce18773b8a94bec1da16e9d85`.

## Authoritative contract decisions

### Upload-session contracts: separate two genuinely different representations

The durable Media runtime owns `UploadSession` and HTTP states **OPEN, FINALIZING, COMPLETED, ABORTED, EXPIRED**. Its TypeScript HTTP SDK has already implemented this exact DTO. The earlier exported `UploadSessionSchema` represents a distinct seven-state, different-field legacy client view: **CREATED, UPLOADING, VERIFYING, COMPLETED, FAILED, CANCELLED, EXPIRED**.

**Approved:** no automatic or inferred mapping. Neither `OPEN`→`CREATED`/`UPLOADING`, `FINALIZING`→`VERIFYING`, nor `ABORTED`→`FAILED`/`CANCELLED` is lossless; multiple possible reasons and missing data make such a translation unsound. Maintain both schemas for existing consumers and use the exported `MediaRuntimeUploadStatusSchema` strictly at the canonical wire boundary. Java retains the existing five states. Do not change the current HTTP OpenAPI contract just to match an unrelated compatibility view.

### Stream contracts: one canonical six-state enum

Java runtime and the existing canonical TypeScript SDK already use **OPEN, CONNECTED, DEGRADED, DRAINING, CLOSED, FAILED**. `MediaRuntimeStreamStateSchema` now exports that same vocabulary from the shared types package; the SDK type is an alias. This does not add an RPC, new server, a legacy `StreamSessionSchema`, or live stream qualification.

### Other divergent vectors have deliberate type-specific meaning

| Divergence | Owner disposition | Necessary testing |
| --- | --- | --- |
| `DP-IDENT-MAXLENGTH` | TS public identifier parser max 256; Java internal required() only nonblank. Do **not** arbitrarily clamp Java globally. | Enforce the actual public DTO's per-field limits when serializing; verify no silent truncation. |
| `DP-SHA256-CASE` | Internal Java may normalize uppercase digest; canonical outgoing wire uses lowercase hex. | Validate lowercase canonical output and checksum equality. |
| `DP-TIME-NUMERATOR-ZERO` | A zero *source presentation time point* is meaningful; a zero-numerator *positive rate* is invalid. These are distinct units. | Reject any point/rate interchange. |
| `DP-BYTES-SAFE-INT` | Internal Java long supports larger values than an exact JavaScript number. Existing JSON-number wire is limited to safe integers. | Reject unsafe outbound JSON numbers; no rounding or implicit string schema change. |
| `DP-UPLOAD-STATES` | Preserve two non-equivalent models and expose exact runtime enum. | Shared golden vectors plus exact HTTP SDK and Java enum tests. |
| `DP-STREAM-STATES` | Shared runtime six-state enum is aligned. | TypeScript/Java enum equality and SDK parser tests. |

The five/six divergence counts in older summaries are descriptive, not a demand to invent correspondence. The golden vector currently enumerates all six named divergences. The design choices above resolve semantic ambiguity. The machine-readable register marks `domain-contract-parity` VERIFIED after executable cross-language typecheck, package, DTO and catalog checks; the separate semantic parity projection still reports `REVIEW_REQUIRED` because resolved source findings remain dispositioned without asserting feature support. Ordinary implementation starts without waiting for the final whole-contract task acceptance.

## Execution dependency decision

The 103-task [development register](remaining-work.json) uses `requires` to denote predecessors of **full integrated completion**, not the permission to write, test or document a source module. `workStartReadiness` distinguishes existing verified work, independently startable engineering, independently startable negative tests, eventual real-positive provider input, journey test design and retention-restricted deletion.

Start immediately in parallel: rights/policy, artifact persistence, bounded job execution, HTTP/SDK parity, streaming, native modality adapters, timeline/animation/simulation/creative engines, camera/gRPC capture, and J01–J30 scenario/negative tests. Actual composed positive results are completed only when their specific engines, auth, data and host tests pass. Never infer model license, voice consent, source authenticity or deployment authority from this decision.

## Historical-content disposition

The [historical preservation register](historical-content-preservation.json) pins **42 large artifact candidates (428652561 bytes)** to Git blob identities at `f889bb5e50d45bdde4cfedf711e89a954a3e1706`. 41 are derived snapshots and one is a historic Explorer movie. An apparent `inboundReferences=0` comes from a coarse basename scan, **not** proof that a record is unneeded. No file is approved for deletion yet.

The owner authorizes retention in the active Git tree pending a real authenticated immutable off-main copy with read-after-write hash/restore verification and consumer/source-pin reconciliation. Existing Git history is only interim content-addressed provenance, not the requested independent immutable archive. Archive setup and deletion may proceed in parallel but are not dependencies of core Media runtime or 30 journeys. No need to rereview every historical packet to write new Media features.

## Cross-product authority

- **Document Intelligence** alone executes generic OCR. Media owns frame sampling, ROI, original source digest and PTS and calls DI via its public contract.
- **Data Cloud** remains an optional metadata/semantic/RunLedger projection consumer. It is not required for Media uploads, STT, TTS, Vision, Multimodal, jobs or delivery; the insufficiently authenticated old `MediaProcessorPort` remains unavailable.
- Shared/Kernels/Tools boundaries use public interfaces. No private repo source imports or second owner for Media state.
- Real licensed provider/voice/corpus access remains a prerequisite only for the exact positive test that consumes it; safe logic, fault injection and interface work are already approved.

## Verification and implementation commands

Run `pnpm --filter @audio-video/types check`, `pnpm --filter @audio-video/client test:package`, the focused `MediaDomainParityGoldenVectorTest` under the supported source-composite Gradle profile, and affected OpenAPI/HTTP gRPC/SDK consistency tests. The 2026-11-05 current-source run passed: types check (105 tests and package consumers), client isolated package consumers, golden vectors (8/8), typed contract bindings (39/39), and structural contract parity. The register task is VERIFIED; `pnpm check:contract-parity` continues to report semantic `REVIEW_REQUIRED` while all 37 audited active findings are dispositioned and none unresolved. Run affected source-free consumers before deleting any compatibility export.

The source changes in this decision were committed through GitHub and **the repository Gradle/pnpm suites were not executed by this review**. The register's existing VERIFIED records are previous reported passes, not fresh tests from this review.

The verification addendum above records a later focused 2026-11-05 run on the current working source. It does not change the independent semantic review result, add unsupported operation mappings, or imply lifecycle, release, or deployment admission.

## Development-only API admission and lifecycle relay decision (2026-11-21)

**Technical-owner decision: APPROVED for bounded contract authoring, tests and source-only development; NOT APPROVED for production exposure or promotion of uninspected local changes.** Current remote inspection baseline: `2b1f80340a376849cf2ef4c069fe709033118cc8`. The executable `MediaHttpHandler` exposes a separately gated `/dev/v1` namespace; the current `config/route-manifest.json` and `contracts/openapi/media.yaml` govern the 30 admitted public-runtime operations. The unpublished local report identifies seven additional proposed development operations and a distinct five-commit `codex/media-infra-sync` candidate, but neither exact seven-operation source diff nor candidate commit content is present in the remote branch. Their names, payloads and admitted effects **must not be guessed or marked implemented**.

**Approved source-ownership rule:** The seven proposed operations remain `DEV_ONLY_CONTRACT_PENDING` until each exact method/path, operationId, request/response DTO, source/tenant/rights/version/clock binding, idempotency/finality, denied/UNKNOWN/error cases and proof selector is independently described and aligned in the *owning* PDP-2 API contract, PDP-3 API/SDK/Explorer mapping and executable source. Reuse `.product-experience/pdp-2-design-interface-system/api/`, `.product-experience/pdp-3-product-experience/api/`, `.product-experience/pdp-3-product-experience/sdk/`, `libs/audio-video-client`, and the existing route/controller/handler conformance generators. Author no second product definition engine and no unreviewed compatibility alias. Keep development methods excluded from the production `config/route-manifest.json` / `contracts/openapi/media.yaml` **unless** a separate explicit versioned product-interface approval promotes them to that public runtime. A DEV_ONLY route may use a separately versioned development API schema/catalog, but that schema must be generated/validated by existing Media tooling and explicitly linked to the owning PDP and SDK records; documentation comments alone cannot admit an operation. Do not silently mix a local simulation with a production route registry.

**Fail-closed admission and concurrency:** Runtime guard requires an explicit development profile, loopback or isolated trusted development ingress, developer identity signed by the host (not a caller-supplied role), current tenant/workspace/rights, bounded request size and timeline/source/version CAS. A route without the exact authoritative binding returns a typed NOT_ADMITTED/404 or capability-unavailable before any durable effect. Missing rights/revoked source, retry with changed fingerprint, ambiguous provider state and stale client version return truthful denial/CONFLICT/UNKNOWN; no default-to-success adapter. Source operations that write a project/review/render must reuse the canonical single writer, not introduce a second timeline or job/artifact state authority.

**Lifecycle-event relay decision (proposed `codex/media-infra-sync`):** A lifecycle event append, delivery/ACK and destination-effect readback are three different states. The canonical event envelope must bind tenant, source operation and immutable version, rights/purpose epoch, event ID, causal offset/cursor, visibility and idempotency fingerprint. Cursor advance must occur *only* after a durable accepted event/consumer checkpoint for the exact stream partition; a gap, crash, out-of-order replay, expired lease or unavailable destination leaves a typed gap/UNKNOWN and never skips an event. Relay startup is **off by default** and enabled only by an explicit development-only host profile with authenticated source and destination, bounded retry/backoff, resource limits and shutdown; neither class initialization nor a production environment should start a development relay by accident. Use existing `modules/infrastructure/messaging` and `providers/aws-postgresql` public outbox/inbox ports; do not create a second event publisher.

**Required source and acceptance sequence:** (1) obtain an exact checked-in candidate diff/commit in an accessible repository branch without staging unrelated local/private files; (2) enumerate each of the seven operations in a method/path/operationId-to-PDP-1/PDP-2/PDP-3/API/SDK/test crosswalk; (3) bind the observed handler schema to one correct, source-authorized development catalog or intentionally reject it; (4) validate route/SDK/OpenAPI source parity and package a source-free client; (5) run focused HTTP/SDK/PDP source selectors and negative authorization/finality tests; (6) run PostgreSQL restart, cursor gap, lost ACK and the browser-to-host persisted journey only when Docker access and the agreed disk headroom are actually available; (7) publish only the exact reviewed code/contract/test files, with commit/readback and recorded skips. Existing 35 focused candidate tests, if semantically current, are reusable as limited observations, not production/PDP admission. The local 38-path Media worktree and no-upstream infra branch remain unmodified by this source decision.

**Resource and external boundary:** Do not request a broad cache purge or override the minimum free-space floor. Safe work (contract text, static code review, source parity and Java/TypeScript noncontainer tests) proceeds without Docker. Docker-backed verification remains blocked until the actual execution host grants socket access; independent lawful model, DI writer, API consumer, destination-ACK and production deployment authority remain separate qualification gates. This owner decision is intentionally not a lifecycle receipt, independent audit signature or statement that the unpublished operations have passed.

