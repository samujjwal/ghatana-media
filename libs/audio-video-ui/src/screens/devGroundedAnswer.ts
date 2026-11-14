/**
 * DEV_ONLY grounded cross-modal answer: strict parsing of the host response and the pure helpers the answer panel uses.
 *
 * The host validates every citation server-side. This module validates again on the client and never presents a claim
 * as grounded when one of its cited ids is not in the evidence set the same response carries ("defence in depth"):
 * such a claim is demoted to the not-grounded list. Times are container microseconds on the source clock (container
 * PTS, start_time included), which is also the position on the player's timeline for MP4.
 */

import type { DevArtifactContentRequest, DevArtifactContentResponse } from "./devArtifactContent";

export interface DevGroundedHostResponse { readonly status: number; readonly body: unknown }

export interface DevGroundedAskRequest {
  readonly requestId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly question: string;
  readonly allowPartial?: boolean;
}

export interface DevGroundedAnswerPort {
  ask(request: DevGroundedAskRequest): Promise<DevGroundedHostResponse>;
  get(outputId: string): Promise<DevGroundedHostResponse>;
  /** Exact-version content read used to load the source video for citation seeking (SHA-256 verified by the panel). */
  readArtifactContent?(request: DevArtifactContentRequest): Promise<DevArtifactContentResponse>;
}

/** Typed host failure. `status` 0 means no response was observed (the outcome of a request is then unknown). */
export class DevGroundedHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevGroundedHostError";
  }
}

export interface GroundedBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface GroundedFrame { readonly ptsTicks: number; readonly timebase: string; readonly frameNumber: number; readonly width: number; readonly height: number }
export type GroundedEvidenceKind = "TRANSCRIPT_SEGMENT" | "FRAME" | "FRAME_OBJECT" | "FRAME_TEXT";
export interface GroundedEvidence {
  readonly evidenceId: string;
  readonly kind: GroundedEvidenceKind;
  readonly startMicros: number;
  readonly endMicros: number;
  readonly frame: GroundedFrame | null;
  readonly box: GroundedBox | null;
  readonly text: string;
  readonly origin: string;
}
export interface GroundedClaim { readonly claimId: string; readonly text: string; readonly evidenceIds: readonly string[] }
export interface NotGroundedClaim { readonly text: string; readonly evidenceIds: readonly string[]; readonly flags: readonly string[]; readonly by: "host" | "client" }
export interface GroundedChild { readonly kind: string; readonly status: string; readonly reason: string | null; readonly evidenceCount: number }
export type GroundedAnswerStatus = "GROUNDED" | "PARTIALLY_GROUNDED" | "UNGROUNDED" | "ANSWER_UNPARSEABLE";

export interface GroundedAnswerView {
  readonly outputId: string;
  readonly replayed: boolean;
  readonly artifact: { readonly artifactId: string; readonly artifactVersionId: string; readonly sha256: string; readonly contentType: string; readonly sizeBytes: number | null };
  readonly requestId: string;
  readonly question: string;
  readonly source: { readonly artifactId: string; readonly artifactVersionId: string; readonly sha256: string; readonly contentType: string };
  readonly clock: { readonly clockId: string; readonly containerStartMicros: number; readonly containerDurationMicros: number };
  readonly children: readonly GroundedChild[];
  readonly evidenceCompleteness: "COMPLETE" | "PARTIAL";
  readonly evidence: readonly GroundedEvidence[];
  readonly status: GroundedAnswerStatus;
  readonly claims: readonly GroundedClaim[];
  readonly notGrounded: readonly NotGroundedClaim[];
}

const KINDS: readonly GroundedEvidenceKind[] = ["TRANSCRIPT_SEGMENT", "FRAME", "FRAME_OBJECT", "FRAME_TEXT"];
const STATUSES: readonly GroundedAnswerStatus[] = ["GROUNDED", "PARTIALLY_GROUNDED", "UNGROUNDED", "ANSWER_UNPARSEABLE"];
const MAX_ITEMS = 500;
const bad = (message: string): never => { throw new DevGroundedHostError("INVALID_RESPONSE", 200, message); };
const record = (value: unknown, what: string): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : bad(`${what} is not an object.`);
const text = (value: unknown, what: string, max = 4096): string =>
  typeof value === "string" && value.length <= max ? value : bad(`${what} is not a bounded string.`);
const int = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : bad(`${what} is not an integer.`);
const num = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isFinite(value) ? value : bad(`${what} is not a finite number.`);
const list = (value: unknown, what: string, max = MAX_ITEMS): readonly unknown[] =>
  Array.isArray(value) && value.length <= max ? value : bad(`${what} is not a bounded array.`);

