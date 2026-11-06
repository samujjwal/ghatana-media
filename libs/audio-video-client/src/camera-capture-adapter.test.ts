import { describe, expect, it } from "vitest";
import type { CaptureRequest } from "./capture-adapters.js";
import {
  CameraCaptureAdapter,
  CameraCaptureError,
  type CameraCaptureSession,
  type CameraConsentPort,
  type CameraFrameClockPort,
  type CameraMediaDevicePort,
  type CameraPermissionDecision,
  type CameraTrack,
} from "./camera-capture-adapter.js";

const now = 1_800_000_000_000;
const request: CaptureRequest = {
  kind: "CAMERA",
  sourceIdentity: "camera:device-1",
  purposeRef: "purpose/record-scene/v3",
  exactRightsScope: "rights/camera-device-1/v4",
  sourceVersionRef: "camera-device-1@v2",
  secretsRef: "secrets/camera-session-1",
  frameClockRef: "clock/camera-monotonic",
};

interface FakeTrack extends CameraTrack {
  stopCalls: number;
  nextFrame(signal: AbortSignal): Promise<Uint8Array | null>;
}

function frameTrack(frames: ReadonlyArray<Uint8Array>): FakeTrack {
  let index = 0;
  const track: FakeTrack = {
    stopCalls: 0,
    async nextFrame(signal) {
      if (signal.aborted) throw new Error("aborted");
      return index < frames.length ? frames[index++] : null;
    },
    stopTracks() { track.stopCalls++; },
  };
  return track;
}

function permissionFor(candidate: CaptureRequest, overrides: Partial<CameraPermissionDecision> = {}): CameraPermissionDecision {
  return {
    disposition: "GRANTED",
    sourceIdentity: candidate.sourceIdentity,
    purposeRef: candidate.purposeRef,
    exactRightsScope: candidate.exactRightsScope,
    sourceVersionRef: candidate.sourceVersionRef,
    decisionRef: "consent-read:v17",
    checkedAtEpochMillis: now,
    expiresAtEpochMillis: now + 30_000,
    ...overrides,
  };
}

function harness(options: {
  decide?: (candidate: CaptureRequest, at: number) => CameraPermissionDecision;
  tracks?: FakeTrack[];
  pts?: (epochRef: string, index: number) => bigint | number;
} = {}) {
  const tracks = options.tracks ?? [frameTrack([new Uint8Array([1, 2, 3])])];
  const opens: CaptureRequest[] = [];
  const subscriptions: Array<{ request: CaptureRequest; listener: (state: "GRANTED" | "DENIED" | "REVOKED" | "UNKNOWN") => void; active: boolean }> = [];
  const clockIndex = new Map<string, number>();
  let epoch = 0;
  const clock: CameraFrameClockPort = {
    nowEpochMillis: () => now,
    beginEpoch: () => `clock-epoch-${++epoch}`,
    readPtsNanos: (epochRef) => {
      const index = clockIndex.get(epochRef) ?? 0;
      clockIndex.set(epochRef, index + 1);
      return options.pts?.(epochRef, index) ?? BigInt(index + 1) * 33_333_333n;
    },
  };
  const consent: CameraConsentPort = {
    checkFresh: async (candidate, at) => options.decide?.(candidate, at) ?? permissionFor(candidate),
    subscribe(candidate, listener) {
      const entry = { request: candidate, listener, active: true };
      subscriptions.push(entry);
      return () => { entry.active = false; };
    },
  };
  const mediaDevices: CameraMediaDevicePort = {
    async open(candidate, signal) {
      opens.push(candidate);
      if (signal.aborted) throw new Error("aborted before open");
      const track = tracks[opens.length - 1];
      if (!track) throw new Error("no mock camera track");
      return track;
    },
  };
  const adapter = new CameraCaptureAdapter({ mediaDevices, consent, frameClock: clock,
    maxFrameBytes: 64, maxFrames: 10, maxSessionMillis: 10_000 });
  return {
    adapter,
    opens,
    tracks,
    subscriptions,
    revoke(index = 0, disposition: "DENIED" | "REVOKED" = "REVOKED") {
      const entry = subscriptions[index];
      if (entry?.active) entry.listener(disposition);
    },
  };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: "CameraCaptureError", code });
}

