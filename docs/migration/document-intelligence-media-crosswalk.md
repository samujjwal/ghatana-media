# Document Intelligence v1 to Media OCR crosswalk

**State:** source-observed conformance crosswalk; no runtime binding or owner
acceptance is implied.

This crosswalk compares the observed `document-intelligence.v1` TypeScript
client with Media's OCR provider boundary. A thin, source/version-aware scene
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
