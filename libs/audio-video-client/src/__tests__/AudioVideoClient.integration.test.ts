import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioVideoClient, type ServiceClientConfig } from '../index.js';

interface CapturedRequest {
  method: string;
  path: string;
  tenantHeader?: string;
  correlationHeader?: string;
}

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

describe('AudioVideoClient integration', () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = undefined;
    }
  });

  it('sends tenant and correlation headers to the service endpoint', async () => {
    let captured: CapturedRequest | undefined;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      captured = {
        method: req.method ?? '',
        path: req.url ?? '',
        tenantHeader: req.headers['x-tenant-id'] as string | undefined,
        correlationHeader: req.headers['x-correlation-id'] as string | undefined,
      };

      // Consume request body before responding to simulate a real HTTP service.
      req.on('data', () => undefined);
      req.on('end', () => {
        const payload = {
          text: 'integration-ok',
          confidence: 0.93,
          processingTimeMs: 10,
          language: 'en-US',
          model: 'integration',
        };
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server failed to bind to a local port');
    }
    closeServer = async () => new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const endpoint = `http://127.0.0.1:${address.port}`;
    const config = createBaseConfig(endpoint);

    const client = new AudioVideoClient({
      stt: config,
      tts: config,
      'ai-voice': config,
      vision: config,
      multimodal: config,
    });

    const result = await client.transcribe(makeSttRequest());

    expect(result.success).toBe(true);
    expect(captured).toBeDefined();
    expect(captured?.method).toBe('POST');
    expect(captured?.path).toBe('/api/stt/transcribe');
    expect(captured?.tenantHeader).toBe('tenant-int-01');
    expect(captured?.correlationHeader).toBe('corr-int-01');
  });
});


