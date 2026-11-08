import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceScenarioReplayClock,
  createScenarioReplayContract,
  resetScenarioReplayClock,
  ScenarioReplayContractError,
  validateScenarioReplayContract,
} from "../dist/index.js";

const explorerInput = {
  consumer: "explorer",
  scenarioId: "media.scenario.transcript-ready",
  sourceRef: ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml#fixtures/@id=media.scenario.transcript-ready",
  clock: { clockId: "source-presentation-time", ticksPerSecond: 48_000, initialTick: 0 },
};

test("Recorder and Explorer share the same strict simulation-only contract", () => {
  const explorer = createScenarioReplayContract(explorerInput);
  const recorder = createScenarioReplayContract({
    consumer: "recorder",
    scenarioId: "media.recorder.p3.scenario.sandboxed-interactive-player.v1",
    sourceRef: ".product-experience/pdp-3-product-experience/recorder-studio-experience.yaml#surfaceCaseScenarioContracts/records/@id=media.recorder.p3.scenario.sandboxed-interactive-player.v1",
    clock: { clockId: "source-presentation-time", ticksPerSecond: 48_000, initialTick: 0 },
  });

  assert.equal(validateScenarioReplayContract(explorer).valid, true);
  assert.equal(validateScenarioReplayContract(recorder).valid, true);
  assert.equal(explorer.truth.label, "SIMULATED_FIXTURE_ONLY");
  assert.equal(createScenarioReplayContract({ ...explorerInput, consumer: "recorder" }).seed, explorer.seed);
  assert.equal(recorder.truth.dispatch, "NEVER");
  assert.equal(recorder.truth.networkEffects, "NEVER");
  assert.equal(recorder.truth.modelOutput, "NOT_PROVIDED");
  assert.equal(recorder.truth.solverOutput, "NOT_PROVIDED");
  assert.equal(recorder.truth.ownerEvidence, "NONE");
  assert.equal(recorder.truth.runtimeAdmission, "NOT_ADMITTED");
});

test("seed and explicit source-clock replay are repeatable without wall time or network", () => {
  const first = createScenarioReplayContract(explorerInput);
  const replay = createScenarioReplayContract(explorerInput);
  assert.equal(first.seed, replay.seed);
  assert.deepEqual(first, replay);

  const advanceA = advanceScenarioReplayClock(first, 1_920);
  const advanceB = advanceScenarioReplayClock(replay, 1_920);
  assert.deepEqual(advanceA, advanceB);
  assert.equal(advanceA.clock.currentTick, 1_920);
  assert.equal(resetScenarioReplayClock(advanceA).clock.currentTick, 0);
  assert.equal(first.clock.currentTick, 0, "clock operations do not mutate the authored seed");

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network use is forbidden in scenario contract helpers");
  };
  try {
    validateScenarioReplayContract(first);
    createScenarioReplayContract(explorerInput);
    advanceScenarioReplayClock(first, 1);
    resetScenarioReplayClock(first);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed fixture contracts reject unsupported truth, sources, seeds, clocks and extra fields", () => {
  const valid = createScenarioReplayContract(explorerInput);
  const malformed = [
    null,
    { ...valid, sourceRef: "https://example.test/fixture.yaml#demo" },
    { ...valid, seed: "caller-forged-seed" },
    { ...valid, clock: { ...valid.clock, currentTick: -1 } },
    { ...valid, clock: { ...valid.clock, ticksPerSecond: 0 } },
    { ...valid, clock: { ...valid.clock, clockId: "wall-clock" } },
    { ...valid, truth: { ...valid.truth, networkEffects: "ALLOWED" } },
    { ...valid, truth: { ...valid.truth, modelOutput: "MODEL_RESULT" } },
    { ...valid, ownerEvidence: true },
  ];
  for (const fixture of malformed) {
    assert.equal(validateScenarioReplayContract(fixture).valid, false);
  }

  let accessorReads = 0;
  const accessorBacked = { ...valid };
  Object.defineProperty(accessorBacked, "consumer", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "explorer";
    },
  });
  assert.equal(validateScenarioReplayContract(accessorBacked).valid, false);
  assert.equal(accessorReads, 0, "validation rejects executable accessors without evaluating them");
  assert.equal(validateScenarioReplayContract(new (class FixtureEnvelope { value = valid; })()).valid, false);
  const uninspectable = new Proxy({}, { getPrototypeOf: () => { throw new Error("uninspectable input"); } });
  assert.equal(validateScenarioReplayContract(uninspectable).valid, false);

  const nearLimit = createScenarioReplayContract({
    ...explorerInput,
    clock: { ...explorerInput.clock, initialTick: 1 },
  });
  assert.throws(
    () => advanceScenarioReplayClock(nearLimit, Number.MAX_SAFE_INTEGER),
    (error) => error instanceof ScenarioReplayContractError && error.issue.code === "CLOCK_OVERFLOW",
  );
  assert.throws(
    () => advanceScenarioReplayClock(valid, 0.5),
    (error) => error instanceof ScenarioReplayContractError && error.issue.code === "NON_NEGATIVE_SAFE_INTEGER_REQUIRED",
  );
});
