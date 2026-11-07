/**
 * H-03: data-driven unattended scenario runner for headless recording.
 *
 * A scenario declares typed actors, scenes, source refs, timed narration,
 * captions and track refs. `orchestrateScenario` produces a deterministic
 * run plan: identical scenarios yield identical lineage, and a changed
 * scene re-plans only that scene's lineage. Dry-run is the default — the
 * runner never dispatches capture, browser or user actions; every capture
 * step is gated on the trusted eligibility seam from capture-adapters.
 */

import {
  CaptureNotAdmittedError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureAdapterEligibility,
  type CaptureRequest,
  type CapturedFrame,
} from "./capture-adapters.js";
import {
  MediaOperationAmbiguousError,
  type MediaOperationClient,
  type CanonicalMediaArtifactObservation,
  type CanonicalMediaClassification,
  type CanonicalMediaUploadSessionObservation,
} from "./operations.js";

export interface ScenarioActor {
  readonly actorId: string;
  readonly role: string;
}

export interface NarrationCue {
  readonly atMillis: number;
  readonly trackRef: string;
}

export interface ScenarioScene {
  readonly sceneId: string;
  /** Exact source, purpose, immutable version, controlled-secret and clock refs. */
  readonly sourceRef: CaptureRequest;
  readonly actorRefs: readonly string[];
  readonly narration: readonly NarrationCue[];
  readonly captionRefs: readonly string[];
  readonly durationMillis: number;
}

export interface Scenario {
  readonly scenarioId: string;
  readonly revision: string;
  readonly actors: readonly ScenarioActor[];
  readonly scenes: readonly ScenarioScene[];
}

export interface SceneRun {
  readonly sceneId: string;
  readonly sourceRevision: string;
  /** Stable declared identity: scenario+scene+source revision, not a content digest. */
  readonly lineageId: string;
  readonly capturePlan: CaptureRequest;
  readonly durationMillis: number;
  /** Exact actor identity/role bindings used by this scene. */
  readonly actorBindings: readonly ScenarioActor[];
  readonly narration: readonly NarrationCue[];
  readonly captionRefs: readonly string[];
}

export interface OrchestrationResult {
  readonly scenarioId: string;
  readonly revision: string;
  /** Deterministic bounded descriptor of the complete plan; not a content digest or proof. */
  readonly planIdentity: string;
  readonly sceneRuns: readonly SceneRun[];
  /** Always true: orchestration plans; it never performs effects. */
  readonly dryRunOnly: true;
}

export class ScenarioError extends Error {
  public constructor(code: "INVALID_SCENARIO" | "ACTOR_UNRESOLVED", message: string) {
    super(message);
    this.name = "ScenarioError";
    this.code = code;
  }
  public readonly code: "INVALID_SCENARIO" | "ACTOR_UNRESOLVED";
}

const MAX_SCENES = 256;
const MAX_ACTORS = 64;
const MAX_SCENE_ACTOR_REFS = MAX_ACTORS;
const MAX_SCENE_NARRATION_CUES = 256;
const MAX_SCENE_CAPTION_REFS = 256;
const MAX_PLAN_IDENTITY_CHARS = 1_048_576;
const CAPTURE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "BROWSER", "DESKTOP", "MOBILE", "TERMINAL", "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE",
]);

function requireText(value: string | undefined, field: string): string {
  if (value === undefined || typeof value !== "string"
    || value.trim().length === 0 || value.length > 384 || value !== value.trim()) {
    throw new ScenarioError("INVALID_SCENARIO", `${field} is required, canonical and bounded`);
  }
  return value;
}

function requireTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ScenarioError("INVALID_SCENARIO", `${field} must be an array`);
  }
  return value.map((entry: unknown, index: number) =>
    requireText(entry as string | undefined, `${field}[${index}]`));
}

/** Deterministic lineage: scenario identity + scene identity + revision. */
function lineageId(scenarioId: string, sceneId: string, source: CaptureRequest): string {
  // JSON tuple encoding is unambiguous even when caller ids contain separators.
  return `media.scene-lineage.v1:${JSON.stringify([
    scenarioId, sceneId, source.kind, source.sourceIdentity, source.sourceVersionRef,
  ])}`;
}

/**
 * Validates a scenario and emits the deterministic run plan. Actor refs must
 * resolve; scene order is the declared order (no reordering), and every
 * scene's lineage binds its exact source revision — two identical runs
 * produce identical lineage ids, and a bumped scene revision changes only
 * that scene's lineage.
 */
