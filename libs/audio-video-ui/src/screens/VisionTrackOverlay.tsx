import React from "react";
import {
  DEFAULT_EXACT_TOLERANCE_US, boxesAt, formatSeconds,
  type VisionTracksDocument,
} from "./devVisionTracks";

export interface VisionTrackOverlayProps {
  readonly document: VisionTracksDocument;
  /** A blob URL (or other URL) of the exact source video whose bytes were verified by the caller. */
  readonly videoSrc: string;
  readonly videoLabel: string;
  /** Window within which the playhead counts as being on a sampled frame; otherwise the earlier frame is "held". */
  readonly exactToleranceMicros?: number;
}

const PALETTE_SIZE = 6;
const toMicros = (seconds: number): number => Math.round(seconds * 1_000_000);

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Video player with a track overlay: the boxes drawn are the detections of the sampled frame that governs the
 * playhead, in the exact source pixel coordinates of the video (the SVG viewBox is the source raster, so the boxes
 * scale with the video). Playhead time is the video clock in source PTS; frames between sampled frames show the last
 * sampled frame's boxes and say so (`data-sync="held"`). The overlay is decorative to the video's own controls
 * (pointer-events none) and every box is also available as text: a labelled group, per-box titles, a polite status
 * line that updates on pause and seek (not every frame), and a keyboard-operable list of tracks.
 */
