/**
 * DEV_ONLY render and review host boundary for the project workspace.
 *
 * The port is deliberately transport-neutral: a host adapter resolves with the
 * exact HTTP status and JSON body for 2xx responses and rejects with
 * {@link DevOutputsHostError} for everything else (status 0 means the request
 * outcome is unknown). Nothing here claims approval, export or delivery.
 */

export type DevRenderFormat = "gif" | "mp4";

export interface DevRenderRequest {
  readonly requestId: string;
  readonly revisionId: string;
  readonly timelineId: string;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly format: DevRenderFormat;
}

export type DevReviewSubject =
  | { readonly kind: "PROJECT_REVISION"; readonly projectId: string; readonly revisionId: string }
  | { readonly kind: "ARTIFACT_VERSION"; readonly artifactId: string; readonly artifactVersionId: string };

export type DevCommentDisposition = "OPEN" | "RESOLVED" | "NEEDS_OWNER_RESPONSE";
export type DevReviewDecision = "ACCEPT" | "REJECT" | "REQUEST_CHANGES" | "DEFER";

export interface DevReviewCommentRequest {
  readonly requestId: string;
  readonly expectedCaseRevision: number;
  readonly text: string;
  readonly disposition: DevCommentDisposition;
}

export interface DevReviewDecisionRequest {
  readonly requestId: string;
  readonly expectedCaseRevision: number;
  readonly decision: DevReviewDecision;
  readonly reason: string;
  readonly confirmed: true;
}