export function orchestrateScenario(scenario: Scenario): OrchestrationResult {
  if (!scenario || typeof scenario !== "object") {
    throw new ScenarioError("INVALID_SCENARIO", "scenario is required");
  }
  const scenarioId = requireText(scenario.scenarioId, "scenarioId");
  const revision = requireText(scenario.revision, "revision");
  if (!Array.isArray(scenario.actors) || scenario.actors.length > MAX_ACTORS) {
    throw new ScenarioError("INVALID_SCENARIO", `actors must contain 0..${MAX_ACTORS}`);
  }
  if (!Array.isArray(scenario.scenes) || scenario.scenes.length < 1
    || scenario.scenes.length > MAX_SCENES) {
    throw new ScenarioError("INVALID_SCENARIO", `scenes must contain 1..${MAX_SCENES}`);
  }
  const actorsById = new Map<string, ScenarioActor>();
  for (const actor of scenario.actors) {
    if (!actor || typeof actor !== "object") {
      throw new ScenarioError("INVALID_SCENARIO", "actors entries must be objects");
    }
    const actorId = requireText(actor.actorId, "actorId");
    const role = requireText(actor.role, "actor.role");
    if (actorsById.has(actorId)) {
      throw new ScenarioError("INVALID_SCENARIO", `duplicate actorId: ${actorId}`);
    }
    actorsById.set(actorId, { actorId, role });
  }
  const seenSceneIds = new Set<string>();
  const identityPrefix = `media.scenario-plan.v1:[${JSON.stringify(scenarioId)},${JSON.stringify(revision)},[`;
  const identitySuffix = "]]";
  const sceneRuns: SceneRun[] = [];
  const sceneDescriptors: string[] = [];
  let planIdentityLength = identityPrefix.length + identitySuffix.length;

  for (const [index, scene] of scenario.scenes.entries()) {
    if (!scene || typeof scene !== "object") {
      throw new ScenarioError("INVALID_SCENARIO", `scenes[${index}] must be an object`);
    }
    const sceneId = requireText(scene.sceneId, `scenes[${index}].sceneId`);
    if (seenSceneIds.has(sceneId)) {
      throw new ScenarioError("INVALID_SCENARIO", `duplicate sceneId: ${sceneId}`);
    }
    seenSceneIds.add(sceneId);
    if (!scene.sourceRef || typeof scene.sourceRef !== "object") {
      throw new ScenarioError("INVALID_SCENARIO", `scenes[${index}].sourceRef must be an object`);
    }
    const sourceRef: CaptureRequest = {
      kind: scene.sourceRef.kind,
      sourceIdentity: requireText(scene.sourceRef.sourceIdentity, `scenes[${index}].sourceRef.sourceIdentity`),
      purposeRef: requireText(scene.sourceRef.purposeRef, `scenes[${index}].sourceRef.purposeRef`),
      exactRightsScope: requireText(scene.sourceRef.exactRightsScope,
        `scenes[${index}].sourceRef.exactRightsScope`),
      sourceVersionRef: requireText(scene.sourceRef.sourceVersionRef, `scenes[${index}].sourceRef.sourceVersionRef`),
      secretsRef: requireText(scene.sourceRef.secretsRef, `scenes[${index}].sourceRef.secretsRef`),
      frameClockRef: requireText(scene.sourceRef.frameClockRef, `scenes[${index}].sourceRef.frameClockRef`),
    };
    if (!CAPTURE_SOURCE_KINDS.has(sourceRef.kind)) {
      throw new ScenarioError("INVALID_SCENARIO",
        `scenes[${index}].sourceRef.kind is outside the supported capture source enum`);
    }
    const sourceRevision = sourceRef.sourceVersionRef;
    const sceneActorIds = new Set<string>();
    const actorRefs = scene.actorRefs === undefined ? []
      : requireTextArray(scene.actorRefs, `scenes[${index}].actorRefs`);
    if (actorRefs.length > MAX_SCENE_ACTOR_REFS) {
      throw new ScenarioError("INVALID_SCENARIO",
        `scene ${sceneId} actorRefs must contain at most ${MAX_SCENE_ACTOR_REFS}`);
    }
    const actorBindings = actorRefs.map((actorRef: string) => {
      if (sceneActorIds.has(actorRef)) {
        throw new ScenarioError("INVALID_SCENARIO",
          `scene ${sceneId} contains duplicate actorRef: ${actorRef}`);
      }
      sceneActorIds.add(actorRef);
      const actor = actorsById.get(actorRef);
      if (!actor) {
        throw new ScenarioError("ACTOR_UNRESOLVED",
          `scene ${sceneId} references undeclared actor ${actorRef}`);
      }
      return actor;
    });
    if (!Number.isSafeInteger(scene.durationMillis) || scene.durationMillis < 1
      || scene.durationMillis > 3_600_000) {
      throw new ScenarioError("INVALID_SCENARIO",
        `scene ${sceneId} durationMillis must be 1..3600000`);
    }
    const narrationEntries = scene.narration === undefined ? [] : scene.narration;
    if (!Array.isArray(narrationEntries)) {
      throw new ScenarioError("INVALID_SCENARIO", `scenes[${index}].narration must be an array`);
    }
    if (narrationEntries.length > MAX_SCENE_NARRATION_CUES) {
      throw new ScenarioError("INVALID_SCENARIO",
        `scene ${sceneId} narration must contain at most ${MAX_SCENE_NARRATION_CUES} cues`);
    }
    const narration = narrationEntries.map((cue: NarrationCue, cueIndex: number) => {
      if (!cue || typeof cue !== "object") {
        throw new ScenarioError("INVALID_SCENARIO",
          `scene ${sceneId} narration[${cueIndex}] must be an object`);
      }
      if (!Number.isSafeInteger(cue.atMillis) || cue.atMillis < 0
        || cue.atMillis > scene.durationMillis) {
        throw new ScenarioError("INVALID_SCENARIO",
          `scene ${sceneId} narration[${cueIndex}] is outside scene duration`);
      }
      return { atMillis: cue.atMillis, trackRef: requireText(cue.trackRef, "trackRef") };
    });
    const captionRefs = scene.captionRefs === undefined ? []
      : requireTextArray(scene.captionRefs, `scenes[${index}].captionRefs`);
    if (captionRefs.length > MAX_SCENE_CAPTION_REFS) {
      throw new ScenarioError("INVALID_SCENARIO",
        `scene ${sceneId} captionRefs must contain at most ${MAX_SCENE_CAPTION_REFS}`);
    }
    const run: SceneRun = {
      sceneId,
      sourceRevision,
      lineageId: lineageId(scenarioId, sceneId, sourceRef),
      capturePlan: sourceRef,
      durationMillis: scene.durationMillis,
      actorBindings,
      narration,
      captionRefs,
    };
    const descriptor = JSON.stringify([
      sceneId,
      sourceRevision,
      run.lineageId,
      sourceRef,
      run.durationMillis,
      actorBindings,
      narration,
      captionRefs,
    ]);
    planIdentityLength += descriptor.length + (sceneDescriptors.length > 0 ? 1 : 0);
    if (planIdentityLength > MAX_PLAN_IDENTITY_CHARS) {
      throw new ScenarioError("INVALID_SCENARIO",
        `serialized scenario plan exceeds ${MAX_PLAN_IDENTITY_CHARS} characters`);
    }
    sceneRuns.push(run);
    sceneDescriptors.push(descriptor);
  }
  const planIdentity = `${identityPrefix}${sceneDescriptors.join(",")}${identitySuffix}`;
  return { scenarioId, revision, planIdentity, sceneRuns, dryRunOnly: true };
}

