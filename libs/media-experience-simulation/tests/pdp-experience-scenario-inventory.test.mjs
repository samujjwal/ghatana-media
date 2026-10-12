import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createFixtureState, mediaExperienceScenarioIds, projectExperience } from "../dist/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const toolsRequire = createRequire(new URL("../../../../ghatana-tools/package.json", import.meta.url));
const { parse } = toolsRequire("yaml");
const scenarioRegistry = parse(await readFile(
  resolve(repoRoot, ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml"),
  "utf8",
));

test("PDP-3 scenario inventory has a deterministic seed or an explicit non-executable disposition", () => {
  const scenarios = scenarioRegistry.fixtures;
  const ids = scenarios.map(({ id }) => id);
  assert.equal(ids.length, 31, "the source scenario denominator changed");
  assert.equal(new Set(ids).size, ids.length, "scenario IDs must be unique");

  const intentionallyUnseeded = scenarios.filter(({ pdp3PayloadState }) =>
    pdp3PayloadState?.startsWith("proposal-only;"),
  );
  assert.deepEqual(intentionallyUnseeded.map(({ id }) => id), []);
  const retryEligible = scenarios.find(({ id }) => id === "media.scenario.job-retry-eligible");
  assert.match(retryEligible.pdp3PayloadState, /pre-dispatch-eligibility-fixture-seeded/u);
  assert.equal(retryEligible.eligibilityEvidenceStatus,
    "SOURCE_EVIDENCE_UNRESOLVED; CONDITIONAL_SCENARIO_NON_EXECUTABLE; ORACLE_UNKNOWN");
  assert.match(retryEligible.pdp3PayloadState, /retry-request-not-dispatched/u);
  assert.match(retryEligible.pdp3PayloadState, /no-local-retry-reducer/u);

  const seededIds = ids.filter((id) => !intentionallyUnseeded.some((scenario) => scenario.id === id));
  assert.deepEqual([...mediaExperienceScenarioIds].sort(), [...seededIds].sort());

  for (const scenarioId of seededIds) {
    const source = scenarios.find(({ id }) => id === scenarioId);
    assert.ok(source.sourceFixtureRef, `${scenarioId} needs a source fixture identity`);
    assert.ok(source.initialConditions?.trim(), `${scenarioId} needs explicit initial conditions`);
    assert.ok(source.expected?.trim(), `${scenarioId} needs an expected definition outcome`);

    const first = createFixtureState(scenarioId);
    const replay = createFixtureState(scenarioId);
    assert.equal(first.scenarioId, scenarioId, `${scenarioId} seed must preserve its source identity`);
    const syntheticSeed = first.source?.synthetic
      ?? first.artifactIntake?.synthetic
      ?? first.artifactVerification?.synthetic
      ?? first.firstUse?.synthetic;
    assert.equal(syntheticSeed, true, `${scenarioId} must remain explicitly synthetic`);
    assert.deepEqual(first, replay, `${scenarioId} seed must be deterministic`);
  }

  assert.equal(createFixtureState("media.scenario.job-retry-eligible").retryEligibility, null,
    "the conditional retry scenario has no source-backed eligibility evidence");
});

test("scenario seeds stay limited to four journeys while all other journeys remain bounded oracles", () => {
  const audit = scenarioRegistry.unseededJourneyFixtureAudit;
  const coverage = scenarioRegistry.journeyCoverage;
  const seededJourneyIds = ["J-01", "J-02", "J-03", "J-20"];
  const selectedCandidateIds = ["J-04", "J-05", "J-07", "J-08", "J-09", "J-16", "J-18", "J-26"];

  assert.equal(coverage.journeyContractCount, 30);
  assert.equal(coverage.journeysWithOneOrMoreExactScenarioSeeds, 4);
  assert.equal(coverage.journeyContractsWithoutExactScenarioSeeds, 26);
  assert.deepEqual(coverage.journeysWithExactSimulationSeeds, seededJourneyIds);
  assert.equal(audit.planJourneyDenominator, 30);
  assert.equal(audit.scenarioSeededJourneyCount, 4);
  assert.equal(audit.unseededJourneyCount, 26);
  assert.equal(audit.records.length, 26);
  assert.ok(audit.status.includes("ALL_26_UNSEEDED_JOURNEYS_HAVE_BOUNDED_SYNTHETIC_DEFINITION_ORACLES"));

  const unseededById = new Map(audit.records.map((record) => [record.journeyRef, record]));
  assert.equal(unseededById.size, 26);
  for (const journeyId of selectedCandidateIds) {
    const record = unseededById.get(journeyId);
    assert.ok(record, `${journeyId} remains in the bounded-oracle-only set`);
    assert.deepEqual(record.scenarioRefs, [], `${journeyId} has no rich state seed without exact owner facts`);
    assert.ok(record.oracleSteps.length > 0, `${journeyId} retains its source-linked step oracles`);
    assert.ok(record.oracleSteps.every((step) => step.scenarioRefs.length === 0 &&
      step.fixtureOracleStatus === "EXACT_STEP_ORACLE_AND_FIXTURE_COVERAGE_LINKED"),
    `${journeyId} uses exact bounded step oracles without binding scenario state`);
    assert.match(record.fixtureDisposition, /^BOUNDED_SYNTHETIC_DEFINITION_FIXTURE;/u);
    assert.match(record.fixtureDisposition, /unbound start state and authority remain UNKNOWN/u);
    assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(record.ownerAcceptedOutcomeOracle, false);
  }

  for (const journeyId of seededJourneyIds) assert.ok(!unseededById.has(journeyId));
});

test("PDP-3 seeded scenarios enforce their declared denied, pending, and unknown outcomes", () => {
  for (const scenarioId of mediaExperienceScenarioIds) {
    const state = createFixtureState(scenarioId);
    const safeActions = new Set(projectExperience(state).safeActionIds);

    if (state.workflow === "first-use") {
      if (!state.firstUse.identityResolved || state.firstUse.workspaceAccess !== "ALLOWED") {
        assert.ok(!safeActions.has("media.action.create-project"), `${scenarioId} must not create without identity and workspace authority`);
      }
      if (state.firstUse.creationStatus === "OUTCOME_UNKNOWN") {
        assert.ok(safeActions.has("media.action.inspect-project-creation"), `${scenarioId} must reconcile the same request`);
        assert.ok(!safeActions.has("media.action.create-project"), `${scenarioId} must not blind-replay create`);
      }
      if (state.firstUse.creationStatus === "CREATED") {
        assert.ok(!safeActions.has("media.action.create-project"), `${scenarioId} must not offer duplicate creation`);
      }
    }

    if (state.artifactIntake) {
      if (state.artifactIntake.status === "OUTCOME_UNKNOWN") {
        assert.ok(safeActions.has("media.action.inspect-artifact"), `${scenarioId} must permit same-identity inspection`);
        assert.ok(!safeActions.has("media.action.resume-artifact-upload"), `${scenarioId} must not resume before reconciliation`);
      }
      if (state.artifactIntake.status !== "AVAILABLE") {
        assert.ok(!safeActions.has("media.action.request-transcription"), `${scenarioId} must not process an unavailable artifact`);
      }
      if (["REJECTED", "QUARANTINED", "ACCESS_REVOKED"].includes(state.artifactIntake.status)) {
        assert.ok(!safeActions.has("media.action.resume-artifact-upload"), `${scenarioId} must not transfer a terminal or isolated upload`);
      }
    }

    if (state.artifactVerification) {
      assert.ok(safeActions.has("media.action.view-job-status"), `${scenarioId} must observe the exact verification job`);
      assert.ok(!safeActions.has("media.action.request-transcription"), `${scenarioId} must not conflate verification with transcription`);
      if (state.artifactVerification.status === "OUTCOME_UNKNOWN") {
        assert.ok(safeActions.has("media.action.check-job-outcome"), `${scenarioId} must check the same verification job`);
        assert.ok(!safeActions.has("media.action.request-cancellation"), `${scenarioId} must not infer cancellation eligibility from unknown finality`);
      }
    }

    if (state.workflow === "transcription") {
      if (state.consentState === "REVOKED" || state.access.processSource !== "ALLOWED") {
        assert.ok(!safeActions.has("media.action.request-transcription"), `${scenarioId} must fail closed after consent or processing authority is denied`);
      }
      if (state.job.finality === "UNKNOWN") {
        assert.ok(safeActions.has("media.action.check-job-outcome"), `${scenarioId} must check the same unknown job`);
        assert.ok(!safeActions.has("media.action.request-transcription"), `${scenarioId} must not duplicate an uncertain request`);
        assert.ok(!safeActions.has("media.action.retry-job"), `${scenarioId} must not retry an unknown attempt`);
        assert.ok(!safeActions.has("media.action.request-cancellation"), `${scenarioId} must not imply cancellation of an unknown attempt`);
      }
      if (state.job.finality === "PENDING") {
        assert.ok(safeActions.has("media.action.request-cancellation"), `${scenarioId} may expose a bounded cancellation request while running`);
        assert.equal(state.job.state, "RUNNING", `${scenarioId} cancellation request must not itself alter job finality`);
      }
    }
  }
});

test("PDP-3 step fixture links preserve all 31 source scenarios and their executable boundary", async () => {
  const journeyDir = resolve(repoRoot, ".product-experience/pdp-3-product-experience/journey-contracts");
  const { readdir } = await import("node:fs/promises");
  const fixtureById = new Map(scenarioRegistry.fixtures.map((fixture) => [fixture.id, fixture]));
  const linked = new Set();
  for (const filename of (await readdir(journeyDir)).filter((name) => name.endsWith(".yaml"))) {
    const journey = parse(await readFile(resolve(journeyDir, filename), "utf8"));
    for (const step of journey.steps) {
      const semantics = step.stepDefinitionSemantics;
      assert.ok(semantics?.fixtureOracle, `${journey.journeyId} step needs an explicit fixture disposition`);
      assert.deepEqual(step.scenarioRefs ?? [], semantics.canonicalBindings.scenarioRefs);
      assert.deepEqual(step.scenarioRefs ?? [], semantics.fixtureOracle.scenarioRefs);
      for (const scenario of semantics.fixtureOracle.scenarios) {
        const source = fixtureById.get(scenario.scenarioRef);
        assert.ok(source, `${scenario.scenarioRef} must exist in the scenario registry`);
        linked.add(source.id);
        assert.equal(scenario.initialConditions, source.initialConditions);
        assert.equal(scenario.expected, source.expected);
        assert.equal(scenario.pdp3PayloadState, source.pdp3PayloadState);
        assert.equal(semantics.fixtureOracle.executable, source.pdp3PayloadState === "authored-in-libs-media-experience-simulation-fixtures-ts");
      }
      if (semantics.fixtureOracle.status === "DEFINITION_CHOICE_ORACLE_BOUND; SYNTHETIC_FIXTURE_NOT_BOUND") {
        assert.equal(step.scenarioRefs?.length ?? 0, 0);
        assert.equal(semantics.fixtureOracle.executable, true);
        assert.ok(semantics.fixtureOracle.cases.length > 0);
        assert.equal(semantics.fixtureOracle.executionBoundary.includes("no action dispatch"), true);
      } else if (step.scenarioRefs?.length) assert.equal(semantics.fixtureOracle.status, "STEP_SCENARIOS_BOUND; ORACLE_ACCEPTANCE_PENDING");
      else assert.equal(semantics.fixtureOracle.status, "NO_STEP_SCENARIO_BOUND");
    }
  }
  assert.deepEqual([...linked].sort(), [...fixtureById.keys()].sort(), "every registered scenario must be allocated to an exact journey step");
});

test("J-08 local source selection declares an unseeded, conditional fixture disposition", async () => {
  const journey = parse(await readFile(
    resolve(repoRoot, ".product-experience/pdp-3-product-experience/journey-contracts/repair-video-with-measured-quality.yaml"),
    "utf8",
  ));
  const step = journey.steps[0];
  const semantics = step.stepDefinitionSemantics;
  assert.equal(journey.journeyId, "J-08");
  assert.equal(semantics.ordinal, 1);
  assert.equal(semantics.action.actionRef, "media.action.choose-source");
  assert.deepEqual(step.scenarioRefs ?? [], []);
  assert.deepEqual(semantics.canonicalBindings.scenarioRefs, []);

  const oracle = semantics.fixtureOracle;
  assert.equal(oracle.status, "NO_STEP_SCENARIO_BOUND");
  assert.equal(oracle.journeyRef, "J-08");
  assert.deepEqual(oracle.scenarioRefs, []);
  assert.deepEqual(oracle.scenarios, []);
  assert.equal(oracle.conditionalDisposition,
    "NO_SEEDED_SCENARIO; NON_EXECUTABLE_UNTIL_SOURCE_LINKED_FIXTURE_EXISTS");
  assert.equal(oracle.executable, false);
  assert.equal(oracle.ownerOracleAcceptance, "NOT_ESTABLISHED");
  assert.equal(Object.hasOwn(oracle, "cases"), false, "no synthetic outcome cases may be invented");
});
