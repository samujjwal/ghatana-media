/**
 * DEV_ONLY audio restoration host boundary (J-07): status, restore, compare.
 *
 * The port is transport-neutral. An adapter resolves with the exact HTTP status and JSON body for 2xx responses and
 * rejects with {@link DevAudioHostError} for everything else (status 0 means the outcome could not be observed). A
 * restoration is an engine output with no perceptual-quality, rights, approval or delivery claim: every figure shown
 * on the page is a measurement the host made from decoded samples, and a verdict is the host's, derived from them.
 */

import type { DevArtifactContentReader, RegisteredArtifact } from "./devArtifactContent";

export interface DevAudioHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevAudioOperations {
  readonly denoise?: { readonly reductionDb: number; readonly noiseFloorDb: number; readonly trackNoise: boolean };
  readonly declip?: { readonly threshold: number };
  readonly dehum?: { readonly frequencyHz: 50 | 60 };
  /** Off unless present. */
  readonly normalize?: { readonly targetLufs: number };
}

export interface DevAudioVersionRef {
  readonly artifactId: string;
  readonly artifactVersionId: string;
}

export interface DevAudioRestoreRequest extends DevAudioVersionRef {
  readonly requestId: string;
  readonly operations: DevAudioOperations;
}

export interface DevAudioCompareRequest {
  readonly requestId: string;
  readonly source: DevAudioVersionRef;
  readonly restored: DevAudioVersionRef;
  readonly reference?: DevAudioVersionRef;
  readonly transcript?: { readonly language: string; readonly referenceText?: string };
}

export interface DevAudioRestorationPort {
  getStatus(): Promise<DevAudioHostResponse>;
  restore(request: DevAudioRestoreRequest): Promise<DevAudioHostResponse>;
  compare(request: DevAudioCompareRequest): Promise<DevAudioHostResponse>;
  /** Optional exact-version content read; without it the A/B clips cannot be played on this page. */
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevAudioHostError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DevAudioHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export interface AudioHostStatus {
  readonly engineReady: boolean;
  readonly engineVersion: string | null;
  readonly transcriptReady: boolean;
  readonly deadlineSeconds: number | null;
  readonly maxSourceBytes: number | null;
}

export function parseAudioHostStatus(response: DevAudioHostResponse): AudioHostStatus {
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.engine)) {
    throw new DevAudioHostError("INVALID_RESPONSE", response.status, "The host returned an invalid audio status view.");
  }
  const limits = isRecord(body.limits) ? body.limits : {};
  return {
    engineReady: body.engine.ready === true,
    engineVersion: str(body.engine.version),
    transcriptReady: isRecord(body.transcriptDiff) && body.transcriptDiff.ready === true,
    deadlineSeconds: finite(limits.deadlineSeconds),
    maxSourceBytes: finite(limits.maxSourceBytes),
  };
}

export interface AudioRestorationView {
  readonly outputId: string;
  readonly replayed: boolean;
  readonly artifact: RegisteredArtifact;
  readonly sourceSha256: string;
  readonly sourceVersionId: string;
  readonly filterGraph: string;
  readonly engineVersion: string | null;
  readonly note: string | null;
}

const VERSION = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{64}$/u;

