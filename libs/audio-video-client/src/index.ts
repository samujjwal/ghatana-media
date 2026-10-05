/**
 * @doc.type client
 * @doc.purpose Unified service client for audio-video application
 * @doc.layer shared
 * @doc.pattern facade pattern
 */

import type {
  ServiceType,
  STTRequest,
  STTResult,
  TTSRequest,
  TTSResult,
  AIVoiceRequest,
  AIVoiceResult,
  VisionRequest,
  DetectionResult,
  MultimodalRequest,
  MultimodalResult,
  ServiceStatus,
  ServiceResponse,
  AudioVideoError,
  ProgressCallback,
  ErrorCallback,
} from '@audio-video/types';
import {
  parseSTTResult,
  parseDetectionResult,
  parseMultimodalResult,
} from '@audio-video/types';

/**
 * Configuration for service clients
 */
export interface ServiceClientConfig {
  endpoint: string;
  timeout: number;
  retries: number;
  enableLogging: boolean;
  apiKey?: string;
  tenantId?: string;
  additionalHeaders?: Readonly<Record<string, string>>;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
}

/**
 * Internal fetch options for service calls.
 */
interface ServiceCallOptions<T> {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  config: ServiceClientConfig;
  serviceLabel: string;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Per-service circuit breaker.
 *
 * States:
 * - CLOSED  — normal operation; failures increment a counter.
 * - OPEN    — requests fail-fast; re-evaluated after `resetTimeoutMs`.
 * - HALF_OPEN — one probe request is allowed through; success → CLOSED,
 *               failure → OPEN again.
 */
class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenProbeInFlight = false;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 30_000,
  ) {}

  /** Returns true when the call should be allowed through. */
  allowRequest(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenProbeInFlight = false;
        return true;
      }
      return false;
    }
    if (this.halfOpenProbeInFlight) {
      return false;
    }
    this.halfOpenProbeInFlight = true;
    return true;
  }

  /** Must be called on every successful response. */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
    this.halfOpenProbeInFlight = false;
  }

  /** Must be called on every failed response. */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.halfOpenProbeInFlight = false;
    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState(): CircuitState { return this.state; }
}

/**
 * Unified audio-video service client.
 *
 * <p>Calls the audio-video REST HTTP gateway at each service's configured endpoint.
 * The default ports (50051-50055) are gRPC ports — configure your endpoint to point
 * to a gRPC-Web proxy or HTTP REST transcoding gateway for TypeScript consumers.
 * In local dev, an HTTP gateway is expected at the service's 8080 port.
 */
export class AudioVideoClient {
  private configs: Map<ServiceType, ServiceClientConfig>;
  private eventListeners: Map<string, Function[]> = new Map();
  private circuitBreakers: Map<ServiceType, CircuitBreaker> = new Map();

  constructor(configs: Record<ServiceType, ServiceClientConfig>) {
    this.configs = new Map(Object.entries(configs) as [ServiceType, ServiceClientConfig][]);
    // Pre-create a circuit breaker for each configured service
    for (const service of Object.keys(configs) as ServiceType[]) {
      const breakerConfig = configs[service].circuitBreaker;
      this.circuitBreakers.set(
        service,
        new CircuitBreaker(
          breakerConfig?.failureThreshold ?? 5,
          breakerConfig?.resetTimeoutMs ?? 30_000,
        ),
      );
    }
  }

  /**
   * Speech-to-Text transcription
   */
  async transcribe(request: STTRequest, options?: {
    onProgress?: ProgressCallback;
    onError?: ErrorCallback;
  }): Promise<ServiceResponse<STTResult>> {
    const config = this.requireConfig('stt');
    this.emitEvent('stt:transcription:start', { request });
    try {
      const result = await this.callService<STTResult>({
        method: 'POST',
        path: '/api/stt/transcribe',
        body: request,
        config,
        serviceLabel: 'stt',
      });
      const validated = parseSTTResult(result);
      this.emitEvent('stt:transcription:complete', { request, result });
      return { success: true, data: validated, metadata: { processingTime: validated.processingTimeMs, service: 'stt' } };
    } catch (error) {
      const audioVideoError = this.toError(error, 'STT_ERROR', 'stt');
      this.emitEvent('stt:transcription:error', { request, error: audioVideoError });
      options?.onError?.(audioVideoError);
      return { success: false, error: audioVideoError };
    }
  }

