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
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureAdapterEligibility,
  type CaptureRequest,
  type CapturedFrame,
} from "./capture-adapters.js";

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

export { noAdmittedCaptureAdapter };