/**
 * Re-plans one scenario against a prior plan and reports which scenes
 * actually changed — stable lineage ids survive untouched scenes.
 */
export function changedSceneLineages(
  prior: OrchestrationResult,
  next: OrchestrationResult,
): { readonly carried: readonly string[]; readonly replanned: readonly string[]; readonly removed: readonly string[] } {
  assertBoundedSceneRuns(prior, "prior");
  assertBoundedSceneRuns(next, "next");
  const priorRuns = new Map(prior.sceneRuns.map((run) => [run.sceneId, run]));
  const carried: string[] = [];
  const replanned: string[] = [];
  for (const run of next.sceneRuns) {
    const priorRun = priorRuns.get(run.sceneId);
    (priorRun && sameSceneMaterialization(priorRun, run) ? carried : replanned)
      .push(run.sceneId);
  }
  const nextSceneIds = new Set(next.sceneRuns.map((run) => run.sceneId));
  const removed = prior.sceneRuns
    .filter((run) => !nextSceneIds.has(run.sceneId))
    .map((run) => run.sceneId);
  return { carried, replanned, removed };
}

/** Keep this public diff helper within the same limits as scenario planning. */
function assertBoundedSceneRuns(
  plan: OrchestrationResult,
  label: "prior" | "next",
): void {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.sceneRuns)) {
    throw new ScenarioError("INVALID_SCENARIO", `${label} plan must contain scene runs`);
  }
  if (plan.sceneRuns.length > MAX_SCENES) {
    throw new ScenarioError("INVALID_SCENARIO", `${label} plan exceeds ${MAX_SCENES} scenes`);
  }
  const seenSceneIds = new Set<string>();
  for (const [index, run] of plan.sceneRuns.entries()) {
    if (!run || typeof run !== "object") {
      throw new ScenarioError("INVALID_SCENARIO", `${label} plan sceneRuns[${index}] must be an object`);
    }
    const sceneId = requireText(run.sceneId, `${label} plan sceneRuns[${index}].sceneId`);
    if (seenSceneIds.has(sceneId)) {
      throw new ScenarioError("INVALID_SCENARIO", `${label} plan has duplicate sceneId: ${sceneId}`);
    }
    seenSceneIds.add(sceneId);
  }
}

/** Compare explicit material fields; lineageId is a stable declared ID, not a content digest. */
function sameSceneMaterialization(left: SceneRun, right: SceneRun): boolean {
  return left.lineageId === right.lineageId
    && left.sourceRevision === right.sourceRevision
    && left.durationMillis === right.durationMillis
    && left.capturePlan.kind === right.capturePlan.kind
    && left.capturePlan.sourceIdentity === right.capturePlan.sourceIdentity
    && left.capturePlan.purposeRef === right.capturePlan.purposeRef
    && left.capturePlan.exactRightsScope === right.capturePlan.exactRightsScope
    && left.capturePlan.sourceVersionRef === right.capturePlan.sourceVersionRef
    && left.capturePlan.secretsRef === right.capturePlan.secretsRef
    && left.capturePlan.frameClockRef === right.capturePlan.frameClockRef
    && JSON.stringify(left.actorBindings) === JSON.stringify(right.actorBindings)
    && JSON.stringify(left.narration) === JSON.stringify(right.narration)
    && JSON.stringify(left.captionRefs) === JSON.stringify(right.captionRefs);
}

/**
 * Noninteractive bounded recapture: executes at most `maxScenes` capture
 * plans, each through the eligibility seam. Unadmitted scenes fail the run
 * closed rather than producing synthetic frames.
 */
export async function recaptureScenario(
  plan: OrchestrationResult,
  eligibility: CaptureAdapterEligibility,
  adapter: { capture(request: CaptureRequest): Promise<CapturedFrame> },
  options: { readonly maxScenes?: number; readonly sceneIds?: readonly string[] } = {},
): Promise<readonly CapturedFrame[]> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ScenarioError("INVALID_SCENARIO", "recapture options must be an object");
  }
  const maxScenes = options.maxScenes === undefined ? MAX_SCENES : options.maxScenes;
  if (!Number.isSafeInteger(maxScenes) || maxScenes < 1 || maxScenes > MAX_SCENES) {
    throw new ScenarioError("INVALID_SCENARIO",
      `maxScenes must be an integer between 1 and ${MAX_SCENES}`);
  }
  if (!plan || !Array.isArray(plan.sceneRuns)) {
    throw new ScenarioError("INVALID_SCENARIO", "recapture plan must contain scene runs");
  }
  if (plan.sceneRuns.length > MAX_SCENES) {
    throw new ScenarioError("INVALID_SCENARIO", `recapture plan exceeds ${MAX_SCENES} scenes`);
  }
  const runsById = new Map<string, SceneRun>();
  for (const [index, run] of plan.sceneRuns.entries()) {
    if (!run || typeof run !== "object") {
      throw new ScenarioError("INVALID_SCENARIO", `recapture plan sceneRuns[${index}] must be an object`);
    }
    const sceneId = requireText(run.sceneId, `recapture plan sceneRuns[${index}].sceneId`);
    if (runsById.has(sceneId)) {
      throw new ScenarioError("INVALID_SCENARIO", `recapture plan has duplicate sceneId: ${sceneId}`);
    }
    runsById.set(sceneId, run);
  }
  let selected = plan.sceneRuns;
  if (options.sceneIds !== undefined) {
    if (!Array.isArray(options.sceneIds)) {
      throw new ScenarioError("INVALID_SCENARIO", "sceneIds must be an array");
    }
    if (options.sceneIds.length > MAX_SCENES) {
      throw new ScenarioError("INVALID_SCENARIO", `sceneIds exceeds ${MAX_SCENES} selectors`);
    }
    const requestedIds = options.sceneIds.map((id, index) => requireText(id, `sceneIds[${index}]`));
    const requestedIdSet = new Set<string>();
    for (const id of requestedIds) {
      if (requestedIdSet.has(id)) {
        throw new ScenarioError("INVALID_SCENARIO", `duplicate recapture sceneId: ${id}`);
      }
      if (!runsById.has(id)) {
        throw new ScenarioError("INVALID_SCENARIO", `unknown recapture sceneId: ${id}`);
      }
      requestedIdSet.add(id);
    }
    // Preserve canonical plan order for the selected valid subset.
    selected = plan.sceneRuns.filter((run) => requestedIdSet.has(run.sceneId));
  }
  if (selected.length > maxScenes) {
    throw new ScenarioError("INVALID_SCENARIO",
      `recapture of ${selected.length} scenes exceeds bound ${maxScenes}`);
  }
  const frames: CapturedFrame[] = [];
  for (const run of selected) {
    frames.push(await captureWithAdmission(eligibility, adapter, run.capturePlan));
  }
  return frames;
}

