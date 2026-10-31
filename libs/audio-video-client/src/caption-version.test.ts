import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  httpCaptionVersionTransport,
  requestFingerprint,
  saveCaptionVersion,
  type CaptionRegistrationRequest,
  type CaptionVersionTransport,
} from './caption-version.js';

const request = (overrides: Partial<CaptionRegistrationRequest> = {}): CaptionRegistrationRequest => ({
  requestId: 'req-1',
  sourceArtifactId: 'artifact-1',
  sourceArtifactVersionId: 'src-v1',
  parentVersionKind: 'TRANSCRIPT_VERSION',
  parentVersionId: 'transcript-v1',
  sourceClockId: 'clock.v1',
  ticksPerSecond: 90_000,
  sourceDurationTicks: 9_000_000,
  languageDisposition: 'DECLARED_BY_USER',
  languageTag: 'en',
  captionSegments: [
    { segmentId: 'seg-1', text: 'hello', startTick: 10, endTick: 900, origin: 'USER_EDITED' },
    { segmentId: 'seg-2', text: 'world', startTick: 900, endTick: 1800, origin: 'RECOGNIZED', speakerLabel: 'spk-1' },
  ],
  ...overrides,
});

const transport = (result: unknown): CaptionVersionTransport => ({
  register: vi.fn(async () => result) as never,
  versions: vi.fn(async () => []),
  version: vi.fn(async () => null),
});

const registered = (requestId: string) => ({
  requestId, requestFingerprint: 'f'.repeat(64), captionVersionId: 'capv-1',
  registrationReceiptId: 'capreg-1', sourceArtifactId: 'artifact-1', sourceArtifactVersionId: 'src-v1',
  parentVersionKind: 'TRANSCRIPT_VERSION' as const, parentVersionId: 'transcript-v1',
  languageDisposition: 'DECLARED_BY_USER' as const, sourceClockId: 'clock.v1', registeredAt: 1,
});

