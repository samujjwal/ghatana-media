import { describe, expect, it } from "vitest";
import { captureWithAdmission, type CaptureRequest } from "./capture-adapters.js";
import {
  CameraCaptureAdapter,
  CameraCaptureError,
  BrowserCameraMediaDevicePort,
  type CameraCaptureSession,
  type CameraAudioSampleObservation,
  type CameraFrameRead,
  type CameraConsentPort,
  type CameraFrameClockPort,
  type CameraMediaDevicePort,
  type CameraPermissionDecision,
  type CameraTrack,
  type CameraTrackSourceMetadata,
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
  sourceMetadata?: CameraTrackSourceMetadata | null;
  nextFrame(signal: AbortSignal): Promise<Uint8Array | CameraFrameRead | null>;
}

function frameTrack(frames: ReadonlyArray<Uint8Array | CameraFrameRead>): FakeTrack {
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
    allowedSignals: ["VIDEO", "AUDIO"],
    selectedSignals: ["VIDEO"],
    syncPolicyRef: "sync-policy/camera:v1",
    codecProfileRef: "codec-profile/h264-main:v1",
    decisionRef: "consent-read:v17",
    checkedAtEpochMillis: now,
    expiresAtEpochMillis: now + 30_000,
    ...overrides,
  };
}

function sourceMetadataFor(candidate: CaptureRequest,
  overrides: Partial<CameraTrackSourceMetadata> = {}): CameraTrackSourceMetadata {
  return {
    sourceIdentity: candidate.sourceIdentity,
    sourceVersionRef: candidate.sourceVersionRef,
    allowedSignals: ["VIDEO", "AUDIO"],
    selectedSignals: ["VIDEO"],
    syncPolicyRef: "sync-policy/camera:v1",
    codecDisposition: "AVAILABLE",
    codecProfileRef: "codec-profile/h264-main:v1",
    codecId: "avc1.640028",
    mimeType: "video/mp4",
    width: 1920,
    height: 1080,
    sourceClockRef: "clock/camera-source:v1",
    sourceStreamRef: "stream/camera-video:v1",
    sourceOriginRef: "origin/camera-epoch:v1",
    sourceTimeBase: { numerator: "1", denominator: "90000" },
    ...overrides,
  };
}

function harness(options: {
  decide?: (candidate: CaptureRequest, at: number) => CameraPermissionDecision;
  tracks?: FakeTrack[];
  pts?: (epochRef: string, index: number) => bigint | number;
  metadata?: (candidate: CaptureRequest) => CameraTrackSourceMetadata | null;
  mediaDevices?: CameraMediaDevicePort;
  maxFrames?: number;
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
  const fakeMediaDevices: CameraMediaDevicePort = {
    async open(candidate, signal) {
      opens.push(candidate);
      if (signal.aborted) throw new Error("aborted before open");
      const track = tracks[opens.length - 1];
      if (!track) throw new Error("no mock camera track");
      if (track.sourceMetadata === undefined) {
        track.sourceMetadata = options.metadata ? options.metadata(candidate) : sourceMetadataFor(candidate);
      }
      return track;
    },
  };
  const adapter = new CameraCaptureAdapter({ mediaDevices: options.mediaDevices ?? fakeMediaDevices, consent, frameClock: clock,
    maxFrameBytes: 64, maxFrames: options.maxFrames ?? 10, maxSessionMillis: 10_000 });
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

function browserHarness(options: {
  permission?: "GRANTED" | "DENIED" | "REVOKED" | "UNKNOWN";
  read?: (signal: AbortSignal) => Promise<Uint8Array | null>;
  encode?: (bytes: Uint8Array, signal: AbortSignal) => Promise<CameraFrameRead>;
  bindStarted?: () => void;
  bindGate?: Promise<void>;
  rejectCodecClose?: boolean;
} = {}) {
  let permission = options.permission ?? "GRANTED";
  const permissionListeners: Array<(state: typeof permission) => void> = [];
  let deviceOpens = 0;
  let deviceStops = 0;
  let codecCloses = 0;
  const mediaDevices = new BrowserCameraMediaDevicePort({
    async check() { return permission; },
    subscribe(_candidate, listener) {
      permissionListeners.push(listener);
      return () => {
        const index = permissionListeners.indexOf(listener);
        if (index >= 0) permissionListeners.splice(index, 1);
      };
    },
  }, {
    async openExact(candidate, signal) {
      deviceOpens++;
      if (signal.aborted) throw new Error("open cancelled");
      return {
        sourceIdentity: candidate.sourceIdentity,
        sourceVersionRef: candidate.sourceVersionRef,
        readFrame: options.read ?? (async () => new Uint8Array([4, 5])),
        stop() { deviceStops++; },
      };
    },
  }, {
    async bind(candidate, _device, signal) {
      options.bindStarted?.();
      await options.bindGate;
      return {
        sourceMetadata: sourceMetadataFor(candidate),
        encode: options.encode ?? (async (bytes) => ({ bytes: Uint8Array.from(bytes) })),
        close() {
          codecCloses++;
          if (options.rejectCodecClose) throw new Error("codec cleanup failed");
        },
      };
    },
  });
  const h = harness({ mediaDevices });
  return {
    ...h,
    counts: () => ({ deviceOpens, deviceStops, codecCloses }),
    setPermission(next: typeof permission) {
      permission = next;
      for (const listener of [...permissionListeners]) listener(next);
    },
  };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: "CameraCaptureError", code });
}

