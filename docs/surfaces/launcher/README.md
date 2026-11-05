# Surface: `launcher`

Canonical Media runtime composition and distribution (`launcher`,
Java/Gradle). `MediaRuntime` is the single composed runtime: versioned
upload, identity, rights, provider-attempt fencing, reconcile-after-crash
and stable terminal reads — **no second writer**.

## Responsibility

- `MediaRuntime.compose(environment)` builds the runtime from `MEDIA_*`
  settings; `MediaRuntime` implements `MediaProcessingRuntimePort` and
  owns upload sessions (`beginUpload`/`appendChunk`/`completeUpload`),
  artifact reads, `processingReady`, `resolveSourceAuthorization` and
  `copyArtifactContent`.
- `MediaHttpHandler` + `MediaRouteManifest` + `MediaSecurityFilter` +
  `MediaErrorCode` serve the admitted HTTP surface with the canonical
  route manifest and typed error taxonomy.
- Supporting runtimes compose consent administration, caption
  registration/parent-clock, lifecycle publication, privacy maintenance,
  semantic redaction, production-run coordination and canonical stream
  frame port — each behind its own admission checks.
- `MediaLauncher` is the process entrypoint; `MediaRuntimeConfig` and
  `LocalMediaRuntimeSupport` hold configuration/support wiring;
  `ComposedMediaRuntimePortFactory` is the ServiceLoader registration
  shared with the standalone `vision-service` entrypoint;
  `MediaSubmissionDigest` supplies submission identity.

## Public operations

| Entry point | Contents |
| --- | --- |
| `MediaLauncher.main` | Process start (`bin/launcher` in the install dist) |
| `MediaRuntime.compose` / upload & artifact methods | Canonical runtime port |
| `MediaHttpHandler` | HTTP request handling over `MediaRouteManifest` |
| `vision-service` (`bin/vision-service`) | Standalone Vision gRPC server on the same packaged classpath |

## States and invariants

- One active writer: the runtime owns job/attempt state; legacy binaries
  may remain the sole active writer until verified M08 cutover — never
  run a second writer against the same state.
- Fail-closed admission: missing factory/runtime/rights or DI admission
  denies rather than degrades. The current scene-text source does not
  admit DI pixel dispatch (no external-processing consent revalidation
  or trusted boundary/region/retention binding); OCR requests stay
  denied. Frame source handles still images only — video-frame OCR is
  unqualified.
- Production-plan fingerprints include tenant/project/origin identity
  with length-framed inputs; earlier fingerprints change — existing
  records must be reconciled against original inputs, never rewritten.
- The H-02 DAG places its manual rights-review gate before capture; the
  H-07 step coordinator does not yet enforce DAG dependencies — callers
  must not dispatch children of skipped/unresolved gates. A durable
  dependency-aware production executor is still required.

## Dependencies and configuration

- `MEDIA_*` environment configuration for the runtime; `VISION_CAPABILITY_PROFILE`
  + `DI_*` endpoint/provider/model settings for the DI consumer path.
  Distribution: `./gradlew :services:media:launcher:installDist`.

## Errors

`MediaErrorCode` typed taxonomy over HTTP; admission denials are explicit
(`NOT_ADMITTED`-class), never silent fallbacks.

## Tests and commands

```bash
./gradlew :services:media:launcher:test
./gradlew :services:media:launcher:installDist
```

Executable completion targets (plan §07): J01/J02/J20/J03 integration,
process-kill before/after commit, stale tenant, idempotency,
cancel/late response, startup readiness, bounded threads and memory.
