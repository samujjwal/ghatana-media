import { describe, expect, it } from "vitest";
import {
  CaptureNotAdmittedError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureRequest,
  type CapturedFrame,
} from "./capture-adapters";

const request: CaptureRequest = {
  kind: "MEDIA_FILE",
  sourceIdentity: "media-file:clip-9",
  purposeRef: "purpose/v1",
  sourceVersionRef: "clip-9@v3",
  secretsRef: "secrets/capture-9",
  frameClockRef: "clock/ntsc-30",
};

function adapterReturning(frame: CapturedFrame) {
  let calls = 0;
  return {
    calls: () => calls,
    capture: async (_request: CaptureRequest): Promise<CapturedFrame> => {
      calls++;
      return frame;
    },
  };
}

describe("captureWithAdmission", () => {
  it("runs capture only through an admitted adapter and binds source+clock", async () => {
    const adapter = adapterReturning({
      sourceIdentity: request.sourceIdentity,
      frameClockRef: request.frameClockRef,
      bytes: new Uint8Array([1, 2, 3]),
      capturedAtEpochMillis: 1_700_000_000_000,
    });
    const frame = await captureWithAdmission(
      { check: () => "ADMITTED" }, adapter, request);
    expect(frame.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(adapter.calls()).toBe(1);
  });

  it.each([["NOT_ADMITTED"], ["UNAVAILABLE"]] as const)(
    "rejects before capture when eligibility is %s", async (decision) => {
      const adapter = adapterReturning({
        sourceIdentity: request.sourceIdentity,
        frameClockRef: request.frameClockRef,
        bytes: new Uint8Array([1]),
        capturedAtEpochMillis: 0,
      });
      await expect(captureWithAdmission({ check: () => decision }, adapter, request))
        .rejects.toBeInstanceOf(CaptureNotAdmittedError);
      expect(adapter.calls()).toBe(0);
    });

  it("the no-admission seam denies every kind", () => {
    for (const kind of ["BROWSER", "DESKTOP", "MOBILE", "TERMINAL",
      "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE"] as const) {
      expect(noAdmittedCaptureAdapter.check({ ...request, kind })).toBe("NOT_ADMITTED");
    }
  });

  it("rejects a captured frame bound to a different source or clock", async () => {
    const adapter = adapterReturning({
      sourceIdentity: "media-file:other",
      frameClockRef: request.frameClockRef,
      bytes: new Uint8Array([1]),
      capturedAtEpochMillis: 0,
    });
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapter, request))
      .rejects.toThrow(/does not bind the requested source identity and clock/u);
  });

  it("rejects requests missing source identity, purpose, version, secrets or clock", async () => {
    const adapter = adapterReturning({
      sourceIdentity: request.sourceIdentity,
      frameClockRef: request.frameClockRef,
      bytes: new Uint8Array([1]),
      capturedAtEpochMillis: 0,
    });
    for (const field of ["sourceIdentity", "purposeRef", "sourceVersionRef",
      "secretsRef", "frameClockRef"] as const) {
      await expect(captureWithAdmission(
        { check: () => "ADMITTED" }, adapter, { ...request, [field]: " " }))
        .rejects.toThrow(TypeError);
    }
    expect(adapter.calls()).toBe(0);
  });

  it("rejects an unrecognized runtime source kind before eligibility or capture", async () => {
    let eligibilityCalls = 0;
    const adapter = adapterReturning({
      sourceIdentity: request.sourceIdentity,
      frameClockRef: request.frameClockRef,
      bytes: new Uint8Array([1]),
      capturedAtEpochMillis: 1,
    });
    await expect(captureWithAdmission({
      check: () => { eligibilityCalls++; return "ADMITTED"; },
    }, adapter, { ...request, kind: "FAKE_SOURCE" as CaptureRequest["kind"] }))
      .rejects.toThrow(/source enum/u);
    expect(eligibilityCalls).toBe(0);
    expect(adapter.calls()).toBe(0);
  });

  it("rejects an accessor that changes kind between guard and snapshot reads", async () => {
    let kindReads = 0;
    let callbackCalls = 0;
    const changingKindRequest = { ...request };
    Object.defineProperty(changingKindRequest, "kind", {
      get: () => kindReads++ === 0 ? "MEDIA_FILE" : "FAKE_SOURCE",
    });
    await expect(captureWithAdmission({
      check: () => { callbackCalls++; return "ADMITTED"; },
    }, {
      capture: async () => {
        callbackCalls++;
        return {
          sourceIdentity: request.sourceIdentity,
          frameClockRef: request.frameClockRef,
          bytes: new Uint8Array([1]),
          capturedAtEpochMillis: 1,
        };
      },
    }, changingKindRequest))
      .rejects.toThrow(/source enum/u);
    expect(kindReads).toBe(2);
    expect(callbackCalls).toBe(0);
  });

  it.each([
    ["empty bytes", new Uint8Array(), 1],
    ["non-byte payload", { length: 1 } as unknown as Uint8Array, 1],
    ["invalid timestamp", new Uint8Array([1]), Number.NaN],
    ["negative timestamp", new Uint8Array([1]), -1],
    ["unsafe timestamp", new Uint8Array([1]), Number.MAX_SAFE_INTEGER + 1],
  ])("rejects capture output with %s", async (_label, bytes, capturedAtEpochMillis) => {
    const adapter = adapterReturning({
      sourceIdentity: request.sourceIdentity,
      frameClockRef: request.frameClockRef,
      bytes,
      capturedAtEpochMillis,
    });
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapter, request))
      .rejects.toThrow(TypeError);
    expect(adapter.calls()).toBe(1);
  });

  it("rejects captured frames above the bounded byte size", async () => {
    const adapter = adapterReturning({
      sourceIdentity: request.sourceIdentity,
      frameClockRef: request.frameClockRef,
      bytes: new Uint8Array(64 * 1024 * 1024 + 1),
      capturedAtEpochMillis: 1,
    });
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapter, request))
      .rejects.toThrow(/capture bound/u);
  });

  it("keeps eligibility and frame binding on a frozen request snapshot during async capture", async () => {
    const callerRequest = { ...request };
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    let eligibilityRequest: CaptureRequest | undefined;
    let adapterRequest: CaptureRequest | undefined;
    const pending = captureWithAdmission({
      check: (admitted) => {
        eligibilityRequest = admitted;
        expect(Reflect.set(admitted as unknown as Record<string, unknown>,
          "sourceIdentity", "media-file:eligibility-relabel")).toBe(false);
        return "ADMITTED";
      },
    }, {
      capture: async (admitted) => {
        adapterRequest = admitted;
        await captureGate;
        return {
          sourceIdentity: admitted.sourceIdentity,
          frameClockRef: admitted.frameClockRef,
          bytes: new Uint8Array([9]),
          capturedAtEpochMillis: 1_700_000_000_000,
        };
      },
    }, callerRequest);

    callerRequest.sourceIdentity = "media-file:attacker-relabel";
    callerRequest.frameClockRef = "clock:attacker-relabel";
    releaseCapture();
    const frame = await pending;

    expect(Object.isFrozen(eligibilityRequest)).toBe(true);
    expect(adapterRequest).toBe(eligibilityRequest);
    expect(eligibilityRequest?.sourceIdentity).toBe(request.sourceIdentity);
    expect(eligibilityRequest?.frameClockRef).toBe(request.frameClockRef);
    expect(frame.sourceIdentity).toBe(request.sourceIdentity);
    expect(frame.frameClockRef).toBe(request.frameClockRef);
  });
});
