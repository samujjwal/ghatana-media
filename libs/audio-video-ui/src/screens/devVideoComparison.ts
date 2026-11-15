/**
 * DEV_ONLY video enhancement and measured comparison host boundary and the strict reader of the registered comparison
 * document (`media.dev.video-comparison.v1`).
 *
 * The document is parsed fail-closed: PSNR/SSIM per frame are finite and bounded, frame presentation timestamps are
 * strictly increasing, aggregates must be present for every subject, and every subject label is unique. The numbers
 * are luma-only measurements against a reference (when one was given) plus no-reference estimates; nothing here is a
 * perceptual, rights, approval or production claim, and a regression is shown exactly like an improvement.
 */

import type { DevArtifactContentReader } from "./devArtifactContent";

export const VIDEO_COMPARISON_SCHEMA = "media.dev.video-comparison.v1";
export const VIDEO_ENHANCEMENT_SCHEMA = "media.dev.video-enhancement.v1";
const MAX_FRAMES = 2_000;
const MAX_SUBJECTS = 3;
/** Finite stand-in the host uses for an infinite PSNR. */
export const IDENTICAL_PSNR_DB = 100;

export interface DevVideoHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevVideoSourceRef {
  readonly artifactId: string;
  readonly artifactVersionId: string;
}

export interface DevVideoCompareRequest {
  readonly requestId: string;
  readonly reference?: DevVideoSourceRef;
  readonly subjects: readonly (DevVideoSourceRef & { readonly label: string })[];
}

export interface DevVideoPort extends Partial<DevArtifactContentReader> {
  compare(request: DevVideoCompareRequest): Promise<DevVideoHostResponse>;
  getComparison(outputId: string): Promise<DevVideoHostResponse>;
}

/** Typed host failure. Status 0 means the outcome was not observed. */
export class DevVideoHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevVideoHostError";
  }
}

export interface VideoFrameMeasure {
  readonly frameIndex: number;
  readonly pts: number;
  readonly ptsMicros: number;
  readonly aligned: boolean;
  readonly psnrY: number | null;
  readonly ssimY: number | null;
  readonly noiseSigmaY: number;
  readonly laplacianVarianceY: number;
}

export interface VideoAgainstReference {
  readonly alignedFrames: number;
  readonly unalignedSubjectFrames: number;
  readonly unalignedReferenceFrames: number;
  readonly fullyAligned: boolean;
  readonly meanPsnrY: number;
  readonly globalPsnrY: number;
  readonly minPsnrY: number;
  readonly maxPsnrY: number;
  readonly meanSsimY: number;
  readonly minSsimY: number;
  readonly identicalFrames: number;
}

export interface VideoSubject {
  readonly label: string;
  readonly source: { readonly artifactId: string; readonly artifactVersionId: string; readonly sha256: string; readonly contentType: string };
  readonly video: { readonly width: number; readonly height: number; readonly frameCount: number; readonly timeBase: string };
  readonly noReference: { readonly meanNoiseSigmaY: number; readonly meanLaplacianVarianceY: number };
  readonly againstReference: VideoAgainstReference | null;
  readonly frames: readonly VideoFrameMeasure[];
}

export interface VideoComparisonDelta {
  readonly subject: string;
  readonly baseline: string;
  readonly verdict: "IMPROVED" | "REGRESSED" | "MIXED" | "NO_REFERENCE";
  readonly meanNoiseSigmaYDelta: number;
  readonly meanLaplacianVarianceYDelta: number;
  readonly comparedFrames: number | null;
  readonly meanPsnrYDeltaDb: number | null;
  readonly meanSsimYDelta: number | null;
  readonly framesPsnrImproved: number | null;
  readonly framesPsnrRegressed: number | null;
  readonly framesSsimImproved: number | null;
  readonly framesSsimRegressed: number | null;
}

export interface VideoComparisonDocument {
  readonly requestId: string;
  readonly reference: { readonly artifactId: string; readonly artifactVersionId: string; readonly sha256: string; readonly contentType: string } | null;
  readonly subjects: readonly VideoSubject[];
  readonly comparisons: readonly VideoComparisonDelta[];
}

export class VideoComparisonParseError extends Error {
  readonly code = "COMPARISON_DOCUMENT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "VideoComparisonParseError";
  }
}

