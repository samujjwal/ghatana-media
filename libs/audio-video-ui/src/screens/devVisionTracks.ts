/**
 * DEV_ONLY video detection and tracking host boundary and the strict reader of the registered tracks document
 * (`media.dev.vision-tracks.v1`).
 *
 * The document is parsed fail-closed: every box must lie inside the declared source frame, frame PTS must be strictly
 * increasing, and every track observation must reference a sampled frame with the same exact PTS. Nothing here claims
 * detection accuracy, rights or approval: the model is a local open model and the tracker is a deterministic
 * IoU-and-label matcher.
 */

import type { DevArtifactContentReader } from "./devArtifactContent";

export const VISION_TRACKS_SCHEMA = "media.dev.vision-tracks.v1";
/** Default window (microseconds) within which the playhead is treated as being ON a sampled frame. */
export const DEFAULT_EXACT_TOLERANCE_US = 50_000;
const MAX_TRACKS = 2_000;
const MAX_OBSERVATIONS = 20_000;
const MAX_FRAMES = 4_096;

export interface DevVisionHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevVisionTrackRequest {
  readonly requestId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly maxFrames: number;
}

export interface DevVisionPort extends Partial<DevArtifactContentReader> {
  track(request: DevVisionTrackRequest): Promise<DevVisionHostResponse>;
  getOutput(outputId: string): Promise<DevVisionHostResponse>;
}

/** Typed host failure. Status 0 means the outcome was not observed. */
export class DevVisionHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevVisionHostError";
  }
}

export interface VisionBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface VisionObservation { readonly frameIndex: number; readonly pts: number; readonly ptsMicros: number; readonly box: VisionBox }
export interface VisionTrack {
  readonly trackId: string;
  readonly label: string;
  readonly firstFrameIndex: number;
  readonly lastFrameIndex: number;
  readonly observations: readonly VisionObservation[];
}
export interface VisionFrame { readonly frameIndex: number; readonly pts: number; readonly ptsMicros: number; readonly detections: number; readonly rejectedDetections: number }
export interface VisionTracksDocument {
  readonly requestId: string;
  readonly source: { readonly artifactId: string; readonly artifactVersionId: string; readonly sha256: string; readonly contentType: string };
  readonly video: { readonly width: number; readonly height: number; readonly timeBase: { readonly num: number; readonly den: number }; readonly frameCount: number; readonly variableFrameRate: boolean };
  readonly tracking: { readonly algorithm: string; readonly minIou: number; readonly maxMissedFrames: number };
  readonly model: { readonly id: string; readonly revision: string; readonly spdxLicense: string };
  readonly frames: readonly VisionFrame[];
  readonly tracks: readonly VisionTrack[];
}

export class VisionTracksParseError extends Error {
  readonly code = "TRACKS_DOCUMENT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "VisionTracksParseError";
  }
}

