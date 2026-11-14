/**
 * DEV_ONLY caption correction host boundary.
 *
 * A correction edits the cue text and timing of one exact WebVTT caption version (the unreviewed Whisper rendering or
 * an earlier correction) and registers a NEW immutable version; the base is never overwritten. The corrector is always
 * the host's authenticated caller. A correction is a statement by a DEV_ONLY principal: it is not reviewed, not a
 * quality claim and not an approval until an assigned reviewer decides on the exact version.
 */

import { DevOutputsHostError, type DevHostResponse, type Outcome, type OutcomeTone } from "./devProjectOutputs";

export interface DevCaptionCue {
  readonly startMillis: number;
  readonly endMillis: number;
  readonly text: string;
}

export interface DevCaptionCorrectionRequest {
  readonly requestId: string;
  readonly baseArtifactId: string;
  /** The exact version the author edited; any other current version is a conflict. */
  readonly expectedVersionId: string;
  readonly cues: readonly DevCaptionCue[];
}

/** Host port. A host without the caption lane omits it and the UI says so. */
export interface DevCaptionPort {
  /** GET /dev/v1/captions/{captionId} */
  getCaption(captionId: string): Promise<DevHostResponse>;
  /** POST /dev/v1/captions/corrections */
  correctCaption(request: DevCaptionCorrectionRequest): Promise<DevHostResponse>;
}

export interface DevCaptionReview {
  readonly available: boolean;
  readonly reviewCaseId: string | null;
  readonly latestDecision: string | null;
  readonly currentness: string | null;
  readonly acceptedByAssignedReviewer: boolean;
}

export interface DevCaptionVersion {
  readonly captionId: string;
  readonly artifactVersionId: string;
  readonly sha256: string;
  readonly kind: "LOCAL_STT_WEBVTT_UNREVIEWED" | "LOCAL_CAPTION_USER_CORRECTED";
  readonly cues: readonly DevCaptionCue[];
  readonly parent: { readonly artifactId: string; readonly artifactVersionId: string } | null;
  readonly machineVersion: { readonly artifactId: string; readonly artifactVersionId: string } | null;
  readonly correctedByPrincipalId: string | null;
  readonly correctionNumber: number;
  readonly edit: { readonly textChanged: number; readonly timingChanged: number; readonly added: number; readonly removed: number } | null;
  readonly sourceArtifactId: string | null;
  readonly review: DevCaptionReview;
  readonly replayed: boolean;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const MAX_CUES = 5_000;
export const MAX_CUE_TEXT_CHARS = 4_096;
export const MAX_MILLIS = 24 * 3_600_000;

const invalid = (what: string): DevOutputsHostError =>
  new DevOutputsHostError("INVALID_RESPONSE", 200, `The host returned an invalid caption version (${what}).`);
const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(what);
  return value as Record<string, unknown>;
};
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw invalid(what);
  return value;
};
const wholeMillis = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MILLIS) throw invalid(what);
  return value;
};
const ref = (value: unknown, what: string): { readonly artifactId: string; readonly artifactVersionId: string } | null => {
  if (value === undefined || value === null) return null;
  const parsed = record(value, what);
  return { artifactId: text(parsed.artifactId, `${what}.artifactId`), artifactVersionId: text(parsed.artifactVersionId, `${what}.artifactVersionId`) };
};

export function isOpaqueId(value: string): boolean { return OPAQUE_ID.test(value); }