  /**
   * Text-to-Speech synthesis
   */
  async synthesize(request: TTSRequest, options?: {
    onProgress?: ProgressCallback;
    onError?: ErrorCallback;
  }): Promise<ServiceResponse<TTSResult>> {
    const config = this.requireConfig('tts');
    this.emitEvent('tts:synthesis:start', { request });
    try {
      const result = await this.callService<TTSResult>({
        method: 'POST',
        path: '/api/tts/synthesize',
        body: request,
        config,
        serviceLabel: 'tts',
      });
      this.emitEvent('tts:synthesis:complete', { request, result });
      return { success: true, data: result, metadata: { processingTime: result.processingTimeMs, service: 'tts' } };
    } catch (error) {
      const audioVideoError = this.toError(error, 'TTS_ERROR', 'tts');
      this.emitEvent('tts:synthesis:error', { request, error: audioVideoError });
      options?.onError?.(audioVideoError);
      return { success: false, error: audioVideoError };
    }
  }

  /**
   * AI Voice processing
   */
  async processAIVoice(request: AIVoiceRequest, options?: {
    onProgress?: ProgressCallback;
    onError?: ErrorCallback;
  }): Promise<ServiceResponse<AIVoiceResult>> {
    const config = this.requireConfig('ai-voice');
    this.emitEvent('ai-voice:process:start', { request });
    try {
      const result = await this.callService<AIVoiceResult>({
        method: 'POST',
        path: '/api/ai-voice/process',
        body: request,
        config,
        serviceLabel: 'ai-voice',
      });
      this.emitEvent('ai-voice:process:complete', { request, result });
      return { success: true, data: result, metadata: { processingTime: result.processingTimeMs, service: 'ai-voice' } };
    } catch (error) {
      const audioVideoError = this.toError(error, 'AI_VOICE_ERROR', 'ai-voice');
      this.emitEvent('ai-voice:process:error', { request, error: audioVideoError });
      options?.onError?.(audioVideoError);
      return { success: false, error: audioVideoError };
    }
  }

  /**
   * Computer Vision processing
   */
  async processVision(request: VisionRequest, options?: {
    onProgress?: ProgressCallback;
    onError?: ErrorCallback;
  }): Promise<ServiceResponse<DetectionResult>> {
    const config = this.requireConfig('vision');
    this.emitEvent('vision:process:start', { request });
    try {
      const result = await this.callService<DetectionResult>({
        method: 'POST',
        path: '/api/vision/analyze',
        body: request,
        config,
        serviceLabel: 'vision',
      });
      const validated = parseDetectionResult(result);
      this.emitEvent('vision:process:complete', { request, result });
      return { success: true, data: validated, metadata: { processingTime: validated.processingTimeMs, service: 'vision' } };
    } catch (error) {
      const audioVideoError = this.toError(error, 'VISION_ERROR', 'vision');
      this.emitEvent('vision:process:error', { request, error: audioVideoError });
      options?.onError?.(audioVideoError);
      return { success: false, error: audioVideoError };
    }
  }

  /**
   * Multimodal processing
   */
  async processMultimodal(request: MultimodalRequest, options?: {
    onProgress?: ProgressCallback;
    onError?: ErrorCallback;
  }): Promise<ServiceResponse<MultimodalResult>> {
    const config = this.requireConfig('multimodal');
    this.emitEvent('multimodal:process:start', { request });
    try {
      const result = await this.callService<MultimodalResult>({
        method: 'POST',
        path: '/api/multimodal/process',
        body: request,
        config,
        serviceLabel: 'multimodal',
      });
      const validated = parseMultimodalResult(result);
      this.emitEvent('multimodal:process:complete', { request, result });
      return { success: true, data: validated, metadata: { processingTime: validated.processingTimeMs, service: 'multimodal' } };
    } catch (error) {
      const audioVideoError = this.toError(error, 'MULTIMODAL_ERROR', 'multimodal');
      this.emitEvent('multimodal:process:error', { request, error: audioVideoError });
      options?.onError?.(audioVideoError);
      return { success: false, error: audioVideoError };
    }
  }

  /**
   * Get service health status.
   * Calls GET {endpoint}/health on the service's HTTP health port.
   */
  async getServiceStatus(service: ServiceType): Promise<ServiceStatus> {
    const config = this.requireConfig(service);
    try {
      const data = await this.callService<Record<string, unknown>>({
        method: 'GET',
        path: '/health',
        config,
        serviceLabel: service,
      });
      return {
        service,
        status: (data['status'] as string) === 'UP' ? 'healthy' : 'degraded',
        uptime: (data['uptime'] as number) ?? Date.now(),
        version: (data['version'] as string) ?? '1.0.0',
        lastCheck: new Date(),
        metrics: {
          requestCount: (data['requestCount'] as number) ?? 0,
          errorRate: (data['errorRate'] as number) ?? 0,
          avgResponseTime: (data['avgResponseTime'] as number) ?? 0,
          activeConnections: (data['activeConnections'] as number) ?? 0,
        },
      };
    } catch {
      return {
        service,
        status: 'unhealthy',
        uptime: 0,
        version: 'unknown',
        lastCheck: new Date(),
        metrics: { requestCount: 0, errorRate: 1, avgResponseTime: 0, activeConnections: 0 },
      };
    }
  }

