# Media Contract Boundaries

This guide points consumers to the existing Media-owned contract sources. It defines no parallel API or policy authority.

## Public contracts

- HTTP operations, request/response schemas, authentication metadata and error envelopes: [`contracts/openapi/media.yaml`](../../contracts/openapi/media.yaml).
- HTTP route inventory: [`config/route-manifest.json`](../../config/route-manifest.json), a generated route projection checked against the OpenAPI operation identities.
- Provider capability declarations: [`config/provider-manifest.json`](../../config/provider-manifest.json). Its provider-local `upload` alias is explicitly mapped in the surface matrix to HTTP `beginMediaUpload` and the exact request/result schemas; those operation identifiers belong to distinct namespaces.
- STT, TTS, Vision and Multimodal service interfaces: the protobuf files under `modules/{speech/stt-service,speech/tts-service,vision/vision-service,intelligence/multimodal-service}/src/main/proto/`.
- TypeScript SDK and shared types: `libs/audio-video-client/src/operations.ts` and `libs/audio-video-types/src/contracts.ts`.
- Data Cloud provider/library adapter: `adapters/data-cloud-media/CONSUMER_GUIDE.md` and the public adapter classes there, implementing the Data Cloud-owned `MediaProcessorPort` SPI. The guide records inputs, outputs, failure behavior, tenant boundary, and dependencies without asserting runtime wiring or availability.
- Runtime DTOs, provider SPIs, job state and upload/artifact semantics: `runtime-contracts/src/main/java/com/ghatana/media/runtime/`.

## Ownership and policy

Product meaning stays in `.product-experience/`. Existing privacy, consent, rights, classification and provider eligibility authorities remain in their current owner files; API/provider records reference those authorities and do not replace them. The Media runtime contract manifest describes contract declarations, not provider/model/license readiness.

The per-surface non-authoritative inventory and contract-definition checks are in [`.ghatana/definition/`](../../.ghatana/definition/). A PASS there means the referenced definitions are statically consistent for the reported inputs; it does not mean an operation has been semantically accepted or that a provider is qualified.

The physical topology crosswalk currently records 29 authored build manifests: 13 contract-bearing physical candidates, 14 support-only candidates, and two subsumed implementation candidates, plus seven declared compositions. The inventory scan excludes generated `node_modules` content and checks that every active authored package/Gradle/Cargo manifest has an explicit topology disposition.

## Known definition boundary

The operation-family inventory remains explicitly proposal-only. The definition matrix links the operation source to 27 HTTP operations, 43 protobuf RPCs, and all 16 individual operation-slice records. Six source slices carry exact HTTP wire bindings with their original bounded-owner/read statuses; the wider family and cross-channel equivalence remains unresolved and is not inferred from names or counts.