/** Strictly validates the host's caption view; never trusts shape. */
export function parseCaptionVersion(body: unknown): DevCaptionVersion {
  const view = record(body, "body");
  if (view.scope !== "DEV_ONLY" || view.schema !== "media.dev.caption-version.v1") throw invalid("schema");
  const artifact = record(view.artifact, "artifact");
  const captionId = text(view.captionId, "captionId");
  if (text(artifact.artifactId, "artifact.artifactId") !== captionId) throw invalid("artifact id mismatch");
  const artifactVersionId = text(artifact.artifactVersionId, "artifact.artifactVersionId");
  if (!/^sha256:[0-9a-f]{64}$/u.test(artifactVersionId)) throw invalid("artifactVersionId");
  const kind = view.kind;
  if (kind !== "LOCAL_STT_WEBVTT_UNREVIEWED" && kind !== "LOCAL_CAPTION_USER_CORRECTED") throw invalid("kind");
  if (!Array.isArray(view.cues) || view.cues.length > MAX_CUES) throw invalid("cues");
  const cues = view.cues.map((raw, index): DevCaptionCue => {
    const cue = record(raw, `cues[${index}]`);
    const startMillis = wholeMillis(cue.startMillis, `cues[${index}].startMillis`);
    const endMillis = wholeMillis(cue.endMillis, `cues[${index}].endMillis`);
    if (endMillis <= startMillis) throw invalid(`cues[${index}] timing`);
    return { startMillis, endMillis, text: text(cue.text, `cues[${index}].text`) };
  });
  const lineage = record(view.lineage, "lineage");
  const review = record(view.review, "review");
  if (review.establishesApproval !== false) throw invalid("review.establishesApproval");
  const edit = lineage.edit === undefined ? null : record(lineage.edit, "lineage.edit");
  const num = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const source = lineage.source === undefined ? null : record(lineage.source, "lineage.source");
  return {
    captionId, artifactVersionId, sha256: text(artifact.sha256, "artifact.sha256"), kind, cues,
    parent: ref(lineage.parent, "lineage.parent"),
    machineVersion: ref(lineage.machineVersion, "lineage.machineVersion"),
    correctedByPrincipalId: typeof lineage.correctedByPrincipalId === "string" ? lineage.correctedByPrincipalId : null,
    correctionNumber: num(lineage.correctionNumber),
    edit: edit ? { textChanged: num(edit.textChanged), timingChanged: num(edit.timingChanged), added: num(edit.added), removed: num(edit.removed) } : null,
    sourceArtifactId: source && typeof source.artifactId === "string" ? source.artifactId : null,
    review: {
      available: review.available === true,
      reviewCaseId: typeof review.reviewCaseId === "string" ? review.reviewCaseId : null,
      latestDecision: typeof review.latestDecision === "string" ? review.latestDecision : null,
      currentness: typeof review.currentness === "string" ? review.currentness : null,
      acceptedByAssignedReviewer: review.acceptedByAssignedReviewer === true,
    },
    replayed: view.replayed === true,
  };
}

// ---- timecodes ----

const TIMECODE = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)\.(\d{3})$/u;

/** {@code mm:ss.mmm}, or {@code h:mm:ss.mmm} from one hour. */
export function formatTimecode(millis: number): string {
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor(millis / 60_000) % 60;
  const seconds = Math.floor(millis / 1_000) % 60;
  const ms = millis % 1_000;
  const two = (value: number): string => value.toString().padStart(2, "0");
  return `${hours > 0 ? `${hours}:` : ""}${two(minutes)}:${two(seconds)}.${ms.toString().padStart(3, "0")}`;
}

/** Exact whole-millisecond parse of {@code [h:]mm:ss.mmm}; null when it is not exactly that. */
export function parseTimecode(value: string): number | null {
  const match = TIMECODE.exec(value.trim());
  if (!match) return null;
  const millis = Number(match[1] ?? 0) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4]);
  return millis <= MAX_MILLIS ? millis : null;
}

// ---- draft ----

export interface DraftCue {
  /** Stable identity within the editor session; not sent to the host. */
  readonly key: number;
  readonly start: string;
  readonly end: string;
  readonly text: string;
}

export interface DraftCueErrors {
  readonly start?: string;
  readonly end?: string;
  readonly text?: string;
}

export function draftFrom(cues: readonly DevCaptionCue[]): DraftCue[] {
  return cues.map((cue, index) => ({ key: index + 1, start: formatTimecode(cue.startMillis), end: formatTimecode(cue.endMillis), text: cue.text }));
}

/** Per-row validation mirroring the host's strict rules (the host stays the authority). */
export function validateDraft(draft: readonly DraftCue[]): { readonly rows: readonly DraftCueErrors[]; readonly summary: readonly string[] } {
  const rows: DraftCueErrors[] = [];
  const summary: string[] = [];
  let previousEnd = 0;
  if (draft.length === 0) summary.push("A caption needs at least one cue.");
  if (draft.length > MAX_CUES) summary.push(`A caption can have at most ${MAX_CUES} cues.`);
  draft.forEach((cue, index) => {
    const errors: { start?: string; end?: string; text?: string } = {};
    const start = parseTimecode(cue.start);
    const end = parseTimecode(cue.end);
    if (start === null) errors.start = "Use mm:ss.mmm, for example 00:03.250.";
    if (end === null) errors.end = "Use mm:ss.mmm, for example 00:05.000.";
    if (start !== null && end !== null) {
      if (end <= start) errors.end = "The end must be after the start.";
      else if (start < previousEnd) errors.start = "This cue must not start before the previous cue ends.";
      previousEnd = Math.max(previousEnd, end);
    }
    const body = cue.text.replace(/\r\n?/gu, "\n").trim();
    if (body === "") errors.text = "Cue text is required.";
    else if (body.includes("<")) errors.text = "Plain text only: '<' is not supported.";
    else if (body.includes("-->")) errors.text = "The text must not contain '-->'.";
    else if (body.length > MAX_CUE_TEXT_CHARS) errors.text = `At most ${MAX_CUE_TEXT_CHARS} characters.`;
    // eslint-disable-next-line no-control-regex
    else if (/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(body)) errors.text = "Control characters are not allowed.";
    rows.push(errors);
    if (errors.start || errors.end || errors.text) summary.push(`Cue ${index + 1}: ${errors.start ?? errors.end ?? errors.text}`);
  });
  return { rows, summary };
}

