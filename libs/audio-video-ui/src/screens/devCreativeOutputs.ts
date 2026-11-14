/**
 * DEV_ONLY creative-output host boundary (audio repair, simulation, spatial GLB, reopen by id).
 *
 * The port is transport-neutral: a host adapter resolves with the exact HTTP status and JSON body for 2xx
 * responses and rejects with {@link DevCreativeHostError} for everything else (status 0 means the outcome is
 * unknown). Nothing here claims quality, measurement, approval, production rights or delivery: audio metrics are
 * engine sample statistics, simulation output is simulated model output, and the spatial rights decision is a
 * DEV_ONLY owner-scope visibility check with productionGrant=false.
 */

import type { DevArtifactContentReader } from "./devArtifactContent";

export interface DevCreativeHostResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DevAudioRepairRequest {
  readonly requestId: string;
  readonly source: { readonly artifactId: string; readonly artifactVersionId: string };
  readonly profile: { readonly threshold: number; readonly maxRunFrames: number };
}
export interface DevSimulationRequest {
  readonly requestId: string;
  readonly scenario: Readonly<Record<string, unknown>>;
}
export interface DevSpatialGlbRequest {
  readonly requestId: string;
  readonly rig: Readonly<Record<string, unknown>>;
}

export interface DevCreativeOutputsPort {
  repairAudio(request: DevAudioRepairRequest): Promise<DevCreativeHostResponse>;
  simulate(request: DevSimulationRequest): Promise<DevCreativeHostResponse>;
  exportSpatialGlb(request: DevSpatialGlbRequest): Promise<DevCreativeHostResponse>;
  getOutput(outputId: string): Promise<DevCreativeHostResponse>;
  /**
   * Optional readback of the registered simulation document (the observation series lives in the artifact bytes,
   * not in the creative-output view). A host without a DEV_ONLY content route omits this and the panel says so.
   */
  readSimulationDocument?(outputId: string): Promise<DevCreativeHostResponse>;
  /**
   * Optional exact-version content read (GET /dev/v1/artifacts/{id}/content). When present the panel reads the
   * simulation document through it with SHA-256 verification (preferred over readSimulationDocument) and offers
   * verified previews and downloads. A host without that route omits it.
   */
  readArtifactContent?: DevArtifactContentReader["readArtifactContent"];
}

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). */
export class DevCreativeHostError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DevCreativeHostError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export type CreativeKind = "AUDIO_REPAIR_CANDIDATE" | "SIMULATED_OUTPUT_NOT_MEASUREMENT" | "SPATIAL_GLB_EXPORT";
export const SIMULATED_LABEL = "SIMULATED_OUTPUT_NOT_MEASUREMENT";

export interface CreativeArtifact {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly sha256: string;
}
export interface Scalar { readonly name: string; readonly value: string }
export interface AudioDetails {
  readonly source: { readonly artifactId: string; readonly artifactVersionId: string; readonly sha256: string | null };
  readonly profile: { readonly threshold: number | null; readonly maxRunFrames: number | null };
  readonly comparisonEngine: string | null;
  /** Engine-reported values exactly as the host returned them, in host order. */
  readonly metrics: readonly Scalar[];
}
export interface SimulationDetails {
  readonly evidenceClass: string;
  readonly validationDisposition: string;
  readonly referenceAuthority: string | null;
  readonly inputReferences: readonly { readonly role: string; readonly identity: string; readonly sha256: string | null }[];
  readonly solverStats: readonly Scalar[];
  readonly scenarioSha256: string | null;
}
export interface SpatialDetails {
  readonly rigId: string | null;
  readonly sourceProjectRevisionRef: string | null;
  readonly sources: readonly { readonly artifactId: string; readonly artifactVersionId: string }[];
  readonly coordinateFrame: readonly Scalar[];
  readonly timeEncoding: string | null;
  readonly lossDisposition: string | null;
  readonly float32LossFields: readonly string[];
  readonly rights: { readonly authority: string; readonly outcome: string | null; readonly productionGrant: false };
}
export interface CreativeView {
  readonly outputId: string;
  readonly kind: CreativeKind;
  readonly requestId: string | null;
  readonly engine: string | null;
  readonly replayed: boolean;
  readonly artifact: CreativeArtifact;
  readonly note: string | null;
  readonly audio: AudioDetails | null;
  readonly simulation: SimulationDetails | null;
  readonly spatial: SpatialDetails | null;
}

