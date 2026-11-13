import { DocumentExtractionError } from '@ghatana/document-extraction';
import { LEGACY_WORKER_CAPABILITY_VERSION, PROTOCOL_VERSION, WORKER_CAPABILITY_VERSIONS, type WireEmbeddingResponse, type WireError, type WireExtractionResponse, type WireParsedDocument, type WireProviderCatalog } from './protocol.js';
import { mapWorkerError, cancelledError } from './errors.js';
import { validateEmbeddingResponse, validateError, validateExtractionResponse, validateParsedResponse, validateProviderCatalog } from './validators.js';

export interface DocumentIntelligenceClientOptions { readonly baseUrl: string; readonly fetchImpl?: typeof fetch; readonly defaultTimeoutMs?: number; readonly maxUploadBytes?: number; /** Upper bound for any worker response body (default 32 MiB); larger bodies are treated as invalid, never partially parsed. */ readonly maxResponseBytes?: number; }
export interface ParseTransportInput { readonly operationId: string; readonly operationGeneration?: string; readonly providerRef: string; readonly mediaType: string; readonly languageHint?: string; readonly timeoutMs: number; readonly limits: Readonly<Record<string, number>>; readonly bytes: Uint8Array; readonly signal?: AbortSignal; }
export interface ExtractTransportInput { readonly operationId: string; readonly operationGeneration?: string; readonly providerRef: string; readonly timeoutMs: number; readonly limits: Readonly<Record<string, number>>; readonly fields: readonly Record<string, unknown>[]; readonly parsed: unknown; readonly languageHint?: string; readonly signal?: AbortSignal; }
export interface EmbedTransportInput { readonly operationId: string; readonly operationGeneration?: string; readonly providerRef: string; readonly timeoutMs: number; readonly limits: Readonly<Record<string, number>>; readonly projection: Record<string, unknown>; readonly signal?: AbortSignal; }

const OPERATION_GENERATION_PATTERN = /^[0-9a-f]{32}$/u;

