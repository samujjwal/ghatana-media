export type ScenarioReplayConsumer = "recorder" | "explorer";

export interface ScenarioReplayClock {
  /** Exact source or fixture clock identity; never wall-clock time. */
  readonly clockId: string;
  readonly ticksPerSecond: number;
  readonly initialTick: number;
  readonly currentTick: number;
}

export interface ScenarioReplayContract {
  readonly schemaVersion: "media.simulation-scenario-contract.v1";
  readonly consumer: ScenarioReplayConsumer;
  readonly scenarioId: string;
  /** Local source path plus exact source pointer, never a remote URL. */
  readonly sourceRef: string;
  /** Stable, non-cryptographic seed identity derived from source-bound IDs. */
  readonly seed: string;
  readonly clock: ScenarioReplayClock;
  readonly truth: {
    readonly label: "SIMULATED_FIXTURE_ONLY";
    readonly dispatch: "NEVER";
    readonly networkEffects: "NEVER";
    readonly modelOutput: "NOT_PROVIDED";
    readonly solverOutput: "NOT_PROVIDED";
    readonly ownerEvidence: "NONE";
    readonly runtimeAdmission: "NOT_ADMITTED";
  };
}

export interface ScenarioReplayContractInput {
  readonly consumer: ScenarioReplayConsumer;
  readonly scenarioId: string;
  readonly sourceRef: string;
  readonly clock: {
    readonly clockId: string;
    readonly ticksPerSecond: number;
    readonly initialTick: number;
  };
}

export interface ScenarioContractIssue {
  readonly path: string;
  readonly code: string;
}

export interface ScenarioContractValidation {
  readonly valid: boolean;
  readonly issues: readonly ScenarioContractIssue[];
}

export class ScenarioReplayContractError extends Error {
  public constructor(public readonly issue: ScenarioContractIssue) {
    super(`${issue.path}: ${issue.code}`);
    this.name = "ScenarioReplayContractError";
  }
}

