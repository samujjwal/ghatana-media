import { describe, expect, it } from "vitest";
import {
  CaptureNotAdmittedError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureRequest,
} from "./capture-adapters.js";
import {
  DesktopCaptureAdapter,
  DesktopCaptureError,
  type DesktopCaptureSource,
} from "./desktop-capture-adapter.js";

const request: CaptureRequest = {
  kind: "DESKTOP",
  sourceIdentity: "desktop:window-12",
  purposeRef: "purpose/v1",
  exactRightsScope: "rights/window-12/v1",
  sourceVersionRef: "window-12@v1",
  secretsRef: "secrets/capture-desktop",
  frameClockRef: "clock/monotonic",
};

interface FakeSource extends DesktopCaptureSource {
  detachCalls: number;
  consent: "GRANTED" | "DENIED" | "REVOKED";
}

function fakeSource(
  frames: ReadonlyArray<Uint8Array>,
  overrides: Partial<{ consent: "GRANTED" | "DENIED" | "REVOKED"; width: number; height: number }> = {},
): FakeSource {
  let index = 0;
  const state = { consent: overrides.consent ?? "GRANTED", width: overrides.width ?? 640, height: overrides.height ?? 480 };
  const source: FakeSource = {
    detachCalls: 0,
    get consent() { return state.consent; },
    set consent(v: "GRANTED" | "DENIED" | "REVOKED") { state.consent = v; },
    nextFrame: () => Promise.resolve(index < frames.length ? frames[index++] : null),
    geometry: () => ({ width: state.width, height: state.height, pixelFormat: "RGBA" }),
    consentState: () => state.consent,
    detach() { this.detachCalls += 1; return Promise.resolve(); },
  };
  return source;
}

describe("DesktopCaptureAdapter", () => {
  it("captures real frame bytes from a consented source and echoes rights", async () => {
    const source = fakeSource([new Uint8Array([1, 2, 3]), new Uint8Array([4])]);
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => source });
    const frame = await adapter.capture(request);
    expect([...frame.bytes]).toEqual([1, 2, 3, 4]);
    expect(frame.exactRightsScope).toBe("rights/window-12/v1");
    expect(frame.frameClockRef).toBe("clock/monotonic");
    expect(source.detachCalls).toBe(1);
  });

  it("refuses before any pixel read when consent is denied", async () => {
    let reads = 0;
    const source = fakeSource([new Uint8Array([9])], { consent: "DENIED" });
    const original = source.nextFrame;
    source.nextFrame = () => { reads += 1; return original(); };
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(DesktopCaptureError);
    expect(reads).toBe(0);
    expect(source.detachCalls).toBe(0);
  });

  it("emits no pixels after a mid-run revoke", async () => {
    const frames = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    let index = 0;
    const source = fakeSource(frames);
    source.nextFrame = () => {
      if (index === 1) source.consent = "REVOKED";
      return Promise.resolve(index < frames.length ? frames[index++] : null);
    };
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(DesktopCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("honors display change: invalid geometry after resize fails closed", async () => {
    let index = 0;
    const source = fakeSource([new Uint8Array([1]), new Uint8Array([2])]);
    const geo = source.geometry;
    source.geometry = () => index === 0 ? geo() : { width: 0, height: 0, pixelFormat: "RGBA" };
    source.nextFrame = () => Promise.resolve(index < 2 ? new Uint8Array([index++]) : null);
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(DesktopCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("rejects a non-source resolution — no arbitrary display access", async () => {
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => "screen:0" as unknown as DesktopCaptureSource });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(DesktopCaptureError);
  });

  it("enforces byte and frame bounds and detaches once", async () => {
    const source = fakeSource([new Uint8Array(100), new Uint8Array(100)]);
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => source, maxBytes: 150 });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(DesktopCaptureError);
    expect(source.detachCalls).toBe(1);

    const source2 = fakeSource([new Uint8Array([1]), new Uint8Array([2])]);
    const adapter2 = new DesktopCaptureAdapter({ resolveSource: () => source2, maxFrames: 1 });
    await expect(adapter2.capture(request)).rejects.toBeInstanceOf(DesktopCaptureError);
    expect(source2.detachCalls).toBe(1);
  });

  it("external detach unblocks in-flight capture and closes once", async () => {
    let detached = false;
    const source: FakeSource = {
      detachCalls: 0,
      consent: "GRANTED",
      nextFrame: () => new Promise((res) => {
        const t = setInterval(() => { if (detached) { clearInterval(t); res(null); } }, 5);
      }),
      geometry: () => ({ width: 2, height: 2, pixelFormat: "RGBA" }),
      consentState() { return this.consent; },
      detach() { detached = true; this.detachCalls += 1; return Promise.resolve(); },
    };
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => source });
    const pending = adapter.capture(request);
    await new Promise((r) => setTimeout(r, 20));
    await adapter.detach();
    const frame = await pending;
    expect(source.detachCalls).toBe(1);
    expect(frame.bytes.byteLength).toBe(0);
  });

  it("rejects invalid bounds and mismatched request kinds before resolving", async () => {
    expect(() => new DesktopCaptureAdapter({ resolveSource: () => fakeSource([]), maxFrames: 0 })).toThrow(TypeError);
    let resolved = 0;
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => { resolved += 1; return fakeSource([]); } });
    await expect(adapter.capture({ ...request, kind: "BROWSER" })).rejects.toBeInstanceOf(TypeError);
    expect(resolved).toBe(0);
  });

  it("passes through the admission seam", async () => {
    const adapter = new DesktopCaptureAdapter({ resolveSource: () => fakeSource([new Uint8Array([1])]) });
    await expect(captureWithAdmission(noAdmittedCaptureAdapter, adapter, request))
      .rejects.toBeInstanceOf(CaptureNotAdmittedError);
  });
});