const scalarText = (value: unknown): string | null =>
  value === null ? "null" : typeof value === "number" && Number.isFinite(value) ? String(value)
    : typeof value === "boolean" ? String(value) : typeof value === "string" ? value : null;
const scalars = (value: unknown): Scalar[] => isRecord(value)
  ? Object.entries(value).flatMap(([name, raw]) => { const text = scalarText(raw); return text === null ? [] : [{ name, value: text }]; })
  : [];

/** Accept a creative-output body only when it is internally consistent. Anything else is an invalid host response. */
export function parseCreativeView(raw: unknown, expected: { readonly kind?: CreativeKind; readonly audioSource?: DevAudioRepairRequest["source"] } = {}): CreativeView {
  if (!isRecord(raw) || raw.scope !== "DEV_ONLY") throw new Error("Creative output response is not a DEV_ONLY body.");
  const artifact = raw.artifact;
  const lineage = raw.lineage;
  if (!isRecord(artifact) || !isRecord(lineage)) throw new Error("Creative output response lacks artifact or lineage.");
  const outputId = str(raw.outputId);
  const artifactId = str(artifact.artifactId);
  const artifactVersionId = str(artifact.artifactVersionId);
  const sha256 = str(artifact.sha256);
  const contentType = str(artifact.contentType);
  if (!outputId || !artifactId || !artifactVersionId || !sha256 || !contentType || outputId !== artifactId || typeof raw.replayed !== "boolean") {
    throw new Error("Creative output artifact identity is inconsistent.");
  }
  const kind = lineage.kind;
  if (kind !== "AUDIO_REPAIR_CANDIDATE" && kind !== "SIMULATED_OUTPUT_NOT_MEASUREMENT" && kind !== "SPATIAL_GLB_EXPORT") {
    throw new Error("Creative output lineage names an unknown output kind.");
  }
  if (expected.kind !== undefined && kind !== expected.kind) throw new Error("Creative output kind does not match the request.");
  const view = {
    outputId, kind: kind as CreativeKind, requestId: str(lineage.requestId), engine: str(lineage.engine), replayed: raw.replayed,
    artifact: { artifactId, artifactVersionId, contentType, sizeBytes: finite(artifact.sizeBytes), sha256 },
    note: str(raw.note),
  };
  if (kind === "AUDIO_REPAIR_CANDIDATE") {
    const source = lineage.source; const profile = lineage.profile;
    if (!isRecord(source) || !isRecord(profile) || !isRecord(lineage.metrics)) throw new Error("Audio repair lineage is incomplete.");
    const sourceId = str(source.artifactId); const sourceVersion = str(source.artifactVersionId);
    if (!sourceId || !sourceVersion) throw new Error("Audio repair lineage lacks the exact source version.");
    if (sourceId === outputId) throw new Error("Audio repair output must be a new artifact, not the source.");
    if (expected.audioSource && (sourceId !== expected.audioSource.artifactId || sourceVersion !== expected.audioSource.artifactVersionId)) {
      throw new Error("Audio repair lineage does not name the exact source version that was requested.");
    }
    return { ...view, simulation: null, spatial: null, audio: {
      source: { artifactId: sourceId, artifactVersionId: sourceVersion, sha256: str(source.sha256) },
      profile: { threshold: finite(profile.threshold), maxRunFrames: finite(profile.maxRunFrames) },
      comparisonEngine: str(lineage.comparisonEngine), metrics: scalars(lineage.metrics),
    } };
  }
  if (kind === "SIMULATED_OUTPUT_NOT_MEASUREMENT") {
    const validation = lineage.validation;
    const evidenceClass = str(lineage.evidenceClass);
    if (!isRecord(validation) || validation.disposition !== "VALID" || !evidenceClass) {
      throw new Error("A registered simulation output must carry a VALID validation disposition.");
    }
    const refs = (Array.isArray(lineage.inputReferences) ? lineage.inputReferences : []).flatMap((entry) =>
      isRecord(entry) && str(entry.role) && str(entry.identity)
        ? [{ role: String(entry.role), identity: String(entry.identity), sha256: str(entry.sha256) }] : []);
    return { ...view, audio: null, spatial: null, simulation: {
      evidenceClass, validationDisposition: "VALID", referenceAuthority: str(validation.referenceAuthority),
      inputReferences: refs, solverStats: scalars(lineage.solverStats), scenarioSha256: str(lineage.scenarioSha256),
    } };
  }
  const rights = lineage.rightsDecision;
  if (!isRecord(rights) || rights.productionGrant !== false || !str(rights.authority)) {
    throw new Error("Host body did not carry a DEV_ONLY rights decision with productionGrant=false.");
  }
  const sources = (Array.isArray(lineage.sources) ? lineage.sources : []).flatMap((entry) =>
    isRecord(entry) && str(entry.artifactId) && str(entry.artifactVersionId)
      ? [{ artifactId: String(entry.artifactId), artifactVersionId: String(entry.artifactVersionId) }] : []);
  if (sources.length === 0) throw new Error("Spatial GLB lineage has no exact source versions.");
  const loss = lineage.float32LossFields;
  if (!Array.isArray(loss) || loss.some((entry) => typeof entry !== "string")) throw new Error("Spatial GLB lineage lacks float32LossFields.");
  return { ...view, audio: null, simulation: null, spatial: {
    rigId: str(lineage.rigId), sourceProjectRevisionRef: str(lineage.sourceProjectRevisionRef), sources,
    coordinateFrame: scalars(isRecord(lineage.coordinateFrame) ? { ...lineage.coordinateFrame, axisDirections: Array.isArray(lineage.coordinateFrame.axisDirections) ? lineage.coordinateFrame.axisDirections.join(", ") : undefined } : null),
    timeEncoding: str(lineage.timeEncoding), lossDisposition: str(lineage.lossDisposition), float32LossFields: loss as string[],
    rights: { authority: String(rights.authority), outcome: str(rights.outcome), productionGrant: false },
  } };
}

