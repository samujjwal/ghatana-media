import { describe, expect, it } from 'vitest';
import {
  CaptionDraftError,
  CaptionDraftSession,
  timingAvailability,
  type CaptionSegment,
} from './caption-draft.js';

const scope = { tenantId: 'tenant-1', principalId: 'principal-1', activeSessionId: 'session-1' };
const clock = { sourceClockId: 'clock.src.v1', ticksPerSecond: 90_000, sourceDurationTicks: 9_000_000 };
const session = (lookup: () => typeof clock | null = () => clock) => new CaptionDraftSession(scope, () => lookup());

const segments = (overrides: Partial<CaptionSegment> = {}): CaptionSegment[] => [
  { segmentId: 'seg-1', text: 'hello', origin: 'RECOGNIZED', timing: { tag: 'NOT_SUPPLIED' }, ...overrides },
  { segmentId: 'seg-2', text: 'world', origin: 'RECOGNIZED', timing: { tag: 'NOT_SUPPLIED' } },
];

const parent = {
  sourceArtifactId: 'artifact-1', sourceArtifactVersionId: 'src-version-1',
  parentVersionKind: 'TRANSCRIPT_VERSION' as const, parentVersionId: 'transcript-v1',
};

const init = (s: CaptionDraftSession, segs = segments()) => s.initialize({ ...parent, segments: segs });
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === 'function' ? p() : p); return null; } catch (e) { return (e as CaptionDraftError).code; }
};

