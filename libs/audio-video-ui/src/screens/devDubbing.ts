/**
 * DEV_ONLY translation and dubbing host boundary (capabilities, translate, revise, dub).
 *
 * Everything the panel offers (admitted target languages, Spanish stock voices, tempo bounds, overflow policies, the
 * voice-cloning status) comes from the host's capabilities response; nothing is hard-coded. The port is
 * transport-neutral: an adapter resolves with the exact HTTP status and JSON body for 2xx responses and rejects with
 * {@link DevDubbingHostError} for everything else (status 0 means the outcome could not be observed). Machine
 * translation and synthetic speech carry no quality, lip-sync, approval, production-rights or delivery claim.
 */

import type { DevArtifactContentReader, RegisteredArtifact } from "./devArtifactContent";

export interface DevDubbingHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevDubbingTranslateRequest {
  readonly requestId: string;
  readonly transcriptArtifactId: string;
  readonly transcriptArtifactVersionId: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}
export interface DevDubbingReviseRequest {
  readonly requestId: string;
  readonly baseArtifactId: string;
  readonly baseArtifactVersionId: string;
  readonly segments: readonly { readonly segmentId: string; readonly text: string }[];
}
export interface DevDubbingDubRequest {
  readonly requestId: string;
  readonly translatedArtifactId: string;
  readonly translatedArtifactVersionId: string;
  readonly voice?: string;
  readonly overflowPolicy?: string;
}

export interface DevDubbingPort {
  getCapabilities(): Promise<DevDubbingHostResponse>;
  translate(request: DevDubbingTranslateRequest): Promise<DevDubbingHostResponse>;
  revise(request: DevDubbingReviseRequest): Promise<DevDubbingHostResponse>;
  dub(request: DevDubbingDubRequest): Promise<DevDubbingHostResponse>;
  /** Optional exact-version content read; without it the dub cannot be played on this page. */
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevDubbingHostError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DevDubbingHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0) ? [...value] as string[] : null;

export interface DubbingCapabilities {
  readonly translationReady: boolean;
  readonly dubbingReady: boolean;
  readonly targets: readonly string[];
  /** Stock voice -> language; only non-English voices are listed by the host. */
  readonly voices: Readonly<Record<string, string>>;
  readonly voiceCloning: string | null;
  readonly tempoAvailable: boolean;
  readonly tempoMin: number;
  readonly tempoMax: number;
  readonly overflowPolicies: readonly string[];
  readonly engineModel: string | null;
  readonly maxSegments: number;
  readonly maxSegmentChars: number;
  readonly lipTimingNote: string | null;
}

/** Parses GET /dev/v1/translations/capabilities; anything malformed is a typed error. */
export function parseDubbingCapabilities(body: unknown): DubbingCapabilities {
  const translation = isRecord(body) && body.scope === "DEV_ONLY" && isRecord(body.translation) ? body.translation : null;
  const dubbing = isRecord(body) && isRecord(body.dubbing) ? body.dubbing : null;
  if (!translation || !dubbing || typeof translation.ready !== "boolean" || typeof dubbing.ready !== "boolean") {
    throw new DevDubbingHostError("INVALID_RESPONSE", 200, "The host returned an invalid translation capabilities view.");
  }
  const admitted = isRecord(translation.admittedTargets) ? strings(translation.admittedTargets.en) ?? [] : [];
  const voices: Record<string, string> = {};
  if (isRecord(dubbing.voices)) {
    for (const [voice, language] of Object.entries(dubbing.voices)) if (typeof language === "string" && language) voices[voice] = language;
  }
  const tempo = isRecord(dubbing.tempo) ? dubbing.tempo : {};
  const engine = isRecord(translation.engine) ? translation.engine : {};
  const lip = isRecord(dubbing.lipTiming) ? dubbing.lipTiming : {};
  return {
    translationReady: translation.ready,
    dubbingReady: dubbing.ready,
    targets: admitted,
    voices,
    voiceCloning: str(dubbing.voiceCloning),
    tempoAvailable: tempo.available === true,
    tempoMin: finite(tempo.minFactor) ?? 0.8,
    tempoMax: finite(tempo.maxFactor) ?? 1.25,
    overflowPolicies: strings(dubbing.overflowPolicies) ?? [],
    engineModel: str(engine.modelId),
    maxSegments: finite(translation.maxSegments) ?? 200,
    maxSegmentChars: finite(translation.maxSegmentChars) ?? 800,
    lipTimingNote: str(lip.note),
  };
}

