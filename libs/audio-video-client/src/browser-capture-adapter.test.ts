import { describe, expect, it } from "vitest";
import {
  CaptureNotAdmittedError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureRequest,
} from "./capture-adapters.js";
import {
  BrowserCaptureAdapter,
  BrowserCaptureError,
  type BrowserCaptureSource,
} from "./browser-capture-adapter.js";

const request: CaptureRequest = {
  kind: "BROWSER",
  sourceIdentity: "browser:https://example.test/page",
  purposeRef: "purpose/v1",
  exactRightsScope: "rights/page/v1",
  sourceVersionRef: "page@v4",
  secretsRef: "secrets/capture-browser",
  frameClockRef: "clock/compositor",
};

interface FakeSource extends BrowserCaptureSource {
  detachCalls: number;
  permission: "GRANTED" | "DENIED" | "REVOKED";
  vis: "VISIBLE" | "HIDDEN" | "OCCLUDED";
  version: string;
  clockId: string;
  ticks: bigint[];
}

function fakeSource(frames: ReadonlyArray<Uint8Array>, ticks: bigint[] = [0n, 16_000_000n, 32_000_000n]): FakeSource {
  let index = 0;
  let lastRead = -1;
  const source: FakeSource = {
    detachCalls: 0,
    permission: "GRANTED",
    vis: "VISIBLE",
    version: "page@v4",
    clockId: "compositor",
    ticks,
    nextFrame: () => { lastRead = index; return Promise.resolve(index < frames.length ? frames[index++] : null); },
    viewport: () => ({ width: 1280, height: 720, scrollX: 0, scrollY: 0 }),
    originPermission() { return this.permission; },
    visibility() { return this.vis; },
    frameClockTick: () => ({ clockId: source.clockId, tick: source.ticks[Math.min(Math.max(lastRead, 0), source.ticks.length - 1)] ?? 0n }),
    sourceVersion() { return this.version; },
    detach() { this.detachCalls += 1; return Promise.resolve(); },
  };
  return source;
}

describe("BrowserCaptureAdapter", () => {
  it("captures real frame bytes with echoed rights/version/clock", async () => {
    const source = fakeSource([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => source });
    const frame = await adapter.capture(request);
    expect([...frame.bytes]).toEqual([1, 2, 3]);
    expect(frame.sourceVersionRef).toBe("page@v4");
    expect(frame.frameClockRef).toBe("clock/compositor");
    expect(source.detachCalls).toBe(1);
  });

  it("denied origin permission emits nothing and never reads", async () => {
    const source = fakeSource([new Uint8Array([9])]);
    source.permission = "DENIED";
    let reads = 0;
    const orig = source.nextFrame;
    source.nextFrame = () => { reads += 1; return orig(); };
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(BrowserCaptureError);
    expect(reads).toBe(0);
  });

  it("mid-capture permission revoke fails closed", async () => {
    let index = 0;
    const source = fakeSource([new Uint8Array([1]), new Uint8Array([2])]);
    source.nextFrame = () => {
      if (index === 1) source.permission = "REVOKED";
      return Promise.resolve(index < 2 ? new Uint8Array([index++]) : null);
    };
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(BrowserCaptureError);
  });

  it("hidden or occluded viewport emits no frames", async () => {
    for (const vis of ["HIDDEN", "OCCLUDED"] as const) {
      const source = fakeSource([new Uint8Array([1])]);
      source.vis = vis;
      const adapter = new BrowserCaptureAdapter({ resolveSource: () => source });
      await expect(adapter.capture(request)).rejects.toBeInstanceOf(BrowserCaptureError);
    }
  });

  it("source-version mismatch fails closed", async () => {
    const source = fakeSource([new Uint8Array([1])]);
    source.version = "page@v5";
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => source });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(BrowserCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("clock drift beyond the bound fails closed", async () => {
    const source = fakeSource([new Uint8Array([1]), new Uint8Array([2])], [0n, 60_000_000_000n]);
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => source, maxClockDriftMillis: 5_000 });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(BrowserCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("rejects non-source resolutions and mismatched kinds before resolving", async () => {
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => null as unknown as BrowserCaptureSource });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(BrowserCaptureError);
    let resolved = 0;
    const adapter2 = new BrowserCaptureAdapter({ resolveSource: () => { resolved += 1; return fakeSource([]); } });
    await expect(adapter2.capture({ ...request, kind: "MOBILE" })).rejects.toBeInstanceOf(TypeError);
    expect(resolved).toBe(0);
  });

  it("enforces byte bound and detaches once", async () => {
    const source = fakeSource([new Uint8Array(100), new Uint8Array(100)]);
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => source, maxBytes: 150 });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(BrowserCaptureError);
    expect(source.detachCalls).toBe(1);
  });

  it("passes through the admission seam", async () => {
    const adapter = new BrowserCaptureAdapter({ resolveSource: () => fakeSource([new Uint8Array([1])]) });
    await expect(captureWithAdmission(noAdmittedCaptureAdapter, adapter, request))
      .rejects.toBeInstanceOf(CaptureNotAdmittedError);
  });
});
