/**
 * DEV_ONLY stems, foley, mix and master host boundary (J-17) and the authoring model.
 *
 * The author builds ORIGINAL procedural stems (tones, chords, drum hits, noise foley) and places them, with uploaded stems that
 * carry a processing rights statement, on a timeline; the host mixes and masters to a loudness target under a true-peak ceiling.
 * {@link toStemRequestSpec} and {@link toMasterRequest} turn the form state into the host's request shapes without guessing: a value
 * that is not a finite number is reported with its JSON path and nothing is sent. The host stays the only authority (strict
 * keys, budgets, rights, DSP). Every number shown as a result is the host's measurement on the output samples.
 */

import type { DevArtifactContentReader, RegisteredArtifact } from "./devArtifactContent";

export interface DevMasterHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevMasterPort {
  getStatus(): Promise<DevMasterHostResponse>;
  generateStem(request: { readonly requestId: string; readonly spec: Readonly<Record<string, unknown>> }): Promise<DevMasterHostResponse>;
  master(request: Readonly<Record<string, unknown>>): Promise<DevMasterHostResponse>;
  /** Optional exact-version content read; without it the master cannot be played on this page. */
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevMasterHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevMasterHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

// ---------------------------------------------------------------------------------------------- status

export interface MasterStatus {
  readonly stemReady: boolean;
  readonly masterReady: boolean;
  readonly maxStemMs: number;
  readonly minStemMs: number;
  readonly maxPlacements: number;
  readonly maxMasterFrames: number;
  readonly sampleRateHz: number;
  readonly drums: readonly string[];
  readonly foley: readonly string[];
  readonly defaultLufs: number;
  readonly defaultCeiling: number;
}

export function parseMasterStatus(response: DevMasterHostResponse): MasterStatus {
  const bad = (): never => { throw new DevMasterHostError("INVALID_RESPONSE", response.status, "The host returned an invalid master status."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.limits) || !isRecord(body.generators) || !isRecord(body.target)) return bad();
  const limits = body.limits;
  const number = (value: unknown): number => finite(value) ?? bad();
  const strings = (value: unknown): string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] as string[] : bad();
  const lufs = isRecord(body.target.integratedLufs) ? body.target.integratedLufs : {};
  const ceiling = isRecord(body.target.truePeakDbtp) ? body.target.truePeakDbtp : {};
  return {
    stemReady: body.stemReady === true, masterReady: body.masterReady === true,
    maxStemMs: number(limits.maxStemMs), minStemMs: number(limits.minStemMs), maxPlacements: number(limits.maxPlacements),
    maxMasterFrames: number(limits.maxMasterFrames), sampleRateHz: number(limits.sampleRateHz),
    drums: strings(body.generators.drums), foley: strings(body.generators.foley),
    defaultLufs: finite(lufs.default) ?? -16, defaultCeiling: finite(ceiling.default) ?? -1,
  };
}

// ---------------------------------------------------------------------------------------------- views

function parseArtifact(value: unknown): RegisteredArtifact | null {
  if (!isRecord(value)) return null;
  const artifactId = str(value.artifactId);
  const artifactVersionId = str(value.artifactVersionId);
  const contentType = str(value.contentType);
  const sha256 = str(value.sha256);
  if (!artifactId || !artifactVersionId || !contentType || !sha256 || !/^[0-9a-f]{64}$/u.test(sha256)) return null;
  return { artifactId, artifactVersionId, contentType, sizeBytes: finite(value.sizeBytes), sha256 };
}

export interface StemView {
  readonly artifact: RegisteredArtifact;
  readonly kind: string;
  readonly durationMs: number;
  readonly channels: number;
  readonly samplePeakDbfs: number | null;
  readonly generatorSpecSha256: string;
  readonly replayed: boolean;
}

export function parseStemView(response: DevMasterHostResponse): StemView {
  const bad = (): never => { throw new DevMasterHostError("INVALID_RESPONSE", response.status, "The host returned an invalid stem."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.lineage)) return bad();
  const artifact = parseArtifact(body.artifact) ?? bad();
  const spec = isRecord(body.lineage.generatorSpec) ? body.lineage.generatorSpec : bad();
  const measurement = isRecord(body.lineage.measurement) ? body.lineage.measurement : {};
  return {
    artifact, kind: str(spec.kind) ?? bad(), durationMs: finite(spec.durationMs) ?? bad(), channels: finite(spec.channels) ?? bad(),
    samplePeakDbfs: finite(measurement.samplePeakDbfs), generatorSpecSha256: str(body.lineage.generatorSpecSha256) ?? bad(),
    replayed: body.replayed === true,
  };
}

