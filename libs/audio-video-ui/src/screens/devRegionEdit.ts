/**
 * DEV_ONLY tracked region edit host boundary (status, lineage, edit, undo) and its strict view parsers.
 *
 * A lineage is an owner-scoped append-only version history: version 1 is the user's own video, every edit is a NEW
 * immutable version, every undo points at the exact earlier artifact. Edits and undo name the head version the user
 * last saw; the host refuses a stale base with `STALE_BASE_VERSION` and this page never retries silently.
 * The host remains the only authority (tracks provenance, rights, geometry, rendering); the page only shows what it
 * registered and verified.
 */

import type { DevArtifactContentReader, RegisteredArtifact } from "./devArtifactContent";

export interface DevRegionEditHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevRegionEditRequest {
  readonly requestId: string;
  readonly baseVersion: number;
  readonly track: { readonly artifactId: string; readonly artifactVersionId: string; readonly trackId: string };
  readonly effect: Readonly<Record<string, unknown>>;
  readonly paddingPx: number;
  readonly maxDriftPx?: number;
  readonly encoder: { readonly crf: number };
}

export interface DevRegionEditPort {
  getStatus(): Promise<DevRegionEditHostResponse>;
  createLineage(request: { readonly lineageId: string; readonly artifactId: string; readonly artifactVersionId: string }): Promise<DevRegionEditHostResponse>;
  getLineage(lineageId: string): Promise<DevRegionEditHostResponse>;
  edit(lineageId: string, request: DevRegionEditRequest): Promise<DevRegionEditHostResponse>;
  undo(lineageId: string, request: { readonly requestId: string; readonly baseVersion: number }): Promise<DevRegionEditHostResponse>;
  /** Optional exact-version content read; without it the video cannot be played on this page. */
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevRegionEditHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevRegionEditHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const SHA = /^[0-9a-f]{64}$/u;

// ---------------------------------------------------------------------------------------------- status

export interface RegionEditStatus {
  readonly ready: boolean;
  readonly effects: readonly string[];
  readonly maxFrames: number;
  readonly maxPaddingPx: number;
  readonly maxBlockSize: number;
  readonly maxBlurRadius: number;
  readonly crfMax: number;
  readonly lossyOutsideMinPsnrDb: number | null;
}

export function parseRegionEditStatus(response: DevRegionEditHostResponse): RegionEditStatus {
  const bad = (): never => { throw new DevRegionEditHostError("INVALID_RESPONSE", response.status, "The host returned an invalid region edit status."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || typeof body.ready !== "boolean" || !isRecord(body.limits) || !Array.isArray(body.effects)) return bad();
  const number = (value: unknown): number => finite(value) ?? bad();
  const range = Array.isArray(body.limits.crfRange) ? body.limits.crfRange : [];
  const encoder = isRecord(body.encoder) ? body.encoder : {};
  return {
    ready: body.ready,
    effects: body.effects.filter((entry): entry is string => typeof entry === "string"),
    maxFrames: number(body.limits.maxFrames), maxPaddingPx: number(body.limits.maxPaddingPx),
    maxBlockSize: number(body.limits.maxBlockSize), maxBlurRadius: number(body.limits.maxBlurRadius),
    crfMax: finite(range[1]) ?? 30, lossyOutsideMinPsnrDb: finite(encoder.lossyOutsideMinPsnrDb),
  };
}

// ---------------------------------------------------------------------------------------------- views

export type VersionKind = "BASE" | "EDIT" | "UNDO";
export interface RegionVersion {
  readonly versionNumber: number;
  readonly kind: VersionKind;
  readonly requestId: string;
  readonly parentVersionNumber: number | null;
  readonly restoresVersionNumber: number | null;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly sha256: string;
  readonly sizeBytes: number | null;
  readonly manifestArtifactId: string | null;
}
export interface RegionLineageView {
  readonly lineageId: string;
  readonly headVersion: number;
  readonly undoAvailable: boolean;
  readonly versions: readonly RegionVersion[];
  readonly created: boolean | null;
}
export interface RegionFrame {
  readonly frameIndex: number;
  readonly pts: number;
  readonly seconds: number;
  readonly source: string;
  readonly mask: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}
export interface RegionManifest {
  readonly width: number;
  readonly height: number;
  readonly frames: readonly RegionFrame[];
  readonly maskedFrames: number;
  readonly effect: string;
  readonly drift: { readonly observations: number; readonly maxGapFrames: number; readonly maxCenterErrorPx: number; readonly meanCenterErrorPx: number; readonly minIou: number };
  readonly verification: {
    readonly ptsExact: boolean; readonly outsideLossless: boolean; readonly outsideMaxAbsDiff: number;
    readonly outsidePsnrDb: number | "INFINITE"; readonly insideChangedSamples: number; readonly frameCount: number;
  };
  readonly crf: number | null;
}
export interface RegionOutcome {
  readonly lineage: RegionLineageView;
  readonly version: RegionVersion;
  readonly manifest: RegionManifest | null;
  readonly replayed: boolean;
}

function parseVersion(value: unknown): RegionVersion | null {
  if (!isRecord(value) || !isRecord(value.artifact)) return null;
  const number = finite(value.versionNumber);
  const kind = value.kind;
  const requestId = str(value.requestId);
  const artifactId = str(value.artifact.artifactId);
  const artifactVersionId = str(value.artifact.artifactVersionId);
  const sha = str(value.artifact.sha256);
  if (number === null || number < 1 || (kind !== "BASE" && kind !== "EDIT" && kind !== "UNDO") || !requestId || !artifactId || !artifactVersionId
    || !sha || !SHA.test(sha) || artifactVersionId !== `sha256:${sha}`) return null;
  const manifestArtifact = isRecord(value.manifestArtifact) ? str(value.manifestArtifact.artifactId) : null;
  return { versionNumber: number, kind, requestId, parentVersionNumber: finite(value.parentVersionNumber),
    restoresVersionNumber: finite(value.restoresVersionNumber), artifactId, artifactVersionId, sha256: sha,
    sizeBytes: finite(value.artifact.sizeBytes), manifestArtifactId: manifestArtifact };
}

export function parseRegionLineage(response: DevRegionEditHostResponse): RegionLineageView {
  const bad = (): never => { throw new DevRegionEditHostError("INVALID_RESPONSE", response.status, "The host returned an invalid lineage view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !Array.isArray(body.versions)) return bad();
  const lineageId = str(body.lineageId);
  const head = finite(body.headVersion);
  if (!lineageId || head === null || typeof body.undoAvailable !== "boolean") return bad();
  const versions: RegionVersion[] = [];
  for (const entry of body.versions) {
    const parsed = parseVersion(entry);
    if (!parsed || parsed.versionNumber !== versions.length + 1) return bad();
    versions.push(parsed);
  }
  if (versions.length === 0 || versions.at(-1)!.versionNumber !== head) return bad();
  return { lineageId, headVersion: head, undoAvailable: body.undoAvailable, versions, created: typeof body.created === "boolean" ? body.created : null };
}

function parseManifest(value: unknown, bad: () => never): RegionManifest {
  if (!isRecord(value) || !isRecord(value.videoGeometry) || !Array.isArray(value.frames) || !isRecord(value.drift) || !isRecord(value.verification)) return bad();
  const geometry = value.videoGeometry;
  const base = isRecord(geometry.timeBase) ? geometry.timeBase : {};
  const num = finite(base.num);
  const den = finite(base.den);
  const width = finite(geometry.width);
  const height = finite(geometry.height);
  if (num === null || den === null || den <= 0 || width === null || height === null) return bad();
  const frames: RegionFrame[] = [];
  for (const entry of value.frames) {
    if (!isRecord(entry)) return bad();
    const frameIndex = finite(entry.frameIndex);
    const pts = finite(entry.pts);
    if (frameIndex === null || pts === null) return bad();
    let mask: RegionFrame["mask"] = null;
    if (entry.mask !== null && entry.mask !== undefined) {
      if (!isRecord(entry.mask)) return bad();
      const [x, y, w, h] = [finite(entry.mask.x), finite(entry.mask.y), finite(entry.mask.width), finite(entry.mask.height)];
      if (x === null || y === null || w === null || h === null) return bad();
      mask = { x, y, width: w, height: h };
    }
    frames.push({ frameIndex, pts, seconds: (pts * num) / den, source: str(entry.source) ?? "NONE", mask });
  }
  const drift = value.drift;
  const verification = value.verification;
  const psnr = verification.outsidePsnrDb === "INFINITE" ? "INFINITE" : finite(verification.outsidePsnrDb);
  const masked = finite(value.maskedFrames);
  const outsideMax = finite(verification.outsideMaxAbsDiff);
  const changed = finite(verification.insideChangedSamples);
  const frameCount = finite(verification.frameCount);
  const [observations, gap, maxCenter, meanCenter, minIou] = [finite(drift.observations), finite(drift.maxGapFrames),
    finite(drift.maxCenterErrorPx), finite(drift.meanCenterErrorPx), finite(drift.minIou)];
  if (psnr === null || masked === null || outsideMax === null || changed === null || frameCount === null || observations === null
    || gap === null || maxCenter === null || meanCenter === null || minIou === null || frames.length !== frameCount) return bad();
  const effect = isRecord(value.effect) ? str(value.effect.type) : null;
  const encoder = isRecord(value.encoder) ? value.encoder : {};
  return {
    width, height, frames, maskedFrames: masked, effect: effect ?? "UNKNOWN",
    drift: { observations, maxGapFrames: gap, maxCenterErrorPx: maxCenter, meanCenterErrorPx: meanCenter, minIou },
    verification: { ptsExact: verification.ptsExact === true, outsideLossless: verification.outsideLossless === true, outsideMaxAbsDiff: outsideMax,
      outsidePsnrDb: psnr, insideChangedSamples: changed, frameCount },
    crf: finite(encoder.crf),
  };
}

export function parseRegionOutcome(response: DevRegionEditHostResponse): RegionOutcome {
  const bad = (): never => { throw new DevRegionEditHostError("INVALID_RESPONSE", response.status, "The host returned an invalid region edit outcome."); };
  const lineage = parseRegionLineage(response);
  const body = response.body as Json;
  const version = parseVersion(body.version);
  if (!version || version.versionNumber > lineage.headVersion) return bad();
  const manifest = version.kind === "EDIT" ? parseManifest(body.manifest, bad) : null;
  return { lineage, version, manifest, replayed: body.replayed === true };
}

/** The registered artifact descriptor of a version's video for the verified-content reader. */
export function registeredVideo(version: RegionVersion): RegisteredArtifact {
  return { artifactId: version.artifactId, artifactVersionId: version.artifactVersionId, contentType: "video/mp4", sizeBytes: version.sizeBytes, sha256: version.sha256 };
}

/** The manifest frame shown at `seconds`: the last frame whose presentation time is not after it (half a millisecond of slack). */
export function frameAt(frames: readonly RegionFrame[], seconds: number): RegionFrame | null {
  let found: RegionFrame | null = null;
  for (const frame of frames) { if (frame.seconds <= seconds + 0.0005) found = frame; else break; }
  return found;
}

// ---------------------------------------------------------------------------------------------- failures

export type RegionFailureTone = "invalid" | "denied" | "untrusted" | "notFound" | "conflict" | "unknown" | "unavailable";
export interface RegionFailure {
  readonly code: string;
  readonly tone: RegionFailureTone;
  readonly text: string;
  /** The JSON path of the offending value, when the host named one. */
  readonly path: string | null;
  /** For a stale base: the version this page sent and the version the host holds. */
  readonly stale: { readonly expected: number; readonly head: number } | null;
}

export function describeRegionFailure(error: unknown): RegionFailure {
  const host = error instanceof DevRegionEditHostError ? error
    : new DevRegionEditHostError("INVALID_RESPONSE", 0, error instanceof Error ? error.message : "Unexpected failure.");
  const code = host.code;
  const path = str(host.details?.path);
  const make = (tone: RegionFailureTone, text: string, stale: RegionFailure["stale"] = null): RegionFailure => ({ code, tone, text, path, stale });
  if (host.status === 0 || code === "OUTCOME_UNKNOWN" || code === "REGION_EDIT_OUTCOME_UNKNOWN") {
    return { code, tone: "unknown", path: null, stale: null, text: "The outcome is unknown: nothing was confirmed and nothing is claimed. Press the same button again; "
      + "the same request identifier is reused so the host never creates a second version." };
  }
  if (code === "STALE_BASE_VERSION") {
    const expected = finite(host.details?.expectedVersion) ?? 0;
    const head = finite(host.details?.headVersion) ?? 0;
    return make("conflict", `Someone else changed this lineage: you were looking at version ${expected} but the head is version ${head}. `
      + "Nothing was changed. Reload the lineage, look at the new head and decide again; this page does not retry on its own.", { expected, head });
  }
  if (code.startsWith("RIGHTS_DECISION_") || code.startsWith("RIGHTS_")) {
    const authority = code === "RIGHTS_AUTHORITY_UNAVAILABLE";
    return { code, tone: authority ? "unavailable" : "denied", path: null, stale: null,
      text: authority ? "The rights authority is not available on this host. Nothing was read, rendered or registered."
        : `The original video has no current processing rights admission (${code.replace(/^RIGHTS_(DECISION_)?/u, "")}). Its uploader must state rights for this exact version. `
          + "Nothing was read, rendered or registered." };
  }
  if (code.startsWith("TRACK_") && code !== "TRACK_NOT_FOUND" && code !== "TRACK_ID_NOT_FOUND") {
    return make("untrusted", `The tracks input is not trusted (${host.message}). Use a tracks artifact produced by this host's tracking for this lineage's original video. Nothing was rendered.`);
  }
  switch (code) {
    case "REGION_EDIT_INVALID": return make("invalid", `The request is not valid${path ? ` at ${path}` : ""}: ${host.message} Nothing was rendered.`);
    case "TRACK_NOT_FOUND": case "TRACK_ID_NOT_FOUND": return make("notFound", `${host.message} Nothing was rendered.`);
    case "LINEAGE_NOT_FOUND": return make("notFound", "No such lineage in this tenant and owner scope.");
    case "SOURCE_VERSION_NOT_FOUND": return make("notFound", "The exact artifact version is not available to this identity.");
    case "LINEAGE_EXISTS": return make("conflict", "This lineage id is already used for a different video or by another owner. Choose another id.");
    case "NOTHING_TO_UNDO": return make("conflict", "The head is the original video; there is no edit to undo.");
    case "REGION_EDIT_REQUEST_ID_REUSED": return make("conflict", "This request identifier was already used for a different edit. Press the button again for a new identifier.");
    case "REGION_EDIT_NO_VISIBLE_CHANGE": return make("invalid", "The effect changed nothing inside the mask (the region may already be flat). Nothing was registered.");
    case "TRACK_DRIFT_EXCEEDED": return make("untrusted", "The track's own observations disagree with their interpolation by more than the drift you allowed. Nothing was rendered.");
    case "RENDER_CAPACITY_EXHAUSTED": return make("unavailable", "The host is at its render capacity. Nothing was rendered; try again shortly.");
    case "ARTIFACT_PERMISSION_REQUIRED": return make("denied", "This identity lacks the artifact read and create permissions required for region edits.");
    default: return make("unavailable", `${host.message || "The request failed."} Nothing was confirmed.`);
  }
}