describe('caption-version-write HTTP transport binding', () => {
  const registered = (requestId: string) => ({
    requestId, requestFingerprint: 'a'.repeat(64), captionVersionId: 'capv-1',
    registrationReceiptId: 'capreg-1', sourceArtifactId: 'artifact-1',
    sourceArtifactVersionId: 'src-v1', parentVersionKind: 'TRANSCRIPT_VERSION' as const,
    parentVersionId: 'transcript-v1', languageDisposition: 'DECLARED_BY_USER' as const,
    sourceClockId: 'clock.v1', registeredAt: 1,
  });
  const request = () => ({
    requestId: 'req-1', sourceArtifactId: 'artifact-1', sourceArtifactVersionId: 'src-v1',
    parentVersionKind: 'TRANSCRIPT_VERSION' as const, parentVersionId: 'transcript-v1',
    sourceClockId: 'clock.v1', ticksPerSecond: 90_000, sourceDurationTicks: 9_000_000,
    languageDisposition: 'DECLARED_BY_USER' as const, languageTag: 'en',
    captionSegments: [{ segmentId: 'seg-1', text: 'hi', startTick: 10, endTick: 900, origin: 'USER_EDITED' as const }],
  });

  it('posts the registration to the canonical route and maps rejections', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; headers: HeadersInit }> = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as HeadersInit });
      if (calls.length === 1) {
        return new Response(JSON.stringify(registered('req-1')), { status: 201 });
      }
      return new Response(JSON.stringify({ error: { details: { requestId: 'req-2', requestFingerprint: 'b'.repeat(64), error: 'IDEMPOTENCY_CONFLICT', retryable: false } } }), { status: 409 });
    };
    const transport = httpCaptionVersionTransport({ baseUrl: 'http://media.test/', tenantId: 't', principalId: 'p', fetchImpl: fetchImpl as typeof fetch });
    const first = await transport.register({ ...request(), requestFingerprint: 'a'.repeat(64) });
    expect(first).toMatchObject({ captionVersionId: 'capv-1' });
    expect(calls[0].url).toBe('http://media.test/api/v1/caption-versions');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({ requestId: 'req-1', requestFingerprint: 'a'.repeat(64) });
    const conflict = await transport.register({ ...request(), requestFingerprint: 'c'.repeat(64) });
    expect(conflict).toMatchObject({ error: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  it('lists caption versions scoped to the source artifact version', async () => {
    const fetchImpl = async (url: string | URL) => new Response(
      JSON.stringify({ captionVersions: [registered('req-1')], count: 1 }), { status: 200 });
    const transport = httpCaptionVersionTransport({ baseUrl: 'http://media.test', tenantId: 't', principalId: 'p', fetchImpl: fetchImpl as typeof fetch });
    const versions = await transport.versions('t', 'p', 'artifact-1', 'src-v1');
    expect(versions).toHaveLength(1);
    expect(versions[0].requestId).toBe('req-1');
  });

  it('sends the supplied bearer credential and never lets identity hints substitute it', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify(registered('req-1')), { status: 201 });
    };
    const transport = httpCaptionVersionTransport({
      baseUrl: 'http://media.test', tenantId: 't', principalId: 'p',
      getAccessToken: async () => 'token-abc', fetchImpl: fetchImpl as typeof fetch,
    });
    await transport.register({ ...request(), requestFingerprint: 'a'.repeat(64) });
    expect(seen[0].authorization).toBe('Bearer token-abc');
    expect(seen[0]['x-principal-id']).toBe('p');
  });

  it('maps non-201 registration responses to typed outcomes without a detail body', async () => {
    const statuses: Array<[number, string, boolean]> = [
      [401, 'ACCESS_DENIED', false], [403, 'ACCESS_DENIED', false],
      [400, 'INVALID_REQUEST', false], [503, 'UNAVAILABLE', true],
    ];
    for (const [status, error, retryable] of statuses) {
      const transport = httpCaptionVersionTransport({
        baseUrl: 'http://media.test', tenantId: 't', principalId: 'p',
        fetchImpl: (async () => new Response('{}', { status })) as typeof fetch,
      });
      const result = await transport.register({ ...request(), requestFingerprint: 'a'.repeat(64) });
      expect(result).toMatchObject({ error, retryable, requestId: 'req-1' });
    }
  });

  it('throws typed read errors instead of collapsing failures to an empty list', async () => {
    for (const [status, code, retryable] of [
      [401, 'UNAUTHENTICATED', false], [403, 'ACCESS_DENIED', false], [503, 'UNAVAILABLE', true],
    ] as const) {
      const transport = httpCaptionVersionTransport({
        baseUrl: 'http://media.test', tenantId: 't', principalId: 'p',
        fetchImpl: (async () => new Response('{}', { status })) as typeof fetch,
      });
      await expect(transport.versions('t', 'p', 'artifact-1', 'src-v1'))
        .rejects.toMatchObject({ name: 'CaptionVersionReadError', code, retryable });
    }
  });

  it('reads one caption version by exact id and maps 404 to null', async () => {
    const snapshot = {
      ...registered('req-1'), ticksPerSecond: 90_000, sourceDurationTicks: 9_000_000,
      languageTag: 'en', captionSegments: [], registeredAt: 1,
    };
    const fetchImpl = async (url: string | URL) => {
      if (String(url).endsWith('/capv-missing')) return new Response('{}', { status: 404 });
      if (String(url).endsWith('/capv-1')) return new Response(JSON.stringify(snapshot), { status: 200 });
      return new Response('{}', { status: 503 });
    };
    const transport = httpCaptionVersionTransport({
      baseUrl: 'http://media.test', tenantId: 't', principalId: 'p', fetchImpl: fetchImpl as typeof fetch,
    });
    const found = await transport.version('capv-1');
    expect(found).toMatchObject({ captionVersionId: 'capv-1', requestId: 'req-1' });
    expect(await transport.version('capv-missing')).toBeNull();
    await expect(transport.version('capv-outage'))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });

  it('rejects a readback snapshot that echoes the wrong caption version id', async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ captionVersionId: 'capv-other', requestId: 'req-1' }), { status: 200 });
    const transport = httpCaptionVersionTransport({
      baseUrl: 'http://media.test', tenantId: 't', principalId: 'p', fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(transport.version('capv-1'))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
  });
});