export function VisionTrackOverlay({ document: tracksDocument, videoSrc, videoLabel, exactToleranceMicros = DEFAULT_EXACT_TOLERANCE_US }: VisionTrackOverlayProps): React.ReactElement {
  const videoRef = React.useRef<FrameCallbackVideo | null>(null);
  const [timeMicros, setTimeMicros] = React.useState(0);
  const [announcedMicros, setAnnouncedMicros] = React.useState(0);
  const [showBoxes, setShowBoxes] = React.useState(true);
  const [selected, setSelected] = React.useState<string | null>(null);
  const headingId = React.useId();

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let handle = 0;
    let usingFrameCallback = false;
    const read = (): void => setTimeMicros(toMicros(video.currentTime));
    const announce = (): void => { read(); setAnnouncedMicros(toMicros(video.currentTime)); };
    const pump = (): void => {
      read();
      if (video.paused || video.ended) return;
      if (typeof video.requestVideoFrameCallback === "function") {
        usingFrameCallback = true;
        handle = video.requestVideoFrameCallback(pump);
      } else {
        handle = window.requestAnimationFrame(pump);
      }
    };
    const onPlay = (): void => pump();
    video.addEventListener("play", onPlay);
    video.addEventListener("seeking", read);
    video.addEventListener("seeked", announce);
    video.addEventListener("pause", announce);
    video.addEventListener("loadedmetadata", announce);
    video.addEventListener("timeupdate", read);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("seeking", read);
      video.removeEventListener("seeked", announce);
      video.removeEventListener("pause", announce);
      video.removeEventListener("loadedmetadata", announce);
      video.removeEventListener("timeupdate", read);
      if (handle) {
        if (usingFrameCallback && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(handle);
        else window.cancelAnimationFrame(handle);
      }
    };
  }, [videoSrc]);

  const current = React.useMemo(() => boxesAt(tracksDocument, timeMicros, exactToleranceMicros), [tracksDocument, timeMicros, exactToleranceMicros]);
  const announced = React.useMemo(() => boxesAt(tracksDocument, announcedMicros, exactToleranceMicros), [tracksDocument, announcedMicros, exactToleranceMicros]);
  const { width, height } = tracksDocument.video;
  const colorOf = (trackId: string): number => Math.max(0, tracksDocument.tracks.findIndex((track) => track.trackId === trackId)) % PALETTE_SIZE;

  const seekTo = (micros: number): void => {
    const video = videoRef.current;
    if (!video) return;
    // A hair past the PTS so the presented frame is the sampled one, not its predecessor.
    video.currentTime = (micros + 1_000) / 1_000_000;
  };

  const statusText = announced.frame === null
    ? `At ${formatSeconds(announcedMicros)}: before the first sampled frame, no tracked objects.`
    : `At ${formatSeconds(announcedMicros)}: ${announced.boxes.length} tracked ${announced.boxes.length === 1 ? "object" : "objects"} from sampled frame ${announced.frame.frameIndex} at ${formatSeconds(announced.frame.ptsMicros)}${announced.sync === "held" ? " (held from the earlier sampled frame)" : ""}${announced.boxes.length ? `: ${announced.boxes.map(({ track }) => `${track.label} ${track.trackId}`).join(", ")}` : ""}.`;

  return <section aria-labelledby={headingId} className="vto" data-vision-overlay="">
    <h3 id={headingId}>Video with tracked objects</h3>
    <div className="vto-stage">
      <video ref={videoRef} src={videoSrc} controls preload="auto" muted aria-label={videoLabel} className="vto-video" data-source-width={width} data-source-height={height} />
      {showBoxes && <svg className="vto-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="group"
        aria-label={current.frame ? `Tracked object boxes at ${formatSeconds(current.frame.ptsMicros)}` : "Tracked object boxes (none before the first sampled frame)"}
        data-frame-index={current.frame?.frameIndex ?? ""} data-frame-pts-micros={current.frame?.ptsMicros ?? ""} data-sync={current.sync} data-box-count={current.boxes.length}>
        {current.boxes.map(({ track, observation }) => {
          const { x, y, width: w, height: h } = observation.box;
          return <g key={track.trackId} className={`vto-box vto-c${colorOf(track.trackId)}${selected === null ? "" : selected === track.trackId ? " is-selected" : " is-dimmed"}`}
            data-track-id={track.trackId} data-label={track.label} data-frame-index={observation.frameIndex}>
            <title>{`${track.label} ${track.trackId}: box x ${x}, y ${y}, width ${w}, height ${h} source pixels at ${formatSeconds(observation.ptsMicros)}`}</title>
            <rect x={x} y={y} width={w} height={h} />
            <text x={x + 4} y={Math.max(14, y + 14)} aria-hidden="true">{`${track.trackId} ${track.label}`}</text>
          </g>;
        })}
      </svg>}
    </div>
    <p role="status" aria-live="polite" aria-atomic="true" className="vto-status" data-testid="vto-status">{statusText}</p>
    <p>
      <label><input type="checkbox" checked={showBoxes} onChange={(event) => setShowBoxes(event.currentTarget.checked)} /> Show boxes on the video</label>
      {" "}
      <span className="vto-note">Boxes are in source pixels ({width}x{height}); sampled frames only; model {tracksDocument.model.id} ({tracksDocument.model.spdxLicense}); tracker {tracksDocument.tracking.algorithm}. No accuracy claim.</span>
    </p>
    <h4>Tracks ({tracksDocument.tracks.length})</h4>
    <ul aria-label="Tracks" className="vto-tracks">
      {tracksDocument.tracks.map((track) => {
        const visible = current.boxes.some((entry) => entry.track.trackId === track.trackId);
        const first = track.observations[0]!;
        const last = track.observations[track.observations.length - 1]!;
        return <li key={track.trackId} data-track-id={track.trackId} data-visible={visible ? "true" : "false"}>
          <button type="button" aria-pressed={selected === track.trackId} onClick={() => setSelected((value) => value === track.trackId ? null : track.trackId)}>
            {`${track.trackId} · ${track.label}`}
          </button>
          {" "}
          <span>{`${track.observations.length} ${track.observations.length === 1 ? "observation" : "observations"}, ${formatSeconds(first.ptsMicros)} to ${formatSeconds(last.ptsMicros)}`}</span>
          {" "}
          <span className="vto-visible">{visible ? "in the current frame" : "not in the current frame"}</span>
          {" "}
          <button type="button" onClick={() => seekTo(first.ptsMicros)} aria-label={`Seek to the first observation of ${track.label} ${track.trackId}`}>Seek to start</button>
        </li>;
      })}
    </ul>
  </section>;
}
