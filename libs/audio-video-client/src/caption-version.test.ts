import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
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
});

const registered = (requestId: string) => ({
  requestId, requestFingerprint: 'f'.repeat(64), captionVersionId: 'capv-1',
  registrationReceiptId: 'capreg-1', sourceArtifactId: 'artifact-1', sourceArtifactVersionId: 'src-v1',
  parentVersionKind: 'TRANSCRIPT_VERSION' as const, parentVersionId: 'transcript-v1',
  languageDisposition: 'DECLARED_BY_USER' as const, sourceClockId: 'clock.v1', registeredAt: 1,
});

describe('caption-version-write client (J-03)', () => {
  it('matches the shared Java/TS golden fingerprint vector', () => {
    const fixture = JSON.parse(readFileSync('../../test-fixtures/caption-registration-parity.v1.json', 'utf8'));
    const golden = request({ requestId: 'req-parity-1', purpose: 'j03 demo' });
    golden.captionSegments[0] = { segmentId: 'seg-1', text: 'Hello, "world"\nline2', startTick: 10, endTick: 900, origin: 'USER_EDITED' };
    golden.captionSegments[1] = { segmentId: 'seg-2', text: 'unicode-अक्षर-😀', startTick: 900, endTick: 1800, origin: 'RECOGNIZED', speakerLabel: 'spk-1' };
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