const ROOT_KEYS = ["schemaVersion", "consumer", "scenarioId", "sourceRef", "seed", "clock", "truth"] as const;
const CLOCK_KEYS = ["clockId", "ticksPerSecond", "initialTick", "currentTick"] as const;
const TRUTH_KEYS = [
  "label", "dispatch", "networkEffects", "modelOutput", "solverOutput", "ownerEvidence", "runtimeAdmission",
] as const;
const SIMULATION_TRUTH = Object.freeze({
  label: "SIMULATED_FIXTURE_ONLY" as const,
  dispatch: "NEVER" as const,
  networkEffects: "NEVER" as const,
  modelOutput: "NOT_PROVIDED" as const,
  solverOutput: "NOT_PROVIDED" as const,
  ownerEvidence: "NONE" as const,
  runtimeAdmission: "NOT_ADMITTED" as const,
});
const SCENARIO_ID = /^media\.(?:scenario\.[a-z0-9-]+|recorder\.p3\.scenario\.[a-z0-9-]+\.v[1-9][0-9]*)$/u;
const LOCAL_SOURCE_REF = /^\.product-experience\/[A-Za-z0-9._/-]+#[A-Za-z0-9._/=@-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** FNV-1a is used only for a reproducible fixture identity, never integrity or trust. */
function seedFor(scenarioId: string, sourceRef: string): string {
  let hash = 0x811c9dc5;
  const input = `${scenarioId}\u0000${sourceRef}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fixture-seed-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Validate the same explicit, non-executable scenario envelope for Recorder
 * and Explorer inputs. Unknown fields fail closed so real outputs, effects,
 * and authority cannot be smuggled into a fixture contract.
 */
export function validateScenarioReplayContract(value: unknown): ScenarioContractValidation {
  const issues: ScenarioContractIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  if (!isRecord(value)) {
    return { valid: false, issues: [{ path: "$", code: "EXPECTED_OBJECT" }] };
  }
  if (!hasExactKeys(value, ROOT_KEYS)) issue("$", "UNEXPECTED_OR_MISSING_FIELDS");
  if (value.schemaVersion !== "media.simulation-scenario-contract.v1") issue("schemaVersion", "UNSUPPORTED_SCHEMA");
  if (value.consumer !== "recorder" && value.consumer !== "explorer") issue("consumer", "UNSUPPORTED_CONSUMER");
  if (typeof value.scenarioId !== "string" || !SCENARIO_ID.test(value.scenarioId)) {
    issue("scenarioId", "INVALID_SOURCE_SCENARIO_ID");
  }
  if (
    typeof value.sourceRef !== "string" || !LOCAL_SOURCE_REF.test(value.sourceRef) ||
    value.sourceRef.includes("..") || value.sourceRef.includes("://")
  ) issue("sourceRef", "INVALID_LOCAL_SOURCE_POINTER");

  if (!isRecord(value.clock) || !hasExactKeys(value.clock, CLOCK_KEYS)) {
    issue("clock", "INVALID_CLOCK_OBJECT");
  } else {
    if (
      typeof value.clock.clockId !== "string" || value.clock.clockId.length === 0 ||
      value.clock.clockId !== value.clock.clockId.trim() || /wall.?clock|system.?time/iu.test(value.clock.clockId)
    ) issue("clock.clockId", "SOURCE_CLOCK_REQUIRED");
    if (!Number.isSafeInteger(value.clock.ticksPerSecond) || Number(value.clock.ticksPerSecond) < 1 || Number(value.clock.ticksPerSecond) > 1_000_000_000) {
      issue("clock.ticksPerSecond", "INVALID_TICK_RATE");
    }
    const initialTick = value.clock.initialTick;
    const currentTick = value.clock.currentTick;
    const validInitialTick = typeof initialTick === "number" && Number.isSafeInteger(initialTick);
    const validCurrentTick = typeof currentTick === "number" && Number.isSafeInteger(currentTick);
    if (!validInitialTick) issue("clock.initialTick", "INVALID_INITIAL_TICK");
    if (
      !validCurrentTick ||
      (validInitialTick && validCurrentTick && currentTick < initialTick)
    ) {
      issue("clock.currentTick", "INVALID_CURRENT_TICK");
    }
  }

  if (value.seed !== seedFor(String(value.scenarioId), String(value.sourceRef))) issue("seed", "SEED_SOURCE_MISMATCH");
  if (!isRecord(value.truth) || !hasExactKeys(value.truth, TRUTH_KEYS)) {
    issue("truth", "INVALID_SIMULATION_TRUTH_OBJECT");
  } else {
    for (const [key, expected] of Object.entries(SIMULATION_TRUTH)) {
      if (value.truth[key] !== expected) issue(`truth.${key}`, "SIMULATION_ONLY_VALUE_REQUIRED");
    }
  }
  return { valid: issues.length === 0, issues };
}

function assertValid(value: unknown): asserts value is ScenarioReplayContract {
  const validation = validateScenarioReplayContract(value);
  if (!validation.valid) throw new ScenarioReplayContractError(validation.issues[0]!);
}

/** Construct the shared contract without clocks, randomness, or external effects. */
export function createScenarioReplayContract(input: ScenarioReplayContractInput): ScenarioReplayContract {
  const contract: ScenarioReplayContract = {
    schemaVersion: "media.simulation-scenario-contract.v1",
    consumer: input.consumer,
    scenarioId: input.scenarioId,
    sourceRef: input.sourceRef,
    seed: seedFor(input.scenarioId, input.sourceRef),
    clock: {
      clockId: input.clock.clockId,
      ticksPerSecond: input.clock.ticksPerSecond,
      initialTick: input.clock.initialTick,
      currentTick: input.clock.initialTick,
    },
    truth: SIMULATION_TRUTH,
  };
  assertValid(contract);
  return contract;
}

/** Advance only the declared source/fixture clock by whole ticks. */
export function advanceScenarioReplayClock(contract: ScenarioReplayContract, tickDelta: number): ScenarioReplayContract {
  assertValid(contract);
  if (!Number.isSafeInteger(tickDelta) || tickDelta < 0) {
    throw new ScenarioReplayContractError({ path: "tickDelta", code: "NON_NEGATIVE_SAFE_INTEGER_REQUIRED" });
  }
  const currentTick = contract.clock.currentTick + tickDelta;
  if (!Number.isSafeInteger(currentTick)) {
    throw new ScenarioReplayContractError({ path: "clock.currentTick", code: "CLOCK_OVERFLOW" });
  }
  return {
    ...contract,
    clock: { ...contract.clock, currentTick },
  };
}

/** Reset the clock to its authored seed tick; replay never consults wall time. */
export function resetScenarioReplayClock(contract: ScenarioReplayContract): ScenarioReplayContract {
  assertValid(contract);
  return { ...contract, clock: { ...contract.clock, currentTick: contract.clock.initialTick } };
}
