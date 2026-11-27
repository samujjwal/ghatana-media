import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  deriveCaptureIndicatorState,
  MediaCaptureIndicator,
  type CaptureIndicatorPermission,
  type CaptureIndicatorState,
  type HostSelectedTrackObservation,
} from "./MediaCaptureIndicator";

const track = (kind: "audio" | "video", readyState: "live" | "ended"): HostSelectedTrackObservation => ({
  status: "observed",
  selectedTrack: { kind, readyState },
});

describe("deriveCaptureIndicatorState", () => {
  it.each([
    ["camera live video + granted", "camera", "GRANTED", track("video", "live"), "on"],
    ["microphone live audio + granted", "microphone", "GRANTED", track("audio", "live"), "on"],
    ["no selected track + granted", "camera", "GRANTED", { status: "observed", selectedTrack: null }, "off"],
    ["ended track + granted", "camera", "GRANTED", track("video", "ended"), "ended"],
    ["closed stream + granted", "microphone", "GRANTED", { status: "observed", selectedTrack: null, streamClosed: true }, "ended"],
    ["prompt permission", "camera", "PROMPT", track("video", "live"), "awaiting-permission"],
    ["unknown permission", "microphone", "UNKNOWN", { status: "observed", selectedTrack: null }, "awaiting-permission"],
    ["denied permission", "camera", "DENIED", { status: "observed", selectedTrack: null }, "blocked"],
    ["revoked permission", "microphone", "REVOKED", track("audio", "ended"), "blocked"],
    ["unknown track readback", "camera", "GRANTED", { status: "unknown" }, "unknown"],
    ["wrong modality", "camera", "GRANTED", track("audio", "live"), "unknown"],
    ["wrong modality even when ended", "camera", "GRANTED", track("audio", "ended"), "unknown"],
  ] as const)("maps %s", (_name, device, permission, observation, expected) => {
    expect(deriveCaptureIndicatorState(device, permission, observation)).toBe(expected);
  });
});

describe("MediaCaptureIndicator", () => {
  it("announces the camera activity state and states its evidence limits accessibly", () => {
    const html = renderToStaticMarkup(React.createElement(MediaCaptureIndicator, {
      device: "camera",
      permission: "GRANTED",
      trackObservation: track("video", "live"),
    }));

    expect(html).toContain('data-state="on"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('aria-label="Camera activity status"');
    expect(html).toContain("Camera: On");
    expect(html).toContain("does not establish consent, source rights, or authorization");
  });

  it("keeps microphone state separate and does not expose track identifiers or labels", () => {
    const sensitiveTrack = Object.assign({ kind: "audio", readyState: "live" }, {
      id: "private-device-id",
      label: "Private Microphone Label",
    }) as Pick<MediaStreamTrack, "kind" | "readyState">;
    const html = renderToStaticMarkup(React.createElement(MediaCaptureIndicator, {
      device: "microphone",
      permission: "GRANTED",
      trackObservation: { status: "observed", selectedTrack: sensitiveTrack },
    }));

    expect(html).toContain('aria-label="Microphone activity status"');
    expect(html).toContain("Microphone: On");
    expect(html).not.toContain("private-device-id");
    expect(html).not.toContain("Private Microphone Label");
  });

  it("never renders unresolved permission or track state as active", () => {
    const permissions: CaptureIndicatorPermission[] = ["PROMPT", "UNKNOWN", "DENIED", "REVOKED"];
    const states = permissions.map((permission) => deriveCaptureIndicatorState("camera", permission, track("video", "live")));
    const expected: CaptureIndicatorState[] = ["awaiting-permission", "awaiting-permission", "blocked", "blocked"];

    expect(states).toEqual(expected);
    expect(states).not.toContain("on");
  });
});