export interface MasterStemLine {
  readonly index: number;
  readonly artifactId: string;
  readonly origin: string;
  readonly channels: number;
  readonly frames: number;
  readonly gainDb: number;
  readonly pan: number;
  readonly startFrame: number;
  readonly fadeInFrames: number;
  readonly fadeOutFrames: number;
}

export interface MasterView {
  readonly masterId: string;
  readonly wav: RegisteredArtifact;
  readonly flac: RegisteredArtifact;
  readonly reportArtifact: RegisteredArtifact;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly target: { readonly integratedLufs: number; readonly truePeakDbtp: number };
  readonly measurement: {
    readonly integratedLufs: number; readonly truePeakDbtp: number; readonly samplePeakDbfs: number; readonly clippedSamples: number;
    readonly preLimiterGainDb: number; readonly maxGainReductionDb: number; readonly limitedFrames: number; readonly targetMet: boolean;
    readonly mixIntegratedLufs: number;
  };
  readonly stems: readonly MasterStemLine[];
  readonly flacVerification: string;
  readonly uploadedStems: number;
  readonly originalStems: number;
  readonly replayed: boolean;
}

export function parseMasterView(response: DevMasterHostResponse): MasterView {
  const bad = (): never => { throw new DevMasterHostError("INVALID_RESPONSE", response.status, "The host returned an invalid master."); };
  const body = response.body;
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.report)) return bad();
  const report = body.report;
  const number = (value: unknown): number => finite(value) ?? bad();
  const target = isRecord(report.target) ? report.target : bad();
  const m = isRecord(report.measurement) ? report.measurement : bad();
  const limiter = isRecord(m.limiter) ? m.limiter : bad();
  const mix = isRecord(m.mix) ? m.mix : bad();
  const format = isRecord(report.format) ? report.format : bad();
  const outputs = isRecord(report.outputs) ? report.outputs : bad();
  const flac = isRecord(outputs.flac) ? outputs.flac : bad();
  const rights = isRecord(report.rightsDecision) ? report.rightsDecision : bad();
  const stems = Array.isArray(report.stems) ? report.stems : bad();
  return {
    masterId: str(body.masterId) ?? bad(), wav: parseArtifact(body.wav) ?? bad(), flac: parseArtifact(body.flac) ?? bad(),
    reportArtifact: parseArtifact(body.reportArtifact) ?? bad(), frames: number(format.frames), durationSeconds: number(format.durationSeconds),
    target: { integratedLufs: number(target.integratedLufs), truePeakDbtp: number(target.truePeakDbtp) },
    measurement: {
      integratedLufs: number(m.integratedLufs), truePeakDbtp: number(m.truePeakDbtp), samplePeakDbfs: number(m.samplePeakDbfs),
      clippedSamples: number(m.clippedSamples), preLimiterGainDb: number(m.preLimiterGainDb), maxGainReductionDb: number(limiter.maxGainReductionDb),
      limitedFrames: number(limiter.limitedFrames), targetMet: m.targetMet === true, mixIntegratedLufs: number(mix.integratedLufs),
    },
    stems: stems.map((entry): MasterStemLine => {
      const s = isRecord(entry) ? entry : bad();
      return { index: number(s.index), artifactId: str(s.artifactId) ?? bad(), origin: str(s.origin) ?? bad(), channels: number(s.channels),
        frames: number(s.frames), gainDb: number(s.gainDb), pan: number(s.pan), startFrame: number(s.startFrame),
        fadeInFrames: number(s.fadeInFrames), fadeOutFrames: number(s.fadeOutFrames) };
    }),
    flacVerification: str(flac.verification) ?? "", uploadedStems: number(rights.uploadedStems), originalStems: number(rights.originalProceduralStems),
    replayed: body.replayed === true,
  };
}

// ---------------------------------------------------------------------------------------------- failures