describe("CameraCaptureAdapter", () => {
  it("requires explicit browser host permission before opening an exact device", async () => {
    for (const [permission, code] of [["DENIED", "PERMISSION_DENIED"], ["UNKNOWN", "PERMISSION_UNKNOWN"]] as const) {
      const h = browserHarness({ permission });
      await expectCode(h.adapter.openSession(request), code);
      expect(h.counts().deviceOpens).toBe(0);
    }
    const granted = browserHarness();
    const session = await granted.adapter.openSession(request);
    expect(granted.counts().deviceOpens).toBe(1);
    await session.close();
  });

  it("revokes a pending browser read without returning encoded bytes", async () => {
    let readStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const h = browserHarness({ read: (_signal) => new Promise((resolve, reject) => {
      readStarted?.();
      _signal.addEventListener("abort", () => reject(new Error("host permission revoked")), { once: true });
    }) });
    const session = await h.adapter.openSession(request);
    const pending = session.nextFrame();
    await started;
    h.setPermission("REVOKED");
    await expectCode(pending, "CONSENT_REVOKED");
    expect(h.counts()).toEqual({ deviceOpens: 1, deviceStops: 1, codecCloses: 1 });
  });

  it("preserves DENIED and UNKNOWN host permission changes during a read", async () => {
    for (const [permission, code] of [["DENIED", "PERMISSION_DENIED"], ["UNKNOWN", "PERMISSION_UNKNOWN"]] as const) {
      let readStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { readStarted = resolve; });
      const h = browserHarness({ read: (signal) => new Promise((_resolve, reject) => {
        readStarted?.();
        signal.addEventListener("abort", () => reject(new Error("permission changed")), { once: true });
      }), rejectCodecClose: true });
      const session = await h.adapter.openSession(request);
      const pending = session.nextFrame();
      await started;
      h.setPermission(permission);
      await expectCode(pending, code);
      expect(h.counts()).toEqual({ deviceOpens: 1, deviceStops: 1, codecCloses: 1 });
    }
  });

  it("does not return a track when permission becomes unknown during an uncancellable codec bind", async () => {
    let markBindStarted: (() => void) | undefined;
    let finishBind: (() => void) | undefined;
    const bindStarted = new Promise<void>((resolve) => { markBindStarted = resolve; });
    const bindGate = new Promise<void>((resolve) => { finishBind = resolve; });
    const h = browserHarness({ bindStarted: () => markBindStarted?.(), bindGate });
    const opening = h.adapter.openSession(request);
    await bindStarted;
    h.setPermission("UNKNOWN");
    finishBind?.();
    await expectCode(opening, "PERMISSION_UNKNOWN");
    expect(h.counts()).toEqual({ deviceOpens: 1, deviceStops: 1, codecCloses: 1 });
  });

  it("stops the browser device and codec on hot unplug or caller cancellation", async () => {
    const unplugged = browserHarness({ read: async () => { throw new Error("device unplugged"); } });
    const unpluggedSession = await unplugged.adapter.openSession(request);
    await expectCode(unpluggedSession.nextFrame(), "DEVICE_UNAVAILABLE");
    expect(unplugged.counts()).toEqual({ deviceOpens: 1, deviceStops: 1, codecCloses: 1 });

    let encodingStarted: (() => void) | undefined;
    let finishEncoding: ((frame: CameraFrameRead) => void) | undefined;
    const started = new Promise<void>((resolve) => { encodingStarted = resolve; });
    const cancelled = browserHarness({ encode: async (_bytes, _signal) => new Promise((resolve) => {
      encodingStarted?.();
      finishEncoding = resolve;
    }) });
    const session = await cancelled.adapter.openSession(request);
    const pending = session.nextFrame();
    await started;
    await session.close();
    finishEncoding?.({ bytes: new Uint8Array([0xfa, 0xce]) });
    await expectCode(pending, "SESSION_CLOSED");
    expect(cancelled.counts()).toEqual({ deviceOpens: 1, deviceStops: 1, codecCloses: 1 });
  });

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
    expect(first.sourcePresentationTime).toEqual({
      disposition: "UNKNOWN",
      reason: "SOURCE_PTS_NOT_SUPPLIED",
    });
    expect(first.cameraMetadata.captureEpochRef).toBe(first.epochRef);
    expect(first.cameraMetadata.hostCapturePtsNanos).toBe(first.ptsNanos.toString());
    expect(first.cameraMetadata.syncPolicyRef).toBe("sync-policy/camera:v1");
    expect(first.cameraMetadata.clockMappings).toHaveLength(4);
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

  it("preserves permission denial as denial when it interrupts an in-flight frame", async () => {
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
    h.revoke(0, "DENIED");
    await expectCode(pending, "PERMISSION_DENIED");
    resolvePending?.(new Uint8Array([0xde, 0xad]));
    await session.close();
    expect(track.stopCalls).toBe(1);
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

    const sourceReorderedTrack = frameTrack([
      { bytes: new Uint8Array([3]), presentationTicks: "9000" },
      { bytes: new Uint8Array([4]), presentationTicks: "8999" },
    ]);
    const sourceReordered = harness({ tracks: [sourceReorderedTrack] });
    const sourceSession = await sourceReordered.adapter.openSession(request);
    await sourceSession.nextFrame();
    await expectCode(sourceSession.nextFrame(), "PTS_INVALID");
    expect(sourceReorderedTrack.stopCalls).toBe(1);
  });

  it("serializes concurrent frame reads so the session frame cap cannot be exceeded", async () => {
    const track = frameTrack([new Uint8Array([1]), new Uint8Array([2])]);
    const h = harness({ tracks: [track], maxFrames: 1 });
    const session = await h.adapter.openSession(request);

    const firstRead = session.nextFrame();
    const secondRead = session.nextFrame();
    const first = await firstRead;
    await expectCode(secondRead, "FRAME_LIMIT");

    expect(first.bytes).toEqual(new Uint8Array([1]));
    expect(track.stopCalls).toBe(1);
    await session.close();
    expect(track.stopCalls).toBe(1);
  });

  it("rejects excess outstanding frame calls before they can queue or reach the track", async () => {
    let trackReadCalls = 0;
    let markReadStarted: (() => void) | undefined;
    let finishTrackRead: ((frame: Uint8Array) => void) | undefined;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const track: FakeTrack = {
      stopCalls: 0,
      nextFrame: () => {
        trackReadCalls++;
        markReadStarted?.();
        return new Promise<Uint8Array>((resolve) => { finishTrackRead = resolve; });
      },
      stopTracks() { track.stopCalls++; },
    };
    const h = harness({ tracks: [track] });
    const session = await h.adapter.openSession(request);

    const reads = Array.from({ length: 9 }, () => session.nextFrame());
    await expectCode(reads[8]!, "FRAME_QUEUE_LIMIT");
    await readStarted;
    expect(trackReadCalls).toBe(1);

    await session.close();
    await Promise.all(reads.slice(0, 8).map((read) => expectCode(read, "SESSION_CLOSED")));
    finishTrackRead?.(new Uint8Array([1]));
    expect(trackReadCalls).toBe(1);
    expect(track.stopCalls).toBe(1);
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
        return permissionFor(candidate, permissionReads >= 5 ? { disposition: "UNKNOWN" } : {});
      },
    });
    const session = await h.adapter.openSession(request);

    await expectCode(session.nextFrame(), "PERMISSION_UNKNOWN");
    expect(permissionReads).toBe(5);
    expect(track.stopCalls).toBe(1);
    expect(h.subscriptions[0]?.active).toBe(false);
  });

  it("one-frame SPI capture closes tracks and strips output on fresh permission loss", async () => {
    const track = frameTrack([new Uint8Array([3, 4])]);
    const h = harness({ tracks: [track] });
    const captured = await h.adapter.capture(request);
    expect(captured.bytes).toEqual(new Uint8Array([3, 4]));
    expect(track.stopCalls).toBe(1);

    const routedTrack = frameTrack([{ bytes: new Uint8Array([4, 5]), presentationTicks: "7" }]);
    const routed = harness({ tracks: [routedTrack] });
    const admitted = await captureWithAdmission({ check: () => "ADMITTED" }, routed.adapter, request);
    expect(admitted.sourcePresentationTime?.disposition).toBe("KNOWN");
    expect(admitted.cameraMetadata?.captureEpochRef).toBe("clock-epoch-1");
    expect(admitted.audioSampleTime?.disposition).toBe("NOT_SELECTED");

    let reads = 0;
    const deniedTrack = frameTrack([new Uint8Array([5])]);
    deniedTrack.nextFrame = async () => { reads++; return new Uint8Array([5]); };
    const denied = harness({ tracks: [deniedTrack], decide: (candidate) =>
      permissionFor(candidate, { disposition: "REVOKED" }) });
    await expectCode(denied.adapter.capture(request), "CONSENT_REVOKED");
    expect(reads).toBe(0);
    expect(deniedTrack.stopCalls).toBe(0);
  });

  it("preserves exact source PTS, rational timebase, discontinuity and capture epoch through capture()", async () => {
    const audioSample: CameraAudioSampleObservation = {
      sampleIndex: "48000", sampleRate: { numerator: "48000", denominator: "1" },
      sourceStreamRef: "stream/camera-audio:v2",
    };
    const track = frameTrack([{ bytes: new Uint8Array([6, 7]), presentationTicks: "9000",
      discontinuity: { disposition: "GAP", evidenceRef: "evidence/camera-gap:v2" }, audioSample }]);
    const h = harness({ tracks: [track],
      metadata: (candidate) => sourceMetadataFor(candidate, { selectedSignals: ["VIDEO", "AUDIO"] }),
      decide: (candidate) => permissionFor(candidate, { selectedSignals: ["VIDEO", "AUDIO"] }),
    });

    const captured = await h.adapter.capture(request);

    expect(captured.epochRef).toBe("clock-epoch-1");
    expect(captured.cameraMetadata.captureEpochRef).toBe(captured.epochRef);
    expect(captured.sourcePresentationTime).toEqual({
      disposition: "KNOWN",
      sourceClockRef: "clock/camera-source:v1",
      sourceStreamRef: "stream/camera-video:v1",
      sourceOriginRef: "origin/camera-epoch:v1",
      presentationTicks: "9000",
      timeBase: { numerator: "1", denominator: "90000" },
      discontinuity: { disposition: "GAP", evidenceRef: "evidence/camera-gap:v2" },
    });
    expect(captured.audioSampleTime).toEqual({
      disposition: "KNOWN", sampleIndex: "48000",
      sampleRate: { numerator: "48000", denominator: "1" },
      sourceStreamRef: "stream/camera-audio:v2",
    });
    expect(captured.cameraMetadata.clockMappings.every((mapping) => mapping.disposition === "UNKNOWN")).toBe(true);
    expect(track.stopCalls).toBe(1);
  });

  it("keeps unsupported codec, unsupported signal and missing source metadata unavailable without reading frames", async () => {
    const unsupportedCodecTrack = frameTrack([new Uint8Array([1])]);
    const codec = harness({ tracks: [unsupportedCodecTrack], metadata: (candidate) =>
      sourceMetadataFor(candidate, { codecDisposition: "UNSUPPORTED" }) });
    await expectCode(codec.adapter.capture(request), "CODEC_UNSUPPORTED");
    expect(unsupportedCodecTrack.stopCalls).toBe(1);

    const unsupportedSignalTrack = frameTrack([new Uint8Array([2])]);
    const signal = harness({ tracks: [unsupportedSignalTrack], metadata: (candidate) =>
      sourceMetadataFor(candidate, { allowedSignals: ["AUDIO"], selectedSignals: ["AUDIO"] }) });
    await expectCode(signal.adapter.capture(request), "SIGNAL_UNSUPPORTED");
    expect(unsupportedSignalTrack.stopCalls).toBe(1);

    const missingTrack = frameTrack([new Uint8Array([3])]);
    const missing = harness({ tracks: [missingTrack], metadata: () => null });
    await expectCode(missing.adapter.capture(request), "SOURCE_METADATA_UNAVAILABLE");
    expect(missingTrack.stopCalls).toBe(1);
  });

  it("does not open a source when initial permission is unknown", async () => {
    const h = harness({ decide: (candidate) => permissionFor(candidate, { disposition: "UNKNOWN" }) });
    await expectCode(h.adapter.capture(request), "PERMISSION_UNKNOWN");
    expect(h.opens).toHaveLength(0);
  });

  it("keeps source PTS and selected audio sample time unknown instead of borrowing host clocks", async () => {
    const track = frameTrack([new Uint8Array([9])]);
    const h = harness({ tracks: [track],
      metadata: (candidate) => sourceMetadataFor(candidate, {
        selectedSignals: ["VIDEO", "AUDIO"],
        sourceClockRef: null,
        sourceTimeBase: null,
      }),
      decide: (candidate) => permissionFor(candidate, { selectedSignals: ["VIDEO", "AUDIO"] }),
    });

    const captured = await h.adapter.capture(request);

    expect(captured.sourcePresentationTime).toEqual({
      disposition: "UNKNOWN", reason: "SOURCE_PTS_NOT_SUPPLIED",
    });
    expect(captured.audioSampleTime).toEqual({
      disposition: "UNKNOWN", reason: "AUDIO_SAMPLE_CLOCK_NOT_SUPPLIED",
    });
    expect(captured.ptsNanos).toBeGreaterThan(0n);
    expect(captured.cameraMetadata.clockMappings.map(({ destinationDomain }) => destinationDomain))
      .toEqual(["AUDIO_SAMPLE", "STORY", "SIMULATION", "WALL_CLOCK"]);
    expect(captured.cameraMetadata.clockMappings.every(({ disposition }) => disposition === "UNKNOWN")).toBe(true);
  });
});