function createOperationGeneration(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function operationGenerationFor(input: { readonly operationGeneration?: string }): string {
  const generation = input.operationGeneration ?? createOperationGeneration();
  if (!OPERATION_GENERATION_PATTERN.test(generation)) throw new DocumentExtractionError('INTERNAL_INVARIANT');
  return generation;
}

export class DocumentIntelligenceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly maxUploadBytes: number;
  private readonly maxResponseBytes: number;
  private workerCapabilityVersion: string | undefined;
  private protocolVersion: string | undefined;
  constructor(options: DocumentIntelligenceClientOptions) { this.baseUrl = options.baseUrl.replace(/\/$/u, ''); this.fetchImpl = options.fetchImpl ?? fetch; this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000; this.maxUploadBytes = options.maxUploadBytes ?? 50 * 1024 * 1024; this.maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024; }

  /** Capability revision declared by the worker in the last /v1/providers response; 'document-intelligence.v1-legacy' when the worker declares none, undefined before the first catalog fetch. */
  get lastWorkerCapabilityVersion(): string | undefined { return this.workerCapabilityVersion; }
  /** protocolVersion carried by the last validated /v1/providers response; undefined before the first catalog fetch. */
  get lastProtocolVersion(): string | undefined { return this.protocolVersion; }

  private correlate<T extends { operationId: string; providerRef: string }>(value: T, operationId: string, providerRef: string): T {
    if (value.operationId !== operationId || value.providerRef !== providerRef) throw new DocumentExtractionError('INTERNAL_INVARIANT', { providerRef });
    return value;
  }

  private validateResponse<T>(value: unknown, validate: (input: unknown) => T, providerRef?: string): T {
    try {
      return validate(value);
    } catch {
      // Worker response details are untrusted. Keep validator exceptions inside
      // the public Shared error contract and avoid surfacing raw payload details.
      throw new DocumentExtractionError('INTERNAL_INVARIANT', { providerRef });
    }
  }

  /** Reads at most maxResponseBytes; oversized or non-JSON bodies yield undefined and are rejected by the caller's validators. */
  private async readBoundedJson(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) { void response.body?.cancel().catch(() => undefined); return undefined; }
    if (!response.body) return undefined;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) { void reader.cancel().catch(() => undefined); return undefined; }
        chunks.push(value);
      }
    } catch (error) { if ((error as { name?: string }).name === 'AbortError') throw error; return undefined; }
    const joined = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown; } catch { return undefined; }
  }

  private async request(path: string, init: RequestInit, operationId: string, operationGeneration?: string, providerRef?: string, timeoutMs = this.defaultTimeoutMs, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      const body: unknown = await this.readBoundedJson(response);
      if (!response.ok) { if (body !== undefined) { try { throw mapWorkerError(validateError(body), providerRef); } catch (error) { if (error instanceof DocumentExtractionError) throw error; } } throw new DocumentExtractionError('INTERNAL_INVARIANT', { providerRef }); }
      return body;
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) { if (signal?.aborted) { if (operationGeneration !== undefined) void this.cancel(operationId, operationGeneration); throw cancelledError(providerRef); } throw new DocumentExtractionError('EXTERNAL_CALL_TIMEOUT', { retryable: true, providerRef }); }
      if (error instanceof DocumentExtractionError) throw error;
      throw new DocumentExtractionError('INTERNAL_INVARIANT', { providerRef });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async parse(input: ParseTransportInput): Promise<WireParsedDocument> {
    if (input.bytes.byteLength > this.maxUploadBytes) throw new DocumentExtractionError('SOURCE_TOO_LARGE', { providerRef: input.providerRef });
    const operationGeneration = operationGenerationFor(input);
    const form = new FormData(); form.append('metadata', JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operationId: input.operationId, operationGeneration, providerRef: input.providerRef, mediaType: input.mediaType, ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }), timeoutMs: input.timeoutMs, limits: input.limits })); form.append('file', new Blob([new Uint8Array(input.bytes)]), 'upload.bin');
    return this.correlate(this.validateResponse(await this.request('/v1/parse', { method: 'POST', headers: { 'x-operation-generation': operationGeneration }, body: form }, input.operationId, operationGeneration, input.providerRef, input.timeoutMs, input.signal), validateParsedResponse, input.providerRef), input.operationId, input.providerRef);
  }
  async extract(input: ExtractTransportInput): Promise<WireExtractionResponse> {
    const operationGeneration = operationGenerationFor(input);
    return this.correlate(this.validateResponse(await this.request('/v1/extract', { method: 'POST', headers: { 'content-type': 'application/json', 'x-operation-generation': operationGeneration }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operationId: input.operationId, operationGeneration, providerRef: input.providerRef, timeoutMs: input.timeoutMs, limits: input.limits, languageHint: input.languageHint, payload: { fields: input.fields, parsed: input.parsed } }) }, input.operationId, operationGeneration, input.providerRef, input.timeoutMs, input.signal), validateExtractionResponse, input.providerRef), input.operationId, input.providerRef);
  }
  async embed(input: EmbedTransportInput): Promise<WireEmbeddingResponse> {
    const operationGeneration = operationGenerationFor(input);
    return this.correlate(this.validateResponse(await this.request('/v1/embed', { method: 'POST', headers: { 'content-type': 'application/json', 'x-operation-generation': operationGeneration }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operationId: input.operationId, operationGeneration, providerRef: input.providerRef, projection: input.projection, timeoutMs: input.timeoutMs, limits: input.limits }) }, input.operationId, operationGeneration, input.providerRef, input.timeoutMs, input.signal), validateEmbeddingResponse, input.providerRef), input.operationId, input.providerRef);
  }
  async cancel(operationId: string, operationGeneration: string): Promise<void> {
    if (!OPERATION_GENERATION_PATTERN.test(operationGeneration)) throw new DocumentExtractionError('INTERNAL_INVARIANT');
    try { await this.fetchImpl(`${this.baseUrl}/v1/operations/${encodeURIComponent(operationId)}`, { method: 'DELETE', headers: { 'x-operation-generation': operationGeneration } }); } catch { /* cancellation is idempotent and must not surface raw transport errors */ }
  }

  /**
   * Generation-bound cancellation with a truthful outcome. Only a 2xx acknowledgement that echoes this exact
   * protocolVersion, operationId and operationGeneration with cancelled=true is CANCELLED; every other outcome
   * (transport failure, non-2xx, malformed/oversized/mismatched acknowledgement, cancelled=false) is UNKNOWN.
   * document-intelligence.v1 has no status GET, so UNKNOWN cannot be resolved by polling.
   */
  async cancelWithOutcome(operationId: string, operationGeneration: string): Promise<'CANCELLED' | 'UNKNOWN'> {
    if (!OPERATION_GENERATION_PATTERN.test(operationGeneration)) throw new DocumentExtractionError('INTERNAL_INVARIANT');
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/operations/${encodeURIComponent(operationId)}`, { method: 'DELETE', headers: { 'x-operation-generation': operationGeneration } });
      const ack = await this.readBoundedJson(response);
      const record = ack !== null && typeof ack === 'object' && !Array.isArray(ack) ? ack as Record<string, unknown> : undefined;
      return response.ok && record?.protocolVersion === PROTOCOL_VERSION && record.operationId === operationId && record.operationGeneration === operationGeneration && record.cancelled === true ? 'CANCELLED' : 'UNKNOWN';
    } catch { return 'UNKNOWN'; }
  }
  async providers(signal?: AbortSignal): Promise<WireProviderCatalog> {
    const catalog = this.validateResponse(await this.request('/v1/providers', { method: 'GET' }, 'catalog', undefined, undefined, this.defaultTimeoutMs, signal), validateProviderCatalog);
    if (catalog.workerCapabilityVersion !== undefined && !(WORKER_CAPABILITY_VERSIONS as readonly string[]).includes(catalog.workerCapabilityVersion)) throw new DocumentExtractionError('INTERNAL_INVARIANT');
    this.protocolVersion = catalog.protocolVersion;
    this.workerCapabilityVersion = catalog.workerCapabilityVersion ?? LEGACY_WORKER_CAPABILITY_VERSION;
    return catalog;
  }
}
