# Document Intelligence v1 to Media OCR crosswalk

**State:** DI is the single OCR execution authority under MDI-001/PDP0-003-D4.
This is a source/consumer crosswalk, not proof of real model admission or an
installed/qualified DI runtime.

This crosswalk compares the observed `document-intelligence.v1` TypeScript
client with Media's scene/frame/time adapter. Media cannot select a separate
OCR engine or own a generic OCR provider; DI chooses all internal adapters. A thin, source/version-aware scene
text adapter candidate now exists at
[`scene-text-adapter.ts`](../../libs/audio-video-client/src/scene-text-adapter.ts).
It does not embed OCR, publish or install the Document Intelligence client,
qualify a provider, or change the MDI-001 ownership boundary. Generic parsing,
OCR execution, provider admission, and qualification remain Document
Intelligence responsibilities; Media retains scene and temporal meaning.

## Candidate field correspondence

| Media input / output | Document Intelligence v1 | Conformance disposition |
| --- | --- | --- |
| `OcrRequest.operationId` | `ParseTransportInput.operationId`; echoed by responses | Candidate direct correlation mapping. |
| `OcrRequest.image.content` | `ParseTransportInput.bytes`, sent as opaque multipart `file` | Candidate transport mapping. The client enforces its upload bound; an adapter must also honor the Media request's admitted limits. |
| `OcrRequest.image.contentType` | `ParseTransportInput.mediaType` | Candidate mapping. The worker/provider catalog remains the authority for admitted media types. |
| `OcrRequest.language` | Optional `ParseTransportInput.languageHint`; parsed lines/pages may return `languageTag` | Candidate hint only. Do not infer language support from the client's candidate-language list; use the accepted provider catalog and qualification. |
| `OcrRequest.timeout` | `ParseTransportInput.timeoutMs` | Candidate duration conversion, subject to the admitted worker/profile ceiling. |
| `OcrRequest.maxPages`, `maxRegions` | `ParseTransportInput.limits` | No field-name or unit mapping is established by this crosswalk. Require an owner-reviewed mapping to the worker's supported limits before use. |
| `OcrRequest.governancePolicyRef` | No corresponding field in the observed parse input or v1 protocol | Keep policy evaluation at the Media/calling boundary unless the owner publishes an explicit binding. Do not drop the policy requirement silently. |
| Execution tenant, principal, consent | Not represented in the observed parse input or protocol envelope | No tenant or consent propagation is established here. A deployment/transport security contract and consumer policy review are prerequisites for a runtime adapter. |
| `OcrTextRegion.pageNumber` | `WirePage.pageNumber` | Structurally corresponding page identity. Image-vs-document page semantics still need a Media use-case decision. |
| `OcrTextRegion.text`, geometry, confidence | `WireLine.text`, `boundingRegion`, optional `confidence` | Text and normalized page geometry correspond. Confidence is optional on the wire but required by Media's result type; missing-value policy is unresolved. |
| `OcrTextRegion.readingOrder` | Ordered page/block/line arrays, with no explicit reading-order field | Not a direct field mapping. Do not claim array traversal is a qualified reading order without an owner-approved rule and fixtures. |
| Video frame timestamp, range, track, scene identity | No timestamp or temporal association in the parsed-document response | Remains Media-owned. A caller must carry frame/time identity outside the generic parse result and perform temporal association itself. |
| `OcrResult.modelRef`, `modelVersion` | `providerProvenance.modelRef`, `modelVersion` may be optional | A successful Media result requires model identity; the adapter must reject or otherwise resolve absent identity under an approved policy. Provider identity alone is insufficient. |
| Media cancellation via operation/idempotency | `DELETE /v1/operations/{operationId}` with a 32-character generation token | Not directly interchangeable. The adapter would need to retain the exact generation token; an idempotency key is not a substitute. Preserve worker generation fencing and late-result behavior. |
| Media failure codes | Sanitized worker error `{code, retryable, providerRef?}` | No complete error taxonomy mapping is established. Preserve sanitized code/retryability and add a reviewed mapping before translating to Media terminal outcomes. |

`textSpan` is extraction evidence, not a parse-line range. When present it is a
zero-based, end-exclusive UTF-16 code-unit interval into the referenced Shared
line text; it must not be treated as a Media time range, frame offset, or
code-point index.

## Runtime and qualification boundary

The existing Media `KernelOcrProviderAdapter` is backed by Media's `OcrService`
and maps a Media model result to the Kernel OCR contract. Replacing its model
with a remote Document Intelligence call would introduce the unresolved
bindings above and must not make generic worker code or Shared extraction
schemas Media-owned. The observed TypeScript package is `0.1.0`, has a
`0.1.0-SNAPSHOT` Shared peer dependency, and is locally linked by the observed
Gharbatai consumer. Those source facts do not establish an immutable published
artifact, release binding, consumer parity, qualification, deployment, or
Document Intelligence owner acceptance.