  /**
   * Get all services status
   */
  async getAllServicesStatus(): Promise<ServiceStatus[]> {
    const services: ServiceType[] = ['stt', 'tts', 'ai-voice', 'vision', 'multimodal'];
    return Promise.all(services.map(s => this.getServiceStatus(s)));
  }

  // ─── Event handling ───────────────────────────────────────────────────────

  addEventListener(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  removeEventListener(event: string, callback: Function): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) listeners.splice(index, 1);
    }
  }

  private emitEvent(event: string, data: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const logger = this.configs.get((event.split(':', 1)[0] || 'stt') as ServiceType)?.logger ?? console;
      listeners.forEach(callback => {
        try { callback(data); } catch (error) {
          logger.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  // ─── Internal HTTP helpers ────────────────────────────────────────────────

  private requireConfig(service: ServiceType): ServiceClientConfig {
    const config = this.configs.get(service);
    if (!config) throw new Error(`${service} service not configured`);
    return config;
  }

  /**
   * Makes one HTTP call to the service endpoint with timeout, retries, and
   * optional API-key injection. Fails fast when the circuit breaker is OPEN.
   * Throws on non-2xx or parsed error body.
   */
  private async callService<T>(opts: ServiceCallOptions<T>): Promise<T> {
    const { method, path, body, config, serviceLabel } = opts;
    const serviceType = serviceLabel as ServiceType;
    const cb = this.circuitBreakers.get(serviceType) ?? new CircuitBreaker();
    const logger = config.logger ?? console;

    if (!cb.allowRequest()) {
      throw new Error(`[${serviceLabel}] circuit breaker is OPEN — service temporarily unavailable`);
    }

    const url = `${config.endpoint}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.additionalHeaders ?? {}),
    };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    if (config.tenantId) headers['X-Tenant-Id'] = config.tenantId;

    let lastError: Error = new Error('No attempts made');
    const maxAttempts = config.retries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status} from ${serviceLabel}: ${errorText}`);
        }

        const result = await response.json() as T;
        cb.recordSuccess();
        return result;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (config.enableLogging) {
          logger.warn(`[${serviceLabel}] attempt ${attempt + 1}/${maxAttempts} failed:`, lastError.message);
        }
        if (!this.shouldRetry(lastError) || attempt + 1 >= maxAttempts) {
          break;
        }

        const backoffMs = this.calculateBackoffDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    cb.recordFailure();
    throw lastError;
  }

  private toError(error: unknown, code: string, service: ServiceType): AudioVideoError {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const statusCode = this.extractStatusCode(normalizedError);
    return {
      code,
      message: normalizedError.message,
      service,
      retryable: statusCode === undefined || statusCode >= 500 || statusCode === 429,
      timestamp: new Date(),
    };
  }

  private shouldRetry(error: Error): boolean {
    const statusCode = this.extractStatusCode(error);
    if (statusCode !== undefined) {
      return statusCode >= 500 || statusCode === 429;
    }
    return error.name === 'AbortError' || /timeout|temporarily unavailable|network/i.test(error.message);
  }

  private extractStatusCode(error: Error): number | undefined {
    const match = error.message.match(/HTTP\s+(\d{3})/i);
    return match ? Number(match[1]) : undefined;
  }

  private calculateBackoffDelay(attempt: number): number {
    const baseDelay = 200 * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * Math.min(250, baseDelay / 4));
    return baseDelay + jitter;
  }
}

/**
 * Factory function to create configured client
 */
export function createAudioVideoClient(configs: Record<ServiceType, ServiceClientConfig>): AudioVideoClient {
  return new AudioVideoClient(configs);
}

/**
 * Default configuration for development.
 *
 * NOTE: Ports 50051-50055 are gRPC ports. For TypeScript consumers, configure
 * the endpoint to point to an HTTP REST gateway or gRPC-Web proxy instead.
 * Use port 8080 for the HTTP REST/health endpoints in development.
 */
export const defaultConfigs: Record<ServiceType, ServiceClientConfig> = {
  stt: {
    endpoint: 'http://localhost:8081',
    timeout: 30000,
    retries: 3,
    enableLogging: true
  },
  tts: {
    endpoint: 'http://localhost:8082',
    timeout: 30000,
    retries: 3,
    enableLogging: true
  },
  'ai-voice': {
    endpoint: 'http://localhost:8083',
    timeout: 30000,
    retries: 3,
    enableLogging: true
  },
  vision: {
    endpoint: 'http://localhost:8084',
    timeout: 30000,
    retries: 3,
    enableLogging: true
  },
  multimodal: {
    endpoint: 'http://localhost:8085',
    timeout: 60000,
    retries: 3,
    enableLogging: true
  }
};