export type SceneAttemptOutcome = "CAPTURED" | "NOT_ADMITTED" | "OUTCOME_UNKNOWN";

/**
 * One real attempt record per executed scene. `sourceDigest` is the SHA-256
 * of the captured frame bytes — a real observed digest, never a declared
 * digest. `OUTCOME_UNKNOWN` is retained when a capture crosses the provider
 * boundary without a durable ack; it is never coerced to success or failure.
 */
export interface SceneAttemptRecord {
  readonly sceneId: string;
  readonly lineageId: string;
  readonly sourceRevision: string;
  readonly outcome: SceneAttemptOutcome;
  readonly sourceDigest: string | null;
  readonly capturedBytes: number;
  readonly attemptedAtEpochMillis: number;
}

export interface ScenarioExecutionRecord {
  readonly scenarioId: string;
  readonly revision: string;
  readonly planIdentity: string;
  readonly attempts: readonly SceneAttemptRecord[];
  readonly executedAtEpochMillis: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Unattended bounded scenario execution: runs each selected scene through the
 * eligibility seam once and records a truthful per-scene attempt outcome.
 * NOT_ADMITTED eligibility denials and lost-ack UNKNOWN outcomes are recorded
 * verbatim — no retry, no coercion — and do not stop remaining bounded scenes.
 */
export async function executeScenario(
  plan: OrchestrationResult,
  eligibility: CaptureAdapterEligibility,
  adapter: { capture(request: CaptureRequest): Promise<CapturedFrame> },
  options: { readonly maxScenes?: number; readonly sceneIds?: readonly string[] } = {},
): Promise<ScenarioExecutionRecord> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ScenarioError("INVALID_SCENARIO", "execute options must be an object");
  }
  const maxScenes = options.maxScenes === undefined ? MAX_SCENES : options.maxScenes;
  if (!Number.isSafeInteger(maxScenes) || maxScenes < 1 || maxScenes > MAX_SCENES) {
    throw new ScenarioError("INVALID_SCENARIO",
      `maxScenes must be an integer between 1 and ${MAX_SCENES}`);
  }
  assertBoundedSceneRuns(plan, "prior");
  const runsById = new Map(plan.sceneRuns.map((run) => [run.sceneId, run]));
  let selected = plan.sceneRuns;
  if (options.sceneIds !== undefined) {
    if (!Array.isArray(options.sceneIds)) {
      throw new ScenarioError("INVALID_SCENARIO", "sceneIds must be an array");
    }
    const requested = options.sceneIds.map((id, i) => requireText(id, `sceneIds[${i}]`));
    for (const id of requested) {
      if (!runsById.has(id)) {
        throw new ScenarioError("INVALID_SCENARIO", `unknown execute sceneId: ${id}`);
      }
    }
    const idSet = new Set(requested);
    if (idSet.size !== requested.length) {
      throw new ScenarioError("INVALID_SCENARIO", "duplicate execute sceneId selector");
    }
    selected = plan.sceneRuns.filter((run) => idSet.has(run.sceneId));
  }
  if (selected.length > maxScenes) {
    throw new ScenarioError("INVALID_SCENARIO",
      `execution of ${selected.length} scenes exceeds bound ${maxScenes}`);
  }
  const attempts: SceneAttemptRecord[] = [];
  for (const run of selected) {
    const attemptedAt = Date.now();
    try {
      const frame = await captureWithAdmission(eligibility, adapter, run.capturePlan);
      attempts.push({
        sceneId: run.sceneId,
        lineageId: run.lineageId,
        sourceRevision: run.sourceRevision,
        outcome: "CAPTURED",
        sourceDigest: await sha256Hex(frame.bytes),
        capturedBytes: frame.bytes.byteLength,
        attemptedAtEpochMillis: attemptedAt,
      });
    } catch (error) {
      const denied = error instanceof CaptureNotAdmittedError;
      attempts.push({
        sceneId: run.sceneId,
        lineageId: run.lineageId,
        sourceRevision: run.sourceRevision,
        outcome: denied ? "NOT_ADMITTED" : "OUTCOME_UNKNOWN",
        sourceDigest: null,
        capturedBytes: 0,
        attemptedAtEpochMillis: attemptedAt,
      });
    }
  }
  return {
    scenarioId: plan.scenarioId,
    revision: plan.revision,
    planIdentity: plan.planIdentity,
    attempts,
    executedAtEpochMillis: Date.now(),
  };
}

/**
 * Selects sceneIds whose materialized fields changed relative to a prior
 * execution — the deterministic "changed scene alone recaptures" selector.
 * Scenes absent from prior, or whose prior attempt was not CAPTURED, run
 * again; identical carried scenes are skipped.
 */
