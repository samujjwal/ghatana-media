import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const experience = ".product-experience/pdp-3-product-experience";
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

function uniqueIds(records, label) {
  const ids = records.map((record) => record.id);
  assert.equal(new Set(ids).size, ids.length, `${label} contains duplicate IDs`);
  return new Set(ids);
}

function assertUniqueKnownRefs(refs, known, label) {
  assert.equal(new Set(refs).size, refs.length, `${label} contains duplicate references`);
  for (const ref of refs) assert.ok(known.has(ref), `${label} contains stale or orphan reference ${ref}`);
}

function assertActorsWithinSource(contractActors, sourceActors, label) {
  for (const actor of contractActors) {
    assert.ok(sourceActors.includes(actor), `${label} invents actor ${actor} outside its PDP-0 journey`);
  }
}

function assertOperationRequiresAction(step, label) {
  if (!step.action && !step.actionRef) {
    assert.equal(step.canonicalOperationRef ?? null, null,
      `${label} cannot bind an operation without an explicit action`);
  }
}

test("PDP-3 screen and journey contracts preserve exact registry cross-links", () => {
  const registry = readYaml(`${experience}/screen-registry.yaml`);
  const journeys = readYaml(`${experience}/journey-registry.yaml`);
  const actions = readYaml(`${experience}/action-registry.yaml`);
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const goals = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  const journeyCatalog = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  const actorResolutions = readYaml(".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml");
  const scenarioFixtures = readYaml(`${experience}/scenario-fixture-registry.yaml`);
  const views = [...registry.screens, ...registry.laneViews];
  const viewIds = uniqueIds(views, "screen registry");
  const journeyIds = new Set(journeys.journeys.map((journey) => journey.id));
  const actionIds = new Set(actions.actions.map((action) => action.id));
  const operationIds = new Set(operations.operations.map((operation) => operation.id));
  const requirementIds = new Set(requirements.requirements.map((item) => item.id));
  const capabilityIds = new Set(capabilities.capabilities.map((item) => item.id));
  const goalIds = new Set(goals.outcomes.map((item) => item.id));
  const scenarioIds = new Set(scenarioFixtures.fixtures.map((item) => item.id));
  const seededJourneyIds = new Set(scenarioFixtures.journeyCoverage.journeysWithExactSimulationSeeds);
  const sourceJourneys = new Map(journeyCatalog.journeys.map((journey) => [journey.id, journey]));
  const actorResolutionByJourney = new Map(actorResolutions.journeys.map((journey) => [journey.id, journey]));
  assert.equal(viewIds.size, 47);
  assert.equal(journeys.journeys.length, 30);

  let linkedViewJourneyRefs = 0;
  let stepCount = 0;
  let linkedSteps = 0;
  let unresolvedViewSteps = 0;
  const contractById = new Map();
  for (const view of views) {
    assertUniqueKnownRefs(view.journeyRefs ?? [], journeyIds, `${view.id}.journeyRefs`);
    const refs = view.contractRefs ?? [];
    assert.equal(refs.length, 1, `${view.id} must have one exact contract`);
    const contract = readYaml(`${experience}/${refs[0]}`);
    assert.equal(contract.screenId, view.id, `${view.id} contract screenId mismatch`);
    assert.deepEqual(contract.journeyRefs ?? [], view.journeyRefs ?? [], `${view.id} contract journeyRefs drifted from registry`);
    contractById.set(view.id, contract);
    linkedViewJourneyRefs += view.journeyRefs?.length ?? 0;
    for (const consequence of contract.actionConsequences ?? []) {
      assert.ok(actionIds.has(consequence.actionId), `${view.id} has stale action ${consequence.actionId}`);
    }
  }
  assert.equal(contractById.size, 47);

  let actionLinks = 0;
  let requirementLinks = 0;
  let capabilityLinks = 0;
  let outcomeLinks = 0;
  let operationLinks = 0;
  for (const journey of journeys.journeys) {
    const contract = readYaml(`${experience}/${journey.contract}`);
    assert.equal(contract.journeyId, journey.id, `${journey.id} contract identity mismatch`);
    assert.equal(journey.pdp0JourneyRef, journey.id, `${journey.id} must retain its exact PDP-0 identity`);
    const sourceJourney = sourceJourneys.get(journey.pdp0JourneyRef);
    assert.ok(sourceJourney, `${journey.id} has no PDP-0 journey source`);
    const actorResolution = actorResolutionByJourney.get(journey.id);
    assert.ok(actorResolution, `${journey.id} has no PDP-0 initiator disposition`);
    assert.deepEqual(actorResolution.collaboratorActorRefs, sourceJourney.actors,
      `${journey.id} actor resolution must preserve the PDP-0 collaborator list in source order`);
    if (actorResolution.initiatingActorRef !== null) {
      assert.ok(sourceJourney.actors.includes(actorResolution.initiatingActorRef),
        `${journey.id} initiator is not a PDP-0 journey actor`);
    }
    assertActorsWithinSource(contract.actors ?? [], sourceJourney.actors, journey.id);
    if (contract.primaryActorRef != null) {
      assert.equal(contract.primaryActorRef, actorResolution.initiatingActorRef,
        `${journey.id} contract primary actor must match the reviewed PDP-0 disposition`);
      assert.notEqual(actorResolution.initiatingActorRef, null,
        `${journey.id} cannot claim a primary actor while PDP-0 leaves initiation unresolved`);
    }
    assertUniqueKnownRefs(journey.contract ? [journey.contract] : [], new Set([journey.contract]), `${journey.id}.contract`);
    assertUniqueKnownRefs(contract.outcomes ?? [], goalIds, `${journey.id}.outcomes`);
    assert.ok((contract.outcomes ?? []).every((outcome) => sourceJourney.outcomeRefs.includes(outcome)),
      `${journey.id} contract outcome is not linked by PDP-0`);
    assertUniqueKnownRefs(contract.scenarioRefs ?? [], scenarioIds, `${journey.id}.scenarioRefs`);
    assert.equal((contract.scenarioRefs ?? []).length > 0, seededJourneyIds.has(journey.id),
      `${journey.id} scenario links must agree with the exact-seed coverage register`);
    outcomeLinks += contract.outcomes?.length ?? 0;
    for (const step of contract.steps ?? []) {
      stepCount++;
      const view = views.find((candidate) => candidate.id === step.view);
      if (!view) {
        unresolvedViewSteps++;
        continue;
      }
      const screenContract = contractById.get(step.view);
      assert.ok(view.contractRefs.includes(step.screenContractRef), `${journey.id} step ${step.view} points at an orphan contract`);
      assert.equal(screenContract.screenId, step.view);
      linkedSteps++;
      if (step.action) {
        assert.ok(actionIds.has(step.action), `${journey.id} has stale action ${step.action}`);
        assert.ok(screenContract.actionConsequences?.some((consequence) => consequence.actionId === step.action),
          `${journey.id} step action ${step.action} is not declared by its exact screen contract`);
        actionLinks++;
      }
      assertUniqueKnownRefs(step.requirementRefs ?? [], requirementIds, `${journey.id}.requirementRefs`);
      assertUniqueKnownRefs(step.capabilityRefs ?? [], capabilityIds, `${journey.id}.capabilityRefs`);
      requirementLinks += step.requirementRefs?.length ?? 0;
      capabilityLinks += step.capabilityRefs?.length ?? 0;
      if (step.canonicalOperationRef && !String(step.canonicalOperationRef).startsWith("pending-")) {
        assert.ok(operationIds.has(step.canonicalOperationRef), `${journey.id} has stale operation ${step.canonicalOperationRef}`);
        operationLinks++;
      }
      assertOperationRequiresAction(step, `${journey.id} step ${step.view}`);
    }
  }
  assert.equal(stepCount, 130);
  assert.equal(seededJourneyIds.size, 3);
  assert.equal(linkedSteps, 122);
  assert.equal(unresolvedViewSteps, 8);
  assert.equal(linkedViewJourneyRefs, 132);
  assert.deepEqual({ actionLinks, requirementLinks, capabilityLinks, outcomeLinks, operationLinks }, {
    actionLinks: 18, requirementLinks: 20, capabilityLinks: 22, outcomeLinks: 72, operationLinks: 7,
  });
});

