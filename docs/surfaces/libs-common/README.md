# Surface: `libs-common`

Shared Java library for the audio-video platform (`libs/common`,
`com.ghatana.audio.video.common`). Cross-cutting configuration, factory
utilities, health, resilience, security and proto helpers consumed by the
Media services — it must not depend on product-specific modules.

## Responsibility

- Common model, health, observability, platform and resilience helpers
  under `com.ghatana.audio.video.common.*` shared across STT, TTS,
  multimodal and infrastructure modules.
- Avoids duplication of cloud-fallback and model-loading logic; keeps
  security/proto plumbing in one owned place.

## Public operations

Package-level shared types and helpers under
`com.ghatana.audio.video.common.{health,model,observability,platform,proto,resilience,security}`;
consumed as a library dependency — no standalone entrypoint.

## States and invariants

- Platform-local layer: shared within the audio-video product boundary;
  no dependency on product modules (dependency direction is services →
  lib only).
- Security helpers must not weaken tenant isolation, consent or rights
  checks in consuming services.
- `ContextAwareBoundedExecutor.Submission.result()` routes direct
  `CompletableFuture.cancel(mayInterruptIfRunning)` requests through the
  submission cancellation fence. Started effect-capable work remains
  `UNKNOWN_OUTCOME`; queued/no-effect cancellation keeps its typed outcome,
  and the supplied interrupt flag is honored. Accepted cancel requests complete
  with the classified operation result rather than a bare
  `CancellationException`, so `isCancelled()` remains false and callers can
  observe the cancellation finality classification.

## Dependencies and configuration

- Consumed by Media service modules; platform observability primitives
  where applicable.
- Each gRPC service accepts a service-scoped TLS certificate/key pair and
  client CA: `<SERVICE>_GRPC_TLS_CERT_CHAIN_PATH`,
  `<SERVICE>_GRPC_TLS_PRIVATE_KEY_PATH`, and
  `<SERVICE>_GRPC_TLS_CLIENT_CA_PATH`. The shared Media equivalents are
  `MEDIA_GRPC_TLS_CERT_CHAIN_PATH`, `MEDIA_GRPC_TLS_PRIVATE_KEY_PATH`, and
  `MEDIA_GRPC_TLS_CLIENT_CA_PATH`. A service uses either its complete
  service-scoped set or the complete shared set; certificate, key, and CA
  must come from the same scope.
- Production, staging, and sovereign profiles require all three files and
  require client certificates signed by the configured CA. Development may
  use server-auth TLS without a client CA; plaintext remains limited to an
  explicit local/test/development profile. CA files must be readable regular
  files and cannot be symlinks.

## Errors

Standard typed exceptions of the consuming service boundaries; this
library does not define product error taxonomies.

## Tests and commands

```bash
./gradlew :services:media:libs:common:test
```

## Relationship to `libs-java-common`

`libs/common` hosts the older `audio.video.common` package family;
`libs/java/common` hosts the newer `com.ghatana.media.*` engine/config
packages (capability, production, simulation, stt engines, runtime,
service HTTP). They are distinct Gradle modules with separate consumers —
see `docs/surfaces/libs-java-common/README.md`.