describe('caption-version-write client (J-03)', () => {
  it('matches the shared Java/TS golden fingerprint vector', () => {
    const fixture = JSON.parse(readFileSync('../../test-fixtures/caption-registration-parity.v1.json', 'utf8'));
    const golden = request({ requestId: 'req-parity-1', purpose: 'j03 demo', captionSegments: [
      { segmentId: 'seg-1', text: 'Hello, "world"\nline2', startTick: 10, endTick: 900, origin: 'USER_EDITED' },
      { segmentId: 'seg-2', text: 'unicode-अक्षर-😀', startTick: 900, endTick: 1800, origin: 'RECOGNIZED', speakerLabel: 'spk-1' },
    ] });
    expect(requestFingerprint(fixture.tenantId, fixture.principalId, golden)).toBe(fixture.expectedRequestFingerprint);
  });

  it('computes a deterministic presence-sensitive fingerprint matching the spec tuple', () => {
    const a = requestFingerprint('t', 'p', request());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(requestFingerprint('t', 'p', request()));
    expect(requestFingerprint('t', 'p', request({ requestId: 'req-2' }))).toBe(a); // requestId is not fingerprinted
    expect(requestFingerprint('t2', 'p', request())).not.toBe(a);
    const { languageTag, ...noTag } = request();
    expect(requestFingerprint('t', 'p', noTag)).not.toBe(a);
    expect(requestFingerprint('t', 'p', request({ purpose: 'demo' }))).not.toBe(a);
  });

  it('validates request shape before dispatch', async () => {
    await expect(saveCaptionVersion(transport(registered('req-1')), 't', 'p', request({ requestId: '!!!' })))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(saveCaptionVersion(transport(registered('req-1')), 't', 'p', request({ captionSegments: [] })))
      .rejects.toMatchObject({ code: 'CAPTION_DRAFT_EMPTY' });
    await expect(saveCaptionVersion(transport(registered('req-1')), 't', 'p', request({
      captionSegments: [{ segmentId: 's', text: 'x', startTick: 5, endTick: 5, origin: 'RECOGNIZED' }],
    }))).rejects.toMatchObject({ code: 'CAPTION_ALIGNMENT_REQUIRED' });
    await expect(saveCaptionVersion(transport(registered('req-1')), 't', 'p', request({
      captionSegments: [{ segmentId: 's', text: 'lone \ud800 surrogate', startTick: 0, endTick: 1, origin: 'RECOGNIZED' }],
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('sends fingerprinted request and preserves server result', async () => {
    const t = transport(registered('req-1'));
    const result = await saveCaptionVersion(t, 't', 'p', request());
    expect(result).toMatchObject({ captionVersionId: 'capv-1', registrationReceiptId: 'capreg-1' });
    expect(t.register).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-1',
      requestFingerprint: requestFingerprint('t', 'p', request()),
    }));
  });

  it('maps transport failure and mismatched echo to UNKNOWN_OUTCOME for reconcile-first', async () => {
    const failing: CaptionVersionTransport = { register: vi.fn(async () => { throw new Error('conn refused'); }), versions: vi.fn() } as never;
    await expect(saveCaptionVersion(failing, 't', 'p', request()))
      .resolves.toMatchObject({ requestId: 'req-1', error: 'UNKNOWN_OUTCOME', retryable: true });
    await expect(saveCaptionVersion(transport(registered('other-req')), 't', 'p', request()))
      .resolves.toMatchObject({ error: 'UNKNOWN_OUTCOME' });
  });
});