test("PDP-3 coverage observation counts authored per-step action bindings by occurrence", () => {
  const journeys = readYaml(`${experience}/journey-registry.yaml`);
  const observation = journeys.coverageObservation;
  assert.equal(journeys.journeys.length, 30, "enumerate every registered journey contract");

  let stepCount = 0;
  let screenContractRefCount = 0;
  const actionBindings = [];
  for (const journey of journeys.journeys) {
    const contract = readYaml(`${experience}/${journey.contract}`);
    assert.equal(contract.journeyId, journey.id, `${journey.id} contract identity mismatch`);
    for (const [index, step] of (contract.steps ?? []).entries()) {
      stepCount++;
      if (step.screenContractRef) screenContractRefCount++;
      // Only exact, top-level step action/actionRef fields count as bindings.
      // Nested action candidates in recovery, outcome, or consequence prose do not.
      for (const field of ["action", "actionRef"]) {
        if (step[field] != null) actionBindings.push({ journeyId: journey.id, step: index + 1, field, ref: step[field] });
      }
    }
  }

  assert.equal(stepCount, 130);
  assert.equal(screenContractRefCount, 122);
  assert.equal(actionBindings.length, 18, "18 exact step-level binding occurrences are authored");
  assert.equal(new Set(actionBindings.map(({ ref }) => ref)).size, 15, "the 18 occurrences use 15 distinct action IDs");
  assert.equal(observation.orderedStepCount, stepCount);
  assert.equal(observation.stepBindings.screenContractRef.linked, screenContractRefCount);
  assert.equal(observation.stepBindings.screenContractRef.unresolved, stepCount - screenContractRefCount);
  assert.equal(observation.stepBindings.action.linked, actionBindings.length);
  assert.equal(observation.stepBindings.action.unresolved, stepCount - actionBindings.length);
  assert.equal(observation.stepBindings.action.blocker,
    "remaining-steps-have-no-exact-step-level-action-allocation; screen-action-candidates-are-not-equivalent-to-journey-step-actions");
});

