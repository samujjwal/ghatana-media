/**
 * DEV_ONLY deterministic 2D animation host boundary (status, render) and the authoring model.
 *
 * The author edits a keyframed scene (rectangles, ellipses, lines, optional image assets named by exact artifact
 * versions) as form state; {@link toRequestSpec} turns it into the host's `media.dev.animation-spec.v1` shape without
 * guessing: a value that is not a finite number is reported with its JSON path and nothing is sent. The host remains
 * the only authority (strict keys, budgets, rights, easing, rendering). {@link sampleCurve} is the browser's
 * approximate preview of the same easing math; it is never shown as a result.
 */

import type { DevArtifactContentReader, RegisteredArtifact } from "./devArtifactContent";

export interface DevAnimationHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevAnimationRenderRequest {
  readonly requestId: string;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly encoder?: { readonly crf: number };
}

export interface DevAnimationPort {
  getStatus(): Promise<DevAnimationHostResponse>;
  render(request: DevAnimationRenderRequest): Promise<DevAnimationHostResponse>;
  /** Optional exact-version content read; without it the video cannot be played on this page. */
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevAnimationHostError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DevAnimationHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const SHA = /^[0-9a-f]{64}$/u;

// ---------------------------------------------------------------------------------------------- status

export interface AnimationStatus {
  readonly ready: boolean;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxFrames: number;
  readonly maxFramesPerSecond: number;
  readonly maxShapes: number;
  readonly maxAssets: number;
  readonly maxAnimationPixels: number;
  readonly easings: readonly string[];
  readonly primitives: readonly string[];
  readonly text: string | null;
  readonly defaultCrf: number;
  readonly minCrf: number;
  readonly maxCrf: number;
  readonly rights: { readonly ready: boolean; readonly scope: string };
}

export function parseAnimationStatus(response: DevAnimationHostResponse): AnimationStatus {
  const bad = (): never => { throw new DevAnimationHostError("INVALID_RESPONSE", response.status, "The host returned an invalid animation status."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || typeof body.ready !== "boolean" || !isRecord(body.limits) || !isRecord(body.encoder)) return bad();
  const limits = body.limits;
  const encoder = body.encoder;
  const number = (value: unknown): number => finite(value) ?? bad();
  const strings = (value: unknown): string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry) ? [...value] as string[] : bad();
  const rights = isRecord(body.rightsAuthority) ? body.rightsAuthority : {};
  return {
    ready: body.ready,
    maxWidth: number(limits.maxWidth), maxHeight: number(limits.maxHeight), maxFrames: number(limits.maxFrames),
    maxFramesPerSecond: number(limits.maxFramesPerSecond), maxShapes: number(limits.maxShapes), maxAssets: number(limits.maxAssets),
    maxAnimationPixels: number(limits.maxAnimationPixels),
    easings: strings(body.easings), primitives: strings(body.primitives), text: str(body.text),
    defaultCrf: number(encoder.defaultCrf), minCrf: number(encoder.minCrf), maxCrf: number(encoder.maxCrf),
    rights: { ready: rights.ready === true, scope: str(rights.scope) ?? "PROCESSING" },
  };
}

// ---------------------------------------------------------------------------------------------- render view

export interface AnimationFrameEntry {
  readonly index: number;
  readonly ptsNumerator: string;
  readonly ptsDenominator: string;
  readonly ptsTicks: number;
  readonly pngSha256: string;
  readonly pixelSha256: string;
}
export interface AnimationRenderView {
  readonly renderId: string;
  readonly video: RegisteredArtifact;
  readonly manifestArtifact: RegisteredArtifact;
  readonly width: number;
  readonly height: number;
  readonly fpsNumerator: number;
  readonly fpsDenominator: number;
  readonly frameCount: number;
  readonly frameSetSha256: string;
  readonly frames: readonly AnimationFrameEntry[];
  readonly verification: { readonly codec: string; readonly pixelFormat: string; readonly averageFrameRate: string; readonly timeBase: string; readonly ptsExact: boolean };
  readonly encoder: { readonly crf: number | null; readonly tool: string | null };
  readonly assetCount: number;
  readonly replayed: boolean;
  readonly note: string | null;
}

function parseArtifact(value: unknown): RegisteredArtifact | null {
  if (!isRecord(value)) return null;
  const artifactId = str(value.artifactId);
  const version = str(value.artifactVersionId);
  const sha = str(value.sha256);
  const contentType = str(value.contentType);
  if (!artifactId || !version || !sha || !contentType || !SHA.test(sha) || version !== `sha256:${sha}`) return null;
  return { artifactId, artifactVersionId: version, contentType, sizeBytes: finite(value.sizeBytes), sha256: sha };
}

export function parseAnimationRenderView(response: DevAnimationHostResponse): AnimationRenderView {
  const bad = (): never => { throw new DevAnimationHostError("INVALID_RESPONSE", response.status, "The host returned an invalid animation render view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.manifest)) return bad();
  const renderId = str(body.renderId);
  const video = parseArtifact(body.video);
  const manifestArtifact = parseArtifact(body.manifestArtifact);
  const manifest = body.manifest;
  const profile = isRecord(manifest.profile) ? manifest.profile : null;
  const verification = isRecord(manifest.verification) ? manifest.verification : null;
  const encoder = isRecord(manifest.encoder) ? manifest.encoder : {};
  const frameSetSha256 = str(manifest.frameSetSha256);
  if (!renderId || !video || !manifestArtifact || !profile || !verification || !frameSetSha256 || !SHA.test(frameSetSha256)
    || !Array.isArray(manifest.frames) || video.contentType !== "video/mp4") return bad();
  const frames: AnimationFrameEntry[] = [];
  for (const entry of manifest.frames) {
    if (!isRecord(entry)) return bad();
    const index = finite(entry.index);
    const ticks = finite(entry.ptsTicks);
    const num = str(entry.ptsNumerator);
    const den = str(entry.ptsDenominator);
    const png = str(entry.pngSha256);
    const pixel = str(entry.pixelSha256);
    if (index === null || ticks === null || !num || !den || !png || !pixel || !SHA.test(png) || !SHA.test(pixel)) return bad();
    frames.push({ index, ptsNumerator: num, ptsDenominator: den, ptsTicks: ticks, pngSha256: png, pixelSha256: pixel });
  }
  const width = finite(profile.width);
  const height = finite(profile.height);
  const fpsNumerator = finite(profile.fpsNumerator);
  const fpsDenominator = finite(profile.fpsDenominator);
  const frameCount = finite(profile.frameCount);
  if (width === null || height === null || fpsNumerator === null || fpsDenominator === null || frameCount === null || frames.length !== frameCount) return bad();
  return {
    renderId, video, manifestArtifact, width, height, fpsNumerator, fpsDenominator, frameCount, frameSetSha256, frames,
    verification: {
      codec: str(verification.codec) ?? "unknown", pixelFormat: str(verification.pixelFormat) ?? "unknown",
      averageFrameRate: str(verification.averageFrameRate) ?? "unknown", timeBase: str(verification.timeBase) ?? "unknown",
      ptsExact: verification.ptsExact === true,
    },
    encoder: { crf: finite(encoder.crf), tool: str(encoder.tool) },
    assetCount: Array.isArray(manifest.assets) ? manifest.assets.length : 0,
    replayed: body.replayed === true,
    note: str(body.note),
  };
}

// ---------------------------------------------------------------------------------------------- failures

export type AnimationFailureTone = "invalid" | "budget" | "denied" | "notFound" | "conflict" | "unknown" | "unavailable";
export interface AnimationFailure {
  readonly code: string;
  readonly tone: AnimationFailureTone;
  readonly text: string;
  /** The JSON path of the offending value, when the host named one. */
  readonly path: string | null;
}

export function describeAnimationFailure(error: unknown): AnimationFailure {
  const host = error instanceof DevAnimationHostError ? error
    : new DevAnimationHostError("INVALID_RESPONSE", 0, error instanceof Error ? error.message : "Unexpected failure.");
  const code = host.code;
  const path = str(host.details?.path);
  if (host.status === 0 || code === "OUTCOME_UNKNOWN" || code === "ANIMATION_OUTCOME_UNKNOWN") {
    return { code, tone: "unknown", path: null, text: "The outcome is unknown: nothing was confirmed and nothing is claimed. Press Render again; "
      + "the same request identifier is reused so the host never creates a second video." };
  }
  switch (code) {
    case "ANIMATION_SPEC_INVALID":
      return { code, tone: "invalid", path, text: `The scene is not valid${path ? ` at ${path}` : ""}: ${host.message} Nothing was rendered.` };
    case "ANIMATION_BUDGET_EXCEEDED": {
      const requested = finite(host.details?.requested);
      const ceiling = finite(host.details?.ceiling);
      const limit = str(host.details?.limit);
      return { code, tone: "budget", path, text: `${limit ?? "A value"} is over its ceiling${ceiling !== null ? ` of ${ceiling}` : ""}${requested !== null ? ` (requested ${requested})` : ""}${path ? ` at ${path}` : ""}. Nothing was rendered.` };
    }
    case "RIGHTS_NOT_ADMITTED": {
      const verdict = str(host.details?.verdict);
      return { code, tone: "denied", path, text: `An image asset${path ? ` (${path})` : ""} has no current processing rights admission${verdict ? ` (${verdict})` : ""}. `
        + "The uploader must state rights for this exact version first. Nothing was read, rendered or registered." };
    }
    case "RIGHTS_AUTHORITY_UNAVAILABLE":
      return { code, tone: "unavailable", path, text: "The rights authority is not available on this host, so image assets cannot be admitted. Nothing was rendered." };
    case "SOURCE_VERSION_NOT_FOUND":
      return { code, tone: "notFound", path: null, text: "The exact asset artifact version is not available to this identity. Nothing was rendered." };
    case "ASSET_NOT_SUPPORTED":
      return { code, tone: "invalid", path, text: `${host.message}${path ? ` (${path})` : ""} Nothing was rendered.` };
    case "ANIMATION_REQUEST_ID_REUSED":
      return { code, tone: "conflict", path: null, text: "This request identifier was already used for a different scene. Change the scene back or press Render again for a new identifier." };
    case "RENDER_CAPACITY_EXHAUSTED":
      return { code, tone: "unavailable", path: null, text: "The host is at its render capacity. Nothing was rendered; try again shortly." };
    case "ARTIFACT_PERMISSION_REQUIRED":
      return { code, tone: "denied", path: null, text: "This identity lacks the artifact read and create permissions required to render." };
    default:
      return { code, tone: "unavailable", path, text: `${host.message || "The request failed."} Nothing was confirmed.` };
  }
}

// ---------------------------------------------------------------------------------------------- authoring model

export type Easing = "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_OUT";
export type Primitive = "RECTANGLE" | "ELLIPSE" | "LINE" | "RASTER_ASSET";
export const EASINGS: readonly Easing[] = ["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_OUT"];
export const PRIMITIVES: readonly Primitive[] = ["RECTANGLE", "ELLIPSE", "LINE", "RASTER_ASSET"];

export interface AuthoredKeyframe {
  readonly frame: string; readonly x: string; readonly y: string; readonly scaleX: string; readonly scaleY: string;
  readonly opacity: string; readonly easing: Easing;
}
export interface AuthoredShape {
  readonly id: string; readonly primitive: Primitive; readonly x: string; readonly y: string; readonly width: string; readonly height: string;
  readonly color: string; readonly assetId: string; readonly keyframes: readonly AuthoredKeyframe[];
}
export interface AuthoredAsset { readonly id: string; readonly artifactId: string; readonly artifactVersionId: string }
export interface AuthoredSpec {
  readonly width: string; readonly height: string; readonly background: string;
  readonly fpsNumerator: string; readonly fpsDenominator: string; readonly frameCount: string;
  readonly shapes: readonly AuthoredShape[]; readonly assets: readonly AuthoredAsset[];
}

export const blankKeyframe = (frame = 0): AuthoredKeyframe =>
  ({ frame: String(frame), x: "0", y: "0", scaleX: "1", scaleY: "1", opacity: "1", easing: "LINEAR" });
export const blankShape = (index: number): AuthoredShape =>
  ({ id: `shape-${index}`, primitive: "RECTANGLE", x: "20", y: "20", width: "40", height: "40", color: "#FF4040", assetId: "", keyframes: [] });

/** A small starting scene: a box that eases across the frame and a ball that falls and grows. */
export function exampleSpec(): AuthoredSpec {
  const key = (frame: number, over: Partial<AuthoredKeyframe> = {}): AuthoredKeyframe => ({ ...blankKeyframe(frame), ...over });
  return {
    width: "320", height: "180", background: "#101828", fpsNumerator: "24", fpsDenominator: "1", frameCount: "48",
    shapes: [
      { id: "box", primitive: "RECTANGLE", x: "20", y: "20", width: "40", height: "40", color: "#FF4040", assetId: "",
        keyframes: [key(0, { easing: "EASE_IN_OUT" }), key(24, { x: "200", easing: "EASE_OUT" }), key(47, { x: "100" })] },
      { id: "ball", primitive: "ELLIPSE", x: "140", y: "80", width: "24", height: "24", color: "#40FF80", assetId: "",
        keyframes: [key(0, { easing: "EASE_IN" }), key(30, { y: "60", scaleX: "1.5", scaleY: "1.5" }), key(47, { y: "60", scaleX: "1.5", scaleY: "1.5" })] },
    ],
    assets: [],
  };
}

export interface SpecProblem { readonly path: string; readonly message: string }

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
function num(text: string, path: string, problems: SpecProblem[], integer = false): number {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) { problems.push({ path, message: "Enter a number." }); return 0; }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) { problems.push({ path, message: integer ? "Enter a whole number." : "Enter a finite number." }); return 0; }
  return value;
}

/**
 * Builds the host spec from the form. Only syntax is checked here (a number is a number); ranges, budgets, ids, easing and
 * rights are the host's decision, so a value the host would refuse is still sent and refused with its path.
 */
export function toRequestSpec(authored: AuthoredSpec): { readonly spec: Record<string, unknown>; readonly problems: readonly SpecProblem[] } {
  const problems: SpecProblem[] = [];
  const shapes = authored.shapes.map((shape, s) => {
    const base = `$.shapes[${s}]`;
    const out: Record<string, unknown> = {
      id: shape.id.trim(), primitive: shape.primitive,
      x: num(shape.x, `${base}.x`, problems), y: num(shape.y, `${base}.y`, problems),
      width: num(shape.width, `${base}.width`, problems), height: num(shape.height, `${base}.height`, problems),
    };
    if (shape.primitive === "RASTER_ASSET") out.assetId = shape.assetId.trim(); else out.color = shape.color.trim();
    out.keyframes = shape.keyframes.map((key, k) => {
      const path = `${base}.keyframes[${k}]`;
      return {
        frame: num(key.frame, `${path}.frame`, problems, true), x: num(key.x, `${path}.x`, problems), y: num(key.y, `${path}.y`, problems),
        scaleX: num(key.scaleX, `${path}.scaleX`, problems), scaleY: num(key.scaleY, `${path}.scaleY`, problems),
        opacity: num(key.opacity, `${path}.opacity`, problems), easing: key.easing,
      };
    });
    return out;
  });
  const spec: Record<string, unknown> = {
    width: num(authored.width, "$.width", problems, true), height: num(authored.height, "$.height", problems, true),
    background: authored.background.trim(),
    fps: { numerator: num(authored.fpsNumerator, "$.fps.numerator", problems, true), denominator: num(authored.fpsDenominator, "$.fps.denominator", problems, true) },
    frameCount: num(authored.frameCount, "$.frameCount", problems, true),
    shapes,
  };
  if (authored.assets.length > 0) {
    spec.assets = authored.assets.map((asset) => ({ id: asset.id.trim(), artifactId: asset.artifactId.trim(), artifactVersionId: asset.artifactVersionId.trim() }));
  }
  return { spec, problems };
}

// ---------------------------------------------------------------------------------------------- preview math

export interface CurveSample { readonly x: number; readonly y: number; readonly scaleX: number; readonly scaleY: number; readonly opacity: number }

/** The renderer's four easing curves on t in [0, 1]. */
export function ease(easing: Easing, t: number): number {
  switch (easing) {
    case "EASE_IN": return t * t;
    case "EASE_OUT": return 1 - (1 - t) * (1 - t);
    case "EASE_IN_OUT": return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    default: return t;
  }
}

/** Interpolated offset/scale/opacity of a shape at a frame; null when a keyframe value is not a number (preview skips it). */
export function sampleCurve(keys: readonly AuthoredKeyframe[], frame: number): CurveSample | null {
  const parsed = keys.map((key) => ({ f: Number(key.frame), x: Number(key.x), y: Number(key.y), sx: Number(key.scaleX), sy: Number(key.scaleY), o: Number(key.opacity), e: key.easing }));
  if (parsed.some((key) => ![key.f, key.x, key.y, key.sx, key.sy, key.o].every(Number.isFinite))) return null;
  parsed.sort((a, b) => a.f - b.f);
  if (parsed.length === 0) return { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1 };
  let left = parsed[0]!;
  if (frame <= left.f) return { x: left.x, y: left.y, scaleX: left.sx, scaleY: left.sy, opacity: left.o };
  for (let i = 1; i < parsed.length; i += 1) {
    const right = parsed[i]!;
    if (frame <= right.f) {
      const t = ease(left.e, (frame - left.f) / (right.f - left.f));
      const mix = (a: number, b: number): number => a + (b - a) * t;
      return { x: mix(left.x, right.x), y: mix(left.y, right.y), scaleX: mix(left.sx, right.sx), scaleY: mix(left.sy, right.sy), opacity: mix(left.o, right.o) };
    }
    left = right;
  }
  return { x: left.x, y: left.y, scaleX: left.sx, scaleY: left.sy, opacity: left.o };
}
