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

## Dependencies and configuration

- Consumed by Media service modules; platform observability primitives
  where applicable. No runtime configuration of its own.

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