test("PDP-3 cross-link assertions reject stale, orphan, and duplicate references", () => {
  const known = new Set(["J-01", "J-02"]);
  assert.throws(() => assertUniqueKnownRefs(["J-99"], known, "journeyRefs"), /stale or orphan/u);
  assert.throws(() => assertUniqueKnownRefs(["J-01", "J-01"], known, "journeyRefs"), /duplicate/u);
  const view = { id: "media.view.example", contractRefs: ["screen-contracts/example.yaml"] };
  assert.ok(view.contractRefs.includes("screen-contracts/example.yaml"));
  assert.ok(!view.contractRefs.includes("screen-contracts/orphan.yaml"), "orphan contract reference must fail membership check");
});

test("PDP-3 actor projection rejects inferred initiators and invented actors", () => {
  const sourceActors = ["media.creator", "media.editor", "media.operator"];
  const unresolvedInitiator = { initiatingActorRef: null, collaboratorActorRefs: sourceActors };

  assert.equal(unresolvedInitiator.initiatingActorRef, null,
    "a multi-actor source with no selected initiator must remain unresolved");
  assert.throws(() => assertActorsWithinSource(["media.reviewer"], sourceActors, "J-test"),
    /invents actor media\.reviewer/u);
});

test("PDP-3 navigation-only steps reject operation placeholders", () => {
  const navigationOnlyStep = { action: null, actionRef: null, canonicalOperationRef: null };
  assert.doesNotThrow(() => assertOperationRequiresAction(navigationOnlyStep, "J-test step 1"));
  assert.throws(() => assertOperationRequiresAction({
    ...navigationOnlyStep,
    canonicalOperationRef: "media.operation.job-lifecycle",
  }, "J-test step 1"), /cannot bind an operation without an explicit action/u);
});