const fail = (message: string): never => { throw new VideoComparisonParseError(message); };
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
const finite = (value: unknown, path: string, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${path} must be a finite number in range`);
  return value as number;
};
const optionalFinite = (value: unknown, path: string, min: number, max: number): number | null =>
  value === undefined ? null : finite(value, path, min, max);

function parseSource(value: unknown, path: string): VideoSubject["source"] {
  const raw = record(value, path);
  const source = {
    artifactId: text(raw.artifactId, `${path}.artifactId`, 128),
    artifactVersionId: text(raw.artifactVersionId, `${path}.artifactVersionId`, 80),
    sha256: text(raw.sha256, `${path}.sha256`, 64),
    contentType: text(raw.contentType, `${path}.contentType`, 128),
  };
  if (!/^[0-9a-f]{64}$/u.test(source.sha256)) fail(`${path}.sha256 must be 64 lowercase hex characters`);
  return source;
}

/** Strict, bounds-validating reader of a registered comparison document. Throws {@link VideoComparisonParseError}. */
export function parseVideoComparisonDocument(value: unknown): VideoComparisonDocument {
  const root = record(value, "document");
  if (root.schema !== VIDEO_COMPARISON_SCHEMA) fail(`document.schema must be ${VIDEO_COMPARISON_SCHEMA}`);
  if (root.scope !== "DEV_ONLY") fail("document.scope must be DEV_ONLY");
  const reference = root.reference === undefined ? null : parseSource(root.reference, "reference");
  const labels = new Set<string>();
  const subjects = array(root.subjects, "subjects", MAX_SUBJECTS).map((rawSubject, index): VideoSubject => {
    const path = `subjects[${index}]`;
    const s = record(rawSubject, path);
    const label = text(s.label, `${path}.label`, 64);
    if (labels.has(label)) fail(`duplicate subject label ${label}`);
    labels.add(label);
    const videoRaw = record(s.video, `${path}.video`);
    const noRef = record(s.noReference, `${path}.noReference`);
    let against: VideoAgainstReference | null = null;
    if (s.againstReference !== undefined) {
      const a = record(s.againstReference, `${path}.againstReference`);
      against = {
        alignedFrames: integer(a.alignedFrames, `${path}.alignedFrames`, 1),
        unalignedSubjectFrames: integer(a.unalignedSubjectFrames, `${path}.unalignedSubjectFrames`),
        unalignedReferenceFrames: integer(a.unalignedReferenceFrames, `${path}.unalignedReferenceFrames`),
        fullyAligned: a.fullyAligned === true,
        meanPsnrY: finite(a.meanPsnrY, `${path}.meanPsnrY`, 0, IDENTICAL_PSNR_DB),
        globalPsnrY: finite(a.globalPsnrY, `${path}.globalPsnrY`, 0, IDENTICAL_PSNR_DB),
        minPsnrY: finite(a.minPsnrY, `${path}.minPsnrY`, 0, IDENTICAL_PSNR_DB),
        maxPsnrY: finite(a.maxPsnrY, `${path}.maxPsnrY`, 0, IDENTICAL_PSNR_DB),
        meanSsimY: finite(a.meanSsimY, `${path}.meanSsimY`, -1, 1),
        minSsimY: finite(a.minSsimY, `${path}.minSsimY`, -1, 1),
        identicalFrames: integer(a.identicalFrames, `${path}.identicalFrames`),
      };
    }
    if (against && !reference) fail(`${path} reports a reference comparison but the document has no reference`);
    let previous = Number.NEGATIVE_INFINITY;
    const frames = array(s.frames, `${path}.frames`, MAX_FRAMES).map((rawFrame, frameIndex): VideoFrameMeasure => {
      const fp = `${path}.frames[${frameIndex}]`;
      const f = record(rawFrame, fp);
      const frame: VideoFrameMeasure = {
        frameIndex: integer(f.frameIndex, `${fp}.frameIndex`),
        pts: integer(f.pts, `${fp}.pts`, Number.MIN_SAFE_INTEGER),
        ptsMicros: integer(f.ptsMicros, `${fp}.ptsMicros`, Number.MIN_SAFE_INTEGER),
        aligned: f.aligned === true,
        psnrY: optionalFinite(f.psnrY, `${fp}.psnrY`, 0, IDENTICAL_PSNR_DB),
        ssimY: optionalFinite(f.ssimY, `${fp}.ssimY`, -1, 1),
        noiseSigmaY: finite(f.noiseSigmaY, `${fp}.noiseSigmaY`, 0),
        laplacianVarianceY: finite(f.laplacianVarianceY, `${fp}.laplacianVarianceY`, 0),
      };
      if (frame.ptsMicros <= previous) fail(`${path} frame presentation times must be strictly increasing`);
      previous = frame.ptsMicros;
      if (frame.aligned !== (frame.psnrY !== null && frame.ssimY !== null)) fail(`${fp} alignment does not match its measurements`);
      return frame;
    });
    if (frames.length === 0) fail(`${path}.frames must not be empty`);
    return {
      label,
      source: parseSource(s.source, `${path}.source`),
      video: {
        width: integer(videoRaw.width, `${path}.video.width`, 1), height: integer(videoRaw.height, `${path}.video.height`, 1),
        frameCount: integer(videoRaw.frameCount, `${path}.video.frameCount`, 1), timeBase: text(videoRaw.timeBase, `${path}.video.timeBase`, 40),
      },
      noReference: { meanNoiseSigmaY: finite(noRef.meanNoiseSigmaY, `${path}.noReference.meanNoiseSigmaY`, 0), meanLaplacianVarianceY: finite(noRef.meanLaplacianVarianceY, `${path}.noReference.meanLaplacianVarianceY`, 0) },
      againstReference: against,
      frames,
    };
  });
  if (subjects.length === 0) fail("subjects must not be empty");
  const comparisons = array(root.comparisons, "comparisons", MAX_SUBJECTS).map((rawDelta, index): VideoComparisonDelta => {
    const path = `comparisons[${index}]`;
    const d = record(rawDelta, path);
    const verdict = d.verdict;
    if (verdict !== "IMPROVED" && verdict !== "REGRESSED" && verdict !== "MIXED" && verdict !== "NO_REFERENCE") fail(`${path}.verdict is not recognised`);
    const optionalInt = (name: string): number | null => (d[name] === undefined ? null : integer(d[name], `${path}.${name}`));
    return {
      subject: text(d.subject, `${path}.subject`, 64), baseline: text(d.baseline, `${path}.baseline`, 64),
      verdict: verdict as VideoComparisonDelta["verdict"],
      meanNoiseSigmaYDelta: finite(d.meanNoiseSigmaYDelta, `${path}.meanNoiseSigmaYDelta`),
      meanLaplacianVarianceYDelta: finite(d.meanLaplacianVarianceYDelta, `${path}.meanLaplacianVarianceYDelta`),
      comparedFrames: optionalInt("comparedFrames"),
      meanPsnrYDeltaDb: optionalFinite(d.meanPsnrYDeltaDb, `${path}.meanPsnrYDeltaDb`, -IDENTICAL_PSNR_DB, IDENTICAL_PSNR_DB),
      meanSsimYDelta: optionalFinite(d.meanSsimYDelta, `${path}.meanSsimYDelta`, -2, 2),
      framesPsnrImproved: optionalInt("framesPsnrImproved"), framesPsnrRegressed: optionalInt("framesPsnrRegressed"),
      framesSsimImproved: optionalInt("framesSsimImproved"), framesSsimRegressed: optionalInt("framesSsimRegressed"),
    };
  });
  for (const delta of comparisons) {
    if (!labels.has(delta.subject) || !labels.has(delta.baseline)) fail("a comparison names an unknown subject");
  }
  return { requestId: text(root.requestId, "requestId", 128), reference, subjects, comparisons };
}

export interface MetricPoint { readonly ptsMicros: number; readonly value: number }
export type MetricName = "psnrY" | "ssimY" | "noiseSigmaY" | "laplacianVarianceY";

/** Per-frame series of one metric for one subject; frames without the metric (unaligned) are left out, never zero-filled. */
export function metricSeries(subject: VideoSubject, metric: MetricName): readonly MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const frame of subject.frames) {
    const value = frame[metric];
    if (value !== null) points.push({ ptsMicros: frame.ptsMicros, value });
  }
  return points;
}

/** The frame whose presentation time governs the playhead (latest frame at or before it), or the first frame. */
export function frameAt(subject: VideoSubject, timeMicros: number): VideoFrameMeasure {
  let low = 0;
  let high = subject.frames.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (subject.frames[mid]!.ptsMicros <= timeMicros) { found = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return subject.frames[found]!;
}

export function formatDb(value: number | null): string { return value === null ? "n/a" : `${value.toFixed(2)} dB`; }
export function formatSsim(value: number | null): string { return value === null ? "n/a" : value.toFixed(4); }
export function formatSigned(value: number | null, digits: number, unit: string): string {
  if (value === null) return "n/a";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}${unit}`;
}

export function describeVideoFailure(error: unknown): { readonly code: string; readonly text: string; readonly tone: "unknown" | "denied" | "unavailable" | "refused" } {
  if (!(error instanceof DevVideoHostError)) {
    return { code: "INVALID_RESPONSE", text: error instanceof Error ? error.message : "The response could not be read.", tone: "refused" };
  }
  const { code, status } = error;
  if (code === "VIDEO_OUTCOME_UNKNOWN" || status === 0 || code === "OUTCOME_UNKNOWN") {
    return { code, text: "Outcome unknown: the run did not complete and nothing was registered. Retrying reuses the same request id, so it cannot register twice.", tone: "unknown" };
  }
  if (status === 403) return { code, text: `Denied (${code}): rights, consent or permission is not admitted. Nothing was read or processed.`, tone: "denied" };
  if (status === 404) return { code, text: `Not found (${code}): this exact version or output is not available to this DEV_ONLY owner.`, tone: "refused" };
  if (status === 503) return { code, text: `Unavailable (${code}): the video tools or rights authority are not ready. Nothing was registered.`, tone: "unavailable" };
  return { code, text: `Refused (${status} ${code}): ${error.message}`, tone: "refused" };
}
