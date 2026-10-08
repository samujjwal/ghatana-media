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

## Host-configured artifact inspection CLI

The package exposes `ghatanamedia-api artifact inspect` as a read-only consumer
of the accepted `getMediaArtifact` query through `MediaOperationClient.getArtifact()`.
It requires an explicit endpoint and caller scope; the bearer token is read only
from `GHATANA_MEDIA_BEARER_TOKEN` and is never accepted in command arguments.

```sh
GHATANA_MEDIA_BEARER_TOKEN="$MEDIA_TOKEN" ghatanamedia-api artifact inspect \
  --endpoint https://media.example.test \
  --tenant tenant-1 \
  --principal principal-1 \
  --artifact artifact-1
```

The command writes a `media.cli-result.v1` JSON envelope to stdout containing
the exact `CanonicalMediaArtifactObservation`. Errors use a JSON
`media.cli-error.v1` envelope on stderr and preserve the server correlation ID
when available. A 404 means the artifact was not visible in the supplied tenant
and principal scope; it does not establish global absence. The result is a
point-in-time metadata observation and does not establish rights, content
retrieval, publication, or downstream availability. Remote endpoints require
HTTPS; plain HTTP is accepted only for loopback testing. Redirects are rejected
so bearer credentials are not forwarded to another endpoint.

This host-configured command is separate from the 11 deterministic fixture
commands in the Explorer simulator. The local consumer implementation does not
qualify any production host or release.

## Canonical upload-session read

`MediaOperationClient.getUploadSession(uploadId)` reads the existing
`getMediaUpload` query at `GET /api/v1/artifacts/uploads/{uploadId}` and returns
the exact `CanonicalMediaUploadSessionObservation` runtime DTO. It requires the
configured tenant and `defaultHeaders: { 'X-Principal-Id': callerPrincipalId }`;
the SDK rejects a response whose tenant, principal, or upload ID differs from
that request. The method accepts only a safe single path-segment upload ID.

```ts
const observation = await client.getUploadSession(uploadId);
```

The response is a point-in-time stored observation. It does not establish
currentness, completion finality, rights, artifact availability, or permission
to replay a mutation. A 404 preserves `UPLOAD_NOT_FOUND` and its correlation
identity and means only that the upload was not visible in the supplied tenant
and principal scope.
