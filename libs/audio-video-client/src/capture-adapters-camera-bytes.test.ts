import { describe, expect, it } from "vitest";
import { captureWithAdmission, type CameraCaptureMetadata, type CaptureRequest, type CapturedFrame } from "./capture-adapters.js";

const request: CaptureRequest = {
  kind: "CAMERA",
  sourceIdentity: "camera:device-1",
  purposeRef: "purpose/record-scene/v3",
  exactRightsScope: "rights/camera-device-1/v4",
  sourceVersionRef: "camera-device-1@v2",
  secretsRef: "secrets/camera-session-1",
  frameClockRef: "clock/camera-monotonic",
};

function metadata(): CameraCaptureMetadata {
  return {
    captureEpochRef: "epoch/camera:v1",
    captureClockRef: request.frameClockRef,
    hostCapturePtsNanos: "9000000",
    sourceIdentity: request.sourceIdentity,
    sourceVersionRef: request.sourceVersionRef,
    permissionDecisionRef: "permission/camera:v1",
    allowedSignals: ["VIDEO"],
    selectedSignals: ["VIDEO"],
    syncPolicyRef: "sync-policy/camera:v1",
    codecDisposition: "AVAILABLE",
    codecProfileRef: "codec-profile/jpeg:v1",
    codecId: "image/jpeg",
    mimeType: "image/jpeg",
    width: 640,
    height: 480,
    sourceClockRef: null,
    sourceStreamRef: null,
    sourceOriginRef: null,
    sourceTimeBase: null,
    clockMappings: ["AUDIO_SAMPLE", "STORY", "SIMULATION", "WALL_CLOCK"].map((destinationDomain) => ({
      sourceDomain: "SOURCE_VIDEO_PRESENTATION" as const,
      destinationDomain: destinationDomain as CameraCaptureMetadata["clockMappings"][number]["destinationDomain"],
      disposition: "UNKNOWN" as const,
      reason: "NO_QUALIFIED_CLOCK_ALIGNMENT" as const,
    })),
  };
}

function frame(bytes: Uint8Array): CapturedFrame {
  return {
    sourceIdentity: request.sourceIdentity,
    purposeRef: request.purposeRef,
    exactRightsScope: request.exactRightsScope,
    sourceVersionRef: request.sourceVersionRef,
    frameClockRef: request.frameClockRef,
    bytes,
    capturedAtEpochMillis: 1_800_000_000_000,
    cameraMetadata: metadata(),
    sourcePresentationTime: { disposition: "UNKNOWN", reason: "SOURCE_PTS_NOT_SUPPLIED" },
    audioSampleTime: { disposition: "NOT_SELECTED" },
  };
}

describe("camera capture byte snapshot", () => {
  it("copies indexed device bytes without trusting provider iterator or length overrides", async () => {
    class ProviderBytes extends Uint8Array {
      public override [Symbol.iterator](): ArrayIterator<number> {
        return [0xee, 0xee, 0xee][Symbol.iterator]();
      }
    }
    const providerBytes = new ProviderBytes([0x12, 0x34]);
    Object.defineProperty(providerBytes, "byteLength", { configurable: true, value: 0 });

    const admitted = await captureWithAdmission(
      { check: () => "ADMITTED" },
      { capture: async () => frame(providerBytes) },
      request,
    );

    expect(admitted.bytes).toEqual(new Uint8Array([0x12, 0x34]));
    providerBytes[0] = 0xff;
    expect(admitted.bytes).toEqual(new Uint8Array([0x12, 0x34]));
  });
});