export interface SimulationRow {
  readonly time: number; readonly position: number; readonly velocity: number; readonly acceleration: number; readonly totalEnergy: number;
}
export interface SimulationDocument {
  readonly units: Readonly<Record<string, string>>;
  readonly disclaimer: string;
  readonly rows: readonly SimulationRow[];
}
/** Parse the registered simulation document; requires the not-a-measurement label and units for every column. */
export function parseSimulationDocument(raw: unknown): SimulationDocument {
  if (!isRecord(raw) || raw.scope !== "DEV_ONLY" || raw.outputKind !== SIMULATED_LABEL) throw new Error("Document is not a simulated-output document.");
  const units = isRecord(raw.units) ? raw.units : null;
  const disclaimer = str(raw.disclaimer);
  if (!units || !disclaimer || !Array.isArray(raw.observations) || raw.observations.length === 0) throw new Error("Simulation document is incomplete.");
  const unitMap: Record<string, string> = {};
  for (const column of ["time", "position", "velocity", "acceleration", "totalEnergy"]) {
    const unit = str(units[column]);
    if (!unit) throw new Error(`Simulation document lacks a unit for ${column}.`);
    unitMap[column] = unit;
  }
  const rows = raw.observations.map((entry): SimulationRow => {
    if (!isRecord(entry)) throw new Error("Simulation observation is malformed.");
    const time = finite(entry.time); const position = finite(entry.position); const velocity = finite(entry.velocity);
    const acceleration = finite(entry.acceleration); const totalEnergy = finite(entry.totalEnergy);
    if (time === null || position === null || velocity === null || acceleration === null || totalEnergy === null) throw new Error("Simulation observation has a non-finite value.");
    return { time, position, velocity, acceleration, totalEnergy };
  });
  return { units: unitMap, disclaimer, rows };
}

// ---------- typed outcomes ----------

export type OutcomeTone = "error" | "unknown" | "denied" | "unavailable";
export interface Finding { readonly reason: string; readonly subject: string; readonly detail: string }
export interface CreativeOutcome {
  readonly tone: OutcomeTone;
  readonly code: string;
  readonly text: string;
  /** Retrying with the same requestId is safe and is what the UI offers. */
  readonly retrySameRequest: boolean;
  /** The recorded requestId can no longer be reused with this payload. */
  readonly discardRequest: boolean;
  /** Simulation validator findings (REJECTED/ABSTAIN); no output exists. */
  readonly findings: readonly Finding[];
}

