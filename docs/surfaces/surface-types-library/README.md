# Logical surface: `media.surface.types-library`

Typed contract library channel. Physical owner:
`libs/audio-video-types` — Zod schemas + TypeScript types.

## Supported operations

22 exported types / 23 public schemas (verified denominators), including
`MediaAttemptState`/`MediaAttemptStateSchema` bound to the
`media-attempt` state model; `MultimodalSourceSchema` remains
schema-only. Shared contract source:
`src/contracts.ts`.

## States and invariants

- Schemas/types are explicitly bound to source-role manifests
  (`.product-experience/interface-parity/typed-contract-bindings.json`)
  — a binding records source role only; `runtimeSupport` stays `false`
  and no binding implies runtime admission.
- JSON/OpenAPI/protobuf parity is tracked by the contract-parity
  checker; wire parity and semantic operation parity remain unresolved
  where the manifest says so.
- Contract changes are additive/compatible; stable IDs and error
  semantics are preserved.

## Dependencies

Consumed by `libs/audio-video-client`, `libs/audio-video-ui` and host
applications; parity manifests under `.product-experience/`.

## Errors

Zod validation errors at consumption boundaries; contract drift is
caught by parity tests, not runtime guessing.

## Tests

`pnpm --filter @audio-video/types test` (95 passed) + projection parity;
`pnpm test:typed-contract-bindings` (39/39 across both binding test
files).
