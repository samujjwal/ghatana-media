import { describe, expect, it, vi } from 'vitest';
import { AudioVideoClient, type ServiceClientConfig } from '../index.js';

function createBaseConfig(endpoint: string): ServiceClientConfig {
  return {
    endpoint,
    timeout: 1000,
    retries: 0,
    enableLogging: false,
    tenantId: 'tenant-int-01',
    additionalHeaders: {
      'X-Correlation-Id': 'corr-int-01',
    },
  };
}

function makeSttRequest() {
  return {
    audio: {
      data: new ArrayBuffer(8),
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      durationMs: 500,
      format: 'wav' as const,
    },
    language: 'en-US',
  };
}

describe('AudioVideoClient legacy route admission', () => {
  it('returns NOT_ADMITTED without dispatching to the unbound legacy STT route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const config = createBaseConfig('https://media.example.test');
      const client = new AudioVideoClient({
        stt: config,
        tts: config,
        'ai-voice': config,
        vision: config,
        multimodal: config,
      });

      const result = await client.transcribe(makeSttRequest());

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'NOT_ADMITTED',
          message: expect.stringContaining('media.sdk.legacy.AudioVideoClient.transcribe'),
          service: 'stt',
          retryable: false,
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});


