# Composition: `media.composition.client-and-machine-interfaces`

All client channels agree on schemas, identity, immutable versions,
rights, errors, cancellation, replay and final state.

## Input / output

Input: identical logical operations issued over HTTP, gRPC, SDK, CLI,
Agent tools, Events and Web/Embedded channels. Output: consistent
responses/state across every channel — no channel-private semantics.

## Authority

- Contract sources: `contracts/openapi/media.yaml` (30 ops), per-service
  protos (44 RPCs), `libs/audio-video-types` (22 types/23 schemas),
  `runtime-contracts`.
- Parity enforcement: `.product-experience/interface-parity/`
  (`operation-parity.yaml`, `typed-contract-bindings.json`),
  `scripts/check-media-contract-parity.mjs`,
  `config/route-manifest.json`.
- Channels: `surface-public-http`, `surface-service-grpc` + four
  `surface-grpc-*`, `surface-sdk`, `surface-cli`,
  `surface-agent-tools`, `surface-events`, `surface-web`,
  `surface-embedded`.

## Failure / rollback

Contract drift must fail parity checks. The stale legacy multimodal SDK
route was dispositioned as non-dispatching rather than inventing an
endpoint, and the 60-declaration/33-registry observation now has a
source-backed crosswalk. Shared runtime upload and stream enums were
added without converting the unrelated seven-state legacy upload view.
Actual installed clients and real provider effects still need testing.

## Cross-child behavior test

Same operation exercised through generated HTTP/gRPC clients, SDK, CLI
and agent handlers with positive/negative/unsupported/timeout cases;
`modules/integration-tests` wire suites + `integration-tests` census;
schemas/identity/versions/rights/errors/cancellation/replay/final-state
agreement asserted.

## Data flow

Channel request → shared contract validation → canonical admission →
runtime execution → channel-appropriate typed response → consistent
observable state (job view, events, artifact refs) on every channel.