describe('session-local caption draft (J-03)', () => {
  it('initializes revision-0 snapshot bound to source/parent and refuses inferred segments', () => {
    const s = session();
    const snap = init(s);
    expect(snap.draftRevision).toBe(0);
    expect(snap.draftId).toMatch(/^draft-/);
    expect(snap.segments).toHaveLength(2);
    expect(snap.timingAvailability).toBe('NOT_SUPPLIED');
    expect(code(() => init(s, []))).resolves.toBe('DRAFT_INITIALIZATION_BLOCKED');
    expect(code(() => init(s, [{ ...segments()[0] }, { ...segments()[0] }]))).resolves.toBe('DRAFT_INITIALIZATION_BLOCKED'); // duplicate segmentId
  });

  it('TEXT_CORRECTION changes only target text/origin and increments revision under CAS', async () => {
    const s = session();
    const snap = init(s);
    const next = s.write({
      draftId: snap.draftId, expectedDraftRevision: 0, ...parent,
      segmentId: 'seg-1', edit: { editKind: 'TEXT_CORRECTION', text: 'HELLO' },
    });
    expect(next.draftRevision).toBe(1);
    expect(next.segments[0]).toMatchObject({ text: 'HELLO', origin: 'USER_EDITED' });
    expect(next.segments[1]).toMatchObject({ text: 'world', origin: 'RECOGNIZED' });
    expect(next.segments[0].timing).toEqual({ tag: 'NOT_SUPPLIED' });
    expect(s.read(snap.draftId).draftRevision).toBe(1);
    // stale CAS
    await expect(code(() => s.write({ draftId: snap.draftId, expectedDraftRevision: 0, ...parent, segmentId: 'seg-1', edit: { editKind: 'TEXT_CORRECTION', text: 'x' } }))).resolves.toBe('DRAFT_REVISION_CONFLICT');
  });

  it('TIMING_ALIGNMENT requires authoritative clock and valid range; marks only the target', async () => {
    const s = session();
    const snap = init(s);
    await expect(code(() => session(() => null).write({ draftId: init(session(() => null)).draftId, expectedDraftRevision: 0, ...parent, segmentId: 'seg-1', edit: { editKind: 'TIMING_ALIGNMENT', startTick: 100, endTick: 400 } }))).resolves.toBe('DRAFT_NOT_FOUND_IN_CALLER_SCOPE'); // separate session scope
    const noClock = session(() => null);
    const nc = init(noClock);
    await expect(code(() => noClock.write({ draftId: nc.draftId, expectedDraftRevision: 0, ...parent, segmentId: 'seg-1', edit: { editKind: 'TIMING_ALIGNMENT', startTick: 100, endTick: 400 } }))).resolves.toBe('SOURCE_CLOCK_UNAVAILABLE');
    const withClock = session();
    const snap2 = init(withClock);
    const next = withClock.write({
      draftId: snap2.draftId, expectedDraftRevision: 0, ...parent,
      segmentId: 'seg-1', edit: { editKind: 'TIMING_ALIGNMENT', startTick: 100, endTick: 400 },
    });
    expect(next.segments[0].timing).toEqual({ tag: 'SOURCE_TICKS', startTick: 100, endTick: 400, ...clock });
    expect(next.segments[0].origin).toBe('USER_EDITED');
    expect(next.timingAvailability).toBe('MIXED'); // NOT_SUPPLIED + SOURCE_TICKS
    await expect(code(() => withClock.write({ draftId: snap2.draftId, expectedDraftRevision: 1, ...parent, segmentId: 'seg-1', edit: { editKind: 'TIMING_ALIGNMENT', startTick: 500, endTick: 400 } }))).resolves.toBe('CAPTION_TIMING_INVALID');
    await expect(code(() => withClock.write({ draftId: snap2.draftId, expectedDraftRevision: 1, ...parent, segmentId: 'seg-1', edit: { editKind: 'TIMING_ALIGNMENT', startTick: 0, endTick: clock.sourceDurationTicks + 1 } }))).resolves.toBe('CAPTION_TIMING_INVALID');
  });

  it('enforces source/parent identity, segment existence, undo and discard', async () => {
    const s = session();
    const snap = init(s);
    const write = (expectedDraftRevision: number, extra: Record<string, unknown> = {}) =>
      () => s.write({ draftId: snap.draftId, expectedDraftRevision, ...parent, segmentId: 'seg-1', edit: { editKind: 'TEXT_CORRECTION', text: 'x' }, ...extra });
    await expect(code(write(0, { sourceArtifactVersionId: 'other' }))).resolves.toBe('SOURCE_IDENTITY_MISMATCH');
    await expect(code(write(0, { parentVersionId: 'other-parent' }))).resolves.toBe('PARENT_VERSION_STALE');
    await expect(code(() => s.write({ draftId: snap.draftId, expectedDraftRevision: 0, ...parent, segmentId: 'missing', edit: { editKind: 'TEXT_CORRECTION', text: 'x' } }))).resolves.toBe('CAPTION_SEGMENT_NOT_FOUND');
    await expect(code(() => s.undo({ draftId: snap.draftId, expectedDraftRevision: 0 }))).resolves.toBe('DRAFT_UNDO_NOT_AVAILABLE');
    s.write({ draftId: snap.draftId, expectedDraftRevision: 0, ...parent, segmentId: 'seg-1', edit: { editKind: 'TEXT_CORRECTION', text: 'edited' } });
    const undone = s.undo({ draftId: snap.draftId, expectedDraftRevision: 1 });
    expect(undone.draftRevision).toBe(2);
    expect(undone.segments[0].text).toBe('hello'); // prior content as NEW revision
    s.discard(snap.draftId);
    await expect(code(() => s.read(snap.draftId))).resolves.toBe('DRAFT_NOT_FOUND_IN_CALLER_SCOPE');
  });

  it('rebase allocates a distinct draftId at revision zero and preserves the stale draft', () => {
    const s = session();
    const snap = init(s);
    s.write({ draftId: snap.draftId, expectedDraftRevision: 0, ...parent, segmentId: 'seg-1', edit: { editKind: 'TEXT_CORRECTION', text: 'x' } });
    const rebased = s.rebase({ draftId: snap.draftId, ...parent, parentVersionId: 'transcript-v2' });
    expect(rebased.draftId).not.toBe(snap.draftId);
    expect(rebased.draftRevision).toBe(0);
    expect(rebased.parentVersionId).toBe('transcript-v2');
    expect(rebased.segments[0].text).toBe('x'); // faithful copy of current content
    expect(s.read(snap.draftId).draftRevision).toBe(1); // old draft retained
  });

  it('aggregate timing availability is conservative and never promoted', () => {
    const t = (tag: CaptionSegment['timing']) => ({ segmentId: `s-${Math.random()}`, text: 't', origin: 'RECOGNIZED' as const, timing: tag });
    expect(timingAvailability([t({ tag: 'SOURCE_TICKS', startTick: 0, endTick: 1, ...clock }), t({ tag: 'SOURCE_TICKS', startTick: 2, endTick: 3, ...clock })])).toBe('SOURCE_CLOCK_BOUND');
    expect(timingAvailability([t({ tag: 'SOURCE_TICKS', startTick: 0, endTick: 1, ...clock }), t({ tag: 'SOURCE_TICKS', startTick: 2, endTick: 3, sourceClockId: 'clock.other', ticksPerSecond: 90_000, sourceDurationTicks: 9_000_000 })])).toBe('MIXED');
    expect(timingAvailability([t({ tag: 'PROVIDER_TIME_UNQUALIFIED', start: 0, end: 2, declaredUnit: 'ms' }), t({ tag: 'PROVIDER_TIME_UNQUALIFIED', start: 2, end: 4, declaredUnit: 'ms' })])).toBe('PROVIDER_TIME_UNQUALIFIED');
    expect(() => timingAvailability([])).toThrow(CaptionDraftError);
  });
});