export interface MasterFailure {
  readonly code: string;
  readonly tone: "invalid" | "budget" | "denied" | "notFound" | "conflict" | "unknown" | "unavailable" | "abstained";
  readonly path: string | null;
  readonly text: string;
}

export function describeMasterFailure(error: unknown): MasterFailure {
  const host = error instanceof DevMasterHostError ? error
    : new DevMasterHostError("INVALID_RESPONSE", 0, error instanceof Error ? error.message : "Unexpected failure.");
  const code = host.code;
  const path = str(host.details?.path);
  if (host.status === 0 || code === "OUTCOME_UNKNOWN" || code === "MASTER_OUTCOME_UNKNOWN") {
    return { code, tone: "unknown", path: null, text: "The outcome is unknown: nothing was confirmed and nothing is claimed. Press the button again; "
      + "the same request identifier is reused so the host never creates a second output." };
  }
  switch (code) {
    case "MASTER_PARAMETERS_INVALID":
      return { code, tone: "invalid", path, text: `The request is not valid${path ? ` at ${path}` : ""}: ${host.message} Nothing was processed.` };
    case "STEM_FORMAT_NOT_SUPPORTED":
      return { code, tone: "invalid", path, text: `${host.message}${path ? ` (${path})` : ""} Only 48 kHz, 16-bit, mono or stereo WAV stems are accepted; nothing is resampled or down-mixed.` };
    case "MASTER_BUDGET_EXCEEDED": {
      const requested = finite(host.details?.requested);
      const ceiling = finite(host.details?.ceiling);
      const limit = str(host.details?.limit);
      return { code, tone: "budget", path, text: `${limit ?? "A value"} is over its ceiling${ceiling !== null ? ` of ${ceiling}` : ""}${requested !== null ? ` (requested ${requested})` : ""}${path ? ` at ${path}` : ""}. Nothing was processed.` };
    }
    case "MASTER_TOO_SHORT_TO_MEASURE":
      return { code, tone: "invalid", path, text: "The master is shorter than 400 milliseconds, so it has no defined integrated loudness. Make it longer." };
    case "MASTER_STEM_PAST_END":
      return { code, tone: "invalid", path, text: "A stem extends past the master length. Nothing is trimmed implicitly; lengthen the master or move the stem." };
    case "MASTER_LOUDNESS_TARGET_UNREACHABLE": {
      const reason = str(host.details?.reason);
      const why = reason === "SILENT_INPUT" ? "The mix is silent, so a loudness target cannot be reached without unbounded gain."
        : reason === "GAIN_CAP" ? "Reaching the target would need more gain than the host allows."
          : "The true-peak ceiling keeps this mix from reaching the target.";
      return { code, tone: "abstained", path: null, text: `The host abstained: ${why} No master was produced.` };
    }
    case "RIGHTS_NOT_ADMITTED": {
      const verdict = str(host.details?.verdict);
      return { code, tone: "denied", path, text: `An uploaded stem${path ? ` (${path})` : ""} has no current processing rights admission${verdict ? ` (${verdict})` : ""}. `
        + "The uploader must state rights for this exact version first. Nothing was read, mixed or registered." };
    }
    case "RIGHTS_AUTHORITY_UNAVAILABLE":
      return { code, tone: "unavailable", path, text: "The rights authority is not available on this host, so uploaded stems cannot be admitted. Nothing was mixed." };
    case "SOURCE_VERSION_NOT_FOUND":
      return { code, tone: "notFound", path: null, text: "The exact stem artifact version is not available to this identity. Nothing was mixed." };
    case "MASTER_REQUEST_ID_REUSED":
      return { code, tone: "conflict", path: null, text: "This request identifier was already used for a different request. Change the request back or press the button again for a new identifier." };
    case "RENDER_CAPACITY_EXHAUSTED":
      return { code, tone: "unavailable", path: null, text: "The host is at its capacity. Nothing was processed; try again shortly." };
    case "ARTIFACT_PERMISSION_REQUIRED":
      return { code, tone: "denied", path: null, text: "This identity lacks the artifact read and create permissions required here." };
    case "AUDIO_ENGINE_UNAVAILABLE":
      return { code, tone: "unavailable", path: null, text: "The audio encoder is not configured on this host. Stems can be built but not mastered." };
    default:
      return { code, tone: "unavailable", path, text: `${host.message || "The request failed."} Nothing was confirmed.` };
  }
}