export interface DevHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevProjectOutputsPort {
  requestRender(projectId: string, request: DevRenderRequest): Promise<DevHostResponse>;
  getRender(projectId: string, renderId: string): Promise<DevHostResponse>;
  openReview(subject: DevReviewSubject): Promise<DevHostResponse>;
  getReview(reviewCaseId: string): Promise<DevHostResponse>;
  addReviewComment(reviewCaseId: string, request: DevReviewCommentRequest): Promise<DevHostResponse>;
  recordReviewDecision(reviewCaseId: string, request: DevReviewDecisionRequest): Promise<DevHostResponse>;
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevOutputsHostError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DevOutputsHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

export interface RenderSource {
  readonly clipId: string;
  readonly trackId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly startFrame: number | null;
  readonly endFrameExclusive: number | null;
  readonly trackKind: string | null;
}
export interface RenderEncoding {
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly videoPtsExact: boolean;
  readonly videoFrameCount: number | null;
  readonly expectedDurationSeconds: number | null;
  readonly manifestSha256: string | null;
}
export interface RenderView {
  readonly renderId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly sha256: string;
  readonly replayed: boolean;
  readonly projectId: string;
  readonly revisionId: string;
  readonly timelineId: string;
  readonly timelineSemanticVersionId: string | null;
  readonly engine: string;
  readonly format: DevRenderFormat;
  readonly frameCount: number | null;
  readonly sources: readonly RenderSource[];
  readonly encoding: RenderEncoding | null;
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Accept a render body only when it is internally consistent and matches what was asked.
 * Anything else is an invalid host response, never a success.
 */
export function parseRenderView(raw: unknown, expected: { projectId: string; revisionId?: string; format?: DevRenderFormat }): RenderView {
  if (!isRecord(raw) || raw.scope !== "DEV_ONLY") throw new Error("Render response is not a DEV_ONLY body.");
  const artifact = raw.artifact;
  const lineage = raw.lineage;
  if (!isRecord(artifact) || !isRecord(lineage)) throw new Error("Render response lacks artifact or lineage.");
  const renderId = str(raw.renderId);
  const artifactId = str(artifact.artifactId);
  const artifactVersionId = str(artifact.artifactVersionId);
  const sha256 = str(artifact.sha256);
  const contentType = str(artifact.contentType);
  const format = lineage.format === "mp4" ? "mp4" : lineage.format === "gif" ? "gif" : null;
  if (!renderId || !artifactId || !artifactVersionId || !sha256 || !contentType || !format
    || renderId !== artifactId || artifactVersionId !== `sha256:${sha256}`
    || (format === "gif" ? contentType !== "image/gif" : contentType !== "video/mp4")
    || typeof raw.replayed !== "boolean") {
    throw new Error("Render artifact identity is inconsistent.");
  }
  const revisionId = str(lineage.revisionId);
  const timelineId = str(lineage.timelineId);
  const engine = str(lineage.engine);
  if (lineage.projectId !== expected.projectId || !revisionId || !timelineId || !engine
    || (expected.revisionId !== undefined && revisionId !== expected.revisionId)
    || (expected.format !== undefined && format !== expected.format)) {
    throw new Error("Render lineage does not match the requested exact project revision.");
  }
  if (!Array.isArray(lineage.sources) || lineage.sources.length === 0) throw new Error("Render lineage has no exact sources.");
  const sources = lineage.sources.map((entry): RenderSource => {
    if (!isRecord(entry)) throw new Error("Render source is malformed.");
    const clipId = str(entry.clipId); const trackId = str(entry.trackId);
    const sourceArtifact = str(entry.artifactId); const sourceVersion = str(entry.artifactVersionId);
    if (!clipId || !trackId || !sourceArtifact || !sourceVersion) throw new Error("Render source lacks an exact version.");
    return { clipId, trackId, artifactId: sourceArtifact, artifactVersionId: sourceVersion,
      startFrame: num(entry.startFrame), endFrameExclusive: num(entry.endFrameExclusive), trackKind: str(entry.trackKind) };
  });
  let encoding: RenderEncoding | null = null;
  if (format === "mp4") {
    const e = lineage.encoding;
    if (!isRecord(e) || !str(e.videoCodec) || !str(e.audioCodec) || typeof e.videoPtsExact !== "boolean") {
      throw new Error("MP4 render response lacks its verified encoding block.");
    }
    encoding = { videoCodec: String(e.videoCodec), audioCodec: String(e.audioCodec), videoPtsExact: e.videoPtsExact,
      videoFrameCount: num(e.videoFrameCount), expectedDurationSeconds: num(e.expectedDurationSeconds),
      manifestSha256: str(e.manifestSha256) };
  }
  return { renderId, artifactId, artifactVersionId, contentType, sizeBytes: num(artifact.sizeBytes), sha256,
    replayed: raw.replayed, projectId: expected.projectId, revisionId, timelineId,
    timelineSemanticVersionId: str(lineage.timelineSemanticVersionId), engine, format,
    frameCount: num(lineage.frameCount), sources, encoding };
}

export type Currentness = "CURRENT" | "STALE" | "UNKNOWN";
export interface ReviewRecord {
  readonly appendRecordId: string;
  readonly caseRevision: number;
  readonly kind: "COMMENT" | "DECISION";
  readonly text: string | null;
  readonly disposition: string | null;
  readonly decision: string | null;
  readonly reason: string | null;
  readonly currentness: Currentness;
}
export interface ReviewView {
  readonly reviewCaseId: string;
  readonly created: boolean | null;
  readonly subjectReference: string;
  readonly subjectKind: string;
  readonly currentness: Currentness;
  readonly caseRevision: number;
  readonly status: string;
  readonly records: readonly ReviewRecord[];
  readonly establishesApproval: false;
  readonly humanReviewApproval: false;
  readonly authority: string;
  readonly note: string;
}
export interface ReviewReceipt {
  readonly reviewCaseId: string;
  readonly caseRevision: number;
  readonly currentness: Currentness;
  readonly replayed: boolean;
  readonly establishesApproval: false;
  readonly appendRecordId: string;
}

const currentnessOf = (value: unknown): Currentness => value === "CURRENT" || value === "STALE" || value === "UNKNOWN" ? value : "UNKNOWN";
const nonNegInt = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A host body that claims approval is rejected outright: DEV_ONLY review can never establish it. */
export function parseReviewView(raw: unknown): ReviewView {
  if (!isRecord(raw) || raw.scope !== "DEV_ONLY") throw new Error("Review response is not a DEV_ONLY body.");
  const state = raw.reviewState;
  const subject = raw.subject;
  if (!isRecord(state) || !isRecord(subject)) throw new Error("Review response lacks state or subject.");
  if (state.establishesApproval !== false || state.humanReviewApproval !== false) {
    throw new Error("Host body claimed approval; a DEV_ONLY review never establishes approval.");
  }
  const reviewCaseId = str(raw.reviewCaseId); const caseRevision = nonNegInt(raw.caseRevision);
  const reference = str(subject.reference); const kind = str(subject.kind); const status = str(state.status);
  if (!reviewCaseId || caseRevision === null || !reference || !kind || !status) throw new Error("Review response is incomplete.");
  const records = (Array.isArray(raw.records) ? raw.records : []).map((entry): ReviewRecord => {
    if (!isRecord(entry)) throw new Error("Review record is malformed.");
    const appendRecordId = str(entry.appendRecordId); const revision = nonNegInt(entry.caseRevision);
    if (!appendRecordId || revision === null || (entry.kind !== "COMMENT" && entry.kind !== "DECISION")) throw new Error("Review record is malformed.");
    return { appendRecordId, caseRevision: revision, kind: entry.kind, text: str(entry.text), disposition: str(entry.disposition),
      decision: str(entry.decision), reason: str(entry.reason), currentness: currentnessOf(entry.currentness) };
  });
  return { reviewCaseId, created: typeof raw.created === "boolean" ? raw.created : null, subjectReference: reference,
    subjectKind: kind, currentness: currentnessOf(raw.currentness), caseRevision, status, records,
    establishesApproval: false, humanReviewApproval: false,
    authority: str(raw.authority) ?? "DEV_ONLY synthetic owner; not an issued human reviewer authority",
    note: str(raw.note) ?? "" };
}

export function parseReviewReceipt(raw: unknown, reviewCaseId: string): ReviewReceipt {
  if (!isRecord(raw) || raw.scope !== "DEV_ONLY" || raw.establishesApproval !== false) {
    throw new Error("Review receipt is not a DEV_ONLY non-approval receipt.");
  }
  const caseRevision = nonNegInt(raw.caseRevision); const appendRecordId = str(raw.appendRecordId);
  if (raw.reviewCaseId !== reviewCaseId || caseRevision === null || !appendRecordId || typeof raw.replayed !== "boolean") {
    throw new Error("Review receipt does not match the review case.");
  }
  return { reviewCaseId, caseRevision, currentness: currentnessOf(raw.currentness), replayed: raw.replayed,
    establishesApproval: false, appendRecordId };
}

export type OutcomeTone = "error" | "unknown" | "denied" | "unavailable";
export interface Outcome {
  readonly tone: OutcomeTone;
  readonly code: string;
  readonly text: string;
  /** Retrying with the same requestId is safe and is what the UI offers. */
  readonly retrySameRequest: boolean;
  /** The recorded requestId can no longer be reused with this payload. */
  readonly discardRequest: boolean;
}

const RENDER_422: Readonly<Record<string, string>> = {
  TRACK_KIND_NOT_SUPPORTED: "This timeline has a track kind the DEV_ONLY renderer does not support. Remove it or render a different timeline; nothing was produced.",
  SOURCE_FORMAT_NOT_SUPPORTED: "A clip source is not a supported still image or media format for this render. Nothing was produced.",
  RENDER_EMPTY_TIMELINE: "The selected timeline has no clips to render. Nothing was produced.",
  RENDER_LIMIT_EXCEEDED: "The render exceeds a DEV_ONLY size, frame or source limit. Nothing was produced.",
  RENDER_UNSUPPORTED_FRAME_GEOMETRY: "MP4 rendering needs even width and height. Nothing was produced.",
  RENDER_UNSUPPORTED_AUDIO_LAYOUT: "A source audio layout is not supported by the MP4 renderer. Nothing was produced.",
  RENDER_UNSUPPORTED_TIMELINE: "The timeline composition is not supported by this renderer. Nothing was produced.",
  TIMELINE_NOT_FOUND: "The selected timeline is not in that exact revision. Nothing was produced.",
};

export function describeRenderFailure(error: unknown): Outcome {
  if (!(error instanceof DevOutputsHostError)) {
    return { tone: "unknown", code: "OUTCOME_UNKNOWN", retrySameRequest: true, discardRequest: false,
      text: "The render outcome is unknown. Retry with the same request identity; a duplicate returns the same artifact rather than a second one." };
  }
  const { status, code } = error;
  if (status === 0 || code === "OUTCOME_UNKNOWN" || code === "INVALID_RESPONSE") {
    return { tone: "unknown", code, retrySameRequest: true, discardRequest: false,
      text: "The render outcome is unknown. Retry with the same request identity; a duplicate returns the same artifact rather than a second one." };
  }
  if (status === 409) {
    return { tone: "error", code, retrySameRequest: false, discardRequest: true,
      text: "CONFLICT: this request identity was already used for a different render. No second output was created. The next request will use a new identity." };
  }
  if (status === 422) {
    return { tone: "error", code, retrySameRequest: false, discardRequest: false,
      text: RENDER_422[code] ?? `The host refused this render (${code}). Nothing was produced.` };
  }
  if (status === 503 && code === "RENDER_CODEC_UNAVAILABLE") {
    return { tone: "unavailable", code, retrySameRequest: true, discardRequest: false,
      text: "MP4 encoding is unavailable on this host (FFmpeg pipeline not configured or not runnable). No output exists. GIF may still be available." };
  }
  if (status === 502 && (code === "RENDER_REGISTRATION_FAILED" || code === "RENDER_EXECUTION_FAILED")) {
    return { tone: "error", code, retrySameRequest: true, discardRequest: false,
      text: code === "RENDER_REGISTRATION_FAILED"
        ? "The rendered bytes were not registered as an artifact. No output is available yet. Retry with the same request identity to resume."
        : "The render did not produce a verified output. No output is available. Retry with the same request identity." };
  }
  if (status === 403 || code === "PROJECT_ACCESS_DENIED" || code === "ARTIFACT_PERMISSION_REQUIRED") {
    return { tone: "denied", code, retrySameRequest: false, discardRequest: false,
      text: "Denied: this DEV_ONLY principal lacks permission to render this project (project write plus artifact read and create). Nothing was produced." };
  }
  if (status === 404) {
    return { tone: "error", code, retrySameRequest: false, discardRequest: false,
      text: code === "SOURCE_VERSION_NOT_FOUND"
        ? "A clip's exact source artifact version is not available to this DEV_ONLY principal. Nothing was produced."
        : `Not found (${code}) in this project and owner scope.` };
  }
  if (status >= 500) {
    return { tone: "unknown", code, retrySameRequest: true, discardRequest: false,
      text: `The host failed with ${code}; the outcome is unknown. Retry with the same request identity.` };
  }
  return { tone: "error", code, retrySameRequest: false, discardRequest: false,
    text: `The host refused this request (${status} ${code}). Nothing was changed.` };
}

export function describeReviewFailure(error: unknown): Outcome {
  if (!(error instanceof DevOutputsHostError) || error.status === 0 || error.code === "OUTCOME_UNKNOWN" || error.code === "INVALID_RESPONSE") {
    return { tone: "unknown", code: error instanceof DevOutputsHostError ? error.code : "OUTCOME_UNKNOWN",
      retrySameRequest: true, discardRequest: false,
      text: "The review outcome is unknown. Re-read the case; retrying the same request identity is idempotent." };
  }
  const { status, code } = error;
  const make = (tone: OutcomeTone, text: string, extra: Partial<Outcome> = {}): Outcome =>
    ({ tone, code, text, retrySameRequest: false, discardRequest: false, ...extra });
  if (code === "REVIEW_SUBJECT_STALE") return make("error", "STALE: the reviewed exact version changed, so new decisions on it are refused. Comments are still recorded as STALE. Open a review on the new exact version. No approval exists.");
  if (code === "REVIEW_CASE_REVISION_CONFLICT") return make("error", "The review case changed. It was re-read; submit again against the current case revision.", { discardRequest: true });
  if (code === "REVIEW_REQUEST_ID_REUSED") return make("error", "This request identity was already used with different content. The next submission uses a new identity.", { discardRequest: true });
  if (code === "REVIEW_CONFIRMATION_REQUIRED") return make("error", "Explicit confirmation is required to record a decision. Nothing was recorded.");
  if (status === 403) return make("denied", "Denied: this DEV_ONLY principal may not use this review case or its exact subject. Nothing was recorded.");
  if (status === 404) return make("error", code === "REVIEW_SUBJECT_NOT_FOUND"
    ? "The exact subject version is not available to this DEV_ONLY owner. No review case was opened."
    : `Not found (${code}) in this owner scope.`);
  if (status === 503 || code === "REVIEW_UNAVAILABLE") return make("unavailable", "The DEV_ONLY review host is unavailable or not enabled. Nothing was recorded.", { retrySameRequest: true });
  if (status >= 500) return make("unknown", `The host failed with ${code}; the outcome is unknown. Re-read the case before another action.`, { retrySameRequest: true });
  return make("error", `The host refused this request (${status} ${code}). Nothing was changed.`);
}
