# Media launcher distribution

Build the launcher distribution with:

```bash
./gradlew :services:media:launcher:installDist
```

The installation at `launcher/build/install/launcher` contains two entrypoints:

- `bin/launcher` starts the Media Runtime HTTP service.
- `bin/vision-service` starts the standalone Vision gRPC server using the same packaged runtime classpath. This includes the launcher's `ComposedMediaRuntimePortFactory` ServiceLoader registration, without making Vision depend on the launcher.

Set `VISION_CAPABILITY_PROFILE=OCR_ONLY` and the required `DI_*` endpoint/provider/model configuration to select the Document Intelligence consumer path. The launcher runtime must also be configured and admitted through the normal `MEDIA_*` environment settings. Missing factory/runtime/rights or DI admission remains fail-closed. This entrypoint does not itself qualify a DI worker, OCR quality, or source rights.

The current runtime-backed scene-text source does not admit DI pixel dispatch: the source-rights probe does not expose the separate external-processing consent revalidation or bind trusted boundary, region and retention facts for the exact DI destination. The server can start, but an OCR request remains denied until the owning runtime supplies that authority. The current frame source also handles still images only; video-frame OCR remains unqualified.

The Vision module's own `installDist` remains a development-only distribution and does not contain the launcher factory. Use the launcher distribution when starting Vision as a standalone process that requires the canonical Media runtime port.

Production plan fingerprints from the Java H-02 compiler now include tenant,
project, and origin identity and use length-framed inputs. Earlier fingerprints
will change. Existing plan or run records must be reconciled against their
original inputs before further effects; a newly compiled fingerprint does not
rewrite an existing run or authorize replay. The compiler produces a plan,
not a rights decision or provider admission.

The H-02 DAG places its manual rights-review gate before capture. The H-07
step coordinator does not yet enforce DAG dependencies or convert a skipped
manual gate into approval: callers must not dispatch child steps from a skipped
or unresolved gate. Source-specific rights and consent are separately checked
at each effect boundary. A durable, dependency-aware production executor is
still required before this plan can establish a real capture outcome.
