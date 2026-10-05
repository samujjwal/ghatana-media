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