const fail = (message: string): never => { throw new VisionTracksParseError(message); };
const record = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>;
};
const array = (value: unknown, path: string, max: number): readonly unknown[] => {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if ((value as unknown[]).length > max) fail(`${path} has too many entries`);
  return value as unknown[];
};
const text = (value: unknown, path: string, max = 256): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${path} must be a non-empty string`);
  return value as string;
};
const integer = (value: unknown, path: string, min = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail(`${path} must be an integer >= ${min}`);
  return value as number;
};
const finite = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value as number;
};

/** Strict, bounds-validating reader of a registered tracks document. Throws {@link VisionTracksParseError}. */
export function parseVisionTracksDocument(value: unknown): VisionTracksDocument {
  const root = record(value, "document");
  if (root.schema !== VISION_TRACKS_SCHEMA) fail(`document.schema must be ${VISION_TRACKS_SCHEMA}`);
  if (root.scope !== "DEV_ONLY") fail("document.scope must be DEV_ONLY");
  const sourceRaw = record(root.source, "source");
  const source = {
    artifactId: text(sourceRaw.artifactId, "source.artifactId", 128),
    artifactVersionId: text(sourceRaw.artifactVersionId, "source.artifactVersionId", 80),
    sha256: text(sourceRaw.sha256, "source.sha256", 64),
    contentType: text(sourceRaw.contentType, "source.contentType", 128),
  };
  if (!/^[0-9a-f]{64}$/u.test(source.sha256)) fail("source.sha256 must be 64 lowercase hex characters");
  const videoRaw = record(root.video, "video");
  const timeBaseRaw = record(videoRaw.timeBase, "video.timeBase");
  const video = {
    width: integer(videoRaw.width, "video.width", 1),
    height: integer(videoRaw.height, "video.height", 1),
    timeBase: { num: integer(timeBaseRaw.num, "video.timeBase.num", 1), den: integer(timeBaseRaw.den, "video.timeBase.den", 1) },
    frameCount: integer(videoRaw.frameCount, "video.frameCount", 1),
    variableFrameRate: videoRaw.variableFrameRate === true,
  };
  const trackingRaw = record(root.tracking, "tracking");
  const tracking = {
    algorithm: text(trackingRaw.algorithm, "tracking.algorithm"),
    minIou: finite(trackingRaw.minIou, "tracking.minIou"),
    maxMissedFrames: integer(trackingRaw.maxMissedFrames, "tracking.maxMissedFrames"),
  };
  const modelRaw = record(root.model, "model");
  const model = { id: text(modelRaw.id, "model.id"), revision: text(modelRaw.revision, "model.revision"), spdxLicense: text(modelRaw.spdxLicense, "model.spdxLicense") };

  const frames: VisionFrame[] = [];
  const framePts = new Map<number, number>();
  let previousPts = Number.NEGATIVE_INFINITY;
  array(root.frames, "frames", MAX_FRAMES).forEach((raw, index) => {
    const f = record(raw, `frames[${index}]`);
    const frame: VisionFrame = {
      frameIndex: integer(f.frameIndex, `frames[${index}].frameIndex`),
      pts: integer(f.pts, `frames[${index}].pts`, Number.MIN_SAFE_INTEGER),
      ptsMicros: integer(f.ptsMicros, `frames[${index}].ptsMicros`, Number.MIN_SAFE_INTEGER),
      detections: integer(f.detections, `frames[${index}].detections`),
      rejectedDetections: integer(f.rejectedDetections, `frames[${index}].rejectedDetections`),
    };
    if (frame.frameIndex >= video.frameCount) fail(`frames[${index}].frameIndex is outside the video`);
    if (frame.pts <= previousPts) fail("frame PTS must be strictly increasing");
    previousPts = frame.pts;
    framePts.set(frame.frameIndex, frame.pts);
    frames.push(frame);
  });
  if (frames.length === 0) fail("frames must not be empty");

  const trackIds = new Set<string>();
  let observationTotal = 0;
  const tracks = array(root.tracks, "tracks", MAX_TRACKS).map((raw, trackIndex): VisionTrack => {
    const t = record(raw, `tracks[${trackIndex}]`);
    const trackId = text(t.trackId, `tracks[${trackIndex}].trackId`, 64);
    if (trackIds.has(trackId)) fail(`duplicate track id ${trackId}`);
    trackIds.add(trackId);
    const observations = array(t.observations, `tracks[${trackIndex}].observations`, MAX_FRAMES).map((rawObservation, i): VisionObservation => {
      const path = `tracks[${trackIndex}].observations[${i}]`;
      const o = record(rawObservation, path);
      const b = record(o.box, `${path}.box`);
      const box: VisionBox = { x: finite(b.x, `${path}.box.x`), y: finite(b.y, `${path}.box.y`), width: finite(b.width, `${path}.box.width`), height: finite(b.height, `${path}.box.height`) };
      if (box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.x + box.width > video.width || box.y + box.height > video.height) {
        fail(`${path}.box is not inside the ${video.width}x${video.height} source frame`);
      }
      const observation: VisionObservation = { frameIndex: integer(o.frameIndex, `${path}.frameIndex`), pts: integer(o.pts, `${path}.pts`, Number.MIN_SAFE_INTEGER), ptsMicros: integer(o.ptsMicros, `${path}.ptsMicros`, Number.MIN_SAFE_INTEGER), box };
      if (framePts.get(observation.frameIndex) !== observation.pts) fail(`${path} does not match a sampled frame PTS`);
      return observation;
    });
    if (observations.length === 0) fail(`tracks[${trackIndex}] has no observations`);
    observationTotal += observations.length;
    if (observationTotal > MAX_OBSERVATIONS) fail("too many observations");
    return {
      trackId, label: text(t.label, `tracks[${trackIndex}].label`),
      firstFrameIndex: observations[0]!.frameIndex, lastFrameIndex: observations[observations.length - 1]!.frameIndex, observations,
    };
  });
  return { requestId: text(root.requestId, "requestId", 128), source, video, tracking, model, frames, tracks };
}

export interface BoxesAtResult {
  /** The latest sampled frame at or before the playhead, or null before the first sampled frame. */
  readonly frame: VisionFrame | null;
  /** `exact` when the playhead is within the tolerance of that frame's PTS, otherwise `held` (an earlier frame). */
  readonly sync: "exact" | "held" | "before-first";
  readonly boxes: readonly { readonly track: VisionTrack; readonly observation: VisionObservation }[];
}

/** Boxes of the sampled frame that governs `timeMicros` (the playhead in source-PTS microseconds). */
export function boxesAt(document: VisionTracksDocument, timeMicros: number, toleranceMicros = DEFAULT_EXACT_TOLERANCE_US): BoxesAtResult {
  let low = 0;
  let high = document.frames.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (document.frames[mid]!.ptsMicros <= timeMicros) { found = mid; low = mid + 1; } else { high = mid - 1; }
  }
  if (found < 0) return { frame: null, sync: "before-first", boxes: [] };
  const frame = document.frames[found]!;
  const boxes: { track: VisionTrack; observation: VisionObservation }[] = [];
  for (const track of document.tracks) {
    const observation = track.observations.find((candidate) => candidate.frameIndex === frame.frameIndex);
    if (observation) boxes.push({ track, observation });
  }
  return { frame, sync: timeMicros - frame.ptsMicros <= toleranceMicros ? "exact" : "held", boxes };
}

/** Exact PTS in seconds as a fixed-point string (3 decimals), derived from microseconds. */
export function formatSeconds(micros: number): string {
  return `${(micros / 1_000_000).toFixed(3)} s`;
}

export function describeVisionFailure(error: unknown): { readonly code: string; readonly text: string; readonly tone: "unknown" | "denied" | "unavailable" | "refused" } {
  if (!(error instanceof DevVisionHostError)) {
    return { code: "INVALID_RESPONSE", text: error instanceof Error ? error.message : "The response could not be read.", tone: "refused" };
  }
  const { code, status } = error;
  if (code === "VISION_OUTCOME_UNKNOWN" || status === 0 || code === "OUTCOME_UNKNOWN") {
    return { code, text: "Outcome unknown: the run did not complete and nothing was registered. Retrying reuses the same request id, so it cannot register twice.", tone: "unknown" };
  }
  if (status === 403) return { code, text: `Denied (${code}): rights, consent or permission is not admitted. Nothing was read or inferred.`, tone: "denied" };
  if (status === 404) return { code, text: `Not found (${code}): this exact version or output is not available to this DEV_ONLY owner.`, tone: "refused" };
  if (status === 503) return { code, text: `Unavailable (${code}): the local model, sidecar or rights authority is not ready. Nothing was registered.`, tone: "unavailable" };
  return { code, text: `Refused (${status} ${code}): ${error.message}`, tone: "refused" };
}
