import { describe, expect, it } from "vitest";
import {
  CaptureNotAdmittedError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureRequest,
} from "./capture-adapters.js";
import {
  MobileCaptureAdapter,
  MobileCaptureError,
  type MobileCaptureSource,
} from "./mobile-capture-adapter.js";

const request: CaptureRequest = {
  kind: "MOBILE",
  sourceIdentity: "mobile:device-5:camera",
  purposeRef: "purpose/v1",
  exactRightsScope: "rights/device-5/v1",
  sourceVersionRef: "device-5@v2",
  secretsRef: "secrets/capture-mobile",
  frameClockRef: "clock/sensor-monotonic",
};

interface FakeSource extends MobileCaptureSource {
  detachCalls: number;
  permission: "GRANTED" | "DENIED" | "REVOKED";
  app: "FOREGROUND" | "BACKGROUND";
  clockId: string;
}

function fakeSource(frames: ReadonlyArray<Uint8Array>): FakeSource {
  let index = 0;
  const source: FakeSource = {
    detachCalls: 0,
    permission: "GRANTED",
    app: "FOREGROUND",
    clockId: "sensor-monotonic",
    nextFrame: () => Promise.resolve(index < frames.length ? frames[index++] : null),
    frameClock: () => ({ clockId: source.clockId, tickNanos: index }),
    permissionState() { return this.permission; },
    appState() { return this.app; },
    detach() { this.detachCalls += 1; return Promise.resolve(); },
  };
  return source;
}

describe("MobileCaptureAdapter", () => {
  it("captures frame bytes while granted+foreground and echoes clock refs", async () => {
    const source = fakeSource([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const adapter = new MobileCaptureAdapter({ resolveSource: () => source });
    const frame = await adapter.capture(request);
    expect([...frame.bytes]).toEqual([1, 2, 3]);
    expect(frame.frameClockRef).toBe("clock/sensor-monotonic");
    expect(frame.exactRightsScope).toBe("rights/device-5/v1");
    expect(source.detachCalls).toBe(1);
  });

  it("denied permission emits zero frames and never reads", async () => {
    const source = fakeSource([new Uint8Array([9])]);
    source.permission = "DENIED";
    let reads = 0;
    const orig = source.nextFrame;
    source.nextFrame = () => { reads += 1; return orig(); };
    const adapter = new MobileCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(MobileCaptureError);
    expect(reads).toBe(0);
  });

  it("backgrounded app emits no camera data", async () => {
    const source = fakeSource([new Uint8Array([1]), new Uint8Array([2])]);
    source.app = "BACKGROUND";
    const adapter = new MobileCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(MobileCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("mid-run permission revoke stops all further frames", async () => {
    let index = 0;
    const frames = [new Uint8Array([1]), new Uint8Array([2])];
    const source = fakeSource(frames);
    source.nextFrame = () => {
      if (index === 1) source.permission = "REVOKED";
      return Promise.resolve(index < frames.length ? frames[index++] : null);
    };
    const adapter = new MobileCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(MobileCaptureError);
  });

  it("a reconnect clock change fails closed — frames from two epochs never merge", async () => {
    let index = 0;
    const frames = [new Uint8Array([1]), new Uint8Array([2])];
    const source = fakeSource(frames);
    source.nextFrame = () => {
      if (index === 1) source.clockId = "sensor-monotonic-r2";
      return Promise.resolve(index < frames.length ? frames[index++] : null);
    };
    const adapter = new MobileCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(MobileCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("rejects a non-source resolution — no arbitrary device access", async () => {
    const adapter = new MobileCaptureAdapter({ resolveSource: () => 42 as unknown as MobileCaptureSource });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(MobileCaptureError);
  });

  it("enforces byte bound and detaches once", async () => {
    const source = fakeSource([new Uint8Array(100), new Uint8Array(100)]);
    const adapter = new MobileCaptureAdapter({ resolveSource: () => source, maxBytes: 150 });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(MobileCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("rejects mismatched kinds before resolving any source", async () => {
    let resolved = 0;
    const adapter = new MobileCaptureAdapter({ resolveSource: () => { resolved += 1; return fakeSource([]); } });
    await expect(adapter.capture({ ...request, kind: "DESKTOP" })).rejects.toBeInstanceOf(TypeError);
    expect(resolved).toBe(0);
  });

  it("passes through the admission seam", async () => {
    const adapter = new MobileCaptureAdapter({ resolveSource: () => fakeSource([new Uint8Array([1])]) });
    await expect(captureWithAdmission(noAdmittedCaptureAdapter, adapter, request))
      .rejects.toBeInstanceOf(CaptureNotAdmittedError);
  });
});
