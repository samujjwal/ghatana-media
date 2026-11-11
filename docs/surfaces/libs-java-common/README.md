# Surface: `libs-java-common`

Shared Java engine/config library for Media (`libs/java/common`,
`com.ghatana.media.*`). Cross-service configuration, capability,
production, simulation, STT-engine, runtime and service-HTTP helpers —
the "shared media engines" layer consumed by the modality services.

## Responsibility

- `com.ghatana.media.config` / `error` / `logging` — service
  configuration, typed errors and logging conventions.
- `com.ghatana.media.capability` — capability declarations/inventory.
- `com.ghatana.media.production` / `simulation` — production planning
  and deterministic simulation support shared by services.
- `com.ghatana.media.vision.api.VisionDetector.BoundingBox` — finite
  local geometry validation and scale-normalized IoU arithmetic; it does
  not select or infer a coordinate frame or range.
- `com.ghatana.media.stt` (+ `engine.native_whisper`, `engine.onnx`,
  `eval`, `api`) — STT engine abstractions and evaluation harnesses.
- `com.ghatana.media.common.lifecycle.NativeModelLifecycle` — fair
  read-use leases that fence native-model disposal for Whisper and Piper.
- `com.ghatana.media.runtime` / `service` / `service.http` /
  `integration` / `resilience` / `common.pool` / `common.validation` /
  `sync` — runtime composition, HTTP service helpers, integration and
  resilience primitives.

## Public operations

Library package surface under `com.ghatana.media.*`; consumed as a
dependency by `modules/*` services and `launcher`. No standalone
entrypoint.

## States and invariants

- Engine abstractions must not fabricate model output: native/ONNX STT
  engines report real availability or fail closed; evaluation harnesses
  mark fixtures as nonproduction.
- Simulation support produces deterministic plans/state only — never
  implies provider admission or real effects.
- Native model calls must hold a lifecycle lease. Closing from a thread that
  still owns a lease fails promptly instead of deadlocking on a read-to-write
  lock upgrade; disposal remains one-shot after active uses drain. Whisper
  pointer access and Piper inference use this fence. These lifecycle tests do
  not load a licensed model or establish inference quality, leak freedom, or
  host qualification.
- `platform-local` style boundary: shared within Media; no dependency on
  product modules.

## Dependencies and configuration

- Consumed by Media services; platform observability/common primitives
  where applicable. Service-specific configuration arrives from each
  consuming module's environment.

## Errors

Typed error types under `com.ghatana.media.error`; consumers map them to
service boundaries — this library does not own wire error taxonomies.

## Tests and commands

```bash
./gradlew :services:media:libs:java:common:test
```

Coverage target: public configuration, factory, engine-pool lease and
validation paths (see module README for the ≥80% target on config/factory
paths).
