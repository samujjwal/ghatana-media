/**
 * DEV_ONLY voice-synthesis host boundary (capabilities, synthesize, reopen, add to timeline).
 *
 * Everything the panel offers (voices, locales, limits, licence and attribution notice, the voice-cloning status)
 * comes from the host's capabilities response; nothing is hard-coded. The port is transport-neutral: an adapter
 * resolves with the exact HTTP status and JSON body for 2xx responses and rejects with {@link DevVoiceHostError}
 * for everything else (status 0 means the outcome could not be observed). The synthesized clip is a stock-voice
 * rendering of the typed text; it carries no quality, approval, production-rights or delivery claim.
 */

import type { DevArtifactContentReader, RegisteredArtifact } from "./devArtifactContent";

export interface DevVoiceHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevVoiceSynthesisRequest {
  readonly requestId: string;
  readonly text: string;
  readonly voice: string;
  readonly locale: string;
  readonly speakingRate: number;
}

/** One exact synthesized version placed as an AUDIO clip. `clipId` is stable per synthesis, so a repeat is a replay. */
export interface DevVoiceTimelineRequest {
  readonly clipId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly sha256: string;
  readonly durationMillis: number;
  readonly sampleRate: number;
}
export interface DevVoiceTimelinePlacement {
  readonly projectId: string;
  readonly timelineId: string;
  readonly revisionId: string;
  readonly clipId: string;
  readonly trackId: string;
}

export interface DevVoiceSynthesisPort {
  getCapabilities(): Promise<DevVoiceHostResponse>;
  synthesize(request: DevVoiceSynthesisRequest): Promise<DevVoiceHostResponse>;
  /** Optional exact-version content read; without it the result cannot be played or saved on this page. */
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
  /** Optional host action; without it the panel states that this host has no timeline. */
  addToTimeline?(request: DevVoiceTimelineRequest): Promise<DevVoiceTimelinePlacement>;
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevVoiceHostError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DevVoiceHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0) ? [...value] as string[] : null;

export interface VoiceCapabilities {
  readonly ready: boolean;
  readonly installState: string;
  readonly modelId: string | null;
  readonly revision: string | null;
  readonly licenseSpdx: string | null;
  readonly noticeRequired: boolean;
  readonly attributionNotice: string | null;
  readonly voices: readonly string[];
  /** Additive host map voice -> language; when present the voice list follows the selected locale. */
  readonly voiceLanguages: Readonly<Record<string, string>> | null;
  readonly defaultVoice: string | null;
  readonly verifiedLanguages: readonly string[];
  readonly voiceCloning: string | null;
  readonly maxTextChars: number;
}

function voiceLanguages(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const map: Record<string, string> = {};
  for (const [voice, language] of Object.entries(value)) if (typeof language === "string" && language) map[voice] = language;
  return Object.keys(map).length > 0 ? map : null;
}

/** The voices that speak the primary language of a locale; all voices when the host reports no language map. */
export function voicesForLocale(capabilities: VoiceCapabilities, locale: string): readonly string[] {
  if (!capabilities.voiceLanguages) return capabilities.voices;
  const primary = locale.split(/[-_]/u, 1)[0]!.toLowerCase();
  return capabilities.voices.filter((voice) => capabilities.voiceLanguages![voice] === primary);
}

/** Parses the text-to-speech section of GET /dev/v1/speech/capabilities; anything malformed is a typed error. */
export function parseVoiceCapabilities(body: unknown): VoiceCapabilities {
  const section = isRecord(body) && body.scope === "DEV_ONLY" && isRecord(body.textToSpeech) ? body.textToSpeech : null;
  if (!section || typeof section.ready !== "boolean") {
    throw new DevVoiceHostError("INVALID_RESPONSE", 200, "The host returned an invalid speech capabilities view.");
  }
  const voices = strings(section.voices) ?? [];
  const languages = strings(section.verifiedLanguages) ?? [];
  const attribution = isRecord(section.attribution) ? section.attribution : null;
  const maxText = finite(section.maxTextChars);
  return {
    ready: section.ready,
    installState: str(section.installState) ?? "UNKNOWN",
    modelId: str(section.modelId),
    revision: str(section.revision),
    licenseSpdx: str(section.licenseSpdx),
    noticeRequired: attribution?.noticeRequired === true,
    attributionNotice: attribution ? str(attribution.notice) : null,
    voices,
    voiceLanguages: voiceLanguages(section.voiceLanguages),
    defaultVoice: str(section.defaultVoice),
    verifiedLanguages: languages,
    voiceCloning: str(section.voiceCloning),
    maxTextChars: maxText !== null && maxText > 0 ? maxText : 2000,
  };
}

export interface VoiceSynthesisView {
  readonly outputId: string;
  readonly replayed: boolean;
  readonly artifact: RegisteredArtifact;
  readonly voice: string;
  readonly locale: string | null;
  readonly sampleRate: number;
  readonly durationMillis: number;
  readonly voiceCloning: string | null;
  readonly requestId: string | null;
  readonly note: string | null;
}

