import React from "react";

export type CaptureIndicatorDevice = "camera" | "microphone";

/** Browser prompt and unresolved permission both remain non-authorizing UNKNOWN states. */
export type CaptureIndicatorPermission =
  | "GRANTED"
  | "PROMPT"
  | "UNKNOWN"
  | "DENIED"
  | "REVOKED";

export type CaptureIndicatorState =
  | "on"
  | "off"
  | "awaiting-permission"
  | "blocked"
  | "ended"
  | "unknown";

export type HostSelectedTrackObservation =
  | {
    /** The host completed a readback, including the known absence of a selected track. */
    readonly status: "observed";
    readonly selectedTrack: Pick<MediaStreamTrack, "kind" | "readyState"> | null;
    /** True only when the host observed the selected track's containing stream close. */
    readonly streamClosed?: boolean;
  }
  | {
    /** No track state was observed; lack of readback is never rendered as OFF or ON. */
    readonly status: "unknown";
  };

export interface MediaCaptureIndicatorProps {
  readonly device: CaptureIndicatorDevice;
  readonly permission: CaptureIndicatorPermission;
  readonly trackObservation: HostSelectedTrackObservation;
  readonly className?: string;
}

/**
 * Derive a read-only activity label from host observations. This function has
 * no browser, capture, permission-request, or device-selection side effects.
 */
export function deriveCaptureIndicatorState(
  device: CaptureIndicatorDevice,
  permission: CaptureIndicatorPermission,
  trackObservation: HostSelectedTrackObservation,
): CaptureIndicatorState {
  if (permission === "DENIED" || permission === "REVOKED") return "blocked";
  if (permission === "PROMPT" || permission === "UNKNOWN") return "awaiting-permission";
  if (trackObservation.status === "unknown") return "unknown";
  const expectedTrackKind = device === "camera" ? "video" : "audio";
  if (trackObservation.selectedTrack && trackObservation.selectedTrack.kind !== expectedTrackKind) return "unknown";
  if (trackObservation.streamClosed || trackObservation.selectedTrack?.readyState === "ended") return "ended";
  if (!trackObservation.selectedTrack) return "off";

  return trackObservation.selectedTrack.readyState === "live" ? "on" : "unknown";
}

const DEVICE_LABEL: Record<CaptureIndicatorDevice, string> = {
  camera: "Camera",
  microphone: "Microphone",
};

const STATE_LABEL: Record<CaptureIndicatorState, string> = {
  on: "On",
  off: "Off",
  "awaiting-permission": "Awaiting permission",
  blocked: "Blocked",
  ended: "Off (ended)",
  unknown: "Status unknown",
};

/**
 * A presentation-only, accessible indicator for one host-observed device.
 * The input intentionally excludes device IDs and device labels.
 */
export function MediaCaptureIndicator({
  device,
  permission,
  trackObservation,
  className,
}: MediaCaptureIndicatorProps): React.ReactElement {
  const state = deriveCaptureIndicatorState(device, permission, trackObservation);
  const deviceLabel = DEVICE_LABEL[device];
  const classes = ["media-capture-indicator", className].filter(Boolean).join(" ");

  return <div className={classes} data-state={state}>
    <span className="media-capture-indicator__light" aria-hidden="true" />
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${deviceLabel} activity status`}
    >{deviceLabel}: {STATE_LABEL[state]}</span>
    <span className="media-capture-indicator__scope">
      Host-observed activity and permission only; this does not establish consent, source rights, or authorization.
    </span>
  </div>;
}
