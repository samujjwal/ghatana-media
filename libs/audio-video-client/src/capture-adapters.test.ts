import { describe, expect, it } from "vitest";
import {
  CaptureAdapterNotWiredError,
  CaptureNotAdmittedError,
  CaptureOutcomeUnknownError,
  CaptureUnavailableError,
  captureWithAdmission,
  noCaptureAdapterProbe,
  noAdmittedCaptureAdapter,
  probeCaptureAdapter,
  routedCaptureAdapter,
  unavailableCaptureAdapter,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceAdapter,
  type CameraCaptureMetadata,
} from "./capture-adapters";

const request: CaptureRequest = {
  kind: "MEDIA_FILE",
  sourceIdentity: "media-file:clip-9",
  purposeRef: "purpose/v1",
  exactRightsScope: "rights/clip-9/v1",
  sourceVersionRef: "clip-9@v3",
  secretsRef: "secrets/capture-9",
  frameClockRef: "clock/ntsc-30",
};

function capturedFrame(
  overrides: Partial<CapturedFrame> = {},
  bytes: Uint8Array = new Uint8Array([1]),
): CapturedFrame {
  return {
    sourceIdentity: request.sourceIdentity,
    purposeRef: request.purposeRef,
    exactRightsScope: request.exactRightsScope,
    sourceVersionRef: request.sourceVersionRef,
    frameClockRef: request.frameClockRef,
    bytes,
    capturedAtEpochMillis: 1,
    ...overrides,
  };
}

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

const cameraRequest: CaptureRequest = { ...request, kind: "CAMERA" };

function cameraMetadata(): CameraCaptureMetadata {
  return {
    captureEpochRef: "epoch/camera:v1",
    captureClockRef: cameraRequest.frameClockRef,
    hostCapturePtsNanos: "9000000",
    sourceIdentity: cameraRequest.sourceIdentity,
    sourceVersionRef: cameraRequest.sourceVersionRef,
    permissionDecisionRef: "permission/camera:v1",
    allowedSignals: ["VIDEO", "AUDIO"],
    selectedSignals: ["VIDEO"],
    syncPolicyRef: "sync-policy/camera:v1",
    codecDisposition: "AVAILABLE",
    codecProfileRef: "codec-profile/jpeg:v1",
    codecId: "image/jpeg",
    mimeType: "image/jpeg",
    width: 640,
    height: 480,
    sourceClockRef: "clock/camera-source:v1",
    sourceStreamRef: "stream/camera-video:v1",
    sourceOriginRef: "origin/camera-epoch:v1",
    sourceTimeBase: { numerator: "1", denominator: "90000" },
    clockMappings: ["AUDIO_SAMPLE", "STORY", "SIMULATION", "WALL_CLOCK"].map((destinationDomain) => ({
      sourceDomain: "SOURCE_VIDEO_PRESENTATION",
      destinationDomain,
      disposition: "UNKNOWN",
      reason: "NO_QUALIFIED_CLOCK_ALIGNMENT",
    })) as CameraCaptureMetadata["clockMappings"],
  };
}

function cameraFrame(overrides: Partial<CapturedFrame> = {}): CapturedFrame {
  return capturedFrame({
    cameraMetadata: cameraMetadata(),
    sourcePresentationTime: {
      disposition: "KNOWN",
      sourceClockRef: "clock/camera-source:v1",
      sourceStreamRef: "stream/camera-video:v1",
      sourceOriginRef: "origin/camera-epoch:v1",
      presentationTicks: "9000",
      timeBase: { numerator: "1", denominator: "90000" },
      discontinuity: { disposition: "GAP", evidenceRef: "evidence/camera-gap:v1" },
    },
    audioSampleTime: { disposition: "NOT_SELECTED" },
    ...overrides,
  });
}