function parseEvidence(raw: unknown): GroundedEvidence {
  const item = record(raw, "evidence item");
  const kind = text(item.kind, "evidence kind") as GroundedEvidenceKind;
  if (!KINDS.includes(kind)) bad("evidence kind is not recognised.");
  const startMicros = int(item.startMicros, "evidence start");
  const endMicros = int(item.endMicros, "evidence end");
  if (endMicros < startMicros) bad("evidence ends before it starts.");
  let frame: GroundedFrame | null = null;
  if (item.frame !== undefined) {
    const f = record(item.frame, "frame");
    frame = { ptsTicks: int(f.ptsTicks, "frame pts"), timebase: text(f.timebase, "frame timebase", 40), frameNumber: int(f.frameNumber, "frame number"),
      width: int(f.width, "frame width"), height: int(f.height, "frame height") };
    if (frame.width <= 0 || frame.height <= 0) bad("frame size is not positive.");
  }
  let box: GroundedBox | null = null;
  if (item.box !== undefined) {
    const b = record(item.box, "box");
    box = { x: num(b.x, "box x"), y: num(b.y, "box y"), width: num(b.width, "box width"), height: num(b.height, "box height") };
    if (frame === null) bad("a box needs its frame.");
    if (box.width < 0 || box.height < 0 || box.x < -1 || box.y < -1 || box.x + box.width > frame!.width + 1 || box.y + box.height > frame!.height + 1) {
      bad("a box lies outside its frame.");
    }
  }
  return { evidenceId: text(item.evidenceId, "evidence id", 80), kind, startMicros, endMicros, frame, box, text: text(item.text, "evidence text"), origin: text(item.origin, "evidence origin", 200) };
}

/**
 * Parses the host's grounded-answer view (POST 200/201 and GET 200 share it). Claims whose cited ids are not all in
 * the response's evidence set are moved to {@link GroundedAnswerView.notGrounded} (by "client").
 */
export function parseGroundedAnswerView(body: unknown, expected: { readonly outputId?: string } = {}): GroundedAnswerView {
  const root = record(body, "response");
  if (root.scope !== "DEV_ONLY") bad("response is not DEV_ONLY.");
  if (root.schema !== "media.dev.grounded-answer.v1") bad("response schema is not recognised.");
  const outputId = text(root.outputId, "output id", 128);
  if (expected.outputId !== undefined && expected.outputId !== outputId) bad("the reopened answer does not match the requested id.");
  const art = record(root.artifact, "artifact");
  const doc = record(root.document, "document");
  if (doc.schema !== "media.dev.grounded-answer.v1") bad("document schema is not recognised.");
  const source = record(doc.source, "source");
  const clock = record(doc.sourceClock, "source clock");
  const evidence = list(doc.evidence, "evidence").map(parseEvidence);
  const ids = new Set<string>();
  for (const item of evidence) { if (ids.has(item.evidenceId)) bad("duplicate evidence id."); ids.add(item.evidenceId); }
  const answer = record(doc.answer, "answer");
  const status = text(answer.status, "answer status", 40) as GroundedAnswerStatus;
  if (!STATUSES.includes(status)) bad("answer status is not recognised.");
  const claims: GroundedClaim[] = [];
  const notGrounded: NotGroundedClaim[] = [];
  for (const raw of list(answer.claims, "claims", 32)) {
    const c = record(raw, "claim");
    const evidenceIds = list(c.evidenceIds, "claim citations", 64).map((id) => text(id, "citation", 80));
    const missing = evidenceIds.filter((id) => !ids.has(id));
    if (evidenceIds.length === 0 || missing.length > 0) {
      notGrounded.push({ text: text(c.text, "claim text"), evidenceIds, by: "client",
        flags: evidenceIds.length === 0 ? ["UNCITED"] : missing.map((id) => `CITED_ID_NOT_IN_EVIDENCE:${id.slice(0, 40)}`) });
    } else {
      claims.push({ claimId: text(c.claimId, "claim id", 40), text: text(c.text, "claim text"), evidenceIds });
    }
  }
  for (const raw of list(answer.flaggedClaims, "flagged claims", 32)) {
    const f = record(raw, "flagged claim");
    notGrounded.push({ text: text(f.text, "flagged text"), evidenceIds: list(f.evidenceIds, "flagged citations", 64).map((id) => text(id, "citation", 80)),
      flags: list(f.flags, "flags", 16).map((flag) => text(flag, "flag", 120)), by: "host" });
  }
  const children = list(doc.children, "children", 8).map((raw): GroundedChild => {
    const c = record(raw, "child");
    return { kind: text(c.kind, "child kind", 40), status: text(c.status, "child status", 40), reason: typeof c.reason === "string" ? c.reason.slice(0, 400) : null,
      evidenceCount: typeof c.evidenceCount === "number" && Number.isSafeInteger(c.evidenceCount) ? c.evidenceCount : 0 };
  });
  const completeness = text(doc.evidenceCompleteness, "completeness", 20);
  if (completeness !== "COMPLETE" && completeness !== "PARTIAL") bad("completeness is not recognised.");
  const startMicros = int(clock.containerStartMicros, "container start");
  const durationMicros = int(clock.containerDurationMicros, "container duration");
  if (durationMicros <= 0) bad("container duration is not positive.");
  return {
    outputId, replayed: root.replayed === true,
    artifact: { artifactId: text(art.artifactId, "artifact id", 128), artifactVersionId: text(art.artifactVersionId, "artifact version", 100), sha256: text(art.sha256, "artifact sha256", 64),
      contentType: text(art.contentType, "artifact type", 100), sizeBytes: typeof art.sizeBytes === "number" ? art.sizeBytes : null },
    requestId: text(doc.requestId, "request id", 128), question: text(doc.question, "question", 400),
    source: { artifactId: text(source.artifactId, "source id", 128), artifactVersionId: text(source.artifactVersionId, "source version", 100),
      sha256: text(source.sha256, "source sha256", 64), contentType: text(source.contentType, "source type", 100) },
    clock: { clockId: text(clock.clockId, "clock id", 200), containerStartMicros: startMicros, containerDurationMicros: durationMicros },
    children, evidenceCompleteness: completeness as "COMPLETE" | "PARTIAL", evidence, status, claims, notGrounded,
  };
}

