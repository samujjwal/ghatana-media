/**
 * DEV_ONLY multitrack composite render host boundary (capabilities, place clips, render, cancel).
 *
 * The port is transport-neutral: an adapter resolves with the exact HTTP status and JSON body for 2xx responses and rejects
 * with {@link DevCompositeHostError} for everything else (status 0 means the outcome could not be observed, so the same
 * requestId must be retried). Placement uses the existing project timeline routes; nothing here fabricates a result.
 */

import type { DevArtifactContentReader, RegisteredArtifact } from "./devArtifactContent";

export interface DevCompositeHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export type CompositeTrackKind = "VIDEO" | "AUDIO" | "OVERLAY" | "CAPTION";

/** One clip row of the placement table; all times are whole milliseconds. */
export interface CompositeClipRow {
  readonly clipId: string;
  readonly trackId: string;
  readonly trackKind: CompositeTrackKind;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly sourceInMs: number;
  readonly sourceOutMs: number;
  readonly storyStartMs: number;
  readonly storyDurationMs: number;
}

export interface CompositeRenderRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly timelineId: string;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly gapPolicy: "REFUSE" | "BLACK";
  readonly captionMode: "NONE" | "MUX" | "BURN" | "BOTH";
  readonly color?: { readonly brightness: number; readonly contrast: number; readonly saturation: number };
  readonly overlays: readonly { readonly clipId: string; readonly x: number; readonly y: number; readonly opacity: number }[];
  readonly audio: readonly { readonly clipId: string; readonly gainDb: number }[];
  readonly maxOutputBytes?: number;
}

export interface DevCompositePort {
  getCapabilities(): Promise<DevCompositeHostResponse>;
  /** Applies timeline edits against an expected head revision and resolves with the new revision body. */
  applyEdits(projectId: string, timelineId: string, expectedHeadRevisionId: string, edits: readonly Record<string, unknown>[]): Promise<DevCompositeHostResponse>;
  readHead(projectId: string): Promise<DevCompositeHostResponse>;
  render(request: CompositeRenderRequest): Promise<DevCompositeHostResponse>;
  cancel(requestId: string): Promise<DevCompositeHostResponse>;
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevCompositeHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevCompositeHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const SHA = /^[0-9a-f]{64}$/u;

export interface CompositeCapabilities {
  readonly videoTypes: readonly string[];
  readonly audioTypes: readonly string[];
  readonly captionModes: readonly string[];
  readonly gapPolicies: readonly string[];
  readonly maxClips: number;
  readonly maxTimelineSeconds: number;
  readonly maxOutputBytes: number;
  readonly note: string | null;
}

export function parseCompositeCapabilities(body: unknown): CompositeCapabilities {
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.limits)) {
    throw new DevCompositeHostError("INVALID_RESPONSE", 200, "The host returned an invalid composite render capabilities view.");
  }
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return {
    videoTypes: list(body.videoSourceTypes), audioTypes: list(body.audioSourceTypes), captionModes: list(body.captionModes),
    gapPolicies: list(body.gapPolicies), maxClips: finite(body.limits.maxClips) ?? 64, maxTimelineSeconds: finite(body.limits.maxTimelineSeconds) ?? 120,
    maxOutputBytes: finite(body.limits.maxOutputBytes) ?? 0, note: str(body.note),
  };
}

export interface CompositeSource {
  readonly clipId: string;
  readonly trackKind: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly sha256: string;
}
export interface CompositeRenderView {
  readonly renderId: string;
  readonly artifact: RegisteredArtifact;
  readonly replayed: boolean;
  readonly frameCount: number;
  readonly durationSeconds: string;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly sources: readonly CompositeSource[];
  readonly measured: { readonly videoCodec: string; readonly audioCodec: string; readonly subtitleCodec: string; readonly formatDurationSeconds: number };
  readonly captionMode: string;
  readonly captionCueCount: number;
}