const UNKNOWN_TEXT = "The outcome is unknown. Retry with the same request identity; the engine is deterministic, so a duplicate returns the same artifact rather than a second one.";
const C422: Readonly<Record<string, string>> = {
  AUDIO_REPAIR_NOTHING_TO_REPAIR: "No clipped samples were found at this threshold, so no repair candidate exists. Nothing was registered. Try a lower threshold or a different source.",
  AUDIO_REPAIR_UNREPAIRABLE_RUN: "A clipped run is longer than the maxRunFrames bound, so the engine refused to guess. Nothing was registered. Raise maxRunFrames or choose another source.",
  AUDIO_REPAIR_INVALID_INPUT: "The engine refused the threshold or run bound. Nothing was registered.",
  SOURCE_FORMAT_NOT_SUPPORTED: "The source version is not a WAV file this lane can read. Nothing was registered.",
  SOURCE_AUDIO_INVALID: "The source is not a decodable WAV file. Nothing was registered.",
  AUDIO_FORMAT_NOT_SUPPORTED: "Only 16-bit PCM WAV is supported by this lane. Nothing was registered.",
  CREATIVE_LIMIT_EXCEEDED: "The request or output exceeds a DEV_ONLY size ceiling. Nothing was registered.",
  SIMULATION_SOLVER_ABSTAINED: "The bounded solver abstained within the declared step and iteration limits. No output was registered.",
  SIMULATION_INPUT_INVALID: "The engine rejected the scenario inputs (for example a unit that does not match its quantity). No output was registered.",
  SIMULATION_VALIDATION_REJECTED: "REJECTED: the simulated pass contradicts a declared invariant. No output was registered; the findings below say which.",
  SIMULATION_VALIDATION_ABSTAIN: "ABSTAIN: the validator could not validate this pass (for example no invariant was declared). No output was registered.",
  SPATIAL_RIG_INVALID: "The engine rejected the rig as invalid. Nothing was registered.",
};

function findingsOf(details: Readonly<Record<string, unknown>> | undefined): Finding[] {
  const raw = details?.findings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => isRecord(entry) && str(entry.reason)
    ? [{ reason: String(entry.reason), subject: typeof entry.subject === "string" ? entry.subject : "", detail: typeof entry.detail === "string" ? entry.detail : "" }] : []);
}

export function describeCreativeFailure(error: unknown): CreativeOutcome {
  const base = { retrySameRequest: false, discardRequest: false, findings: [] as Finding[] };
  if (!(error instanceof DevCreativeHostError)) {
    return { ...base, tone: "unknown", code: "OUTCOME_UNKNOWN", retrySameRequest: true, text: UNKNOWN_TEXT };
  }
  const { status, code } = error;
  if (status === 0 || code === "OUTCOME_UNKNOWN" || code === "INVALID_RESPONSE") {
    return { ...base, tone: "unknown", code, retrySameRequest: true, text: UNKNOWN_TEXT };
  }
  if (status === 409) {
    return { ...base, tone: "error", code, discardRequest: true,
      text: "CONFLICT: this request identity was already used for a different creative-output request. No second output was created. The next request will use a new identity." };
  }
  if (status === 422) {
    const text = C422[code] ?? (code.startsWith("SPATIAL_")
      ? `The spatial engine refused this rig (${code}). Nothing was registered.` : `The host refused this request (${code}). Nothing was registered.`);
    return { ...base, tone: "error", code, text, findings: findingsOf(error.details) };
  }
  if (status === 400) {
    return { ...base, tone: "error", code, text: `The host rejected the request shape (${code}): ${error.message}. Nothing was registered.` };
  }
  if (status === 403) {
    return { ...base, tone: "denied", code,
      text: "Denied: this DEV_ONLY principal lacks the artifact read and create permissions for this lane. Nothing was registered." };
  }
  if (status === 404) {
    return { ...base, tone: "error", code,
      text: code === "SOURCE_VERSION_NOT_FOUND"
        ? "An exact source artifact version is not available to this DEV_ONLY principal. Nothing was registered."
        : code === "CREATIVE_OUTPUT_NOT_FOUND" ? "That creative output is not available in this tenant and owner scope."
          : `Not found (${code}) in this owner scope.` };
  }
  if (status === 502 && code === "CREATIVE_OUTPUT_REGISTRATION_FAILED") {
    return { ...base, tone: "error", code, retrySameRequest: true,
      text: "The output was not registered as an artifact. Retry with the same request identity to resume; a duplicate never creates a second output." };
  }
  if (status === 503) {
    return { ...base, tone: "unavailable", code, retrySameRequest: true,
      text: "The DEV_ONLY creative-output host is unavailable or not enabled. No output exists." };
  }
  if (status >= 500) {
    return { ...base, tone: "unknown", code, retrySameRequest: true,
      text: `The host failed with ${code}; the outcome is unknown. Retry with the same request identity.` };
  }
  return { ...base, tone: "error", code, text: `The host refused this request (${status} ${code}). Nothing was changed.` };
}

