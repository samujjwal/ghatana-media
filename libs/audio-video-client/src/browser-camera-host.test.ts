import { describe, expect, it } from "vitest";
import { CameraCaptureAdapter, type CameraConsentPort, type CameraFrameClockPort } from "./camera-capture-adapter.js";
import { createBrowserCameraMediaDevicePort } from "./browser-camera-host.js";
import type { CaptureRequest } from "./capture-adapters.js";

const request: CaptureRequest = { kind: "CAMERA", sourceIdentity: "camera:device-A", purposeRef: "purpose/record/v1",
  exactRightsScope: "rights/device-A/v1", sourceVersionRef: "device-A@rev-4", secretsRef: "secrets/session", frameClockRef: "clock/host" };

function setup(state: PermissionState = "granted", options: { available?: boolean; frame?: (done: (blob: Blob) => void) => void; deviceId?: string;
  maxFrameBytes?: number; maxPixels?: number; videoWidth?: number; videoHeight?: number; pendingOpen?: boolean; pendingPlay?: boolean;
  pendingPermissionSubscription?: boolean; domSetupFailure?: boolean; pauseFailure?: boolean;
  listenerRemovalFailure?: boolean; trackStopFailure?: boolean; secondTrack?: boolean;
  consentUnsubscribeFailure?: boolean; sourceVersionThrowsOnSecond?: boolean; getTracksFailure?: boolean } = {}) {
  let permissionState = state;
  const listeners: Array<() => void> = [];
  let permissionQueries = 0;
  let signalDeviceOpenStarted!: () => void;
  const deviceOpenStarted = new Promise<void>((resolve) => { signalDeviceOpenStarted = resolve; });
  let finishPermissionSubscription!: (status: { state: PermissionState; addEventListener: (_: string, listener: () => void) => void;
    removeEventListener: (_: string, listener: () => void) => void }) => void;
  let opens = 0; let stops = 0; let reads = 0; let plays = 0; let creates = 0;
  let sourceVersionCalls = 0;
  let finishOpen!: () => void; let finishPlay!: () => void; let revoke!: () => void;
  const trackListeners: Array<() => void> = [];
  const width = options.videoWidth ?? 2; const height = options.videoHeight ?? 2;
  const track = { readyState: "live", getSettings: () => ({ deviceId: options.deviceId ?? "device-A", width, height }),
    addEventListener: (_: string, listener: () => void) => trackListeners.push(listener),
    removeEventListener: (_: string, listener: () => void) => {
      if (options.listenerRemovalFailure) throw new Error("synthetic listener cleanup failure");
      const i = trackListeners.indexOf(listener); if (i >= 0) trackListeners.splice(i, 1);
    },
    stop: () => { stops++; if (options.trackStopFailure) throw new Error("synthetic device stop failure"); } };
  const anotherTrack = { stop: () => { stops++; } };
  const ownedTracks = options.secondTrack ? [track, anotherTrack] : [track];
  const stream = { getVideoTracks: () => [track], getTracks: () => {
    if (options.getTracksFailure) throw new Error("synthetic track enumeration failure");
    return ownedTracks;
  } };
  const video = { muted: false, playsInline: false, videoWidth: width, videoHeight: height, srcObject: null as unknown,
    play: async () => { plays++; if (options.pendingPlay) await new Promise<void>((resolve) => { finishPlay = resolve; }); },
    pause: () => { if (options.pauseFailure) throw new Error("synthetic detached element failure"); } };
  let draws = 0;
  const context = { drawImage: () => { draws++; } };
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: (blob: Blob | null) => void) => {
    reads++;
    options.frame?.((blob) => callback(blob));
    if (!options.frame) callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
  } };
  const browser = options.available === false ? {} : {
    mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
      opens++;
      signalDeviceOpenStarted();
      expect(constraints.video).toEqual({ deviceId: { exact: "device-A" } });
      if (options.pendingOpen) await new Promise<void>((resolve) => { finishOpen = resolve; });
      return stream;
    } },
    permissions: { query: async () => {
      permissionQueries++;
      if (options.pendingPermissionSubscription && permissionQueries === 2) {
        return await new Promise((resolve) => { finishPermissionSubscription = resolve; });
      }
      return { get state() { return permissionState; }, addEventListener: (_: string, listener: () => void) => listeners.push(listener),
        removeEventListener: (_: string, listener: () => void) => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
    } },
    document: { createElement: (tag: string) => {
      creates++;
      if (options.domSetupFailure && tag === "video") throw new Error("synthetic DOM setup failure");
      return tag === "video" ? video : canvas;
    } },
  };
  const port = createBrowserCameraMediaDevicePort({ sourceVersionRef: (id) => {
    sourceVersionCalls++;
    if (options.sourceVersionThrowsOnSecond && sourceVersionCalls === 2) throw new Error("synthetic revision lookup failure");
    return id === "device-A" ? "device-A@rev-4" : undefined;
  },
    maxFrameBytes: options.maxFrameBytes, maxPixels: options.maxPixels, browser: browser as never, frameTimeoutMillis: 100 });
  const now = 1_800_000_000_000;
  const consent: CameraConsentPort = {
    async checkFresh(candidate) { return { disposition: "GRANTED", sourceIdentity: candidate.sourceIdentity, purposeRef: candidate.purposeRef,
      exactRightsScope: candidate.exactRightsScope, sourceVersionRef: candidate.sourceVersionRef, allowedSignals: ["VIDEO"], selectedSignals: ["VIDEO"],
      syncPolicyRef: "sync-policy/independent-video:v1", codecProfileRef: "codec-profile/browser-jpeg:v1",
      decisionRef: "decision/v1", checkedAtEpochMillis: now, expiresAtEpochMillis: now + 10_000 }; },
    subscribe: () => () => { if (options.consentUnsubscribeFailure) throw new Error("synthetic consent detach failure"); },
  };
  let epoch = 0;
  const clock: CameraFrameClockPort = { nowEpochMillis: () => now, beginEpoch: () => `epoch-${++epoch}`, readPtsNanos: () => BigInt(epoch) };
  const adapter = new CameraCaptureAdapter({ mediaDevices: port, consent, frameClock: clock, maxFrameBytes: 64, maxFrames: 4 });
  revoke = () => { permissionState = "denied"; listeners.forEach((listener) => listener()); };
  return { adapter, port, counts: () => ({ opens, stops, reads, draws }), details: () => ({ plays, creates }), revoke, deviceOpenStarted,
    unplug() { track.readyState = "ended"; trackListeners.slice().forEach((listener) => listener()); },
    permissionListenerCount: () => listeners.length, resolveOpen: () => finishOpen(), resolvePlay: () => finishPlay(),
    resolvePermissionSubscription: () => finishPermissionSubscription({ get state() { return permissionState; },
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: (_: string, listener: () => void) => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } }) };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CameraCaptureError", code });
}