export function scenesRequiringRecapture(
  prior: OrchestrationResult,
  next: OrchestrationResult,
  priorAttempts: readonly SceneAttemptRecord[] = [],
): readonly string[] {
  const delta = changedSceneLineages(prior, next);
  const capturedLineages = new Set(
    priorAttempts.filter((a) => a.outcome === "CAPTURED").map((a) => a.lineageId));
  return next.sceneRuns
    .filter((run) => delta.replanned.includes(run.sceneId) || !capturedLineages.has(run.lineageId))
    .map((run) => run.sceneId);
}

export { noAdmittedCaptureAdapter };

/** Rational rate/time-base values used by the final container contract. */
export interface RenderRational {
  readonly numerator: number;
  readonly denominator: number;
}

export interface RenderCaptionTiming {
  readonly captionRef: string;
  readonly startTicks: number;
  readonly endTicks: number;
}

export interface FinalRenderRequest {
  readonly renderId: string;
  readonly plan: OrchestrationResult;
  readonly frameRate: RenderRational;
  readonly variableFrameRate: boolean;
  readonly timeBase: RenderRational;
  readonly durationTicks: number;
  readonly captions: readonly RenderCaptionTiming[];
  /** Versioned, rights-gated source refs for the closing credit sequence. */
  readonly creditRefs: readonly string[];
  readonly fileName: string;
  readonly retention: string;
  readonly classification: CanonicalMediaClassification;
}

export interface RenderAdmissionDecision {
  readonly status: "ADMITTED" | "NOT_ADMITTED";
  /** Exact authority references returned by the trusted source/rights owner. */
  readonly decisionRefs: readonly string[];
}

/** Host authority is rechecked immediately before render effects. */
export interface FinalRenderAdmissionPort {
  admit(request: FinalRenderRequest): Promise<RenderAdmissionDecision>;
}

export interface RenderedContainer {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Facts observed by the host ffprobe/decode path, not request echoes. */
  readonly probe: {
    readonly container: string;
    readonly frameRate: RenderRational;
    readonly variableFrameRate: boolean;
    readonly timeBase: RenderRational;
    readonly durationTicks: number;
    readonly decodedFrameCount: number;
    readonly audioTrackCount: number;
    /** Source references verified in the muxed audio track inventory. */
    readonly narrationTrackRefs: readonly string[];
    /** Subtitle/caption tracks observed in the decoded container. */
    readonly captionTrackCount: number;
    readonly captionTimings: readonly RenderCaptionTiming[];
    /** Credit source references verified in the rendered closing sequence. */
    readonly creditRefsIncluded: readonly string[];
  };
}

/**
 * This port must be backed by the admitted host codec and decoder/probe. The
 * SDK intentionally ships no codec implementation, so absence is NOT_ADMITTED.
 */
export interface FinalRenderMuxAndProbePort {
  muxAndVerify(request: FinalRenderRequest): Promise<RenderedContainer>;
}

export type FinalRenderPublishResult =
  | { readonly outcome: "PUBLISHED"; readonly artifact: CanonicalMediaArtifactObservation; readonly sha256: string }
  | { readonly outcome: "NOT_ADMITTED"; readonly reason: string }
  | { readonly outcome: "PARTIAL_UPLOAD_NOT_FINALIZED"; readonly reason: string; readonly uploadId: string }
  | { readonly outcome: "OUTCOME_UNKNOWN"; readonly reason: string; readonly uploadId?: string };

const MAX_RENDER_BYTES = 1_073_741_824;
const RENDER_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RENDER_AUTHORITY_REFS_PER_CHECK = 64;
const MAX_RENDER_AUTHORITY_REFS_TOTAL = 256;

function freezeRenderValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeRenderValue(nested);
    Object.freeze(value);
  }
  return value;
}

/** JSON object key order is not part of the canonical metadata value. */
function sameRenderJson(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") {
    return false;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((value, index) => sameRenderJson(value, expected[index]));
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => Object.hasOwn(expectedRecord, key)
      && sameRenderJson(actualRecord[key], expectedRecord[key]));
}