// ---------- form validation and request builders ----------

export type Built<T> = { readonly ok: true; readonly request: T } | { readonly ok: false; readonly errors: readonly string[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
const INTEGER = /^[1-9][0-9]{0,8}$/u;

export function parseDecimal(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export interface AudioForm { readonly artifactId: string; readonly artifactVersionId: string; readonly threshold: string; readonly maxRunFrames: string }

/** The profile is explicit: nothing is defaulted here. Range checks mirror the engine and the host re-checks. */
export function buildAudioRepairRequest(form: AudioForm, requestId: string): Built<DevAudioRepairRequest> {
  const errors: string[] = [];
  const artifactId = form.artifactId.trim(); const artifactVersionId = form.artifactVersionId.trim();
  if (!ID.test(artifactId)) errors.push("Source artifact ID is required (letters, digits, . _ : -).");
  if (!ID.test(artifactVersionId)) errors.push("Exact source artifact version is required (for example sha256:...).");
  const threshold = parseDecimal(form.threshold);
  if (threshold === null || threshold < 0.5 || threshold > 1) errors.push("Threshold must be a number from 0.5 to 1.");
  const maxRunFrames = INTEGER.test(form.maxRunFrames.trim()) ? Number(form.maxRunFrames.trim()) : null;
  if (maxRunFrames === null) errors.push("Maximum clipped run (frames) must be a positive whole number.");
  if (errors.length > 0 || threshold === null || maxRunFrames === null) return { ok: false, errors };
  return { ok: true, request: { requestId, source: { artifactId, artifactVersionId }, profile: { threshold, maxRunFrames } } };
}

export type SimUnitGroup = "MASS" | "LENGTH" | "TIME" | "VELOCITY" | "FORCE" | "SPRING_CONSTANT" | "ENERGY";
export const SIM_UNITS: Readonly<Record<SimUnitGroup, readonly string[]>> = {
  MASS: ["KILOGRAM", "GRAM"], LENGTH: ["METER", "CENTIMETER"], TIME: ["SECOND", "MILLISECOND"],
  VELOCITY: ["METER_PER_SECOND"], FORCE: ["NEWTON", "MILLINEWTON"], SPRING_CONSTANT: ["NEWTON_PER_METER"], ENERGY: ["JOULE"],
};
export type SimModelType = "CONSTANT_FORCE" | "HARMONIC_SPRING";
export type SimObservable = "POSITION" | "VELOCITY" | "TOTAL_ENERGY";
export const OBSERVABLE_GROUP: Readonly<Record<SimObservable, SimUnitGroup>> = { POSITION: "LENGTH", VELOCITY: "VELOCITY", TOTAL_ENERGY: "ENERGY" };

export interface SimFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly group: SimUnitGroup;
  /** Measurements carry a value and a standard uncertainty; quantities carry a value only. */
  readonly measurement: boolean;
}
export const SIM_MODEL_FIELDS: Readonly<Record<SimModelType, readonly SimFieldSpec[]>> = {
  CONSTANT_FORCE: [
    { key: "mass", label: "Mass", group: "MASS", measurement: true },
    { key: "force", label: "Constant force", group: "FORCE", measurement: true },
  ],
  HARMONIC_SPRING: [
    { key: "mass", label: "Mass", group: "MASS", measurement: true },
    { key: "springConstant", label: "Spring constant", group: "SPRING_CONSTANT", measurement: true },
    { key: "equilibriumPosition", label: "Equilibrium position", group: "LENGTH", measurement: true },
  ],
};
export const SIM_COMMON_FIELDS: readonly SimFieldSpec[] = [
  { key: "initialPosition", label: "Initial position", group: "LENGTH", measurement: true },
  { key: "initialVelocity", label: "Initial velocity", group: "VELOCITY", measurement: true },
  { key: "duration", label: "Solver duration", group: "TIME", measurement: false },
  { key: "maxStep", label: "Maximum step", group: "TIME", measurement: false },
  { key: "minStep", label: "Minimum step", group: "TIME", measurement: false },
  { key: "absolutePositionTolerance", label: "Absolute position tolerance", group: "LENGTH", measurement: false },
  { key: "absoluteVelocityTolerance", label: "Absolute velocity tolerance", group: "VELOCITY", measurement: false },
  { key: "expectedDuration", label: "Expected duration", group: "TIME", measurement: false },
];

export interface SimFieldState { readonly value: string; readonly uncertainty: string; readonly unit: string }
export interface SimulationForm {
  readonly model: SimModelType;
  readonly fields: Readonly<Record<string, SimFieldState>>;
  readonly maxAcceptedSteps: string;
  readonly maxIterations: string;
  readonly invariantId: string;
  readonly invariantObservable: SimObservable;
  readonly invariantExpected: SimFieldState;
  readonly invariantTolerance: SimFieldState;
}

const emptyField = (group: SimUnitGroup): SimFieldState => ({ value: "", uncertainty: "", unit: SIM_UNITS[group][0]! });
export function emptySimulationForm(model: SimModelType = "CONSTANT_FORCE"): SimulationForm {
  const fields: Record<string, SimFieldState> = {};
  for (const spec of [...SIM_MODEL_FIELDS.HARMONIC_SPRING, ...SIM_MODEL_FIELDS.CONSTANT_FORCE, ...SIM_COMMON_FIELDS]) fields[spec.key] = emptyField(spec.group);
  return { model, fields, maxAcceptedSteps: "", maxIterations: "", invariantId: "", invariantObservable: "POSITION",
    invariantExpected: emptyField("LENGTH"), invariantTolerance: emptyField("LENGTH") };
}
/**
 * A documented worked example (constant 6 N on 2 kg from rest for 2 s, so the terminal position is 6 m). It is a
 * convenience the owner must choose; it is never applied implicitly.
 */
export function exampleSimulationForm(): SimulationForm {
  const f = (value: string, unit: string, uncertainty = "0"): SimFieldState => ({ value, uncertainty, unit });
  return {
    model: "CONSTANT_FORCE",
    fields: { ...emptySimulationForm().fields,
      mass: f("2", "KILOGRAM"), force: f("6", "NEWTON"), initialPosition: f("0", "METER"), initialVelocity: f("0", "METER_PER_SECOND"),
      duration: f("2", "SECOND"), maxStep: f("0.25", "SECOND"), minStep: f("0.00001", "SECOND"),
      absolutePositionTolerance: f("1e-8", "METER"), absoluteVelocityTolerance: f("1e-8", "METER_PER_SECOND"), expectedDuration: f("2", "SECOND") },
    maxAcceptedSteps: "100", maxIterations: "1000", invariantId: "terminal-position", invariantObservable: "POSITION",
    invariantExpected: f("6", "METER"), invariantTolerance: f("1e-8", "METER"),
  };
}

export function buildSimulationRequest(form: SimulationForm, requestId: string): Built<DevSimulationRequest> {
  const errors: string[] = [];
  const quantity = (label: string, state: SimFieldState): { value: number; unit: string } | null => {
    const value = parseDecimal(state.value);
    if (value === null) { errors.push(`${label}: enter a finite number.`); return null; }
    return { value, unit: state.unit };
  };
  const measurement = (label: string, state: SimFieldState): Record<string, unknown> | null => {
    const value = quantity(label, state);
    const uncertaintyValue = parseDecimal(state.uncertainty);
    if (uncertaintyValue === null || uncertaintyValue < 0) { errors.push(`${label} standard uncertainty: enter a number of at least 0 (the same unit).`); return null; }
    return value ? { value, standardUncertainty: { value: uncertaintyValue, unit: state.unit } } : null;
  };
  const model: Record<string, unknown> = { type: form.model };
  for (const spec of SIM_MODEL_FIELDS[form.model]) model[spec.key] = measurement(spec.label, form.fields[spec.key]!);
  const get = (key: string): SimFieldState => form.fields[key]!;
  const initialState = { position: measurement("Initial position", get("initialPosition")), velocity: measurement("Initial velocity", get("initialVelocity")) };
  const steps = INTEGER.test(form.maxAcceptedSteps.trim()) ? Number(form.maxAcceptedSteps.trim()) : null;
  const iterations = INTEGER.test(form.maxIterations.trim()) ? Number(form.maxIterations.trim()) : null;
  if (steps === null) errors.push("Maximum accepted steps must be a positive whole number.");
  if (iterations === null) errors.push("Maximum iterations must be a positive whole number.");
  const solverPolicy = { duration: quantity("Solver duration", get("duration")), maxStep: quantity("Maximum step", get("maxStep")),
    minStep: quantity("Minimum step", get("minStep")),
    absolutePositionTolerance: quantity("Absolute position tolerance", get("absolutePositionTolerance")),
    absoluteVelocityTolerance: quantity("Absolute velocity tolerance", get("absoluteVelocityTolerance")),
    maxAcceptedSteps: steps, maxIterations: iterations };
  const expectedDuration = quantity("Expected duration", get("expectedDuration"));
  const invariants: Record<string, unknown>[] = [];
  const invariantId = form.invariantId.trim();
  if (invariantId !== "") {
    if (!ID.test(invariantId)) errors.push("Invariant ID may use letters, digits, . _ : - only.");
    const expected = quantity("Invariant expected value", form.invariantExpected);
    const tolerance = quantity("Invariant tolerance", form.invariantTolerance);
    if (tolerance && tolerance.value < 0) errors.push("Invariant tolerance must be at least 0.");
    if (expected && tolerance) invariants.push({ id: invariantId, observable: form.invariantObservable, expected, absoluteTolerance: tolerance });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, request: { requestId, scenario: { model, initialState, solverPolicy, expectedDuration, invariants } } };
}

const HANDEDNESS = ["RIGHT_HANDED", "LEFT_HANDED"] as const;
const AXES = ["POS_X", "NEG_X", "POS_Y", "NEG_Y", "POS_Z", "NEG_Z"] as const;
const JOINTS = ["BALL"] as const;
const RIG_LIMIT = 4096;

/**
 * Client-side shape validation for the rig JSON. This mirrors the host's declared shape so a malformed rig is
 * refused locally; the engine still decides what it supports (frame, joint bounds, float32 time collapse, ...).
 */
export function buildSpatialGlbRequest(text: string, requestId: string): Built<DevSpatialGlbRequest> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, errors: ["Rig JSON could not be parsed."] }; }
  const errors: string[] = [];
  const exact = (value: unknown, required: readonly string[], optional: readonly string[], where: string): value is Json => {
    if (!isRecord(value)) { errors.push(`${where} must be an object.`); return false; }
    const keys = Object.keys(value);
    const missing = required.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !required.includes(key) && !optional.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      errors.push(`${where} fields do not match its declared shape${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}.`);
      return false;
    }
    return true;
  };
  const numbers = (value: unknown, size: number, where: string): void => {
    if (!Array.isArray(value) || value.length !== size || value.some((entry) => finite(entry) === null)) errors.push(`${where} must be ${size} finite numbers.`);
  };
  const pose = (value: unknown, where: string): void => {
    if (!exact(value, ["position", "orientation"], [], where)) return;
    numbers(value.position, 3, `${where}.position`); numbers(value.orientation, 4, `${where}.orientation`);
  };
  const placeholder = (value: string): boolean => value.startsWith("<");
  const rig = parsed;
  if (exact(rig, ["id", "coordinateFrame", "sourceVersions", "bones", "tracks"], ["sourceProjectRevisionRef"], "rig")) {
    if (!str(rig.id) || !ID.test(String(rig.id))) errors.push("rig.id is required (letters, digits, . _ : -).");
    if (rig.sourceProjectRevisionRef !== undefined && !str(rig.sourceProjectRevisionRef)) errors.push("rig.sourceProjectRevisionRef must be a non-empty string when given.");
    const frame = rig.coordinateFrame;
    if (exact(frame, ["frameRef", "frameVersionRef", "handedness", "axisDirections", "positionUnitRef", "orientationUnitRef"], [], "rig.coordinateFrame")) {
      for (const key of ["frameRef", "frameVersionRef", "positionUnitRef", "orientationUnitRef"]) if (!str(frame[key])) errors.push(`rig.coordinateFrame.${key} must be a non-empty string.`);
      if (!HANDEDNESS.includes(frame.handedness as never)) errors.push(`rig.coordinateFrame.handedness must be one of ${HANDEDNESS.join(", ")}.`);
      if (!Array.isArray(frame.axisDirections) || frame.axisDirections.length !== 3 || frame.axisDirections.some((axis) => !AXES.includes(axis as never))) {
        errors.push(`rig.coordinateFrame.axisDirections must list x, y and z from ${AXES.join(", ")}.`);
      }
    }
    if (!Array.isArray(rig.sourceVersions) || rig.sourceVersions.length === 0 || rig.sourceVersions.length > RIG_LIMIT) {
      errors.push("rig.sourceVersions must list at least one exact owner artifact version.");
    } else {
      rig.sourceVersions.forEach((entry, index) => {
        if (!exact(entry, ["artifactId", "artifactVersionId"], [], `rig.sourceVersions[${index}]`)) return;
        if (!str(entry.artifactId) || !str(entry.artifactVersionId) || placeholder(String(entry.artifactId)) || placeholder(String(entry.artifactVersionId))) {
          errors.push(`rig.sourceVersions[${index}] needs a real artifactId and artifactVersionId.`);
        }
      });
    }
    if (!Array.isArray(rig.bones) || rig.bones.length === 0 || rig.bones.length > RIG_LIMIT) errors.push("rig.bones must list at least one bone.");
    else rig.bones.forEach((bone, index) => {
      const where = `rig.bones[${index}]`;
      if (!exact(bone, ["id", "restPose", "constraint"], ["parentId"], where)) return;
      if (!str(bone.id)) errors.push(`${where}.id must be a non-empty string.`);
      if (bone.parentId !== undefined && bone.parentId !== null && !str(bone.parentId)) errors.push(`${where}.parentId must be a non-empty string or omitted.`);
      pose(bone.restPose, `${where}.restPose`);
      if (exact(bone.constraint, ["kind", "maxAngularDeviationRadians"], [], `${where}.constraint`)) {
        if (!JOINTS.includes(bone.constraint.kind as never)) errors.push(`${where}.constraint.kind must be one of ${JOINTS.join(", ")}.`);
        if (finite(bone.constraint.maxAngularDeviationRadians) === null) errors.push(`${where}.constraint.maxAngularDeviationRadians must be a finite number.`);
      }
    });
    if (!isRecord(rig.tracks)) errors.push("rig.tracks must be an object keyed by bone id.");
    else for (const [boneId, keys] of Object.entries(rig.tracks)) {
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > RIG_LIMIT) { errors.push(`rig.tracks.${boneId} must list keyframes.`); continue; }
      keys.forEach((key, index) => {
        const where = `rig.tracks.${boneId}[${index}]`;
        if (!exact(key, ["time", "pose"], [], where)) return;
        if (exact(key.time, ["numerator", "denominator"], [], `${where}.time`)) {
          const n = key.time.numerator; const d = key.time.denominator;
          if (!Number.isSafeInteger(n) || (n as number) < 0 || !Number.isSafeInteger(d) || (d as number) < 1) errors.push(`${where}.time must be an exact rational (non-negative integer numerator, positive integer denominator).`);
        }
        pose(key.pose, `${where}.pose`);
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 12) };
  return { ok: true, request: { requestId, rig: rig as Json } };
}

/** An illustrative rig with placeholder source ids; client validation refuses it until real ids replace them. */
export const SPATIAL_RIG_TEMPLATE = JSON.stringify({
  id: "rig-1",
  sourceProjectRevisionRef: "project:edit:revision-1",
  coordinateFrame: { frameRef: "urn:media:frame:glb", frameVersionRef: "v1", handedness: "RIGHT_HANDED", axisDirections: ["POS_X", "POS_Y", "POS_Z"],
    positionUnitRef: "urn:media:spatial:unit:metre:v1", orientationUnitRef: "urn:media:spatial:orientation:unit-quaternion-xyzw:v1" },
  sourceVersions: [{ artifactId: "<owner-artifact-id>", artifactVersionId: "<exact-version-id>" }],
  bones: [{ id: "root", restPose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] }, constraint: { kind: "BALL", maxAngularDeviationRadians: 3.14159 } }],
  tracks: { root: [
    { time: { numerator: 0, denominator: 1 }, pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] } },
    { time: { numerator: 1, denominator: 1 }, pose: { position: [1, 0, 0], orientation: [0, 0, 0, 1] } },
  ] },
}, null, 2);
