# @audio-video/client

Typed HTTP client for Audio-Video product services (`stt`, `tts`, `ai-voice`, `vision`, `multimodal`).

## What it provides

- Unified `AudioVideoClient` facade for service calls.
- Retry + timeout handling with exponential backoff.
- Per-service circuit breaker.
- Runtime payload validation for critical response types.
- Tenant and custom header propagation (`X-Tenant-Id`, correlation headers, etc.).

## Quick usage

```ts
import { createAudioVideoClient } from '@audio-video/client';

const client = createAudioVideoClient({
  stt: {
    endpoint: 'http://localhost:8081',
    timeout: 30_000,
    retries: 2,
    enableLogging: true,
    tenantId: 'tenant-1',
    additionalHeaders: {
      'X-Correlation-Id': 'req-123',
    },
  },
  tts: { endpoint: 'http://localhost:8082', timeout: 30_000, retries: 2, enableLogging: true },
  'ai-voice': { endpoint: 'http://localhost:8083', timeout: 30_000, retries: 2, enableLogging: true },
  vision: { endpoint: 'http://localhost:8084', timeout: 30_000, retries: 2, enableLogging: true },
  multimodal: { endpoint: 'http://localhost:8085', timeout: 60_000, retries: 2, enableLogging: true },
});

const response = await client.transcribe({
  audio: {
    data: new ArrayBuffer(8),
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    durationMs: 500,
    format: 'wav',
  },
  language: 'en-US',
});
```

## Development

```bash
pnpm --filter @audio-video/client test
pnpm --filter @audio-video/client build
```

## Canonical artifact read migration

`MediaOperationClient.getArtifact()` reads `GET /api/v1/artifacts/{artifactId}`
and returns the exact runtime observation type exported from the
`@audio-video/client/operations` subpath:

```ts
import type { CanonicalMediaArtifactObservation } from '@audio-video/client/operations';
```

The result uses runtime field names such as `artifactId`, `contentType`,
`sha256`, `principalId`, and `objectReference`. It is not the older
`@audio-video/types` `MediaArtifact` product shape; that existing type remains
available for its other source-compatible APIs. Artifact reads require
`defaultHeaders: { 'X-Principal-Id': callerPrincipalId }` in addition to the
client's tenant configuration. A 404 preserves the runtime's
`ARTIFACT_NOT_FOUND` code and correlation identity and means only that the
artifact was not visible in the supplied tenant and principal scope.


## Canonical upload migration

`MediaOperationClient.createUploadSession()`, `uploadPart()`, and
`completeUploadSession()` use the runtime routes under
`/api/v1/artifacts/uploads`. Upload requests now use the runtime field names
`contentType`, `expectedSizeBytes`, `expectedSha256`, `classification`, and
ISO-8601 `retention`; the old `mimeType`, `sizeBytes`, `checksumSha256`, and
`kind` request fields are not aliases. Create requests also retain the declared
`idempotencyKey`, sent as `Idempotency-Key`. The current runtime handler does
not establish replay behavior for that key, so callers must not infer a
replay-safe create from the header.

Upload methods require `defaultHeaders: { 'X-Principal-Id': callerPrincipalId }`
and send that caller scope with the configured tenant. Upload sessions use the
exported `CanonicalMediaUploadSessionObservation` runtime DTO. `uploadPart()`
accepts the session's current zero-based `nextChunkIndex`, returns the updated
session, and sends raw `application/octet-stream` bytes. The SDK never retries
an append after a timeout or connection loss: the server may have accepted the
chunk even when its acknowledgement was lost. Query the the existing scoped upload-status HTTP route before deciding how to proceed. Completion
returns `CanonicalMediaArtifactObservation` and sends no request body. Prefer
passing the complete session to `completeUploadSession(session)`; it verifies
the returned artifact's tenant, principal, size, SHA-256, filename, content
type, classification, and metadata against the session. The legacy
`completeUploadSession(uploadId)` overload remains source-compatible but cannot
bind the returned artifact to an expected upload payload because the wire
artifact contains no source upload ID.