function validateAndSnapshotRenderRequest(request: FinalRenderRequest): FinalRenderRequest {
  requireText(request.renderId, "renderId");
  if (!request.plan || request.plan.dryRunOnly !== true) {
    throw new ScenarioError("INVALID_SCENARIO", "render plan must be a validated scenario plan");
  }
  assertBoundedSceneRuns(request.plan, "prior");
  if (request.plan.sceneRuns.length < 1 || request.plan.sceneRuns.length > MAX_SCENES) {
    throw new ScenarioError("INVALID_SCENARIO", `render plan must contain 1..${MAX_SCENES} scenes`);
  }
  requireText(request.plan.scenarioId, "plan.scenarioId");
  requireText(request.plan.revision, "plan.revision");
  if (typeof request.plan.planIdentity !== "string" || request.plan.planIdentity.trim().length === 0
    || request.plan.planIdentity.length > MAX_PLAN_IDENTITY_CHARS + 256
    || request.plan.planIdentity !== request.plan.planIdentity.trim()) {
    throw new ScenarioError("INVALID_SCENARIO", "plan.planIdentity must be canonical and bounded");
  }

  // Rebuild the plan from its typed materialization. A caller-supplied digest,
  // lineage ID, or partial scene object is not accepted as proof of the plan.
  const actorsById = new Map<string, ScenarioActor>();
  for (const [index, run] of request.plan.sceneRuns.entries()) {
    if (!Array.isArray(run.actorBindings) || run.actorBindings.length > MAX_ACTORS
      || !Array.isArray(run.narration) || run.narration.length > MAX_SCENE_NARRATION_CUES
      || !Array.isArray(run.captionRefs) || run.captionRefs.length > MAX_SCENE_CAPTION_REFS) {
      throw new ScenarioError("INVALID_SCENARIO", `plan.sceneRuns[${index}] exceeds bounded actor, narration, or caption inputs`);
    }
    for (const [actorIndex, actor] of run.actorBindings.entries()) {
      if (!actor || typeof actor !== "object") {
        throw new ScenarioError("INVALID_SCENARIO", `plan.sceneRuns[${index}].actorBindings[${actorIndex}] must be an object`);
      }
      const actorId = requireText(actor.actorId, `plan.sceneRuns[${index}].actorBindings[${actorIndex}].actorId`);
      const role = requireText(actor.role, `plan.sceneRuns[${index}].actorBindings[${actorIndex}].role`);
      const existing = actorsById.get(actorId);
      if (existing && existing.role !== role) {
        throw new ScenarioError("INVALID_SCENARIO", `actor ${actorId} has inconsistent roles across render scenes`);
      }
      actorsById.set(actorId, { actorId, role });
    }
  }
  const canonicalPlan = orchestrateScenario({
    scenarioId: request.plan.scenarioId,
    revision: request.plan.revision,
    actors: [...actorsById.values()],
    scenes: request.plan.sceneRuns.map((run) => ({
      sceneId: run.sceneId,
      sourceRef: run.capturePlan,
      actorRefs: run.actorBindings.map((actor) => actor.actorId),
      narration: run.narration,
      captionRefs: run.captionRefs,
      durationMillis: run.durationMillis,
    })),
  });
  if (canonicalPlan.planIdentity !== request.plan.planIdentity
    || canonicalPlan.sceneRuns.some((run, index) => run.lineageId !== request.plan.sceneRuns[index]?.lineageId
      || run.sourceRevision !== request.plan.sceneRuns[index]?.sourceRevision)) {
    throw new ScenarioError("INVALID_SCENARIO", "render plan identity or scene lineage does not match its materialized inputs");
  }

  for (const [field, value] of [["frameRate", request.frameRate], ["timeBase", request.timeBase]] as const) {
    if (!value || !Number.isSafeInteger(value.numerator) || value.numerator < 1
      || !Number.isSafeInteger(value.denominator) || value.denominator < 1) {
      throw new ScenarioError("INVALID_SCENARIO", `${field} must be a positive rational`);
    }
  }
  if (!Number.isSafeInteger(request.durationTicks) || request.durationTicks < 1) {
    throw new ScenarioError("INVALID_SCENARIO", "durationTicks must be a positive safe integer");
  }
  if (typeof request.variableFrameRate !== "boolean") {
    throw new ScenarioError("INVALID_SCENARIO", "variableFrameRate must be a boolean");
  }
  if (!Array.isArray(request.captions) || request.captions.length > 4096) {
    throw new ScenarioError("INVALID_SCENARIO", "captions must contain at most 4096 timed cues");
  }
  const seenCaptionRefs = new Set<string>();
  const captions = request.captions.map((caption, index) => {
    const ref = requireText(caption.captionRef, `captions[${index}].captionRef`);
    if (seenCaptionRefs.has(ref)) throw new ScenarioError("INVALID_SCENARIO", `duplicate captionRef: ${ref}`);
    seenCaptionRefs.add(ref);
    if (!Number.isSafeInteger(caption.startTicks) || !Number.isSafeInteger(caption.endTicks)
      || caption.startTicks < 0 || caption.endTicks <= caption.startTicks
      || caption.endTicks > request.durationTicks) {
      throw new ScenarioError("INVALID_SCENARIO", `captions[${index}] is outside the render timebase`);
    }
    return { captionRef: ref, startTicks: caption.startTicks, endTicks: caption.endTicks };
  });
  if (!Array.isArray(request.creditRefs) || request.creditRefs.length > 256) {
    throw new ScenarioError("INVALID_SCENARIO", "creditRefs must contain at most 256 references");
  }
  const creditsSeen = new Set<string>();
  const creditRefs = request.creditRefs.map((refValue, index) => {
    const ref = requireText(refValue, `creditRefs[${index}]`);
    if (creditsSeen.has(ref)) throw new ScenarioError("INVALID_SCENARIO", `duplicate creditRef: ${ref}`);
    creditsSeen.add(ref);
    return ref;
  });
  if (request.classification !== "PUBLIC" && request.classification !== "INTERNAL"
    && request.classification !== "CONFIDENTIAL" && request.classification !== "RESTRICTED") {
    throw new ScenarioError("INVALID_SCENARIO", "classification is outside the canonical media enum");
  }
  const snapshot: FinalRenderRequest = {
    renderId: request.renderId,
    plan: canonicalPlan,
    frameRate: { numerator: request.frameRate.numerator, denominator: request.frameRate.denominator },
    variableFrameRate: request.variableFrameRate,
    timeBase: { numerator: request.timeBase.numerator, denominator: request.timeBase.denominator },
    durationTicks: request.durationTicks,
    captions,
    creditRefs,
    fileName: requireText(request.fileName, "fileName"),
    retention: requireText(request.retention, "retention"),
    classification: request.classification,
  };
  return freezeRenderValue(snapshot);
}

function stableRenderIdentity(request: FinalRenderRequest): string {
  return JSON.stringify([
    request.renderId,
    request.plan.planIdentity,
    request.plan.sceneRuns.map((run) => [run.sceneId, run.lineageId, run.sourceRevision]),
    [request.frameRate.numerator, request.frameRate.denominator],
    request.variableFrameRate,
    [request.timeBase.numerator, request.timeBase.denominator],
    request.durationTicks,
    request.captions.map(({ captionRef, startTicks, endTicks }) => [captionRef, startTicks, endTicks]),
    request.creditRefs,
    request.fileName,
    request.retention,
    request.classification,
  ]);
}

