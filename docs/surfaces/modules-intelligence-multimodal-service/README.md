# Surface: `modules-intelligence-multimodal-service`

Media Multimodal Analysis Service (`modules/intelligence/
multimodal-service`, `:services:media:modules:intelligence:
multimodal-service`). Separate from the Vision service; composes
source-grounded audio and visual observations for authorized gRPC
clients and Media adapters.

## Responsibility

- Owns temporal association and multimodal semantics — **not**
  duplicate STT/Vision engines, generic model routing, OCR or Data
  Cloud storage.
- `MultimodalGrpcServer` entry point; `MultimodalGrpcService` validates
  and delegates; `CrossModalFusionEngine` fuses audio and visual
  embeddings; `MultimodalAnalysisRequest`/`Result` models.
- `adapters/agent-tools-media` holds the `AudioTranscriptionAgent` and
  `MultimodalAnalysisAgent` wrappers — kept at the Tools SPI boundary so
  this service compiles without pulling Tool runtime into its classpath.

## Public operations

Public `MultimodalGrpcService` composition: the current source-
authorization and canonical operation executor are **unavailable**.
Runtime-port injection is an integration seam, not source
authorization. Family processing remains
`MULTIMODAL_FAMILY_NOT_ADMITTED` (`FAILED_PRECONDITION`) until canonical
per-operation bindings exist. STT/Vision readiness probes return false —
qualified provider readiness is not wired. The `WAVE2-RPC-CAPABILITY-
MATRIX.md` preserves the RPC inventory, but its combined/partial
response descriptions are historical observations; canonical MM-08 and
the actual guards govern current execution.

## States and invariants

- No multimodal analysis executes: family operations fail closed with
  typed `FAILED_PRECONDITION` rather than returning partial/synthetic
  results.
- No duplicate engines: STT/Vision ownership stays with their services;
  this module composes their admitted outputs only.
- `POST /api/v1/media/multimodal-analyses` SDK route is pinned as a
  stale disposition pending owner review (the SDK method rejects before
  dispatch) — see contract-parity manifest.

## Dependencies and configuration

- `MULTIMODAL_GRPC_PORT` (default 50055, range 1–65535); shared
  `GrpcTransportSecurityPolicy` under the `MULTIMODAL` prefix — missing
  production-like TLS rejects startup. Former `vision.model`/
  `vision.fusion-strategy` examples were never read by this server and
  do not activate a provider.
- Builds on `libs/java/common` and `modules/infrastructure/*`.

## Errors

`MULTIMODAL_FAMILY_NOT_ADMITTED` (`FAILED_PRECONDITION`) for family
operations; transport-security misconfiguration rejects startup.

## Child-result snapshot integrity

Before fusion, nested child-result values are detached into an immutable
snapshot and bound to a digest. Mutating provider-owned nested maps/lists
afterward cannot change the fused observations or their recorded digest.
The focused `DelegatingMultimodalProviderTest` mutation regression and 15
admission/restart selectors pass. This is local provider/fixture evidence;
it does not qualify real licensed STT/Vision providers, source/rights
grounding, or external runtime behavior. Those remain open.

Launcher restart reconstruction also deep-copies bounded child result JSON
before building parent observations. A regression mutates nested metadata and
timed observations after fusion and confirms the reconstructed snapshot remains
unchanged and immutable. This protects the local readback snapshot only; it
does not establish PostgreSQL crash recovery, licensed child outputs, or
source/rights grounding.

## Tests and commands

```bash
./gradlew :services:media:modules:intelligence:multimodal-service:test
```

Coverage: RPC matrix guards, fail-closed family admission, readiness
probes, transport security policy.