/** Cues exactly as they would be sent: parsed times, trimmed text with normalized newlines. */
export function draftToCues(draft: readonly DraftCue[]): readonly DevCaptionCue[] {
  return draft.map((cue) => ({
    startMillis: parseTimecode(cue.start) ?? 0,
    endMillis: parseTimecode(cue.end) ?? 0,
    text: cue.text.replace(/\r\n?/gu, "\n").trim(),
  }));
}

export function sameCues(left: readonly DevCaptionCue[], right: readonly DevCaptionCue[]): boolean {
  return left.length === right.length && left.every((cue, index) =>
    cue.startMillis === right[index]!.startMillis && cue.endMillis === right[index]!.endMillis && cue.text === right[index]!.text);
}

export function buildCorrectionRequest(base: DevCaptionVersion, draft: readonly DraftCue[], requestId: string): DevCaptionCorrectionRequest {
  if (!OPAQUE_ID.test(requestId)) throw new TypeError("requestId must be a 1-128 character opaque id.");
  if (validateDraft(draft).summary.length > 0) throw new TypeError("The draft is not valid.");
  return { requestId, baseArtifactId: base.captionId, expectedVersionId: base.artifactVersionId, cues: draftToCues(draft) };
}

// ---- failures ----

export function describeCaptionFailure(error: unknown): Outcome {
  const make = (tone: OutcomeTone, code: string, message: string, extra: Partial<Outcome> = {}): Outcome =>
    ({ tone, code, text: message, retrySameRequest: false, discardRequest: false, ...extra });
  if (!(error instanceof DevOutputsHostError)) {
    return make("unknown", "OUTCOME_UNKNOWN", "The outcome is unknown. Reopen this caption version before saving again; saving again with the same edits is idempotent.", { retrySameRequest: true });
  }
  const { status, code } = error;
  if (status === 0 || code === "OUTCOME_UNKNOWN" || code === "INVALID_RESPONSE" || status === 502) {
    return make("unknown", code, "OUTCOME UNKNOWN: the host did not confirm whether the corrected caption was saved. Saving again with the same edits reuses the same request identity, so it cannot create a second version.", { retrySameRequest: true });
  }
  if (code === "CAPTION_VERSION_CONFLICT") {
    return make("error", code, "CONFLICT: this caption version is no longer the one to edit (it already has a correction, or its version changed). Nothing was overwritten and nothing was saved. Reopen it to see the current version, then re-apply your edits.", { discardRequest: true });
  }
  if (code.startsWith("RIGHTS_DECISION_") || code === "RIGHTS_AUTHORITY_UNAVAILABLE") {
    return make(code === "RIGHTS_AUTHORITY_UNAVAILABLE" ? "unavailable" : "denied", code,
      `Refused: source rights and consent no longer admit editing this caption (${code.replace("RIGHTS_DECISION_", "").toLowerCase()}). Nothing was saved.`);
  }
  if (code === "ARTIFACT_PERMISSION_REQUIRED" || status === 403) return make("denied", code, "Denied: this DEV_ONLY identity may not correct captions (project write plus artifact read and create). Nothing was saved.");
  if (code === "SOURCE_VERSION_NOT_FOUND" || code === "CAPTION_NOT_FOUND" || status === 404) return make("error", code, "That caption version is not available to this DEV_ONLY identity. Only its owner can open or correct it.");
  if (code === "CAPTION_UNCHANGED") return make("error", code, "Nothing to save: the cues are identical to this version.");
  if (code === "CAPTION_BASE_NOT_SUPPORTED") return make("error", code, "Only a machine caption or an earlier correction can be corrected.");
  if (status === 422 || status === 400) return make("error", code, `The host refused the cues (${code}). Nothing was saved.`);
  if (status === 429) return make("unavailable", code, "The host is at capacity. Try again shortly; the same edits reuse the same request identity.", { retrySameRequest: true });
  if (status >= 500) return make("unavailable", code, "The caption lane is unavailable. Nothing you can rely on was saved.");
  return make("error", code, `The host refused the request (${status} ${code}).`);
}