/** Compare a chunk receipt to the exact immutable session that authorized dispatch. */
function sameUploadSessionIdentity(
  actual: CanonicalMediaUploadSessionObservation,
  expected: CanonicalMediaUploadSessionObservation,
): boolean {
  return actual.uploadId === expected.uploadId
    && actual.tenantId === expected.tenantId
    && actual.principalId === expected.principalId
    && actual.fileName === expected.fileName
    && actual.contentType === expected.contentType
    && actual.expectedSizeBytes === expected.expectedSizeBytes
    && actual.expectedSha256 === expected.expectedSha256
    && actual.classification === expected.classification
    && actual.createdAt === expected.createdAt
    && actual.expiresAt === expected.expiresAt
    && sameRenderJson(actual.metadata, expected.metadata);
}

/**
 * Publishes only bytes returned by the admitted mux+decoder/probe host port.
 * The canonical upload's declared idempotency key is stable for the same
 * validated render request. Runtime replay guarantees remain unqualified;
 * this function never retries an ambiguous mutation. Incomplete uploads are
 * deliberately never finalized as artifacts.
 */
export async function publishFinalRender(
  request: FinalRenderRequest,
  admission: FinalRenderAdmissionPort | undefined,
  muxer: FinalRenderMuxAndProbePort | undefined,
  artifactClient: MediaOperationClient | undefined,
  signal?: AbortSignal,
): Promise<FinalRenderPublishResult> {
  const safeRequest = validateAndSnapshotRenderRequest(request);
  if (signal?.aborted) {
    return { outcome: "NOT_ADMITTED", reason: "render publication was cancelled before authority or codec work began" };
  }
  if (!admission || !muxer || !artifactClient) {
    return { outcome: "NOT_ADMITTED", reason: "trusted render authority, codec/probe, and canonical artifact client are required" };
  }
  const admittedRefs = new Set<string>();
  const checkAdmission = async (): Promise<boolean> => {
    try {
      const decision: RenderAdmissionDecision = await admission.admit(safeRequest);
      if (decision.status !== "ADMITTED" || !Array.isArray(decision.decisionRefs)
        || decision.decisionRefs.length === 0
        || decision.decisionRefs.length > MAX_RENDER_AUTHORITY_REFS_PER_CHECK) {
        return false;
      }
      const refs = decision.decisionRefs.map((ref) => {
        if (typeof ref !== "string" || ref.trim().length === 0 || ref.length > 384 || ref !== ref.trim()) {
          throw new TypeError("render authority reference is invalid");
        }
        return ref;
      });
      const combinedRefs = new Set([...admittedRefs, ...refs]);
      if (combinedRefs.size > MAX_RENDER_AUTHORITY_REFS_TOTAL) return false;
      for (const ref of refs) admittedRefs.add(ref);
      return true;
    } catch {
      return false;
    }
  };
  if (!await checkAdmission()) {
    return { outcome: "NOT_ADMITTED", reason: "render rights or source authority did not admit this request" };
  }
  if (signal?.aborted) {
    return { outcome: "NOT_ADMITTED", reason: "render publication was cancelled before codec work began" };
  }

  let rendered: RenderedContainer;
  try {
    rendered = await muxer.muxAndVerify(safeRequest);
  } catch {
    return { outcome: "NOT_ADMITTED", reason: "qualified mux/decoder verification is unavailable or failed" };
  }
  if (signal?.aborted) {
    return { outcome: "NOT_ADMITTED", reason: "render publication was cancelled before artifact upload began" };
  }
  // Detach from caller/adapter-owned memory before any further await.
  const bytes = rendered?.bytes instanceof Uint8Array ? rendered.bytes.slice() : undefined;
  if (!rendered || !bytes || bytes.byteLength < 1
    || bytes.byteLength > MAX_RENDER_BYTES || typeof rendered.contentType !== "string"
    || !/^video\/[a-z0-9.+-]+$/u.test(rendered.contentType)) {
    return { outcome: "NOT_ADMITTED", reason: "muxer did not return a bounded verified video container" };
  }
  const probe = rendered.probe;
  const narrationRefs = [...new Set(safeRequest.plan.sceneRuns.flatMap((run) => run.narration.map((cue) => cue.trackRef)))];
  if (!probe || !probe.frameRate || !probe.timeBase || !Array.isArray(probe.captionTimings)
    || typeof probe.container !== "string" || probe.container.trim().length === 0
    || !Number.isSafeInteger(probe.decodedFrameCount) || probe.decodedFrameCount < 1
    || !Number.isSafeInteger(probe.audioTrackCount) || probe.audioTrackCount < 0
    || !Array.isArray(probe.narrationTrackRefs)
    || !Number.isSafeInteger(probe.captionTrackCount) || probe.captionTrackCount < 0
    || !Array.isArray(probe.creditRefsIncluded)
    || probe.frameRate.numerator !== safeRequest.frameRate.numerator
    || probe.frameRate.denominator !== safeRequest.frameRate.denominator
    || probe.variableFrameRate !== safeRequest.variableFrameRate
    || probe.timeBase.numerator !== safeRequest.timeBase.numerator
    || probe.timeBase.denominator !== safeRequest.timeBase.denominator
    || probe.durationTicks !== safeRequest.durationTicks
    || (narrationRefs.length > 0 && probe.audioTrackCount < 1)
    || JSON.stringify(probe.narrationTrackRefs) !== JSON.stringify(narrationRefs)
    || (safeRequest.captions.length > 0 && probe.captionTrackCount < 1)
    || JSON.stringify(probe.captionTimings) !== JSON.stringify(safeRequest.captions)
    || JSON.stringify(probe.creditRefsIncluded) !== JSON.stringify(safeRequest.creditRefs)) {
    return { outcome: "NOT_ADMITTED", reason: "decoder/probe or mux observations do not prove requested frame timing, narration, caption track/timing, or credit inclusion" };
  }

  const sha256 = await sha256Hex(bytes);
  const identityDigest = await sha256Hex(new TextEncoder().encode(stableRenderIdentity(safeRequest)));
  const idempotencyKey = `media-render-v1-${identityDigest}`;
  let uploadId: string | undefined;
  let completionStarted = false;
  try {
    if (signal?.aborted) {
      return { outcome: "NOT_ADMITTED", reason: "render publication was cancelled before canonical artifact creation" };
    }
    if (!await checkAdmission()) {
      return { outcome: "NOT_ADMITTED", reason: "render authority was denied or unavailable before canonical artifact creation" };
    }
    if (signal?.aborted) {
      return { outcome: "NOT_ADMITTED", reason: "render publication was cancelled before canonical artifact creation" };
    }
    const uploadMetadata = freezeRenderValue({
      operation: "media.recorder.final-render.v1",
      renderIdentitySha256: identityDigest,
      sourceLineage: safeRequest.plan.sceneRuns.map((run) => ({
        sceneId: run.sceneId, lineageId: run.lineageId, sourceRevision: run.sourceRevision,
      })),
      authorityDecisionRefs: [...admittedRefs],
      frameRate: safeRequest.frameRate,
      variableFrameRate: safeRequest.variableFrameRate,
      timeBase: safeRequest.timeBase,
      durationTicks: safeRequest.durationTicks,
      captions: safeRequest.captions,
      creditRefs: safeRequest.creditRefs,
    });
    let session = await artifactClient.createUploadSession({
      fileName: safeRequest.fileName,
      contentType: rendered.contentType,
      expectedSizeBytes: bytes.byteLength,
      expectedSha256: sha256,
      classification: safeRequest.classification,
      retention: safeRequest.retention,
      metadata: uploadMetadata,
      idempotencyKey,
    }, signal);
    uploadId = session.uploadId;
    if (session.status !== "OPEN") {
      return { outcome: "OUTCOME_UNKNOWN", reason: "idempotent upload session is not open; read canonical state before replay", uploadId };
    }
    if (session.fileName !== safeRequest.fileName || session.contentType !== rendered.contentType
      || session.expectedSizeBytes !== bytes.byteLength || session.expectedSha256 !== sha256
      || session.classification !== safeRequest.classification
      || !sameRenderJson(session.metadata, uploadMetadata)) {
      return { outcome: "OUTCOME_UNKNOWN", reason: "canonical upload session does not bind the verified render request; inspect state before replay", uploadId };
    }
    let offset = session.bytesReceived;
    let chunkIndex = session.nextChunkIndex;
    const expectedChunkIndex = Math.ceil(offset / RENDER_UPLOAD_CHUNK_BYTES);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength
      || (offset !== bytes.byteLength && offset % RENDER_UPLOAD_CHUNK_BYTES !== 0)
      || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex !== expectedChunkIndex) {
      return { outcome: "OUTCOME_UNKNOWN", reason: "canonical upload resume position does not align with a verified chunk boundary", uploadId };
    }
    while (offset < bytes.byteLength) {
      if (!await checkAdmission()) {
        return { outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", reason: "render authority was denied or unavailable before a chunk dispatch", uploadId };
      }
      if (signal?.aborted) {
        return { outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", reason: "render publication was cancelled before a chunk dispatch", uploadId };
      }
      const end = Math.min(offset + RENDER_UPLOAD_CHUNK_BYTES, bytes.byteLength);
      // Preserve the exact pre-dispatch receipt; an adapter may mutate its
      // session object while handling the request, so never compare against
      // that same mutable reference after awaiting the chunk effect.
      const dispatchedSession = JSON.parse(JSON.stringify(session)) as CanonicalMediaUploadSessionObservation;
      const acknowledgedSession = await artifactClient.uploadPart(session, chunkIndex,
        new Blob([bytes.slice(offset, end)], { type: "application/octet-stream" }), { signal });
      if (!acknowledgedSession || acknowledgedSession.status !== "OPEN"
        || !sameUploadSessionIdentity(acknowledgedSession, dispatchedSession)
        || acknowledgedSession.bytesReceived !== end
        || acknowledgedSession.nextChunkIndex !== chunkIndex + 1) {
        return { outcome: "OUTCOME_UNKNOWN", reason: "canonical chunk acknowledgement does not confirm the exact upload session progress", uploadId };
      }
      session = acknowledgedSession;
      offset = end;
      chunkIndex += 1;
    }
    if (!await checkAdmission()) {
      return { outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", reason: "render authority was denied or unavailable before canonical completion", uploadId };
    }
    if (signal?.aborted) {
      return { outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", reason: "render publication was cancelled before canonical completion", uploadId };
    }
    completionStarted = true;
    const artifact = await artifactClient.completeUploadSession(session, signal);
    if (artifact.tenantId !== session.tenantId || artifact.principalId !== session.principalId
      || artifact.sha256 !== sha256 || artifact.sizeBytes !== bytes.byteLength
      || artifact.fileName !== safeRequest.fileName || artifact.contentType !== rendered.contentType) {
      return { outcome: "OUTCOME_UNKNOWN", reason: "canonical artifact receipt does not match verified render bytes or upload scope", uploadId };
    }
    if (artifact.classification !== session.classification
      || !sameRenderJson(artifact.metadata, session.metadata)) {
      return { outcome: "OUTCOME_UNKNOWN", reason: "canonical artifact receipt does not bind to the completed upload metadata", uploadId };
    }
    return { outcome: "PUBLISHED", artifact, sha256 };
  } catch (error) {
    if (completionStarted) return { outcome: "OUTCOME_UNKNOWN", reason: "canonical completion acknowledgement is missing; read upload/artifact state before replay", uploadId };
    if (error instanceof MediaOperationAmbiguousError) return { outcome: "OUTCOME_UNKNOWN", reason: "canonical chunk acknowledgement is missing; read upload state before replay", uploadId };
    if (uploadId) return { outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", reason: "upload failed before canonical artifact completion; session is left for canonical recovery/expiry", uploadId };
    return { outcome: "OUTCOME_UNKNOWN", reason: "canonical upload creation outcome is unknown" };
  }
}