export interface DubbingSegment {
  readonly segmentId: string;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly sourceText: string;
  readonly text: string;
}
export interface TranslationView {
  readonly translationId: string;
  readonly artifact: RegisteredArtifact;
  readonly kind: string | null;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly segments: readonly DubbingSegment[];
  readonly replayed: boolean;
  readonly note: string | null;
}

const SHA = /^[0-9a-f]{64}$/u;

function parseArtifact(value: unknown): RegisteredArtifact | null {
  if (!isRecord(value)) return null;
  const artifactId = str(value.artifactId);
  const version = str(value.artifactVersionId);
  const sha = str(value.sha256);
  const contentType = str(value.contentType);
  if (!artifactId || !version || !sha || !contentType || !SHA.test(sha) || version !== `sha256:${sha}`) return null;
  return { artifactId, artifactVersionId: version, contentType, sizeBytes: finite(value.sizeBytes), sha256: sha };
}

export function parseTranslationView(response: DevDubbingHostResponse): TranslationView {
  const bad = (): never => { throw new DevDubbingHostError("INVALID_RESPONSE", response.status, "The host returned an invalid translation view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.translation) || !Array.isArray(body.segments)) return bad();
  const artifact = parseArtifact(body.translation.artifact);
  const lineage = isRecord(body.translation.lineage) ? body.translation.lineage : null;
  const source = str(body.sourceLanguage);
  const target = str(body.targetLanguage);
  if (!artifact || !source || !target || body.segments.length === 0) return bad();
  const segments: DubbingSegment[] = [];
  for (const entry of body.segments) {
    if (!isRecord(entry)) return bad();
    const id = str(entry.segmentId);
    const start = finite(entry.startMillis);
    const end = finite(entry.endMillis);
    const text = str(entry.text);
    const sourceText = typeof entry.sourceText === "string" ? entry.sourceText : "";
    if (!id || start === null || end === null || end <= start || !text) return bad();
    segments.push({ segmentId: id, startMillis: start, endMillis: end, sourceText, text });
  }
  return {
    translationId: str(body.translationId) ?? artifact.artifactId, artifact, kind: lineage ? str(lineage.kind) : null,
    sourceLanguage: source, targetLanguage: target, segments, replayed: body.replayed === true, note: str(body.note),
  };
}

export type DubbingFit = "FITS" | "TEMPO_ADJUSTED" | "OVERFLOW";
export interface DubbingTimingSegment {
  readonly segmentId: string;
  readonly sourceStartMillis: number;
  readonly sourceEndMillis: number;
  readonly windowMillis: number;
  readonly naturalDurationMillis: number;
  readonly tempoFactor: number;
  readonly dubDurationMillis: number;
  readonly fit: DubbingFit;
  readonly overflow: boolean;
  readonly overflowMillis: number;
}
export interface DubbingTiming {
  readonly voice: string | null;
  readonly overflowPolicy: string | null;
  readonly segments: readonly DubbingTimingSegment[];
  readonly trackDurationMillis: number | null;
  readonly tempoAdjustedCount: number | null;
  readonly overflowCount: number | null;
  readonly lipTimingNote: string | null;
}
export interface DubView {
  readonly dubId: string;
  readonly audio: RegisteredArtifact;
  readonly captions: RegisteredArtifact;
  readonly timingArtifact: RegisteredArtifact;
  readonly timing: DubbingTiming;
  readonly replayed: boolean;
  readonly note: string | null;
}

/** Parses the per-segment timing array; shared by a successful dub and the typed overflow refusal details. */
export function parseDubbingTimingSegments(value: unknown): DubbingTimingSegment[] | null {
  if (!Array.isArray(value)) return null;
  const out: DubbingTimingSegment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const id = str(entry.segmentId);
    const start = finite(entry.sourceStartMillis);
    const end = finite(entry.sourceEndMillis);
    const window = finite(entry.windowMillis);
    const natural = finite(entry.naturalDurationMillis);
    const tempo = finite(entry.tempoFactor);
    const dub = finite(entry.dubDurationMillis);
    const overflowMillis = finite(entry.overflowMillis);
    const fit = entry.fit;
    if (!id || start === null || end === null || window === null || natural === null || tempo === null || dub === null
      || overflowMillis === null || (fit !== "FITS" && fit !== "TEMPO_ADJUSTED" && fit !== "OVERFLOW") || typeof entry.overflow !== "boolean") return null;
    out.push({
      segmentId: id, sourceStartMillis: start, sourceEndMillis: end, windowMillis: window, naturalDurationMillis: natural,
      tempoFactor: tempo, dubDurationMillis: dub, fit, overflow: entry.overflow, overflowMillis,
    });
  }
  return out;
}

export function parseDubView(response: DevDubbingHostResponse): DubView {
  const bad = (): never => { throw new DevDubbingHostError("INVALID_RESPONSE", response.status, "The host returned an invalid dub view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.outputs) || !isRecord(body.timing)) return bad();
  const outputs = body.outputs;
  const pick = (key: string): RegisteredArtifact | null => isRecord(outputs[key]) ? parseArtifact((outputs[key] as Json).artifact) : null;
  const audio = pick("audio");
  const captions = pick("captions");
  const timingArtifact = pick("timing");
  const segments = parseDubbingTimingSegments(body.timing.segments);
  const dubId = str(body.dubId);
  if (!audio || !captions || !timingArtifact || !segments || segments.length === 0 || !dubId) return bad();
  const totals = isRecord(body.timing.totals) ? body.timing.totals : {};
  const lip = isRecord(body.timing.lipTiming) ? body.timing.lipTiming : {};
  return {
    dubId, audio, captions, timingArtifact, replayed: body.replayed === true, note: str(body.note),
    timing: {
      voice: str(body.timing.voice), overflowPolicy: str(body.timing.overflowPolicy), segments,
      trackDurationMillis: finite(totals.trackDurationMillis), tempoAdjustedCount: finite(totals.tempoAdjustedCount),
      overflowCount: finite(totals.overflowCount), lipTimingNote: str(lip.note),
    },
  };
}

export type DubbingFailureTone = "denied" | "unsupported" | "unknown" | "unavailable" | "invalid" | "overflow";
export interface DubbingOverflowSegment {
  readonly segmentId: string;
  readonly windowMillis: number;
  readonly naturalDurationMillis: number;
  readonly overflowMillis: number;
  readonly requiredTempoFactor: number | null;
  readonly reason: string;
}
export interface DubbingFailure {
  readonly code: string;
  readonly tone: DubbingFailureTone;
  readonly text: string;
  /** Present for DUB_TIMING_OVERFLOW: the segments that do not fit and the full per-segment fit the host measured. */
  readonly overflowSegments?: readonly DubbingOverflowSegment[];
  readonly fitSegments?: readonly DubbingTimingSegment[];
}

/** Plain-language, typed description of a refusal. A refusal never implies that anything was registered. */
export function describeDubbingFailure(error: unknown): DubbingFailure {
  const host = error instanceof DevDubbingHostError ? error
    : new DevDubbingHostError("INVALID_RESPONSE", 0, error instanceof Error ? error.message : "Unexpected failure.");
  const code = host.code;
  const list = (key: string): string => {
    const value = host.details?.[key];
    return Array.isArray(value) ? value.join(", ") : "";
  };
  if (host.status === 0 || code === "OUTCOME_UNKNOWN" || code === "TRANSLATION_OUTCOME_UNKNOWN" || code === "DUB_OUTCOME_UNKNOWN") {
    return { code, tone: "unknown", text: "The outcome is unknown: nothing was confirmed and nothing is claimed. Press the same button again; "
      + "the same request identifier is reused so the host never creates a second output." };
  }
  switch (code) {
    case "DUB_TIMING_OVERFLOW": {
      const overflowSegments: DubbingOverflowSegment[] = [];
      const raw = host.details?.overflowSegments;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!isRecord(entry)) continue;
          const id = str(entry.segmentId);
          const window = finite(entry.windowMillis);
          const natural = finite(entry.naturalDurationMillis);
          const over = finite(entry.overflowMillis);
          if (id && window !== null && natural !== null && over !== null) {
            overflowSegments.push({ segmentId: id, windowMillis: window, naturalDurationMillis: natural, overflowMillis: over,
              requiredTempoFactor: finite(entry.requiredTempoFactor), reason: str(entry.reason) ?? "" });
          }
        }
      }
      const fit = parseDubbingTimingSegments(host.details?.segments) ?? undefined;
      return { code, tone: "overflow", overflowSegments, ...(fit ? { fitSegments: fit } : {}),
        text: "At least one dubbed segment does not fit its source time window even at the maximum tempo factor. Nothing was registered and no "
          + "audio was truncated. Shorten the translation of the listed segments and save a revision, or choose the ALLOW_SPILL policy "
          + "(which still refuses a segment that would run into the next one)." };
    }
    case "LANGUAGE_NOT_ADMITTED":
      return { code, tone: "denied", text: `This language is not admitted for translation and dubbing${list("admittedTargets") ? ` (admitted: ${list("admittedTargets")})` : ""}. Nothing was produced.` };
    case "VOICE_NOT_ADMITTED":
      return { code, tone: "denied", text: "This voice is not part of the verified model installation. Nothing was produced." };
    case "VOICE_LOCALE_MISMATCH":
      return { code, tone: "denied", text: "This stock voice does not speak the target language. Nothing was produced." };
    case "VOICE_CLONING_NOT_SUPPORTED":
      return { code, tone: "unsupported", text: "Voice cloning and likeness synthesis are not supported. Nothing was produced." };
    case "RIGHTS_AUTHORITY_UNAVAILABLE":
      return { code, tone: "unavailable", text: "No rights statement for the original source is available. Nothing was produced." };
    case "SOURCE_VERSION_NOT_FOUND":
      return { code, tone: "denied", text: "That exact artifact version is not available to this identity." };
    case "SOURCE_NOT_A_TRANSCRIPT":
      return { code, tone: "invalid", text: "That artifact is not a speech transcript produced by the speech lane." };
    case "SOURCE_LANGUAGE_MISMATCH":
      return { code, tone: "invalid", text: "The transcript is not in English." };
    case "TRANSLATION_UNAVAILABLE":
    case "TRANSLATION_MODEL_NOT_ADMITTED":
    case "SPEECH_RUNTIME_UNAVAILABLE":
      return { code, tone: "unavailable", text: "The local translation or speech model is not currently admitted on this host. Nothing was produced." };
    case "RENDER_CAPACITY_EXHAUSTED":
      return { code, tone: "unavailable", text: "The host is at capacity. Retry the same request after a short delay." };
    case "REQUEST_ID_REUSED":
      return { code, tone: "invalid", text: "That request identifier was already used for a different request." };
    case "TRANSLATION_NOT_CHANGED":
      return { code, tone: "invalid", text: "The revision does not change any segment text." };
    case "ARTIFACT_PERMISSION_REQUIRED":
      return { code, tone: "denied", text: "This identity lacks the artifact permissions needed for translation and dubbing." };
    default:
      if (code.startsWith("RIGHTS_DECISION_")) {
        return { code, tone: "denied", text: `Source rights and consent do not admit this request (${code.slice("RIGHTS_DECISION_".length).toLowerCase()}). Nothing was produced.` };
      }
      return { code, tone: host.status >= 500 ? "unavailable" : "invalid", text: `${host.message || "The request failed."} Nothing was registered.` };
  }
}