// ---------------------------------------------------------------------------------------------- authoring

export type StemKind = "TONE" | "CHORD" | "DRUM" | "FOLEY";
export const STEM_KINDS: readonly StemKind[] = ["TONE", "CHORD", "DRUM", "FOLEY"];

export interface AuthoredStem {
  kind: StemKind;
  durationMs: string;
  channels: string;
  amplitudeDb: string;
  frequencyHz: string;
  frequenciesHz: string;
  drum: string;
  foley: string;
  seed: string;
}

export const blankStem = (): AuthoredStem => ({ kind: "TONE", durationMs: "1000", channels: "1", amplitudeDb: "-6", frequencyHz: "440",
  frequenciesHz: "261.63, 329.63, 392", drum: "KICK", foley: "FOOTSTEP", seed: "1" });

export interface Problem { readonly path: string; readonly message: string }

const num = (text: string, path: string, problems: Problem[], integer = false): number => {
  const trimmed = text.trim();
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    problems.push({ path, message: integer ? "Enter a whole number." : "Enter a number." });
    return 0;
  }
  return value;
};

export function toStemRequestSpec(a: AuthoredStem): { readonly spec: Record<string, unknown>; readonly problems: readonly Problem[] } {
  const problems: Problem[] = [];
  const spec: Record<string, unknown> = {
    kind: a.kind, durationMs: num(a.durationMs, "$.spec.durationMs", problems, true), channels: num(a.channels, "$.spec.channels", problems, true),
    amplitudeDb: num(a.amplitudeDb, "$.spec.amplitudeDb", problems),
  };
  if (a.kind === "TONE") spec.frequencyHz = num(a.frequencyHz, "$.spec.frequencyHz", problems);
  if (a.kind === "CHORD") {
    spec.frequenciesHz = a.frequenciesHz.split(",").map((part, index) => num(part, `$.spec.frequenciesHz[${index}]`, problems));
  }
  if (a.kind === "DRUM") { spec.drum = a.drum; spec.seed = num(a.seed, "$.spec.seed", problems, true); }
  if (a.kind === "FOLEY") { spec.foley = a.foley; spec.seed = num(a.seed, "$.spec.seed", problems, true); }
  return { spec, problems };
}

export interface AuthoredPlacement {
  artifactId: string;
  artifactVersionId: string;
  label: string;
  gainDb: string;
  pan: string;
  startFrame: string;
  fadeInFrames: string;
  fadeOutFrames: string;
}

export const blankPlacement = (artifactId = "", artifactVersionId = "", label = ""): AuthoredPlacement => ({
  artifactId, artifactVersionId, label, gainDb: "0", pan: "0", startFrame: "0", fadeInFrames: "0", fadeOutFrames: "0" });

export interface AuthoredMaster {
  placements: AuthoredPlacement[];
  durationFrames: string;
  targetLufs: string;
  truePeakDbtp: string;
}

export function toMasterRequest(a: AuthoredMaster): { readonly request: Record<string, unknown>; readonly problems: readonly Problem[] } {
  const problems: Problem[] = [];
  const stems = a.placements.map((p, i) => {
    const base = `$.stems[${i}]`;
    return {
      artifactId: p.artifactId.trim(), artifactVersionId: p.artifactVersionId.trim(),
      gainDb: num(p.gainDb, `${base}.gainDb`, problems), pan: num(p.pan, `${base}.pan`, problems),
      startFrame: num(p.startFrame, `${base}.startFrame`, problems, true), fadeInFrames: num(p.fadeInFrames, `${base}.fadeInFrames`, problems, true),
      fadeOutFrames: num(p.fadeOutFrames, `${base}.fadeOutFrames`, problems, true),
    };
  });
  const request: Record<string, unknown> = {
    stems,
    target: { integratedLufs: num(a.targetLufs, "$.target.integratedLufs", problems), truePeakDbtp: num(a.truePeakDbtp, "$.target.truePeakDbtp", problems) },
  };
  if (a.durationFrames.trim() !== "") request.durationFrames = num(a.durationFrames, "$.durationFrames", problems, true);
  return { request, problems };
}