The adapter candidate binds each call to the reported Document Intelligence
protocol and worker capability versions, exact catalog provider/version,
Media-supplied expected model identity, source artifact/version, and frame ID
and timestamp. It checks provider readiness/promotion, source media type and
language against both caller policy and provider catalog, response correlation,
single-page image scope, normalized geometry, and required confidence/model
identity. It preserves wire sequence only as `wireOrdinal`; it does not infer
reading order. Callers must provide explicit worker-limit names/units; no
default mapping from Media limits is invented.

This is implementation of a typed, fail-closed *candidate boundary*. It is not
an admitted runtime binding: the current package is still a Media SNAPSHOT and
has no dependency on the public Document Intelligence package. Tenant and
consent enforcement, policy propagation, approved page/frame and confidence
semantics, producer error/terminal-state mapping, and public artifact
compatibility remain unresolved. The candidate output carries source/time
identity outside the DI response; it does not claim DI observed or validated
those Media fields. Before enabling this adapter in a deployed consumer, obtain
owner-approved mappings and fixtures for those gaps, then qualify the immutable
public artifact and consumer under MDI-001 without changing accepted consumer
contracts or activation state.

## Source basis

- `services/document-intelligence/contracts/protocol-v1.md`
- `services/document-intelligence/clients/typescript/src/{client,protocol,validators}.ts`
- `services/document-intelligence/clients/typescript/package.json`
- Media `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/ocr/{OcrService,KernelOcrProviderAdapter}.java`
- Accepted boundary: `decisions/MDI-001-document-intelligence-ownership.md`
- Source snapshot and publication/qualification limitations: `external-platform-contract-observation.json` (X-04)

## October 30 single-authority implementation refinement

The canonical MDI-001/PDP0-003-D4 decision makes DI the **sole** OCR gateway.
`authorized-scene-text.ts` no longer takes a generic Media OCR recognizer;
it takes the DI v1 public client and typed provider policy, performs Media-owned
source rights/version/digest checks, and calls `DocumentIntelligenceSceneTextAdapter`
only. Any old Media `OcrService`/Kernel facades remain fail-closed until
consumer migration and deletion. The client package/version, real worker,
provider qualifications and installed end-to-end tests still need proof
under Ghatana #252; no new wire protocol version was introduced.

OCR-M02 source seam: `modules/vision/vision-service/.../scenetext/` adds a
`java.net.http` consumer of the frozen v1 API (`DocumentIntelligenceHttpClient`)
and `SceneTextRecognitionService`, which verifies source rights, version and
crop digest before any DI call, checks the DI catalog/provenance, maps crop
boxes to source-frame coordinates with frame ID/PTS, and fences cancellation
with the operation generation. Its tests use a local wire fixture, not a real
worker; it is not yet exposed through a VIS-09 RPC. See
`ocr-consumer-inventory.v1.json` for every remaining caller disposition.

## Executable development-stage consumer cutover (one DI OCR authority)

These are *migration work packets*, not a second OCR contract, new PDP task
registry or implied completion. Owners work against current `main` and the
existing MDI-001 / PDP0-003-D4 meaning. Since all callers are still in
development, eliminate obsolete compatibility code after testing the
replacement, rather than retaining indefinite parallel provider surfaces.

