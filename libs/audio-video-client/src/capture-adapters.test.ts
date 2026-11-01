import { describe, expect, it } from "vitest";
import {
  CaptureNotAdmittedError,
  CaptureOutcomeUnknownError,
  CaptureUnavailableError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  unavailableCaptureAdapter,
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

  it("marks an admitted adapter rejection unknown without exposing caller-controlled refs or provider text", async () => {
    let eligibilityCalls = 0;
    let captureCalls = 0;
    let outcome: unknown;
    try {
      await captureWithAdmission({
      check: () => { eligibilityCalls++; return "ADMITTED"; },
    }, {
      capture: async () => {
        captureCalls++;
        throw new Error("provider transport failure with potentially sensitive details");
      },
    }, {
      ...request,
      sourceIdentity: "SECRET_SOURCE_MARKER",
      sourceVersionRef: "SECRET_VERSION_MARKER",
      purposeRef: "SECRET_PURPOSE_MARKER",
      secretsRef: "SECRET_VALUE_MARKER",
      frameClockRef: "SECRET_CLOCK_MARKER",
    });
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(CaptureOutcomeUnknownError);
    expect(outcome).toBeInstanceOf(TypeError);
    expect(outcome).toMatchObject({ kind: "MEDIA_FILE", reason: "ADAPTER_REJECTED" });
    expect(String(outcome)).not.toMatch(/SECRET_|potentially sensitive details/u);
    expect(Object.keys(outcome as object).sort()).toEqual(["kind", "name", "reason"]);
    expect(eligibilityCalls).toBe(1);
    expect(captureCalls).toBe(1);
  });

  it("detaches captured bytes from the adapter-owned frame", async () => {
    const source = new Uint8Array([1, 2]);
    const frame = await captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning({
      sourceIdentity: request.sourceIdentity, frameClockRef: request.frameClockRef,
      bytes: source, capturedAtEpochMillis: 1,
    }), request);
    source[0] = 9;
    expect(frame.bytes).toEqual(new Uint8Array([1, 2]));
    frame.bytes[1] = 8;
    expect(source).toEqual(new Uint8Array([9, 2]));
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

  it.each(["BROWSER", "DESKTOP", "MOBILE", "CAMERA", "HTTP_API", "GRPC_API"] as const)(
    "reports an absent %s host capability as UNAVAILABLE without dispatch", async (kind) => {
      let eligibilityCalls = 0;
      const adapter = adapterReturning({
        sourceIdentity: request.sourceIdentity,
        frameClockRef: request.frameClockRef,
        bytes: new Uint8Array([1]),
        capturedAtEpochMillis: 0,
      });
      await expect(captureWithAdmission({
        check: (candidate) => {
          eligibilityCalls++;
          expect(candidate.kind).toBe(kind);
          return unavailableCaptureAdapter.check(candidate);
        },
      }, adapter, { ...request, kind }))
        .rejects.toBeInstanceOf(CaptureUnavailableError);
      expect(eligibilityCalls).toBe(1);
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
      .rejects.toMatchObject({ name: "CaptureOutcomeUnknownError", reason: "INVALID_FRAME" });
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

  it("rejects non-canonical request references before eligibility or capture", async () => {
    let eligibilityCalls = 0;
    const adapter = adapterReturning({
      sourceIdentity: request.sourceIdentity,
      frameClockRef: request.frameClockRef,
      bytes: new Uint8Array([1]),
      capturedAtEpochMillis: 0,
    });
    for (const field of ["sourceIdentity", "purposeRef", "sourceVersionRef",
      "secretsRef", "frameClockRef"] as const) {
      await expect(captureWithAdmission({
        check: () => { eligibilityCalls++; return "ADMITTED"; },
      }, adapter, { ...request, [field]: ` ${request[field]} ` }))
        .rejects.toThrow(/canonical/u);
    }
    expect(eligibilityCalls).toBe(0);
    expect(adapter.calls()).toBe(0);
  });

  it("rejects an invalid runtime eligibility result without attempting capture", async () => {
    const adapter = adapterReturning({
      sourceIdentity: request.sourceIdentity,
      frameClockRef: request.frameClockRef,
      bytes: new Uint8Array([1]),
      capturedAtEpochMillis: 0,
    });
    await expect(captureWithAdmission({
      check: () => "MAYBE" as "ADMITTED",
    }, adapter, request)).rejects.toThrow(/unsupported decision/u);
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
      .rejects.toBeInstanceOf(CaptureOutcomeUnknownError);
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
      .rejects.toMatchObject({ reason: "INVALID_FRAME", kind: "MEDIA_FILE" });
  });

  it.each([
    ["source marker", "SECRET_OTHER_SOURCE", request.frameClockRef],
    ["clock marker", request.sourceIdentity, "SECRET_OTHER_CLOCK"],
  ])("returns sanitized UNKNOWN when the captured %s does not match", async (_label, sourceIdentity, frameClockRef) => {
    let outcome: unknown;
    try {
      await captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning({
        sourceIdentity,
        frameClockRef,
        bytes: new Uint8Array([1]),
        capturedAtEpochMillis: 1,
      }), {
        ...request,
        sourceIdentity: "SECRET_EXPECTED_SOURCE",
        frameClockRef: "SECRET_EXPECTED_CLOCK",
      });
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(CaptureOutcomeUnknownError);
    expect(outcome).toMatchObject({ reason: "INVALID_FRAME", kind: "MEDIA_FILE" });
    expect(String(outcome)).not.toMatch(/SECRET_|OTHER_/u);
    expect(Object.keys(outcome as object).sort()).toEqual(["kind", "name", "reason"]);
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
