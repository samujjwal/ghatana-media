import { describe, expect, it } from 'vitest';
import { DocumentExtractionError } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../src/client.js';

describe('worker client', () => {
  it('does not retry generic HTTP transport', async () => {
    let calls = 0;
    const client = new DocumentIntelligenceClient({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: (async () => { calls += 1; return new Response(JSON.stringify({ protocolVersion: 'document-intelligence.v1', operationId: 'op', code: 'TIMEOUT', retryable: true }), { status: 504 }); }) as typeof fetch });
    await expect(client.embed({ operationId: 'op', providerRef: 'ghatana.minilm', timeoutMs: 100, limits: {}, projection: {} })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('maps malformed successful worker responses to the typed Shared error contract', async () => {
    const client = new DocumentIntelligenceClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: (async () => new Response(JSON.stringify({
        protocolVersion: 'document-intelligence.v1',
        operationId: 'op',
        providerRef: 'ghatana.minilm',
        dimensions: 384,
        values: Array.from({ length: 384 }, () => 0),
        unexpected: 'provider-internal-detail',
      }), { status: 200 })) as typeof fetch,
    });

    const error = await client.embed({
      operationId: 'op', providerRef: 'ghatana.minilm', timeoutMs: 100, limits: {}, projection: {},
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DocumentExtractionError);
    expect(error).toMatchObject({ code: 'INTERNAL_INVARIANT', providerRef: 'ghatana.minilm' });
    expect((error as Error).message).not.toContain('provider-internal-detail');
  });

  it('sends a fresh operation generation on submission and scopes abort cancellation to it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const controller = new AbortController();
    const client = new DocumentIntelligenceClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }) as typeof fetch,
    });

    const pending = client.embed({ operationId: 'reused-id', providerRef: 'ghatana.minilm', timeoutMs: 1000, limits: {}, projection: {}, signal: controller.signal });
    expect(calls).toHaveLength(1);
    const submission = calls[0]!;
    const requestBody = JSON.parse(String(submission.init?.body)) as { operationId: string; operationGeneration: string };
    const generation = requestBody.operationGeneration;
    expect(requestBody.operationId).toBe('reused-id');
    expect(generation).toMatch(/^[0-9a-f]{32}$/u);
    expect(new Headers(submission.init?.headers).get('x-operation-generation')).toBe(generation);

    controller.abort();
    await expect(pending).rejects.toThrow();
    const cancellation = calls.find((call) => call.init?.method === 'DELETE');
    expect(cancellation?.url).toBe('http://127.0.0.1:8765/v1/operations/reused-id');
    expect(new Headers(cancellation?.init?.headers).get('x-operation-generation')).toBe(generation);
  });
});