| ID / owner | What, where, how | Required test and closure |
| --- | --- | --- |
| **OCR-C01 — Media + DI source integrator** | Inventory every true OCR caller in `ghatana-media`, `ghatana/services/media` (historical read-only), `ghatana-kernel`, Data Cloud and product SDKs. Inspect `OcrService.of`, `VisionModelEngine.extractText`, `VisionDetector.extractText`, `KernelOcrProviderAdapter`, `ProductRuntimeFacets.OcrProvider` and direct Paddle/Tesseract model calls. Separate test-only references from live registrations, source-only manifests and actual consumers. | Machine-readable current import/call graph with each actual live consumer disposition `DI_MIGRATED` / `RETIRED` / `REQUIRES_WORK`; no silent orphan or alternate OCR model owner. |
| **OCR-D01 — Ghatana Document Intelligence + Shared** | Keep the existing `document-intelligence.v1` public contract, `GET /v1/providers` and `POST /v1/parse`; validate provider selection inside `services/document-intelligence/src/document_intelligence/`. Produce a reproducible installed `@ghatana/document-intelligence-client` with compatible versioned `@ghatana/document-extraction` peer, currently observed as `0.1.0-SNAPSHOT`. Do not manufacture v2 or vendor Shared types. | `python scripts/verify_increment3.py --strict`, `pytest tests/contract`, package `pnpm build && pnpm test`, packed installed consumer and exact provider-catalog/parse correlation. A source-only test is not a published release. |
| **OCR-D02 — DI model/provider owner** | Qualify provider adapters under `services/document-intelligence/src/document_intelligence/providers/`, `routing/parser-routing.v1.yaml` and `profiles/` with lawful, pinned models and independently labeled image/PDF inputs. Admit actual MIME, language, confidence and ROI limits; preserve cancellation generation and bounded resource isolation. | Real PNG/JPEG/PDF positive/negative OCR text/box results, model+gold/license provenance, malformed/oversized image, timeout/cancel/UNKNOWN and per-language measured quality. Unqualified providers remain invisible, not fallback-success. |
| **OCR-M01 — Media TypeScript source/capture consumer** | Keep `libs/audio-video-client/src/authorized-scene-text.ts` as the only Media source-owner authorization wrapper and `scene-text-adapter.ts` as the **DI-only** result mapper. Source digest/version, purpose, tenant/principal, media PTS and cropped frame verified before calling the DI client; use the DI provider catalog, never a Media OCR model. | `pnpm --filter @audio-video/client test`, `pnpm test:ocr-single-authority` and actual installed DI client integration. Denial, forged source, invalid PNG/model, duplicate/cancel or unavailable DI cause zero misleading OCR text. |
| **OCR-M02 — Media Vision Java consumer** | Under `modules/vision/vision-service`, route genuine `VIS-09` frame/ROI/PTS text calls through a DI-owned public Java client or reviewed HTTP client of the frozen DI v1 API. DI owns inference, Media owns frame crop, lawful source and temporal association. Reuse already bounded frame-extraction/native host helpers; do not place Paddle/Tesseract/Docling code in Vision. | Real ROI pixel/box/source-time verification against a DI worker on the declared host, wrong tenant/version/rights denial, late cancel and no duplicate effect. Keep VIS-09 incomplete until true provider receipt. |
| **OCR-K01 — Kernel and product consumers** | Inspect `ghatana-kernel/platform-kernel/kernel-product-api/.../ProductRuntimeFacets.java`, `ProductRuntimeCapabilityOperations.java` and Materializer. Bind any live OCR consumer to DI as the provider owner (not `ghatana-media`), using current Kernel public facets; migrate TutorPutor/GharBatai/Data Cloud/AEP call sites only where source contains actual OCR execution. | Source-free DI-backed capability conformance for each consumer; no direct OCR-engine imports or Media OCR service URL in production registry; original Kernel API consumers remain compatible where applicable. |
| **OCR-M03 — Media obsolete-code retirement** | After OCR-M01/M02/K01 prove their replacement, remove `OcrService`/legacy Kernel OCR adapter and unused `extractText` implementations/registrations in `modules/vision/vision-service` and `adapters/ocr-compat`; update all directly affected unit/integration tests and remove stale Gradle sources/projections through their owning generators. **Do not remove** non-OCR detector/camera/scene features. | No callable Media generic OCR implementation remains; no stale imports or public API exports; source-free consumers still pass, DI-only positive/denial tests replace legacy model stub tests. No fake PDP acceptance from deletion. |
| **OCR-X01 — Cross-repo acceptance integrator** | Run DI worker and **two real source-free consumers**: one Media frame with known text/ROI/timestamp, one document/PDF consumer. Bring DI down while running Media normal STT/vision/video jobs, then bring Data Cloud down; test cancellation, revocation, crash/restart and actual provider/finality. Track Ghatana #252 and original VIS-09/OC-04 IDs. | True readback of recognized text with source-relative and frame-relative boxes, independently checked frame PTS, and non-OCR Media availability unchanged. Zero required OCR consumers pointed at alternate worker. No Track B/gtool/release claim. |

**Sequence and parallelism:** OCR-C01 and OCR-D01/D02 start immediately; OCR-M01 can finish negative and source/contract tests without live model rights. OCR-M02 and OCR-K01 require DI public API/model admission for positive proof. OCR-M03 is a deliberate cleanup step **after exact callers migrate**, not a reason to preserve an active second engine. OCR-X01 is last. Each item retains its original owner for code/test, current Git SHA, selected model/license/source and truthful pass/fail/skipped. No license grant is inferred from user engineering approval.

**Fallback:** If the DI worker is unavailable or not licensed, Media continues all non-OCR workflows and returns `NOT_ADMITTED` for the dependent text-recognition operation. Do not silently restore a Media-owned OCR fallback. If a provider needs replacement, swap the adapter/model **inside Document Intelligence**, with one public contract.
