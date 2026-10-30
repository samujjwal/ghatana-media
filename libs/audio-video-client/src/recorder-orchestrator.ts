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
  readonly sourceRef: string;
  readonly sourceRevision: string;
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
  /** Deterministic lineage id: scenario+scene+revision, stable across runs. */
  readonly lineageId: string;
  readonly capturePlan: CaptureRequest;
  readonly narration: readonly NarrationCue[];
  readonly captionRefs: readonly string[];
}

export interface OrchestrationResult {
  readonly scenarioId: string;
  readonly revision: string;
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

function requireText(value: string | undefined, field: string): string {
  if (value === undefined || typeof value !== "string"
    || value.trim().length === 0 || value.length > 384 || value !== value.trim()) {
    throw new ScenarioError("INVALID_SCENARIO", `${field} is required, canonical and bounded`);
  }
  return value;
}

/** Deterministic lineage: scenario identity + scene identity + revision. */
function lineageId(scenarioId: string, sceneId: string, sourceRevision: string): string {
  return `${scenarioId}/${sceneId}@${sourceRevision}`;
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
  const actorIds = new Set(scenario.actors.map((a) => requireText(a.actorId, "actorId")));

  const sceneRuns: SceneRun[] = scenario.scenes.map((scene, index) => {
    const sceneId = requireText(scene.sceneId, `scenes[${index}].sceneId`);
    const sourceRef = requireText(scene.sourceRef, `scenes[${index}].sourceRef`);
    const sourceRevision = requireText(scene.sourceRevision, `scenes[${index}].sourceRevision`);
    for (const actorRef of scene.actorRefs ?? []) {
      if (!actorIds.has(actorRef)) {
        throw new ScenarioError("ACTOR_UNRESOLVED",
          `scene ${sceneId} references undeclared actor ${actorRef}`);
      }
    }
    if (!Number.isSafeInteger(scene.durationMillis) || scene.durationMillis < 1
      || scene.durationMillis > 3_600_000) {
      throw new ScenarioError("INVALID_SCENARIO",
        `scene ${sceneId} durationMillis must be 1..3600000`);
    }
    const narration = (scene.narration ?? []).map((cue: NarrationCue, cueIndex: number) => {
      if (!Number.isSafeInteger(cue.atMillis) || cue.atMillis < 0
        || cue.atMillis > scene.durationMillis) {
        throw new ScenarioError("INVALID_SCENARIO",
          `scene ${sceneId} narration[${cueIndex}] is outside scene duration`);
      }
      return { atMillis: cue.atMillis, trackRef: requireText(cue.trackRef, "trackRef") };
    });
    return {
      sceneId,
      sourceRevision,
      lineageId: lineageId(scenarioId, sceneId, sourceRevision),
      capturePlan: {
        kind: "MEDIA_FILE",
        sourceIdentity: sourceRef,
        purposeRef: `scenario/${scenarioId}`,
        sourceVersionRef: sourceRevision,
        secretsRef: `secrets/scenario/${scenarioId}`,
        frameClockRef: `clock/scenario/${scenarioId}`,
      },
      narration,
      captionRefs: [...(scene.captionRefs ?? [])],
    };
  });
  return { scenarioId, revision, sceneRuns, dryRunOnly: true };
}

/**
 * Re-plans one scenario against a prior plan and reports which scenes
 * actually changed — stable lineage ids survive untouched scenes.
 */
export function changedSceneLineages(
  prior: OrchestrationResult,
  next: OrchestrationResult,
): { readonly carried: readonly string[]; readonly replanned: readonly string[] } {
  const priorLineages = new Map(prior.sceneRuns.map((r) => [r.sceneId, r.lineageId]));
  const carried: string[] = [];
  const replanned: string[] = [];
  for (const run of next.sceneRuns) {
    (priorLineages.get(run.sceneId) === run.lineageId ? carried : replanned)
      .push(run.sceneId);
  }
  return { carried, replanned };
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
  const maxScenes = options.maxScenes ?? MAX_SCENES;
  const selected = options.sceneIds === undefined
    ? plan.sceneRuns
    : plan.sceneRuns.filter((run) => options.sceneIds!.includes(run.sceneId));
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
