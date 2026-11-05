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

The five/six divergence counts in older summaries are descriptive, not a demand to invent correspondence. The golden vector currently enumerates all six named divergences. The design choices above resolve semantic ambiguity; `domain-contract-parity` remains OPEN for executable cross-language typecheck, package and DTO tests. Ordinary implementation starts without waiting for the final whole-contract task acceptance.

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

Run `pnpm --filter @audio-video/types check`, `pnpm --filter @audio-video/client test:package`, the focused `MediaDomainParityGoldenVectorTest` under the supported source-composite Gradle profile, and affected OpenAPI/HTTP gRPC/SDK consistency tests. Mark `domain-contract-parity` VERIFIED only after these are genuinely green. Run affected source-free consumers before deleting any compatibility export.

The source changes in this decision were committed through GitHub and **the repository Gradle/pnpm suites were not executed by this review**. The register's existing VERIFIED records are previous reported passes, not fresh tests from this review.
