/**
 * @doc.type client
 * @doc.purpose Unified service client for audio-video application
 * @doc.layer shared
 * @doc.pattern facade pattern
 */

import type {
  AudioFormat,
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
import { MediaOperationNotAdmittedError } from './http-core.js';
export {
  DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
  DOCUMENT_INTELLIGENCE_WORKER_V1,
  DocumentIntelligenceSceneTextAdapter,
  SceneTextAdapterError,
} from './scene-text-adapter.js';
export type {
  DocumentIntelligenceV1Client,
  SceneTextAdapterErrorCode,
  SceneTextAdapterPolicy,
  SceneTextObservation,
  SceneTextSourceFrame,
} from './scene-text-adapter.js';
export { CaptionDraftError, CaptionDraftSession, timingAvailability } from './caption-draft.js';
export type {
  CaptionDraftEdit,
  CaptionDraftErrorCode,
  CaptionDraftScope,
  CaptionDraftSnapshot,
  CaptionSegment,
  CaptionSegmentOrigin,
  CaptionSegmentTiming,
  ParentVersionKind,
  SourceClockContext,
  TimingAvailability,
} from './caption-draft.js';
export {
  CaptionRegistrationError,
  CaptionVersionReadError,
  httpCaptionVersionTransport,
  reconcileCaptionRegistration,
  requestFingerprint,
  saveCaptionVersion,
} from './caption-version.js';
export type {
  CaptionReadErrorCode,
  CaptionRegistrationRequest,
  CaptionVersionRegistered,
  CaptionVersionRejected,
  CaptionVersionSegment,
  CaptionVersionSnapshot,
  CaptionVersionTransport,
  HttpCaptionTransportOptions,
  LanguageDisposition,
  RegistrationErrorCode,
  SegmentOrigin,
} from './caption-version.js';
export { OfflineEditQueue, OfflineEditQueueError } from './offline-edit-queue.js';
export type {
  OfflineEdit,
  OfflineEditQueueOptions,
  OfflineEditRecord,
  OfflineEditReplayAdapter,
  OfflineEditReplayState,
  OfflineEditScope,
  OfflineEditState,
  OfflineEditStore,
} from './offline-edit-queue.js';
export { IndexedDbOfflineEditStore, IndexedDbOfflineEditStoreError } from './indexeddb-offline-edit-store.js';
export type { IndexedDbOfflineEditStoreErrorCode, IndexedDbOfflineEditStoreOptions } from './indexeddb-offline-edit-store.js';
export { OfflineReconnectCoordinator } from './offline-reconnect.js';
export type {
  OfflineReconnectOperations,
  OfflineReconnectResult,
  ScopedAuthorizationRead,
  ScopedEditApplyResult,
  ScopedProjectVersionRead,
} from './offline-reconnect.js';
export {
  CameraCaptureAdapter,
  CameraCaptureError,
  CameraCaptureSession,
} from './camera-capture-adapter.js';
export { createBrowserCameraMediaDevicePort } from './browser-camera-host.js';
export type { BrowserCameraHostOptions } from './browser-camera-host.js';
export type {
  CameraCaptureAdapterOptions,
  CameraCaptureErrorCode,
  CameraCapturedFrame,
  CameraAudioSampleObservation,
  CameraFrameRead,
  CameraTrackSourceMetadata,
  CameraConsentPort,
  CameraFrameClockPort,
  CameraMediaDevicePort,
  CameraPermissionDecision,
  CameraPermissionDisposition,
  CameraTrack,
  CameraCaptureSessionLimits,
} from './camera-capture-adapter.js';
export type {
  CameraAudioSampleTime,
  CameraCaptureMetadata,
  CameraClockMappingUncertainty,
  CameraDiscontinuity,
  CameraPositiveRational,
  CameraSignal,
  CameraSourcePresentationTime,
} from './capture-adapters.js';

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
  validateResponse?: (input: unknown) => T;
}

/** A legacy processing POST crossed dispatch without a final receipt. */
class LegacyOperationOutcomeUnknownError extends Error {
  public constructor(public readonly requestId: string) {
    super('The Media operation outcome is unknown after dispatch. Reconcile its durable status before retrying.');
    this.name = 'LegacyOperationOutcomeUnknownError';
  }
}

function asResponseRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} response must be an object.`);
  }
  return input as Record<string, unknown>;
}

function validateLegacyTtsResponse(input: unknown): TTSResult {
  const result = asResponseRecord(input, 'TTS');
  const audio = asResponseRecord(result.audio, 'TTS audio');
  const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const audioFormats: ReadonlySet<AudioFormat> = new Set(['pcm', 'wav', 'mp3', 'flac', 'ogg', 'aac']);
  if (!(audio.data instanceof ArrayBuffer) || !finiteNumber(audio.sampleRate)
    || !finiteNumber(audio.channels) || !finiteNumber(audio.bitsPerSample)
    || !finiteNumber(audio.durationMs) || typeof audio.format !== 'string'
    || !audioFormats.has(audio.format as AudioFormat)
    || typeof result.voiceUsed !== 'string' || !finiteNumber(result.processingTimeMs)
    || !finiteNumber(result.characters) || !finiteNumber(result.durationMs)) {
    throw new TypeError('TTS response does not match the declared result fields.');
  }
  return input as TTSResult;
}

function validateLegacyAiVoiceResponse(input: unknown): AIVoiceResult {
  const result = asResponseRecord(input, 'AI voice');
  if (typeof result.processedText !== 'string' || typeof result.originalText !== 'string'
    || typeof result.task !== 'string' || typeof result.processingTimeMs !== 'number'
    || !Number.isFinite(result.processingTimeMs) || typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)) {
    throw new TypeError('AI voice response does not match the declared result fields.');
  }
  return input as AIVoiceResult;
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
 * LEGACY_COMPATIBILITY: preserves the existing unversioned modality-route
 * client contract. Semantic mapping, wire parity, and consumer migration are
 * pending; this annotation does not change routes or runtime behavior.
 *
 * Historical description: unified audio-video service client.
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
        validateResponse: parseSTTResult,
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
        validateResponse: validateLegacyTtsResponse,
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
        validateResponse: validateLegacyAiVoiceResponse,
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
        validateResponse: parseDetectionResult,
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
        validateResponse: parseMultimodalResult,
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
    if (!(method === 'GET' && path === '/health')) {
      const operation: Record<string, string> = {
        stt: 'media.sdk.legacy.AudioVideoClient.transcribe',
        tts: 'media.sdk.legacy.AudioVideoClient.synthesize',
        'ai-voice': 'media.sdk.processAIVoice',
        vision: 'media.sdk.processVision',
        multimodal: 'media.sdk.processMultimodal',
      };
      throw new MediaOperationNotAdmittedError(operation[serviceLabel] ?? 'media.sdk.legacy-unbound');
    }
    const serviceType = serviceLabel as ServiceType;
    const cb = this.circuitBreakers.get(serviceType) ?? new CircuitBreaker();
    const logger = config.logger ?? console;

    if (!cb.allowRequest()) {
      throw new Error(`[${serviceLabel}] circuit breaker is OPEN — service temporarily unavailable`);
    }

    const url = `${config.endpoint}${path}`;
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.additionalHeaders ?? {}),
    };
    // Remove request ID defaults case-insensitively before setting one
    // generated trace identity for this call and its allowed GET retries.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'x-request-id') delete headers[name];
    }
    headers['X-Request-ID'] = crypto.randomUUID();
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    if (config.tenantId) headers['X-Tenant-Id'] = config.tenantId;

    let lastError: Error = new Error('No attempts made');
    // Only GET is a no-effect read in this legacy client. The modality POST
    // routes have no admitted idempotent replay contract.
    const maxAttempts = method === 'GET' ? config.retries + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: serializedBody,
          signal: controller.signal,
          ...(method === 'GET' ? {} : { redirect: 'error' as const }),
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          if (method !== 'GET' && response.status >= 500) {
            throw new LegacyOperationOutcomeUnknownError(headers['X-Request-ID']!);
          }
          throw new Error(`HTTP ${response.status} from ${serviceLabel}`);
        }

        let result: T;
        try {
          const responseBody: unknown = await response.json();
          result = opts.validateResponse ? opts.validateResponse(responseBody) : responseBody as T;
        } catch {
          if (method !== 'GET') throw new LegacyOperationOutcomeUnknownError(headers['X-Request-ID']!);
          throw new Error(`Invalid JSON response from ${serviceLabel}`);
        }
        cb.recordSuccess();
        return result;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = method !== 'GET' && !(err instanceof LegacyOperationOutcomeUnknownError)
          && !(err instanceof Error && /^HTTP (?:400|401|403)\b/u.test(err.message))
          ? new LegacyOperationOutcomeUnknownError(headers['X-Request-ID']!)
          : err instanceof Error ? err : new Error(String(err));
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
    if (error instanceof MediaOperationNotAdmittedError) {
      return {
        code: 'NOT_ADMITTED',
        message: error.message,
        service,
        retryable: false,
        timestamp: new Date(),
      };
    }
    if (error instanceof LegacyOperationOutcomeUnknownError) {
      return {
        code: 'OUTCOME_UNKNOWN',
        message: error.message,
        service,
        details: { requestId: error.requestId },
        retryable: false,
        timestamp: new Date(),
      };
    }
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

export { canonicalMediaHttpRoutes, legacyCompatibilityRoutes, mediaHttpRouteAuthority } from './canonical-routes.js';

export {
  MediaSceneTextAdmissionError, recognizeAuthorizedMediaSceneText,
} from './authorized-scene-text.js';
export type {
  MediaSceneTextAccess, MediaSceneTextDecision,
  MediaSceneTextSourceAuthority, AuthorizedMediaSceneTextObservation,
} from './authorized-scene-text.js';