describe("concrete browser camera host", () => {
  it("does not report a late permission-query failure after the subscription was removed", async () => {
    let rejectQuery!: (error: Error) => void;
    const port = createBrowserCameraMediaDevicePort({
      sourceVersionRef: () => undefined,
      browser: { permissions: { query: () => new Promise((_, reject) => { rejectQuery = reject; }) } } as never,
    });
    const observations: string[] = [];
    const permission = (port as unknown as { permission: { subscribe: (candidate: CaptureRequest, listener: (state: string) => void) => () => void } }).permission;
    const unsubscribe = permission.subscribe(request, (state) => observations.push(state));
    unsubscribe();
    rejectQuery(new Error("late host permission query failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(observations).toEqual([]);
  });

  it("fails closed for denied, unknown and absent browser APIs without opening a device", async () => {
    for (const [state, code] of [["denied", "PERMISSION_DENIED"], ["prompt", "PERMISSION_UNKNOWN"]] as const) {
      const h = setup(state);
      await expectCode(h.adapter.openSession(request), code);
      expect(h.counts().opens).toBe(0);
    }
    const absent = setup("granted", { available: false });
    await expectCode(absent.adapter.openSession(request), "PERMISSION_UNKNOWN");
    expect(absent.counts()).toEqual({ opens: 0, stops: 0, reads: 0, draws: 0 });
  });

  it("requests only the exact source revision and returns bounded JPEG frame bytes", async () => {
    const h = setup();
    const session = await h.adapter.openSession(request);
    const frame = await session.nextFrame();
    expect(frame.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(frame.sourceIdentity).toBe(request.sourceIdentity);
    expect(frame.sourceVersionRef).toBe(request.sourceVersionRef);
    await session.close();
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 1, draws: 1 });

    const switched = setup("granted", { deviceId: "other-device" });
    await expectCode(switched.adapter.openSession(request), "DEVICE_UNAVAILABLE");
    expect(switched.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
  });

  it("stops an opened camera stream when browser media element setup fails", async () => {
    const h = setup("granted", { domSetupFailure: true });
    await expectCode(h.adapter.openSession(request), "DEVICE_UNAVAILABLE");
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
    expect(h.details()).toEqual({ plays: 0, creates: 1 });
  });

  it("still releases camera tracks when media element teardown throws", async () => {
    const h = setup("granted", { pauseFailure: true });
    const session = await h.adapter.openSession(request);
    await expect(session.close()).rejects.toThrow("camera session cleanup failed");
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
  });

  it("stops every track and repeats a sanitized failure when listener removal and one track stop throw", async () => {
    const h = setup("granted", { listenerRemovalFailure: true, trackStopFailure: true, secondTrack: true });
    const opened = await h.port.open(request, new AbortController().signal);
    const close = () => Promise.resolve(opened.stopTracks());
    await expect(close()).rejects.toThrow("camera stream cleanup failed");
    expect(h.counts().stops).toBe(2);
    await expect(close()).rejects.toThrow("camera stream cleanup failed");
    expect(h.counts().stops).toBe(2);
  });

  it("reports failed host track cleanup through explicit session close and repeated close", async () => {
    const h = setup("granted", { trackStopFailure: true });
    const session = await h.adapter.openSession(request);
    await expect(session.close()).rejects.toThrow("camera session cleanup failed");
    expect(h.counts().stops).toBe(1);
    await expect(session.close()).rejects.toThrow("camera session cleanup failed");
    expect(h.counts().stops).toBe(1);
  });

  it("preserves a primary permission failure when host cleanup also fails", async () => {
    const h = setup("granted", { trackStopFailure: true });
    const session = await h.adapter.openSession(request);
    h.revoke();
    await expectCode(session.nextFrame(), "PERMISSION_DENIED");
    await expect(session.close()).rejects.toThrow("camera session cleanup failed");
    expect(h.counts().stops).toBe(1);
  });

  it("attempts all stream tracks when exact-source startup cleanup encounters a stop failure", async () => {
    const h = setup("granted", { deviceId: "different-device", trackStopFailure: true, secondTrack: true });
    await expectCode(h.adapter.openSession(request), "DEVICE_UNAVAILABLE");
    expect(h.counts().stops).toBe(2);
  });

  it("stops every opened track when the post-open source revision lookup throws", async () => {
    const h = setup("granted", { sourceVersionThrowsOnSecond: true, secondTrack: true });
    await expectCode(h.adapter.openSession(request), "DEVICE_UNAVAILABLE");
    expect(h.counts().stops).toBe(2);
    expect(h.details().plays).toBe(0);
  });

  it("stops the known video track when stream track enumeration fails during close", async () => {
    const h = setup("granted", { getTracksFailure: true });
    const session = await h.adapter.openSession(request);
    await expect(session.close()).rejects.toThrow("camera session cleanup failed");
    expect(h.counts().stops).toBe(1);
  });

  it("attempts track cleanup even when the session permission listener cannot detach", async () => {
    const h = setup("granted", { consentUnsubscribeFailure: true });
    const session = await h.adapter.openSession(request);
    await expect(session.close()).rejects.toThrow("camera session cleanup failed");
    expect(h.counts().stops).toBe(1);
  });

  it("contains cleanup failures from the ended event callback and reports them on close", async () => {
    const h = setup("granted", { trackStopFailure: true });
    const opened = await h.port.open(request, new AbortController().signal);
    expect(() => h.unplug()).not.toThrow();
    await expect(Promise.resolve(opened.stopTracks())).rejects.toThrow("camera stream cleanup failed");
    expect(h.counts().stops).toBe(1);
  });

  it("stops a stream that resolves after session cancellation without creating media elements or returning a frame", async () => {
    const h = setup("granted", { pendingOpen: true });
    const opening = h.adapter.openSession(request);
    const rejected = expectCode(opening, "SESSION_CLOSED");
    await h.deviceOpenStarted;
    await h.adapter.close();
    h.resolveOpen();
    await rejected;
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
    expect(h.details()).toEqual({ plays: 0, creates: 0 });
  });

  it("releases an idle camera stream as soon as the browser reports device removal", async () => {
    const h = setup();
    const session = await h.adapter.openSession(request);
    h.unplug();
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
    await expectCode(session.nextFrame(), "DEVICE_UNAVAILABLE");
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
  });

  it("fails device startup when the camera is unplugged while playback is pending", async () => {
    const h = setup("granted", { pendingPlay: true });
    const opening = h.adapter.openSession(request);
    const rejected = expectCode(opening, "DEVICE_UNAVAILABLE");
    while (!h.details().plays) await new Promise((resolve) => setTimeout(resolve, 0));
    h.unplug();
    h.resolvePlay();
    await rejected;
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
    expect(h.details()).toEqual({ plays: 1, creates: 2 });
  });

  it("rechecks host permission after device startup while the permission listener is still installing", async () => {
    const h = setup("granted", { pendingOpen: true, pendingPermissionSubscription: true });
    const opening = h.adapter.openSession(request);
    const rejected = expectCode(opening, "PERMISSION_DENIED");
    await h.deviceOpenStarted;
    h.revoke();
    h.resolvePermissionSubscription();
    h.resolveOpen();
    await rejected;
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
  });

  it("stops a stream when permission is revoked while browser playback startup is pending", async () => {
    const h = setup("granted", { pendingPlay: true });
    const opening = h.adapter.openSession(request);
    const rejected = expectCode(opening, "PERMISSION_DENIED");
    while (!h.details().plays) await new Promise((resolve) => setTimeout(resolve, 0));
    // Wait until the browser permission listener is installed before revoking.
    while (!h.permissionListenerCount()) await new Promise((resolve) => setTimeout(resolve, 0));
    h.revoke();
    await rejected;
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
    expect(h.details()).toEqual({ plays: 1, creates: 2 });
    // The abandoned host play promise can settle later without reopening capture.
    h.resolvePlay();
  });

  it("does not return bytes produced after permission revocation and tears down capture", async () => {
    let finish!: (blob: Blob) => void;
    const h = setup("granted", { frame: (done) => { finish = done; } });
    const session = await h.adapter.openSession(request);
    const pending = session.nextFrame();
    const rejected = expectCode(pending, "PERMISSION_DENIED");
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
    h.revoke();
    finish(new Blob([new Uint8Array([9])], { type: "image/jpeg" }));
    await rejected;
    expect(h.counts().stops).toBe(1);
  });

  it("cancels reads after session close without releasing a late frame", async () => {
    let finish!: (blob: Blob) => void;
    const h = setup("granted", { frame: (done) => { finish = done; } });
    const session = await h.adapter.openSession(request);
    const pending = session.nextFrame();
    const rejected = expectCode(pending, "SESSION_CLOSED");
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
    await session.close();
    finish(new Blob([new Uint8Array([8])], { type: "image/jpeg" }));
    await rejected;
    expect(h.counts().stops).toBe(1);
  });

  it("rejects frames larger than the configured browser-host byte bound", async () => {
    const h = setup("granted", { maxFrameBytes: 2 });
    const session = await h.adapter.openSession(request);
    await expect(session.nextFrame()).rejects.toMatchObject({ name: "CameraCaptureError" });
    expect(h.counts().reads).toBe(1);
    expect(h.counts().stops).toBe(1);
  });

  it("rejects oversized dimensions before canvas allocation, drawing or encoding", async () => {
    const h = setup("granted", { videoWidth: 4_097, videoHeight: 2 });
    const session = await h.adapter.openSession(request);
    await expect(session.nextFrame()).rejects.toMatchObject({ name: "CameraCaptureError" });
    expect(h.counts()).toEqual({ opens: 1, stops: 1, reads: 0, draws: 0 });
  });
});
