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
});