export function parseAudioRestorationView(response: DevAudioHostResponse): AudioRestorationView {
  const bad = (): never => { throw new DevAudioHostError("INVALID_RESPONSE", response.status, "The host returned an invalid restoration view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || body.kind !== "RESTORATION" || !isRecord(body.artifact) || !isRecord(body.lineage)) return bad();
  const artifact = body.artifact;
  const lineage = body.lineage;
  const source = isRecord(lineage.source) ? lineage.source : null;
  const engine = isRecord(lineage.engine) ? lineage.engine : null;
  const artifactId = str(artifact.artifactId);
  const version = str(artifact.artifactVersionId);
  const sha = str(artifact.sha256);
  const contentType = str(artifact.contentType);
  const sourceSha = source ? str(source.sha256) : null;
  const sourceVersion = source ? str(source.artifactVersionId) : null;
  const graph = str(lineage.filterGraph);
  if (!artifactId || !version || !sha || !contentType || !sourceSha || !sourceVersion || !graph
    || !VERSION.test(version) || !SHA.test(sha) || version !== `sha256:${sha}` || !SHA.test(sourceSha)
    || lineage.kind !== "LOCAL_AUDIO_RESTORED") return bad();
  return {
    outputId: str(body.outputId) ?? artifactId,
    replayed: body.replayed === true,
    artifact: { artifactId, artifactVersionId: version, contentType, sizeBytes: finite(artifact.sizeBytes), sha256: sha },
    sourceSha256: sourceSha,
    sourceVersionId: sourceVersion,
    filterGraph: graph,
    engineVersion: engine ? str(engine.version) : null,
    note: str(body.note),
  };
}

export interface AudioSideMetrics {
  readonly clippedSamples: number;
  readonly peakAbs: number | null;
  readonly rmsDbfs: number | null;
  readonly noiseFloorDbfs: number | null;
  readonly noiseFloorFlatness: number | null;
  readonly snrDb: number | null;
  readonly segmentalSnrDb: number | null;
}

export interface AudioTranscriptDiff {
  readonly status: string;
  readonly cleanText: string | null;
  readonly sourceText: string | null;
  readonly restoredText: string | null;
  readonly sourceWordErrorRate: number | null;
  readonly restoredWordErrorRate: number | null;
  readonly intelligibility: string | null;
}

export interface AudioComparisonReport {
  readonly outputId: string;
  readonly replayed: boolean;
  readonly hasReference: boolean;
  readonly source: AudioSideMetrics;
  readonly restored: AudioSideMetrics;
  readonly reference: AudioSideMetrics | null;
  readonly delta: {
    readonly snrDb: number | null;
    readonly segmentalSnrDb: number | null;
    readonly clippedSamples: number | null;
    readonly noiseFloorDbfs: number | null;
    readonly noiseFloorFlatness: number | null;
  };
  readonly verdict: {
    readonly overall: string;
    readonly snr: string;
    readonly segmentalSnr: string;
    readonly clipping: string;
    readonly noiseFloorLevel: string;
  };
  readonly transcript: AudioTranscriptDiff;
  readonly note: string | null;
}

function side(value: unknown): AudioSideMetrics | null {
  if (!isRecord(value)) return null;
  const clipped = finite(value.clippedSamples);
  if (clipped === null) return null;
  const floor = isRecord(value.noiseFloor) ? value.noiseFloor : null;
  return {
    clippedSamples: clipped, peakAbs: finite(value.peakAbs), rmsDbfs: finite(value.rmsDbfs),
    noiseFloorDbfs: floor ? finite(floor.rmsDbfs) : null, noiseFloorFlatness: floor ? finite(floor.spectralFlatness) : null,
    snrDb: finite(value.snrDb), segmentalSnrDb: finite(value.segmentalSnrDb),
  };
}

export function parseAudioComparisonView(response: DevAudioHostResponse): AudioComparisonReport {
  const bad = (): never => { throw new DevAudioHostError("INVALID_RESPONSE", response.status, "The host returned an invalid comparison view."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || body.kind !== "COMPARISON" || !isRecord(body.report)) return bad();
  const report = body.report;
  const metrics = isRecord(report.metrics) ? report.metrics : null;
  const verdict = isRecord(report.verdict) ? report.verdict : null;
  if (!metrics || !verdict) return bad();
  const source = side(metrics.source);
  const restored = side(metrics.restored);
  const delta = isRecord(metrics.delta) ? metrics.delta : null;
  const overall = str(verdict.overall);
  if (!source || !restored || !delta || !overall) return bad();
  const transcript = isRecord(report.transcript) ? report.transcript : {};
  const reference = side(metrics.reference);
  return {
    outputId: str(body.outputId) ?? "",
    replayed: body.replayed === true,
    hasReference: reference !== null && isRecord(report.reference),
    source, restored, reference,
    delta: {
      snrDb: finite(delta.snrDb), segmentalSnrDb: finite(delta.segmentalSnrDb), clippedSamples: finite(delta.clippedSamples),
      noiseFloorDbfs: finite(delta.noiseFloorDbfs), noiseFloorFlatness: finite(delta.noiseFloorSpectralFlatness),
    },
    verdict: {
      overall, snr: str(verdict.snr) ?? "NOT_MEASURED", segmentalSnr: str(verdict.segmentalSnr) ?? "NOT_MEASURED",
      clipping: str(verdict.clipping) ?? "NOT_MEASURED", noiseFloorLevel: str(verdict.noiseFloorLevel) ?? "NOT_MEASURED",
    },
    transcript: {
      status: str(transcript.status) ?? "NOT_REQUESTED", cleanText: str(transcript.cleanText), sourceText: str(transcript.sourceText),
      restoredText: str(transcript.restoredText), sourceWordErrorRate: finite(transcript.sourceWordErrorRate),
      restoredWordErrorRate: finite(transcript.restoredWordErrorRate), intelligibility: str(transcript.intelligibility),
    },
    note: str(body.note),
  };
}

/** Plain-language sentence for the host's overall verdict; never says "better" unless the host's numbers did. */
export function describeAudioVerdict(report: AudioComparisonReport): string {
  switch (report.verdict.overall) {
    case "IMPROVED": return "Measured against the clean reference, the restored version is closer to it than the source (SNR and segmental SNR both rose).";
    case "DEGRADED": return "Measured against the clean reference, the restored version is further from it than the source. This restoration made it worse.";
    case "MIXED": return "Mixed result against the clean reference: one of SNR and segmental SNR improved and the other did not.";
    case "NO_MEASURABLE_CHANGE": return "No measurable change against the clean reference (both SNR figures moved by less than 0.5 dB).";
    default: return "No clean reference was supplied, so quality is NOT measured and no improvement is claimed. The figures below are descriptive only.";
  }
}

export type AudioFailureTone = "denied" | "unknown" | "unavailable" | "invalid" | "stale";
export interface AudioFailure {
  readonly code: string;
  readonly tone: AudioFailureTone;
  readonly text: string;
}

/** Typed, plain-language description of a refusal. A refusal never implies that audio was produced. */
export function describeAudioFailure(error: unknown): AudioFailure {
  const host = error instanceof DevAudioHostError ? error
    : new DevAudioHostError("INVALID_RESPONSE", 0, error instanceof Error ? error.message : "Unexpected failure.");
  const code = host.code;
  if (host.status === 0 || code === "OUTCOME_UNKNOWN" || code === "AUDIO_RESTORATION_OUTCOME_UNKNOWN") {
    return { code, tone: "unknown", text: "The outcome is unknown: the engine did not confirm completion and nothing is claimed. "
      + "Press the button again; the same request identifier is reused so the host registers at most one restoration." };
  }
  switch (code) {
    case "AUDIO_PARAMETERS_INVALID":
      return { code, tone: "invalid", text: `${host.message} Nothing was processed.` };
    case "SOURCE_VERSION_STALE":
      return { code, tone: "stale", text: "That is not the current version of this artifact. Reload the artifact and use its current version. Nothing was processed." };
    case "SOURCE_VERSION_NOT_FOUND":
      return { code, tone: "denied", text: "This exact artifact version is not available to this DEV_ONLY principal. Nothing was processed." };
    case "RIGHTS_AUTHORITY_UNAVAILABLE":
      return { code, tone: "unavailable", text: "No rights and consent authority could be reached, so nothing was processed." };
    case "AUDIO_ENGINE_UNAVAILABLE":
      return { code, tone: "unavailable", text: "The local audio engine is not available on this host. Nothing was processed." };
    case "SPEECH_RUNTIME_UNAVAILABLE":
      return { code, tone: "unavailable", text: "The local speech recognizer is not available, so no transcript diff can be made. Nothing was registered." };
    case "COMPARISON_LINEAGE_MISMATCH":
      return { code, tone: "invalid", text: "The restored version is not a recorded restoration of that source version, so they cannot be compared. Nothing was registered." };
    case "COMPARISON_SHAPE_MISMATCH":
      return { code, tone: "invalid", text: "The compared versions differ in sample rate, channels or length. No alignment is guessed; nothing was registered." };
    case "AUDIO_REQUEST_ID_REUSED":
      return { code, tone: "invalid", text: "That request identifier was already used for a different request. Change an input and try again." };
    case "RENDER_CAPACITY_EXHAUSTED":
      return { code, tone: "unavailable", text: "The host is at capacity. Retry the same request after a short delay." };
    case "ARTIFACT_PERMISSION_REQUIRED":
      return { code, tone: "denied", text: "This identity lacks the artifact permissions needed for audio restoration." };
    default:
      if (code.startsWith("RIGHTS_DECISION_")) {
        return { code, tone: "denied", text: `Processing rights for this exact version are not admitted (${code.slice("RIGHTS_DECISION_".length).toLowerCase()}). Nothing was processed or registered.` };
      }
      return { code, tone: host.status >= 500 ? "unavailable" : "invalid", text: `${host.message || "The request failed."} Nothing was registered.` };
  }
}