export function parseVoiceSynthesisView(response: DevVoiceHostResponse): VoiceSynthesisView {
  const bad = (): never => { throw new DevVoiceHostError("INVALID_RESPONSE", response.status, "The host returned an invalid synthesis view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.artifact) || !isRecord(body.lineage)) return bad();
  const artifact = body.artifact;
  const lineage = body.lineage;
  const audio = isRecord(lineage.audio) ? lineage.audio : null;
  const artifactId = str(artifact.artifactId);
  const version = str(artifact.artifactVersionId);
  const sha = str(artifact.sha256);
  const contentType = str(artifact.contentType);
  const voice = str(lineage.voice);
  const durationMillis = audio ? finite(audio.durationMillis) : null;
  const sampleRate = audio ? finite(audio.sampleRate) : null;
  if (!artifactId || !version || !sha || !contentType || !voice || durationMillis === null || durationMillis <= 0
    || sampleRate === null || sampleRate <= 0 || lineage.kind !== "LOCAL_TTS_AUDIO"
    || !/^sha256:[0-9a-f]{64}$/u.test(version) || !/^[0-9a-f]{64}$/u.test(sha) || version !== `sha256:${sha}`) return bad();
  return {
    outputId: str(body.outputId) ?? artifactId,
    replayed: body.replayed === true,
    artifact: { artifactId, artifactVersionId: version, contentType, sizeBytes: finite(artifact.sizeBytes), sha256: sha },
    voice,
    locale: str(lineage.locale),
    sampleRate,
    durationMillis,
    voiceCloning: audio ? str(audio.voiceCloning) : null,
    requestId: str(lineage.requestId),
    note: str(body.note),
  };
}

export type VoiceFailureTone = "denied" | "unsupported" | "unknown" | "unavailable" | "invalid";
export interface VoiceFailure {
  readonly code: string;
  readonly tone: VoiceFailureTone;
  readonly text: string;
}

/** Plain-language, typed description of a refusal. A refusal never implies that audio was produced. */
export function describeVoiceFailure(error: unknown): VoiceFailure {
  const host = error instanceof DevVoiceHostError ? error
    : new DevVoiceHostError("INVALID_RESPONSE", 0, error instanceof Error ? error.message : "Unexpected failure.");
  const code = host.code;
  const list = (key: string): string => {
    const value = host.details?.[key];
    return Array.isArray(value) ? value.join(", ") : "";
  };
  if (host.status === 0 || code === "OUTCOME_UNKNOWN" || code === "SPEECH_OUTCOME_UNKNOWN") {
    return { code, tone: "unknown", text: "The outcome is unknown: no verified audio was received and nothing is claimed. "
      + "Press Synthesize again; the same request identifier is reused so the host never creates a second clip." };
  }
  switch (code) {
    case "LOCALE_NOT_ADMITTED":
      return { code, tone: "denied", text: `This locale is not verified for the installed model${list("verifiedLanguages") ? ` (verified: ${list("verifiedLanguages")})` : ""}. Nothing was synthesized.` };
    case "VOICE_NOT_ADMITTED":
      return { code, tone: "denied", text: "This voice is not part of the verified model installation. Nothing was synthesized." };
    case "VOICE_LOCALE_MISMATCH":
      return { code, tone: "denied", text: "This stock voice does not speak the chosen locale. Pick a voice for that language. Nothing was synthesized." };
    case "VOICE_CLONING_NOT_SUPPORTED":
      return { code, tone: "unsupported", text: "Voice cloning and likeness synthesis are not supported by this model. Nothing was synthesized." };
    case "RIGHTS_AUTHORITY_UNAVAILABLE":
      return { code, tone: "unavailable", text: "No rights and consent authority is available for this request. Nothing was synthesized." };
    case "RENDER_CAPACITY_EXHAUSTED":
      return { code, tone: "unavailable", text: "The host is at capacity. Retry the same request after a short delay." };
    case "SPEECH_RUNTIME_UNAVAILABLE":
      return { code, tone: "unavailable", text: "The local text-to-speech model is not currently admitted on this host. Nothing was synthesized." };
    case "ARTIFACT_PERMISSION_REQUIRED":
      return { code, tone: "denied", text: "This identity lacks the artifact permissions needed to synthesize speech." };
    default:
      if (code.startsWith("RIGHTS_DECISION_")) {
        return { code, tone: "denied", text: `A confirmed voice-or-likeness statement is required (${code.slice("RIGHTS_DECISION_".length).toLowerCase()}). Nothing was synthesized.` };
      }
      return { code, tone: host.status >= 500 ? "unavailable" : "invalid", text: `${host.message || "The request failed."} Nothing was registered.` };
  }
}

/** Display name of a language tag, falling back to the tag itself (never invents a language). */
export function languageLabel(tag: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    return name && name !== tag ? `${tag} · ${name}` : tag;
  } catch {
    return tag;
  }
}