export function parseCompositeRender(response: DevCompositeHostResponse): CompositeRenderView {
  const bad = (): never => { throw new DevCompositeHostError("INVALID_RESPONSE", response.status, "The host returned an invalid composite render view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.artifact) || !isRecord(body.lineage)) return bad();
  const artifactId = str(body.artifact.artifactId), version = str(body.artifact.artifactVersionId), sha = str(body.artifact.sha256);
  const contentType = str(body.artifact.contentType), renderId = str(body.renderId);
  if (!artifactId || !version || !sha || !contentType || !renderId || !SHA.test(sha) || version !== `sha256:${sha}`) return bad();
  const lineage = body.lineage;
  const encoding = isRecord(lineage.encoding) ? lineage.encoding : {};
  const composition = isRecord(lineage.composition) ? lineage.composition : {};
  const sources: CompositeSource[] = [];
  if (Array.isArray(lineage.sources)) {
    for (const entry of lineage.sources) {
      if (!isRecord(entry)) return bad();
      const clipId = str(entry.clipId), artifact = str(entry.artifactId), versionId = str(entry.artifactVersionId), digest = str(entry.sha256);
      if (!clipId || !artifact || !versionId || !digest) return bad();
      sources.push({ clipId, trackKind: str(entry.trackKind) ?? "", artifactId: artifact, artifactVersionId: versionId, sha256: digest });
    }
  }
  const frames = finite(lineage.frameCount), width = finite(lineage.width), height = finite(lineage.height), fps = finite(lineage.framesPerSecond);
  if (frames === null || width === null || height === null || fps === null || sources.length === 0) return bad();
  return {
    renderId, artifact: { artifactId, artifactVersionId: version, contentType, sizeBytes: finite(body.artifact.sizeBytes), sha256: sha },
    replayed: body.replayed === true, frameCount: frames, durationSeconds: str(lineage.durationSeconds) ?? "", width, height, framesPerSecond: fps, sources,
    measured: { videoCodec: str(encoding.videoCodec) ?? "", audioCodec: str(encoding.audioCodec) ?? "", subtitleCodec: str(encoding.subtitleCodec) ?? "",
      formatDurationSeconds: finite(encoding.formatDurationSeconds) ?? 0 },
    captionMode: str(composition.captionMode) ?? "", captionCueCount: finite(composition.captionCueCount) ?? 0,
  };
}

const time = (ms: number, clock: "SOURCE_PRESENTATION" | "STORY"): Record<string, string> =>
  ({ ticks: String(ms), rateNumerator: "1000", rateDenominator: "1", clock });

/**
 * Timeline edits for a placement table: optionally the scene and one track per distinct trackId first, then one putClip per
 * row. Track order follows the first appearance of each track in the table.
 */
export function buildPlacementEdits(rows: readonly CompositeClipRow[], scaffold: boolean, sceneId = "scene-main"): Record<string, unknown>[] {
  const edits: Record<string, unknown>[] = [];
  if (scaffold) {
    edits.push({ type: "addScene", sceneId, order: 0 });
    const seen = new Map<string, CompositeTrackKind>();
    for (const row of rows) if (!seen.has(row.trackId)) seen.set(row.trackId, row.trackKind);
    let order = 0;
    for (const [trackId, trackKind] of seen) edits.push({ type: "addTrack", trackId, sceneId, trackKind, order: order++ });
  }
  for (const row of rows) {
    edits.push({ type: "putClip", clip: {
      clipId: row.clipId, sceneId, trackId: row.trackId,
      source: { artifactId: row.artifactId, artifactVersionId: row.artifactVersionId },
      sourceIn: time(row.sourceInMs, "SOURCE_PRESENTATION"), sourceOut: time(row.sourceOutMs, "SOURCE_PRESENTATION"),
      storyStart: time(row.storyStartMs, "STORY"), storyDuration: time(row.storyDurationMs, "STORY"),
    } });
  }
  return edits;
}

export interface CompositeFailure {
  readonly code: string;
  readonly text: string;
  readonly path: string | null;
  readonly tone: "denied" | "invalid" | "unknown" | "cancelled" | "budget" | "unavailable";
}

/** Maps a host failure to text; the path of a typed 422 is kept so the field can be named. Never shows raw host internals. */
export function describeCompositeFailure(error: unknown): CompositeFailure {
  if (!(error instanceof DevCompositeHostError)) return { code: "UNEXPECTED_ERROR", text: "The page could not complete the request.", path: null, tone: "unavailable" };
  const path = typeof error.details?.path === "string" ? error.details.path : null;
  const code = error.code;
  const tone: CompositeFailure["tone"] = error.status === 0 || code === "RENDER_OUTCOME_UNKNOWN" || code === "RENDER_TIMEOUT" || code === "OUTCOME_UNKNOWN" ? "unknown"
    : code === "RENDER_CANCELLED" ? "cancelled"
    : code.startsWith("RENDER_") && code.endsWith("_BUDGET") || code === "RENDER_OUTPUT_BUDGET_EXCEEDED" || code === "RENDER_LIMIT_EXCEEDED" ? "budget"
    : error.status === 403 || error.status === 404 ? "denied"
    : error.status === 422 || error.status === 409 ? "invalid" : "unavailable";
  return { code, text: error.message, path, tone };
}