describe("captureWithAdmission", () => {
  it("reports a missing adapter unavailable before eligibility or source dispatch", async () => {
    let eligibilityCalls = 0;

    await expect(captureWithAdmission({
      check: () => { eligibilityCalls++; return "ADMITTED"; },
    }, null as unknown as { capture(request: CaptureRequest): Promise<CapturedFrame> }, request))
      .rejects.toMatchObject({ name: "CaptureUnavailableError", kind: "MEDIA_FILE", eligibility: "UNAVAILABLE" });

    expect(eligibilityCalls).toBe(0);
  });

  it("contains a throwing adapter getter as pre-dispatch unavailable", async () => {
    let eligibilityCalls = 0;
    const adapter = Object.defineProperty({}, "capture", {
      get() { throw new Error("sensitive adapter binding detail"); },
    }) as { capture(request: CaptureRequest): Promise<CapturedFrame> };

    await expect(captureWithAdmission({
      check: () => { eligibilityCalls++; return "ADMITTED"; },
    }, adapter, request)).rejects.toBeInstanceOf(CaptureUnavailableError);

    expect(eligibilityCalls).toBe(0);
  });

  it("runs capture only through an admitted adapter and binds source+clock", async () => {
    const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 1_700_000_000_000 }, new Uint8Array([1, 2, 3])));
    const frame = await captureWithAdmission(
      { check: () => "ADMITTED" }, adapter, request);
    expect(frame.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(adapter.calls()).toBe(1);
  });

  it("keeps the selected adapter method across the eligibility callback", async () => {
    let originalCalls = 0;
    let replacementCalls = 0;
    const adapter: { capture(candidate: CaptureRequest): Promise<CapturedFrame> } = {
      capture: async (candidate) => {
        originalCalls++;
        return capturedFrame({
          sourceIdentity: candidate.sourceIdentity,
          purposeRef: candidate.purposeRef,
          exactRightsScope: candidate.exactRightsScope,
          sourceVersionRef: candidate.sourceVersionRef,
          frameClockRef: candidate.frameClockRef,
        }, new Uint8Array([1]));
      },
    };

    const frame = await captureWithAdmission({
      check: () => {
        adapter.capture = async () => {
          replacementCalls++;
          return capturedFrame({}, new Uint8Array([2]));
        };
        return "ADMITTED";
      },
    }, adapter, request);

    expect(frame.bytes).toEqual(new Uint8Array([1]));
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
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
    const frame = await captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning(
      capturedFrame({}, source)), request);
    source[0] = 9;
    expect(frame.bytes).toEqual(new Uint8Array([1, 2]));
    frame.bytes[1] = 8;
    expect(source).toEqual(new Uint8Array([9, 2]));
  });

  it("validates and detaches nested camera clocks and metadata before returning the frame", async () => {
    const sourceMetadata = cameraMetadata();
    const sourceTime = cameraFrame().sourcePresentationTime!;
    const adapterFrame = cameraFrame({ cameraMetadata: sourceMetadata, sourcePresentationTime: sourceTime });
    const frame = await captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning(adapterFrame), cameraRequest);

    const mutableMetadata = sourceMetadata as unknown as {
      allowedSignals: string[];
      clockMappings: Array<{ destinationDomain: string }>;
      sourceTimeBase: { numerator: string; denominator: string };
    };
    mutableMetadata.allowedSignals[0] = "AUDIO";
    mutableMetadata.clockMappings[0]!.destinationDomain = "WALL_CLOCK";
    mutableMetadata.sourceTimeBase.numerator = "90000";
    const mutableSourceTime = sourceTime as unknown as {
      timeBase: { numerator: string; denominator: string };
      discontinuity: { evidenceRef: string };
    };
    mutableSourceTime.timeBase.numerator = "90000";
    mutableSourceTime.discontinuity.evidenceRef = "evidence/attacker:v1";

    expect(frame.cameraMetadata?.allowedSignals).toEqual(["VIDEO", "AUDIO"]);
    expect(frame.cameraMetadata?.clockMappings.map(({ destinationDomain }) => destinationDomain))
      .toEqual(["AUDIO_SAMPLE", "STORY", "SIMULATION", "WALL_CLOCK"]);
    expect(frame.cameraMetadata?.sourceTimeBase).toEqual({ numerator: "1", denominator: "90000" });
    expect(frame.sourcePresentationTime).toMatchObject({
      timeBase: { numerator: "1", denominator: "90000" },
      discontinuity: { disposition: "GAP", evidenceRef: "evidence/camera-gap:v1" },
    });
    expect(Object.isFrozen(frame.cameraMetadata)).toBe(true);
    expect(Object.isFrozen(frame.cameraMetadata?.clockMappings)).toBe(true);
    expect(Object.isFrozen(frame.sourcePresentationTime)).toBe(true);
  });

  it("freezes the camera frame envelope so admitted source and PTS bindings cannot be relabeled", async () => {
    const frame = await captureWithAdmission(
      { check: () => "ADMITTED" }, adapterReturning(cameraFrame()), cameraRequest);

    expect(Object.isFrozen(frame)).toBe(true);
    expect(Reflect.set(frame as unknown as Record<string, unknown>, "sourceVersionRef", "camera@other:v1"))
      .toBe(false);
    expect(Reflect.set(frame as unknown as Record<string, unknown>, "sourcePresentationTime", {
      disposition: "UNKNOWN", reason: "SOURCE_PTS_NOT_SUPPLIED",
    })).toBe(false);
    expect(frame.sourceVersionRef).toBe(cameraRequest.sourceVersionRef);
    expect(frame.sourcePresentationTime).toMatchObject({ disposition: "KNOWN", presentationTicks: "9000" });
  });

  it("freezes admitted gRPC source-version and clock bindings after validation", async () => {
    const grpcRequest: CaptureRequest = { ...request, kind: "GRPC_API" };
    const frame = await captureWithAdmission({ check: () => "ADMITTED" },
      adapterReturning(capturedFrame()), grpcRequest);

    expect(Object.isFrozen(frame)).toBe(true);
    expect(Reflect.set(frame as unknown as Record<string, unknown>, "sourceVersionRef", "stream@attacker"))
      .toBe(false);
    expect(Reflect.set(frame as unknown as Record<string, unknown>, "frameClockRef", "clock:attacker"))
      .toBe(false);
    expect(frame.sourceVersionRef).toBe(grpcRequest.sourceVersionRef);
    expect(frame.frameClockRef).toBe(grpcRequest.frameClockRef);
    // Consumers may still process the detached payload.
    frame.bytes[0] = 9;
    expect(frame.bytes[0]).toBe(9);
  });

  it("preserves negative signed camera PTS when source clock identity matches", async () => {
    const base = cameraFrame();
    if (base.sourcePresentationTime?.disposition !== "KNOWN") throw new Error("fixture must include source PTS");
    const frame = cameraFrame({ sourcePresentationTime: {
      ...base.sourcePresentationTime,
      presentationTicks: "-9223372036854775808",
    } });

    const captured = await captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning(frame), cameraRequest);

    expect(captured.sourcePresentationTime).toMatchObject({
      disposition: "KNOWN", presentationTicks: "-9223372036854775808",
    });
  });

  it("returns sanitized UNKNOWN for malformed camera clock sets and mismatched source PTS", async () => {
    const duplicatedClockDomains = cameraMetadata();
    const mutableMappings = duplicatedClockDomains.clockMappings as unknown as Array<{
      destinationDomain: string;
    }>;
    mutableMappings[3]!.destinationDomain = "STORY";
    const malformed = cameraFrame({ cameraMetadata: duplicatedClockDomains });
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning(malformed), cameraRequest))
      .rejects.toMatchObject({ kind: "CAMERA", reason: "INVALID_FRAME" });

    const knownTime = cameraFrame().sourcePresentationTime!;
    if (knownTime.disposition !== "KNOWN") throw new Error("test fixture must have known camera PTS");
    const mismatched = cameraFrame({ sourcePresentationTime: {
      ...knownTime, sourceClockRef: "clock/other:v1",
    } });
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning(mismatched), cameraRequest))
      .rejects.toMatchObject({ kind: "CAMERA", reason: "INVALID_FRAME" });
  });

  it.each([["NOT_ADMITTED"], ["UNAVAILABLE"]] as const)(
    "rejects before capture when eligibility is %s", async (decision) => {
      const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 0 }));
      await expect(captureWithAdmission({ check: () => decision }, adapter, request))
        .rejects.toBeInstanceOf(CaptureNotAdmittedError);
      expect(adapter.calls()).toBe(0);
    });

  it.each(["BROWSER", "DESKTOP", "MOBILE", "TERMINAL",
    "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE"] as const)(
    "keeps an unavailable %s host typed UNAVAILABLE without dispatch", async (kind) => {
      let eligibilityCalls = 0;
      const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 0 }));
      const outcome = captureWithAdmission({
        check: (candidate) => {
          eligibilityCalls++;
          expect(candidate.kind).toBe(kind);
          return unavailableCaptureAdapter.check(candidate);
        },
      }, adapter, { ...request, kind });
      await expect(outcome).rejects.toBeInstanceOf(CaptureUnavailableError);
      await expect(outcome).rejects.toMatchObject({ eligibility: "UNAVAILABLE" });
      expect(eligibilityCalls).toBe(1);
      expect(adapter.calls()).toBe(0);
    });

  it("fails closed when gRPC eligibility readback errors without exposing its details", async () => {
    const adapter = adapterReturning(capturedFrame());
    let outcome: unknown;
    try {
      await captureWithAdmission({
        check: () => { throw new Error("SECRET_CURSOR_TOKEN from transport readback"); },
      }, adapter, { ...request, kind: "GRPC_API" });
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(CaptureUnavailableError);
    expect(String(outcome)).not.toMatch(/SECRET_CURSOR_TOKEN|transport readback/u);
    expect(adapter.calls()).toBe(0);
  });

  it("the no-admission seam denies every kind", () => {
    for (const kind of ["BROWSER", "DESKTOP", "MOBILE", "TERMINAL",
      "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE"] as const) {
      expect(noAdmittedCaptureAdapter.check({ ...request, kind })).toBe("NOT_ADMITTED");
    }
  });

  it("returns NOT_ADMITTED from the disabled adapter for every kind without capture", async () => {
    for (const kind of ["BROWSER", "DESKTOP", "MOBILE", "TERMINAL",
      "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE"] as const) {
      const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 0 }));
      await expect(captureWithAdmission(noAdmittedCaptureAdapter, adapter, { ...request, kind }))
        .rejects.toMatchObject({ name: "CaptureNotAdmittedError", eligibility: "NOT_ADMITTED" });
      expect(adapter.calls()).toBe(0);
    }
  });

  it("rejects a captured frame bound to a different source or clock", async () => {
    const adapter = adapterReturning(capturedFrame({ sourceIdentity: "media-file:other", capturedAtEpochMillis: 0 }));
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapter, request))
      .rejects.toMatchObject({ name: "CaptureOutcomeUnknownError", reason: "INVALID_FRAME" });
  });

  it("returns typed NOT_ADMITTED for requests missing any source, rights, purpose, secret ref or clock", async () => {
    const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 0 }));
    let eligibilityCalls = 0;
    for (const field of ["sourceIdentity", "purposeRef", "exactRightsScope", "sourceVersionRef",
      "secretsRef", "frameClockRef"] as const) {
      await expect(captureWithAdmission(
        { check: () => { eligibilityCalls++; return "ADMITTED"; } }, adapter,
        { ...request, [field]: " " }))
        .rejects.toBeInstanceOf(CaptureNotAdmittedError);
    }
    expect(eligibilityCalls).toBe(0);
    expect(adapter.calls()).toBe(0);
  });

  it("rejects non-canonical request references before eligibility or capture", async () => {
    let eligibilityCalls = 0;
    const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 0 }));
    for (const field of ["sourceIdentity", "purposeRef", "exactRightsScope", "sourceVersionRef",
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
    const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 0 }));
    await expect(captureWithAdmission({
      check: () => "MAYBE" as "ADMITTED",
    }, adapter, request)).rejects.toThrow(/unsupported decision/u);
    expect(adapter.calls()).toBe(0);
  });

  it("rejects an unrecognized runtime source kind before eligibility or capture", async () => {
    let eligibilityCalls = 0;
    const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis: 1 }));
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
        return capturedFrame({ capturedAtEpochMillis: 1 });
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
    const adapter = adapterReturning(capturedFrame({ capturedAtEpochMillis }, bytes));
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapter, request))
      .rejects.toBeInstanceOf(CaptureOutcomeUnknownError);
    expect(adapter.calls()).toBe(1);
  });

  it("rejects captured frames above the bounded byte size", async () => {
    const adapter = adapterReturning(capturedFrame({}, new Uint8Array(64 * 1024 * 1024 + 1)));
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, adapter, request))
      .rejects.toMatchObject({ reason: "INVALID_FRAME", kind: "MEDIA_FILE" });
  });

  it.each([
    ["purposeRef", { purposeRef: "purpose/other" }],
    ["exactRightsScope", { exactRightsScope: "rights/other" }],
    ["sourceVersionRef", { sourceVersionRef: "clip-9@v4" }],
    ["frameClockRef", { frameClockRef: "clock/other" }],
  ] as const)("returns sanitized UNKNOWN when captured %s provenance differs", async (_field, binding) => {
    await expect(captureWithAdmission({ check: () => "ADMITTED" },
      adapterReturning(capturedFrame(binding)), request))
      .rejects.toMatchObject({ reason: "INVALID_FRAME", kind: "MEDIA_FILE" });
  });

  it.each([
    ["source marker", "SECRET_OTHER_SOURCE", request.frameClockRef],
    ["clock marker", request.sourceIdentity, "SECRET_OTHER_CLOCK"],
  ])("returns sanitized UNKNOWN when the captured %s does not match", async (_label, sourceIdentity, frameClockRef) => {
    let outcome: unknown;
    try {
      await captureWithAdmission({ check: () => "ADMITTED" }, adapterReturning(capturedFrame({
        sourceIdentity,
        frameClockRef,
      })), {
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
          purposeRef: admitted.purposeRef,
          exactRightsScope: admitted.exactRightsScope,
          sourceVersionRef: admitted.sourceVersionRef,
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

describe("routedCaptureAdapter", () => {
  function kindAdapter(kind: CaptureRequest["kind"], bytes: number[]): CaptureSourceAdapter {
    return {
      kind,
      capture: async (candidate) => capturedFrame({
        sourceIdentity: candidate.sourceIdentity,
        purposeRef: candidate.purposeRef,
        exactRightsScope: candidate.exactRightsScope,
        sourceVersionRef: candidate.sourceVersionRef,
        frameClockRef: candidate.frameClockRef,
        bytes: new Uint8Array(bytes),
        capturedAtEpochMillis: 5,
      }),
    };
  }

  it("dispatches each admitted kind to its wired adapter", async () => {
    const fileAdapter = kindAdapter("MEDIA_FILE", [1]);
    const httpAdapter = kindAdapter("HTTP_API", [2]);
    const routed = routedCaptureAdapter({ MEDIA_FILE: fileAdapter, HTTP_API: httpAdapter });
    for (const [kind, expected] of [["MEDIA_FILE", 1], ["HTTP_API", 2]] as const) {
      const frame = await captureWithAdmission({ check: () => "ADMITTED" }, routed,
        { ...request, kind });
      expect(Array.from(frame.bytes)).toEqual([expected]);
    }
  });

  it("keeps dispatch bound to the adapter validated at composition time", async () => {
    let originalCaptures = 0;
    let replacementCaptures = 0;
    const original = kindAdapter("MEDIA_FILE", [1]);
    const replacement: CaptureSourceAdapter = {
      kind: "HTTP_API",
      capture: async (candidate) => {
        replacementCaptures++;
        return capturedFrame({
          sourceIdentity: candidate.sourceIdentity,
          purposeRef: candidate.purposeRef,
          exactRightsScope: candidate.exactRightsScope,
          sourceVersionRef: candidate.sourceVersionRef,
          frameClockRef: candidate.frameClockRef,
          bytes: new Uint8Array([2]),
          capturedAtEpochMillis: 5,
        });
      },
    };
    const mutableRegistry: Partial<Record<CaptureRequest["kind"], CaptureSourceAdapter>> = {
      MEDIA_FILE: {
        kind: "MEDIA_FILE",
        capture: async (candidate) => {
          originalCaptures++;
          return original.capture(candidate);
        },
      },
    };
    const routed = routedCaptureAdapter(mutableRegistry);
    mutableRegistry.MEDIA_FILE = replacement;

    const frame = await captureWithAdmission(
      { check: () => "ADMITTED" }, routed, { ...request, kind: "MEDIA_FILE" });

    expect(Array.from(frame.bytes)).toEqual([1]);
    expect(originalCaptures).toBe(1);
    expect(replacementCaptures).toBe(0);
  });

  it("rejects kinds without a wired adapter before any capture", async () => {
    const routed = routedCaptureAdapter({ MEDIA_FILE: kindAdapter("MEDIA_FILE", [1]) });
    await expect(captureWithAdmission({ check: () => "ADMITTED" }, routed,
      { ...request, kind: "CAMERA" }))
      .rejects.toMatchObject({ name: "CaptureUnavailableError", eligibility: "UNAVAILABLE" });
    await expect(routed.capture({ ...request, kind: "CAMERA" }))
      .rejects.toBeInstanceOf(CaptureAdapterNotWiredError);
  });

  it("keeps an admitted but unwired gRPC source unavailable before dispatch", async () => {
    let eligibilityCalls = 0;
    const routed = routedCaptureAdapter({});

    await expect(captureWithAdmission({
      check: (candidate) => {
        eligibilityCalls++;
        expect(candidate.kind).toBe("GRPC_API");
        return "ADMITTED";
      },
    }, routed, { ...request, kind: "GRPC_API" }))
      .rejects.toMatchObject({
        name: "CaptureUnavailableError",
        kind: "GRPC_API",
        eligibility: "UNAVAILABLE",
      });
    expect(eligibilityCalls).toBe(1);
  });

  it("does not invoke the gRPC adapter when trusted eligibility denies capture", async () => {
    let captures = 0;
    const grpcAdapter: CaptureSourceAdapter = {
      kind: "GRPC_API",
      capture: async () => {
        captures++;
        throw new Error("must not dispatch");
      },
    };

    await expect(captureWithAdmission({ check: () => "NOT_ADMITTED" },
      routedCaptureAdapter({ GRPC_API: grpcAdapter }), { ...request, kind: "GRPC_API" }))
      .rejects.toMatchObject({ name: "CaptureNotAdmittedError", eligibility: "NOT_ADMITTED" });
    expect(captures).toBe(0);
  });

  it("rejects mislabeled wiring and invalid kinds at composition", () => {
    expect(() => routedCaptureAdapter({
      MEDIA_FILE: kindAdapter("HTTP_API", [1]),
    })).toThrow(/match their source kind/u);
    expect(() => routedCaptureAdapter(null as unknown as Record<string, never>))
      .toThrow(/registry must be an object/u);
    const routed = routedCaptureAdapter({});
    return expect(routed.capture({ ...request, kind: "FAKE" as CaptureRequest["kind"] }))
      .rejects.toThrow(/source enum/u);
  });
});

describe("probeCaptureAdapter", () => {
  const probeRequest = {
    tenantId: "tenant/demo",
    sourceId: "source/demo",
    providerProfileId: "profile/demo",
    requestedSignals: ["screen", "clock"],
    policyRef: "policy/capture/v1",
  } as const;

  it("preserves the PDP-1 observation result variants without dispatching capture", async () => {
    expect(await probeCaptureAdapter(noCaptureAdapterProbe, probeRequest)).toBe("NOT_QUALIFIED");
    for (const disposition of ["QUALIFIED", "NOT_QUALIFIED", "UNAVAILABLE", "DENIED"] as const) {
      let seen: unknown;
      expect(await probeCaptureAdapter({
        probe: async (request) => { seen = request; return disposition; },
      }, probeRequest)).toBe(disposition);
      expect(seen).toMatchObject(probeRequest);
      expect(Object.isFrozen(seen)).toBe(true);
      expect(Object.isFrozen((seen as { requestedSignals: readonly string[] }).requestedSignals)).toBe(true);
    }
    expect(noAdmittedCaptureAdapter.check(request)).toBe("NOT_ADMITTED");
  });

  it("maps failed observation to UNAVAILABLE without exposing provider errors", async () => {
    await expect(probeCaptureAdapter({
      probe: async () => { throw new Error("secret-bearing provider failure"); },
    }, probeRequest)).resolves.toBe("UNAVAILABLE");
  });

  it("preserves requested signal order and duplicates", async () => {
    let seenSignals: readonly string[] = [];
    await probeCaptureAdapter({
      probe: async (request) => { seenSignals = request.requestedSignals; return "NOT_QUALIFIED"; },
    }, { ...probeRequest, requestedSignals: ["screen", "clock", "screen"] });
    expect(seenSignals).toEqual(["screen", "clock", "screen"]);
  });

  it("rejects malformed source-defined probe requests before invoking the probe", async () => {
    let calls = 0;
    const probe = { probe: async () => { calls++; return "QUALIFIED" as const; } };
    await expect(probeCaptureAdapter(probe, { ...probeRequest, requestedSignals: [] }))
      .rejects.toThrow(/1\.\.32/u);
    await expect(probeCaptureAdapter(probe, { ...probeRequest, policyRef: " " }))
      .rejects.toThrow(/policyRef/u);
    expect(calls).toBe(0);
  });
});