/**
 * Player position in seconds for an evidence item: its container-clock (PTS) time. Browsers play an MP4 on that same
 * absolute timeline (a non-zero start_time is a leading gap). The clock argument is kept so a per-player origin can be
 * applied in one place; the panel checks the result against the player's seekable range and never clamps silently.
 */
export function playerSeconds(item: Pick<GroundedEvidence, "startMicros">, _clock?: { readonly containerStartMicros: number }): number {
  return Math.max(0, item.startMicros / 1_000_000);
}

/** Compact m:ss.t label of a player position in seconds. */
export function formatSeconds(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Percentage geometry of an evidence box inside its frame, for an overlay on a same-aspect video. */
export function boxPercent(item: Pick<GroundedEvidence, "box" | "frame">): { left: number; top: number; width: number; height: number } | null {
  if (!item.box || !item.frame) return null;
  const clamp = (v: number): number => Math.min(100, Math.max(0, v));
  return {
    left: clamp((item.box.x / item.frame.width) * 100), top: clamp((item.box.y / item.frame.height) * 100),
    width: clamp((item.box.width / item.frame.width) * 100), height: clamp((item.box.height / item.frame.height) * 100),
  };
}

export interface GroundedFailure { readonly tone: "unknown" | "denied" | "unavailable" | "refused"; readonly code: string; readonly text: string }

/** Plain-language outcome of a typed host failure. A mutation with no observed response is OUTCOME_UNKNOWN. */
export function describeGroundedFailure(error: DevGroundedHostError): GroundedFailure {
  const { code, status } = error;
  if (status === 0 || code === "OUTCOME_UNKNOWN" || code === "GROUNDED_OUTCOME_UNKNOWN") {
    return { tone: "unknown", code, text: "The outcome is unknown: nothing is shown as an answer. Retrying uses the same request identity and resumes safely." };
  }
  if (code.startsWith("RIGHTS_") || status === 403) {
    return { tone: "denied", code, text: "The exact source version has no current processing rights admission, so nothing was run or registered." };
  }
  if (code === "SOURCE_CLOCK_MISMATCH" || code === "STALE_CHILD_SOURCE_VERSION" || code === "SOURCE_CLOCK_UNDETERMINED") {
    return { tone: "refused", code, text: "The source clock or version could not be bound to the evidence, so no answer was produced or registered." };
  }
  if (code === "GROUNDED_CHILD_FAILED") {
    return { tone: "refused", code, text: "An evidence child failed. No answer was produced; nothing was invented to fill the gap." };
  }
  if (status === 503 || status === 429) return { tone: "unavailable", code, text: "The local model service is unavailable or busy. Nothing was registered; retry the same request." };
  return { tone: "refused", code, text: error.message || "The request was refused. Nothing was registered." };
}