describe("CameraCaptureAdapter", () => {
  it("requires fresh exact source and purpose permission before opening the camera", async () => {
    for (const [code, decision] of [
      ["PERMISSION_DENIED", permissionFor(request, { disposition: "DENIED" })],
      ["PERMISSION_STALE", permissionFor(request, { checkedAtEpochMillis: now - 6_000 })],
      ["PERMISSION_MISMATCH", permissionFor(request, { purposeRef: "purpose/other" })],
      ["PERMISSION_MISMATCH", permissionFor(request, { sourceIdentity: "camera:other" })],
    ] as const) {
      const h = harness({ decide: () => decision });
      await expectCode(h.adapter.openSession(request), code);
      expect(h.opens).toHaveLength(0);
    }
  });

  it("captures detached bounded bytes with exact bindings and increasing PTS", async () => {
    const original = new Uint8Array([7, 8]);
    const track = frameTrack([original, new Uint8Array([9])]);
    const h = harness({ tracks: [track] });
    const session = await h.adapter.openSession(request);
    const first = await session.nextFrame();
    const second = await session.nextFrame();
    original[0] = 99;
    first.bytes[1] = 88;

    expect(first.bytes).toEqual(new Uint8Array([7, 88]));
    expect(second.bytes).toEqual(new Uint8Array([9]));
    expect(first.sourceIdentity).toBe(request.sourceIdentity);
    expect(first.purposeRef).toBe(request.purposeRef);
    expect(first.epochRef).toBe(second.epochRef);
    expect(second.ptsNanos).toBeGreaterThan(first.ptsNanos);
    await session.close();
    expect(track.stopCalls).toBe(1);
  });

  it("revocation aborts an in-flight read, stops tracks once and never returns frame bytes", async () => {
    let resolvePending: ((bytes: Uint8Array) => void) | undefined;
    const track: FakeTrack = {
      stopCalls: 0,
      nextFrame: () => new Promise<Uint8Array>((resolve) => { resolvePending = resolve; }),
      stopTracks() { track.stopCalls++; },
    };
    const h = harness({ tracks: [track] });
    const session = await h.adapter.openSession(request);
    const pending = session.nextFrame();
    await Promise.resolve();
    h.revoke();
    await expectCode(pending, "CONSENT_REVOKED");
    resolvePending?.(new Uint8Array([0xde, 0xad]));
    await session.close();
    expect(track.stopCalls).toBe(1);
    expect(h.opens).toHaveLength(1);
  });

  it("switches to a newly authorized device, detaches old tracks once and resets PTS by epoch", async () => {
    const oldTrack = frameTrack([new Uint8Array([1])]);
    const newTrack = frameTrack([new Uint8Array([2])]);
    const h = harness({
      tracks: [oldTrack, newTrack],
      pts: (epochRef) => epochRef === "clock-epoch-1" ? 100n : 1n,
    });
    const session = await h.adapter.openSession(request);
    const oldFrame = await session.nextFrame();
    const nextRequest = { ...request, sourceIdentity: "camera:device-2",
      exactRightsScope: "rights/camera-device-2/v1", sourceVersionRef: "camera-device-2@v1" };
    await session.switchDevice(nextRequest);
    const newFrame = await session.nextFrame();

    expect(h.opens.map((item) => item.sourceIdentity)).toEqual(["camera:device-1", "camera:device-2"]);
    expect(oldTrack.stopCalls).toBe(1);
    expect(oldFrame.epochRef).not.toBe(newFrame.epochRef);
    expect(oldFrame.ptsNanos).toBeGreaterThan(newFrame.ptsNanos);
    expect(newFrame.sourceIdentity).toBe("camera:device-2");
    await session.close();
    expect(oldTrack.stopCalls).toBe(1);
    expect(newTrack.stopCalls).toBe(1);
  });

  it("discards a pending old-device frame during switch before opening the new source", async () => {
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const oldTrack: FakeTrack = {
      stopCalls: 0,
      nextFrame: () => {
        markReadStarted?.();
        return new Promise<Uint8Array>(() => undefined);
      },
      stopTracks() { oldTrack.stopCalls++; },
    };
    const newTrack = frameTrack([new Uint8Array([2])]);
    const h = harness({ tracks: [oldTrack, newTrack] });
    const session = await h.adapter.openSession(request);
    const pendingFrame = session.nextFrame();
    await readStarted;
    const switching = session.switchDevice({ ...request,
      sourceIdentity: "camera:device-2",
      exactRightsScope: "rights/camera-device-2/v1",
      sourceVersionRef: "camera-device-2@v1",
    });
    await expectCode(pendingFrame, "DEVICE_SWITCHED");
    await switching;
    expect(h.opens.map((item) => item.sourceIdentity)).toEqual(["camera:device-1", "camera:device-2"]);
    expect(oldTrack.stopCalls).toBe(1);
    expect((await session.nextFrame()).bytes).toEqual(new Uint8Array([2]));
    await session.close();
    expect(oldTrack.stopCalls).toBe(1);
    expect(newTrack.stopCalls).toBe(1);
  });

  it("rejects non-increasing PTS inside one epoch and rejects oversized frames", async () => {
    const repeated = harness({ tracks: [frameTrack([new Uint8Array([1]), new Uint8Array([2])])],
      pts: () => 10 });
    const repeatedSession = await repeated.adapter.openSession(request);
    await repeatedSession.nextFrame();
    await expectCode(repeatedSession.nextFrame(), "PTS_INVALID");
    expect(repeated.tracks[0]?.stopCalls).toBe(1);

    const tooLarge = harness({ tracks: [frameTrack([new Uint8Array(65)])] });
    const boundedSession = await tooLarge.adapter.openSession(request);
    await expectCode(boundedSession.nextFrame(), "FRAME_INVALID");
    expect(tooLarge.tracks[0]?.stopCalls).toBe(1);
  });

  it("treats device unplug during a frame read as unavailable and releases the device", async () => {
    const unplugged: FakeTrack = {
      stopCalls: 0,
      async nextFrame() { throw new Error("device removed"); },
      stopTracks() { unplugged.stopCalls++; },
    };
    const h = harness({ tracks: [unplugged] });
    const session = await h.adapter.openSession(request);

    await expectCode(session.nextFrame(), "DEVICE_UNAVAILABLE");
    expect(unplugged.stopCalls).toBe(1);
    expect(h.subscriptions[0]?.active).toBe(false);
    await session.close();
    expect(unplugged.stopCalls).toBe(1);
  });

  it("discards a frame when exact permission becomes unknown during the device read", async () => {
    let permissionReads = 0;
    const track = frameTrack([new Uint8Array([0xca, 0xfe])]);
    const h = harness({
      tracks: [track],
      decide: (candidate) => {
        permissionReads++;
        return permissionFor(candidate, permissionReads >= 4 ? { disposition: "UNKNOWN" } : {});
      },
    });
    const session = await h.adapter.openSession(request);

    await expectCode(session.nextFrame(), "PERMISSION_DENIED");
    expect(permissionReads).toBe(4);
    expect(track.stopCalls).toBe(1);
    expect(h.subscriptions[0]?.active).toBe(false);
  });

  it("one-frame SPI capture closes tracks and strips output on fresh permission loss", async () => {
    const track = frameTrack([new Uint8Array([3, 4])]);
    const h = harness({ tracks: [track] });
    const captured = await h.adapter.capture(request);
    expect(captured.bytes).toEqual(new Uint8Array([3, 4]));
    expect(track.stopCalls).toBe(1);

    let reads = 0;
    const deniedTrack = frameTrack([new Uint8Array([5])]);
    deniedTrack.nextFrame = async () => { reads++; return new Uint8Array([5]); };
    const denied = harness({ tracks: [deniedTrack], decide: (candidate) =>
      permissionFor(candidate, { disposition: "REVOKED" }) });
    await expectCode(denied.adapter.capture(request), "CONSENT_REVOKED");
    expect(reads).toBe(0);
    expect(deniedTrack.stopCalls).toBe(0);
  });
});
