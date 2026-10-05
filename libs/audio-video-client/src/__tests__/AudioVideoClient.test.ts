/**
 * Tests for AudioVideoClient: circuit breaker, retry, transport errors, event emission.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AudioVideoClient,
  type ServiceClientConfig,
  type CircuitBreakerConfig,
  createAudioVideoClient,
  defaultConfigs,
} from '../index.js';

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

function mockFetch(
  responses: Array<{ status: number; body: unknown } | Error>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const calls = responses.slice();
  return (): Promise<Response> => {
    const next = calls.shift();
    if (!next) {
      return Promise.reject(new Error('Unexpected fetch call — no more mocked responses'));
    }
    if (next instanceof Error) return Promise.reject(next);
    const { status, body } = next;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  };
}

// ─── Config factory ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ServiceClientConfig> = {}): ServiceClientConfig {
  return {
    endpoint: 'http://localhost:9999',
    timeout: 500,
    retries: 0,
    enableLogging: false,
    ...overrides,
  };
}

function makeClient(
  configOverrides: Partial<ServiceClientConfig> = {},
  breakerConfig?: Partial<CircuitBreakerConfig>,
): AudioVideoClient {
  const cfg = makeConfig({ ...configOverrides, circuitBreaker: breakerConfig });
  return new AudioVideoClient({
    stt: cfg,
    tts: cfg,
    'ai-voice': cfg,
    vision: cfg,
    multimodal: cfg,
  });
}

function makeSTTRequest() {
  return {
    audio: {
      data: new ArrayBuffer(8),
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      durationMs: 1000,
      format: 'wav' as const,
    },
    language: 'en-US',
  };
}

function makeTTSRequest() {
  return { text: 'Hello world', voiceId: 'voice-1' };
}

function makeVisionRequest() {
  return {
    image: { data: new ArrayBuffer(4), width: 100, height: 100, format: 'png' as const },
    task: 'detect' as const,
  };
}

function makeMultimodalRequest() {
  return {
    audio: {
      data: new ArrayBuffer(8),
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      durationMs: 500,
      format: 'wav' as const,
    },
    task: 'analyze' as const,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AudioVideoClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Constructor & configuration ──────────────────────────────────────────

  describe('constructor and createAudioVideoClient', () => {
    it('creates a client through the factory function', () => {
      const client = createAudioVideoClient({
        stt: makeConfig(),
        tts: makeConfig(),
        'ai-voice': makeConfig(),
        vision: makeConfig(),
        multimodal: makeConfig(),
      });
      expect(client).toBeInstanceOf(AudioVideoClient);
    });

    it('throws when a service is not configured', async () => {
      // Only stt configured — calling tts should fail
      const client = new AudioVideoClient({ stt: makeConfig() } as Parameters<
        typeof AudioVideoClient.prototype.transcribe
      >[0] extends never
        ? never
        : Record<string, ServiceClientConfig>);
      const g = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('{}'),
      } as unknown as Response);
      await expect(client.synthesize(makeTTSRequest())).rejects.toThrow(/tts service not configured/i);
      g.mockRestore();
    });
  });

  // ─── STT transcription ─────────────────────────────────────────────────

  describe('transcribe()', () => {
    it('returns success with data on 200', async () => {
      const sttResult = {
        text: 'Hello',
        confidence: 0.95,
        processingTimeMs: 120,
        language: 'en-US',
        model: 'default',
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: sttResult }]),
      );
      const client = makeClient();
      const response = await client.transcribe(makeSTTRequest());
      expect(response.success).toBe(true);
      expect(response.data?.text).toBe('Hello');
      expect(response.data?.confidence).toBe(0.95);
      expect(response.metadata?.service).toBe('stt');
      g.mockRestore();
    });

    it('returns failure on 500', async () => {
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(mockFetch([{ status: 500, body: 'Internal Server Error' }]));
      const client = makeClient();
      const response = await client.transcribe(makeSTTRequest());
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('STT_ERROR');
      expect(response.error?.service).toBe('stt');
      g.mockRestore();
    });

    it('returns failure when STT payload violates runtime schema', async () => {
      const invalidPayload = {
        text: 'Hello',
        confidence: 1.5,
        processingTimeMs: 120,
        language: 'en-US',
        model: 'default',
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: invalidPayload }]),
      );
      const client = makeClient();

      const response = await client.transcribe(makeSTTRequest());

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('STT_ERROR');
      g.mockRestore();
    });

    it('calls onError callback on failure', async () => {
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(mockFetch([{ status: 503, body: 'unavailable' }]));
      const client = makeClient();
      const onError = vi.fn();
      await client.transcribe(makeSTTRequest(), { onError });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toMatchObject({ code: 'STT_ERROR', retryable: true });
      g.mockRestore();
    });

    it('retries on 500 and succeeds on second attempt', async () => {
      const sttResult = {
        text: 'Retry ok',
        confidence: 0.9,
        processingTimeMs: 80,
        language: 'en',
        model: 'default',
      };
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          mockFetch([{ status: 500, body: 'err' }, { status: 200, body: sttResult }]),
        );
      const client = makeClient({ retries: 1 });
      const resultP = client.transcribe(makeSTTRequest());
      // advance timers to allow backoff delay
      await vi.runAllTimersAsync();
      const result = await resultP;
      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('Retry ok');
      expect(g).toHaveBeenCalledTimes(2);
      g.mockRestore();
    });

    it('does not retry on 400 (client error)', async () => {
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(mockFetch([{ status: 400, body: 'bad request' }]));
      const client = makeClient({ retries: 3 });
      const result = await client.transcribe(makeSTTRequest());
      expect(result.success).toBe(false);
      // Should only be called once — no retries on 4xx
      expect(g).toHaveBeenCalledTimes(1);
      g.mockRestore();
    });

    it('propagates tenant header when configured', async () => {
      const sttResult = {
        text: 'Tenant scoped',
        confidence: 0.95,
        processingTimeMs: 12,
        language: 'en',
        model: 'default',
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: sttResult }]),
      );
      const client = makeClient({ tenantId: 'tenant-42' });

      const response = await client.transcribe(makeSTTRequest());

      expect(response.success).toBe(true);
      const fetchOptions = g.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(fetchOptions?.headers).toMatchObject({ 'X-Tenant-Id': 'tenant-42' });
      g.mockRestore();
    });

    it('propagates additional headers when configured', async () => {
      const sttResult = {
        text: 'Header check',
        confidence: 0.95,
        processingTimeMs: 12,
        language: 'en',
        model: 'default',
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: sttResult }]),
      );
      const client = makeClient({ additionalHeaders: { 'X-Correlation-Id': 'corr-1' } });

      const response = await client.transcribe(makeSTTRequest());

      expect(response.success).toBe(true);
      const fetchOptions = g.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(fetchOptions?.headers).toMatchObject({ 'X-Correlation-Id': 'corr-1' });
      g.mockRestore();
    });
  });

  // ─── TTS synthesis ────────────────────────────────────────────────────

  describe('synthesize()', () => {
    it('returns success with audio data on 200', async () => {
      const ttsResult = {
        audio: new ArrayBuffer(0),
        duration: 2.5,
        processingTimeMs: 200,
        sampleRate: 22050,
        format: 'mp3',
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: ttsResult }]),
      );
      const client = makeClient();
      const response = await client.synthesize(makeTTSRequest());
      expect(response.success).toBe(true);
      expect(response.metadata?.service).toBe('tts');
      g.mockRestore();
    });

    it('returns failure when service responds with 503', async () => {
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(mockFetch([{ status: 503, body: 'unavailable' }]));
      const client = makeClient();
      const response = await client.synthesize(makeTTSRequest());
      expect(response.success).toBe(false);
      expect(response.error?.retryable).toBe(true);
      g.mockRestore();
    });
  });

  // ─── Vision processing ────────────────────────────────────────────────

  describe('processVision()', () => {
    it('returns detection result on success', async () => {
      const visionResult = {
        objects: [
          { class: 'person', confidence: 0.9, bbox: { x: 2, y: 3, width: 40, height: 50 } },
        ],
        processingTimeMs: 50,
        confidence: 0.9,
        imageSize: { width: 100, height: 100 },
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: visionResult }]),
      );
      const client = makeClient();
      const response = await client.processVision(makeVisionRequest());
      expect(response.success).toBe(true);
      expect(response.metadata?.service).toBe('vision');
      g.mockRestore();
    });

    it('returns failure when vision payload violates runtime schema', async () => {
      const invalidPayload = {
        objects: [{ class: 'car', confidence: 0.9 }],
        confidence: 0.9,
        processingTimeMs: 50,
        imageSize: { width: 100, height: 100 },
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: invalidPayload }]),
      );
      const client = makeClient();

      const response = await client.processVision(makeVisionRequest());

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VISION_ERROR');
      g.mockRestore();
    });
  });

  // ─── Multimodal processing ────────────────────────────────────────────

  describe('processMultimodal()', () => {
    it('returns success on 200', async () => {
      const multiResult = {
        result: { summary: 'ok' },
        confidence: 0.88,
        insights: [],
        processingTimeMs: 300,
        modalities: ['audio'],
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: multiResult }]),
      );
      const client = makeClient();
      const response = await client.processMultimodal(makeMultimodalRequest());
      expect(response.success).toBe(true);
      g.mockRestore();
    });
  });

  // ─── Circuit breaker ──────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('opens after reaching failure threshold', async () => {
      const threshold = 2;
      // Threshold-many failures + 1 more call that should be rejected by open breaker
      const responses: Array<{ status: number; body: unknown }> = Array.from(
        { length: threshold },
        () => ({ status: 500, body: 'err' }),
      );
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(mockFetch(responses));
      const client = makeClient(
        { retries: 0 },
        { failureThreshold: threshold, resetTimeoutMs: 60_000 },
      );

      // Exhaust threshold
      for (let i = 0; i < threshold; i++) {
        await client.transcribe(makeSTTRequest());
      }

      // This call should be rejected immediately (OPEN breaker), no fetch call
      const result = await client.transcribe(makeSTTRequest());
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/circuit breaker is OPEN/i);
      // Fetch should only have been called `threshold` times
      expect(g).toHaveBeenCalledTimes(threshold);
      g.mockRestore();
    });

    it('allows probe after reset timeout and recovers on success', async () => {
      const threshold = 1;
      const resetMs = 1000;
      const sttOk = {
        text: 'Recovery',
        confidence: 0.85,
        processingTimeMs: 90,
        language: 'en',
        model: 'default',
      };
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          mockFetch([
            { status: 500, body: 'err' }, // triggers open
            { status: 200, body: sttOk }, // recovery probe
          ]),
        );
      const client = makeClient(
        { retries: 0 },
        { failureThreshold: threshold, resetTimeoutMs: resetMs },
      );

      // Open the breaker
      await client.transcribe(makeSTTRequest());

      // Advance past reset timeout
      vi.advanceTimersByTime(resetMs + 1);

      // Probe should be allowed through and succeed → CLOSED
      const result = await client.transcribe(makeSTTRequest());
      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('Recovery');
      g.mockRestore();
    });
  });

  // ─── Event listeners ─────────────────────────────────────────────────

  describe('addEventListener / removeEventListener', () => {
    it('emits start and complete events on successful transcription', async () => {
      const sttResult = {
        text: 'Event test',
        confidence: 0.99,
        processingTimeMs: 10,
        language: 'en',
        model: 'test',
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: sttResult }]),
      );
      const client = makeClient();
      const started = vi.fn();
      const completed = vi.fn();
      client.addEventListener('stt:transcription:start', started);
      client.addEventListener('stt:transcription:complete', completed);

      await client.transcribe(makeSTTRequest());

      expect(started).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      g.mockRestore();
    });

    it('emits error event on failure', async () => {
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(mockFetch([{ status: 500, body: 'err' }]));
      const client = makeClient();
      const onErrorEvent = vi.fn();
      client.addEventListener('stt:transcription:error', onErrorEvent);

      await client.transcribe(makeSTTRequest());

      expect(onErrorEvent).toHaveBeenCalledOnce();
      g.mockRestore();
    });

    it('removeEventListener stops future notifications', async () => {
      const sttResult = {
        text: 'bye',
        confidence: 1,
        processingTimeMs: 5,
        language: 'en',
        model: 'default',
      };
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          mockFetch([
            { status: 200, body: sttResult },
            { status: 200, body: sttResult },
          ]),
        );
      const client = makeClient();
      const listener = vi.fn();
      client.addEventListener('stt:transcription:complete', listener);

      await client.transcribe(makeSTTRequest());
      expect(listener).toHaveBeenCalledTimes(1);

      client.removeEventListener('stt:transcription:complete', listener);
      await client.transcribe(makeSTTRequest());
      expect(listener).toHaveBeenCalledTimes(1); // still 1
      g.mockRestore();
    });
  });

  // ─── Service status ───────────────────────────────────────────────────

  describe('getServiceStatus()', () => {
    it('returns healthy status when service responds UP', async () => {
      const healthBody = {
        status: 'UP',
        uptime: 123456,
        version: '2.0.0',
        requestCount: 100,
        errorRate: 0.01,
        avgResponseTime: 50,
        activeConnections: 5,
      };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch([{ status: 200, body: healthBody }]),
      );
      const client = makeClient();
      const status = await client.getServiceStatus('stt');
      expect(status.status).toBe('healthy');
      expect(status.version).toBe('2.0.0');
      expect(status.metrics).toBeDefined();
      expect(status.metrics!.requestCount).toBe(100);
      g.mockRestore();
    });

    it('returns unhealthy status on network error', async () => {
      const g = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(mockFetch([new Error('Network failure')]));
      const client = makeClient();
      const status = await client.getServiceStatus('stt');
      expect(status.status).toBe('unhealthy');
      expect(status.metrics).toBeDefined();
      expect(status.metrics!.errorRate).toBe(1);
      g.mockRestore();
    });

    it('getAllServicesStatus returns status for all five services', async () => {
      const healthBody = { status: 'UP', uptime: 1, version: '1.0', requestCount: 0, errorRate: 0, avgResponseTime: 0, activeConnections: 0 };
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(
        mockFetch(Array.from({ length: 5 }, () => ({ status: 200, body: healthBody }))),
      );
      const client = makeClient();
      const statuses = await client.getAllServicesStatus();
      expect(statuses).toHaveLength(5);
      const services = statuses.map((s) => s.service);
      expect(services).toContain('stt');
      expect(services).toContain('tts');
      expect(services).toContain('vision');
      g.mockRestore();
    });
  });

  // ─── Timeout behavior ─────────────────────────────────────────────────

  describe('timeout handling', () => {
    it('surfaces timeout as retryable error', async () => {
      const g = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        // Simulate a hanging request that the AbortController will cut off
        return new Promise<Response>((_, reject) => {
          setTimeout(() => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), 10);
        });
      });
      const client = makeClient({ timeout: 5, retries: 0 });
      const pending = client.transcribe(makeSTTRequest());
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.error?.retryable).toBe(true);
      g.mockRestore();
    });
  });

  // ─── defaultConfigs ───────────────────────────────────────────────────

  describe('defaultConfigs', () => {
    it('provides configs for all five services', () => {
      const services: Array<keyof typeof defaultConfigs> = [
        'stt', 'tts', 'ai-voice', 'vision', 'multimodal',
      ];
      for (const svc of services) {
        expect(defaultConfigs[svc]).toBeDefined();
        expect(typeof defaultConfigs[svc].endpoint).toBe('string');
        expect(defaultConfigs[svc].timeout).toBeGreaterThan(0);
        expect(defaultConfigs[svc].retries).toBeGreaterThanOrEqual(0);
      }
    });

    it('multimodal has longer timeout than stt', () => {
      expect(defaultConfigs.multimodal.timeout).toBeGreaterThan(defaultConfigs.stt.timeout);
    });
  });
});
