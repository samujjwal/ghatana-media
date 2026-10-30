# Media Vision OCR and Data Cloud dependency — clarified owner boundary

**Status:** source-inspected architecture decision, not a PDP scope/status transition.
**Current canonical OCR owner decision:** \`docs/migration/decisions/MDI-001-document-intelligence-ownership.md\` and \`.product-experience/pdp-0-product-truth/ocr-ownership.yaml\`. They explicitly assigned **generic OCR/document parsing** to Ghatana Document Intelligence, and Media-specific scene/temporal text intent to Media. Do not silently contradict this accepted decision while editing Java/TypeScript files.
**Current Data Cloud owner decision:** Media owns artifact, upload, job/attempt, stream, rights/consent and processing finality. Data Cloud owns optional governed metadata/search/semantic projections and must not become a second Media runtime.

## Answer and decision

**Media owns the scene-text product feature**, including source image/frame, ROI selection, clocks, shot/scene/tracking, confidence/identity/provenance, permission checks, correction/edit/use in narration/video and provider choice. It must be operationally capable of denying/failing safely with **zero** Document Intelligence and **zero** Data Cloud availability.

**Document Intelligence owns the already accepted reusable generic OCR engine and document-focused processing** (PDF/Office parsing, text lines, tables/layout, extracted fields, provider/model evaluation), per MDI-001. It can serve as an **optional OCR provider** for Media via its frozen \`document-intelligence.v1\` public client. Media does not import DI's internal Python/provider code or borrow its document structures as product authority. The Media-owned \`libs/audio-video-client/src/scene-text-adapter.ts\` is a thin optional DI provider client; \`authorized-scene-text.ts\` independently requires current Media source-version/digest/tenant/rights readback and checks returned source identity.

**What if Media must operate OCR without DI?** Add an admitted Media Vision OCR provider behind the same Media-owned recognition port, using a model with lawful weights/runtime and independently measured quality; it must pass real text+ROI+time, resource, consent and provenance tests. This is **additional provider implementation** without taking over generic document parsing. A wholesale transfer of the generic OCR engine into Media would *supersede MDI-001* and require an actual owner-approved PDP source/consumer migration, testing every DI downstream consumer, not merely renaming directories. There is no need to duplicate currently working DI models just for a Media-specific feature.

## The Data Cloud dependency is optional integration, not an input to Media runtime

Current source:
- \`runtime-contracts\`, \`launcher\`, Vision/STT/TTS/Multimodal, Media job persistence, OCI codecs and streaming are Media-owned and should have **no Data Cloud build/runtime source imports**.
- \`adapters/data-cloud-media/build.gradle.kts\` currently imports Ghatana Data Cloud \`:services:data-cloud:delivery:api\` and \`:services:data-cloud:planes:shared-spi\`, and the adapter's \`MediaObservationPublicationCoordinator\` uses Data Cloud's \`OperationalSemanticContext.SemanticObject\`. **That is the actual direct compile-time dependency.** Other optional \`adapters/ledger\` code also refers to Data Cloud types. They are compatibility integration modules, not Media core.
- \`FOCUSED\` Media builds expressly omit Data Cloud; optional **FULL** composite builds compile the interop adapter. A FULL-build test passing does not prove a source-free installed public client.
- \`MediaSemanticObservationProjector\` checks tenant/version/classification/reference shapes but does **not** independently authenticate a source, grant rights, or prove a destination write. The coordinator has a source readback hook, idempotent outbox and \`OUTCOME_UNKNOWN\` semantics. Its receipt is **not** Media job finality.

Correct data direction:

\`\`\`mermaid
flowchart LR
    M["Media Core: Artifacts / Jobs / Video / Speech / Scene OCR / Rights"]
    O["Optional Vision OCR Provider: DI v1 client OR qualified Media model"]
    C["Optional Data Cloud projection adapter"]
    D["Ghatana Data Cloud: indexing, semantic read model, search"]
    M --> O
    M -->|immutable, permissioned metadata/events only| C
    C --> D
    D -.->|never commands Media job finality| M
\`\`\`

**Failure law:** Data Cloud disabled/unreachable -> Media jobs and artifacts continue to operate and persist normally. Projection is queued, \`OUTCOME_UNKNOWN\`, or explicitly unavailable. No fake ACK; no duplicate job store or second active writer. DI disabled/unreachable -> Vision detection, capture and all other Media operations continue. Scene-text OCR that requires the unavailable provider returns typed \`NOT_ADMITTED\`, without a fabricated OCR result.

## Concrete migration and acceptance sequence

1. **Now: enforce the core boundary.** Run \`pnpm test:media-core-independence\`. All Media core source and Gradle modules must remain free of Data Cloud compilation imports. Only \`adapters/data-cloud-media\` and \`adapters/ledger\` may refer to external Data Cloud types while their compatibility contracts are active.
2. **Now: source-authorized OCR admission.** \`authorized-scene-text.ts\` requires trusted original frame digest/version and live purpose+tenant/principal consent, checks the exact cropped-content SHA-256, then calls a pluggable recognizer. Revalidate the returned frame/time/version and observe no model effect for denial/stale source/altered bytes. Tests are fixtures, not real OCR model qualification.
3. **Next: make interop truly source-free.** Data Cloud owner publishes a versioned governed metadata POST/GET (Ghatana #254) with auth/current rights, tenant/source and proper \`ACCEPTED/PENDING/COMMITTED/UNKNOWN\` semantics. Keep the full Data Cloud implementation and storage in \`ghatana\`. Media consumes only a public client or HTTP contract; retire legacy Media \`MediaProcessorPort\` compatibility adapters after all consumers have migrated.
4. **Next: DI provider qualification.** Ghatana #252 publishes the accepted versioned/installed \`document-intelligence.v1\` client, with immutable provider catalog, ROI/media limits, model proof and independent negative tests. Media's Vision scene-text adapter translates source region/time and preserves rights. DI remains document OCR owner; Media retains scene semantics.
5. **Optional independent Vision OCR runtime.** If standalone OCR without DI is a product requirement, register a Media-owned inference provider under the existing Vision runtime/modality provider admission contract, with vetted model, corpus, real OCR metrics and OCI isolation. Do not copy DI internal implementations; reuse third-party model/runtime only under qualified license and current source contract.
6. **Integrated test:** Start Media **without** Data Cloud and DI: upload → job → saved artifact/transcript/stream remains unaffected; scene-text using DI returns typed unavailability. Start DI only: actual OCR result must have frame/version/ROI/time and real provider provenance. Start Data Cloud only: upload/processing remains Media-owned. Start both: actual governed metadata readback with idempotency and reconciliation after timeout/crash, no tenant leak. No mock-only result may be claimed as live integration.

**Formal boundaries:** MDI-001 remains the accepted generic-document OCR ownership until explicitly superseded. This architecture clarification does not close VIS-09, OC-04, Ghatana #252/#254, R8/PDP, gtool stage, release or legacy deployment cutover. Do not claim real OCR inference/real Data Cloud readback until the exact installed service tests run.
