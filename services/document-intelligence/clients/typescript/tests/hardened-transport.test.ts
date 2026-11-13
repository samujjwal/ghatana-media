import { describe, expect, it } from 'vitest';
import { DocumentExtractionError } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient, PROTOCOL_VERSION } from '../src/index.js';

const base = 'http://127.0.0.1:8765';
const generation = 'a'.repeat(32);
const embed = (client: DocumentIntelligenceClient) => client.embed({ operationId: 'op', providerRef: 'ghatana.minilm', timeoutMs: 100, limits: {}, projection: {} });
const clientFor = (fetchImpl: typeof fetch, maxResponseBytes?: number) => new DocumentIntelligenceClient({ baseUrl: base, fetchImpl, ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }) });

describe('malformed and oversized worker responses', () => {
  it.each([
    ['non-JSON', 'not json'],
    ['empty', ''],
    ['array', '[]'],
    ['wrong protocol', JSON.stringify({ protocolVersion: 'document-intelligence.v2', operationId: 'op', providerRef: 'ghatana.minilm', dimensions: 384, values: [] })],
    ['invalid UTF-8 JSON', '\u0000'],
  ])('maps %s success bodies to the typed invariant error', async (_name, body) => {
    const error = await embed(clientFor((async () => new Response(body, { status: 200 })) as typeof fetch)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DocumentExtractionError);
    expect(error).toMatchObject({ code: 'INTERNAL_INVARIANT' });
  });

  it('rejects an oversized body without parsing it (streamed and content-length declared)', async () => {
    const huge = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operationId: 'op', providerRef: 'ghatana.minilm', pad: 'x'.repeat(5000) });
    const streamed = await embed(clientFor((async () => new Response(huge, { status: 200 })) as typeof fetch, 1024)).catch((cause: unknown) => cause);
    expect(streamed).toMatchObject({ code: 'INTERNAL_INVARIANT' });
    const declared = await embed(clientFor((async () => new Response('{}', { status: 200, headers: { 'content-length': '999999' } })) as typeof fetch, 1024)).catch((cause: unknown) => cause);
    expect(declared).toMatchObject({ code: 'INTERNAL_INVARIANT' });
    const oversizedError = await embed(clientFor((async () => new Response(huge, { status: 422 })) as typeof fetch, 1024)).catch((cause: unknown) => cause);
    expect(oversizedError).toMatchObject({ code: 'INTERNAL_INVARIANT' });
  });
});

describe('cancellation ambiguity', () => {
  const ack = (overrides: Record<string, unknown> = {}) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operationId: 'op', operationGeneration: generation, cancelled: true, ...overrides });
  const run = (response: () => Response | Promise<Response>) => clientFor((async () => response()) as typeof fetch).cancelWithOutcome('op', generation);

  it('is CANCELLED only for a matching, generation-bound, positive 2xx acknowledgement', async () => {
    const calls: RequestInit[] = [];
    const client = clientFor((async (_url: string | URL | Request, init?: RequestInit) => { calls.push(init ?? {}); return new Response(ack(), { status: 200 }); }) as typeof fetch);
    await expect(client.cancelWithOutcome('op', generation)).resolves.toBe('CANCELLED');
    expect(calls[0]?.method).toBe('DELETE');
    expect(new Headers(calls[0]?.headers).get('x-operation-generation')).toBe(generation);
  });

  it.each([
    ['cancelled=false', () => new Response(ack({ cancelled: false }), { status: 200 })],
    ['stale generation', () => new Response(ack({ operationGeneration: 'b'.repeat(32) }), { status: 200 })],
    ['other operation', () => new Response(ack({ operationId: 'other' }), { status: 200 })],
    ['wrong protocol', () => new Response(ack({ protocolVersion: 'document-intelligence.v2' }), { status: 200 })],
    ['5xx with perfect body', () => new Response(ack(), { status: 500 })],
    ['malformed', () => new Response('{{{', { status: 200 })],
    ['empty (lost acknowledgement)', () => new Response('', { status: 200 })],
    ['oversized', () => new Response(ack({ pad: 'p'.repeat(40 * 1024 * 1024) }), { status: 200 })],
    ['transport failure', () => { throw new TypeError('network down'); }],
  ])('remains UNKNOWN for %s', async (_name, response) => {
    await expect(run(response)).resolves.toBe('UNKNOWN');
  });

  it('local abort is a caller-side CANCELLED error, not a confirmed remote cancellation', async () => {
    const controller = new AbortController();
    const deletes: string[] = [];
    const client = clientFor((async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deletes.push('x'); throw new TypeError('lost'); }
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    }) as typeof fetch);
    const pending = embed(client).catch((cause: unknown) => cause);
    const pendingWithSignal = client.embed({ operationId: 'op', providerRef: 'ghatana.minilm', timeoutMs: 1000, limits: {}, projection: {}, signal: controller.signal }).catch((cause: unknown) => cause);
    controller.abort();
    expect(await pendingWithSignal).toMatchObject({ code: 'CANCELLED' });
    expect(deletes).toHaveLength(1);
    await pending; // timeout path resolves independently as EXTERNAL_CALL_TIMEOUT
  });
});

describe('tenant isolation boundary', () => {
  it('carries no tenant or principal in the frozen v1 wire body; the Kernel/Media facade owns tenant scoping', async () => {
    let body = '';
    const client = clientFor((async (_url: string | URL | Request, init?: RequestInit) => { body = String(init?.body); return new Response('{}', { status: 400 }); }) as typeof fetch);
    await embed(client).catch(() => undefined);
    expect(body).not.toMatch(/tenant|principal|consent/iu);
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(['limits', 'operationGeneration', 'operationId', 'projection', 'protocolVersion', 'providerRef', 'timeoutMs']);
  });
});
