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
  const operationIds = new Set([...operations.operations.map((operation) => operation.id), ...(operations.individualOperationContracts?.records ?? []).map((operation) => operation.id)]);
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
      assertUniqueKnownRefs(step.requiredOperationRefs ?? [], operationIds, `${journey.id}.requiredOperationRefs`);
      assertOperationRequiresAction(step, `${journey.id} step ${step.view}`);
    }
  }
  assert.equal(stepCount, 130);
  assert.equal(seededJourneyIds.size, 3);
  assert.equal(linkedSteps, 130);
  assert.equal(unresolvedViewSteps, 0);
  assert.equal(journeys.coverageObservation.stepBindings.screenContractRef.blocker.startsWith("none;"), true);
  assert.equal(linkedViewJourneyRefs, 132);
  assert.deepEqual({ actionLinks, requirementLinks, capabilityLinks, outcomeLinks, operationLinks }, {
    actionLinks: 18, requirementLinks: 20, capabilityLinks: 22, outcomeLinks: 72, operationLinks: 16,
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
  assert.equal(screenContractRefCount, 130);
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

test("PDP-3 J-29/J-30 step views use exact owner-selected source contracts and preserve proposal status", () => {
  const journeyRegistry = readYaml(`${experience}/journey-registry.yaml`);
  const sourceCatalog = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  const sourceById = new Map(sourceCatalog.journeys.map((journey) => [journey.id, journey]));
  const extensions = new Map(journeyRegistry.journeys
    .filter(({ id }) => ["J-29", "J-30"].includes(id))
    .map((journey) => [journey.id, readYaml(`${experience}/${journey.contract}`)]));

  assert.deepEqual([...extensions.keys()], ["J-29", "J-30"]);
  const expectedViews = {
    "J-29": [
      ["media.view.review-activity", "screen-contracts/review-activity.yaml", "media.intent.recover-live-session"],
      ["media.view.job-status", "screen-contracts/job-status.yaml", "media.intent.recover-live-session"],
      ["media.view.job-status", "screen-contracts/job-status.yaml", "media.intent.recover-live-session"],
      ["media.view.review-activity", "screen-contracts/review-activity.yaml", "media.intent.recover-live-session"],
    ],
    "J-30": [
      ["media.view.check-processing-options", "screen-contracts/check-processing-options.yaml", "media.intent.check-processing-options"],
      ["media.view.check-processing-options", "screen-contracts/check-processing-options.yaml", "media.intent.check-processing-options"],
      ["media.view.check-processing-readiness", "screen-contracts/check-processing-readiness.yaml", "media.intent.check-processing-readiness"],
      ["media.view.choose-eligible-processing-option", "screen-contracts/choose-eligible-processing-option.yaml", "media.intent.choose-eligible-processing-option"],
    ],
  };
  for (const [journeyId, contract] of extensions) {
    const source = sourceById.get(journeyId);
    assert.ok(source.viewRefs.length > 0, `${journeyId} retains its source-level PDP-0 view list`);
    assert.ok(contract.orderedViews.length > 0, `${journeyId} retains its journey-level PDP-3 ordered view list`);
    assert.deepEqual(contract.steps.map(({ stepId }) => stepId),
      journeyId === "J-29"
        ? ["detect-loss-or-consent-change", "fence-new-frame-submission", "reconcile-dispatched-frame-effects", "present-bounded-return-state"]
        : ["establish-scope-and-permissions", "inspect-profile-and-provider-dimensions", "preserve-unknown-or-unavailable-reasons", "return-eligible-options-with-provenance"],
      `${journeyId} preserves the authored step identities and order`);
    for (const [index, step] of contract.steps.entries()) {
      assert.deepEqual(
        [step.view, step.screenContractRef, step.intent],
        expectedViews[journeyId][index],
        `${journeyId}/${step.stepId} uses the selected exact source view and intent`,
      );
      assert.equal(step.action, undefined, `${journeyId}/${step.stepId} has no exact step-level action source`);
      assert.equal(step.actionRef, undefined, `${journeyId}/${step.stepId} has no exact step-level action source`);
    }
  }
  assert.equal(journeyRegistry.coverageObservation.stepBindings.screenContractRef.linked, 130);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.screenContractRef.unresolved, 0);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.screenContractRef.acceptance,
    undefined, "source mapping does not imply screen admission or behavior acceptance");
});

test("J-02 upload workflow binds exact slices and preserves verification authority", () => {
  const c=readYaml(`${experience}/journey-contracts/upload-import-and-verify-artifact.yaml`);
  const records=readYaml(".product-experience/pdp-1-domain-data/operations.yaml").individualOperationContracts.records;
  const ids=new Set(records.map(x=>x.id));
  assert.equal(c.runtimeAdmission,"NOT_ADMITTED");
  assert.equal(c.definitionReview.status,"SOURCE_DEFINED_OWNER_ACCEPTED");
  assert.match(c.definitionReview.boundary,/phase acceptance and runtime admission remain separate/u);
  assert.deepEqual(c.steps[1].requiredOperationRefs,["media.operation-slice.begin-upload","media.operation-slice.append-upload-chunk","media.operation-slice.complete-upload"]);
  assert.deepEqual(c.steps[2].resumeWorkflow.orderedOperationRefs,["media.operation-slice.inspect-upload","media.operation-slice.append-upload-chunk","media.operation-slice.complete-upload"]);
  assert.ok(c.steps[2].resumeWorkflow.guards.some(x=>x.includes("unknown")&&x.includes("never-authorizes")));
  assert.ok(c.steps[2].resumeWorkflow.guards.some(x=>x.includes("never-authorizes-append")&&x.includes("FINALIZING")));
  assert.deepEqual(c.steps.map(x=>x.actorRefs),Array(5).fill(["media.creator","media.editor"]));
  assert.deepEqual(c.steps.map(x=>x.transitionDisposition.status),["NOT_APPLICABLE_WITH_REASON","APPLICABLE_WITH_BOUNDS","APPLICABLE_WITH_BOUNDS","NOT_APPLICABLE_WITH_REASON","NOT_APPLICABLE_WITH_REASON"]);
  for(const step of c.steps)for(const ref of step.requiredOperationRefs??[])assert.ok(ids.has(ref),`unknown operation slice ${ref}`);
  assert.match(c.terminalSuccess,/T02/u); assert.match(c.terminalSuccess,/AVAILABLE only when verification authority records current positive evidence/u);
  assert.ok(c.steps[3].postconditions.some(x=>x.includes("Verification-authority evidence")));
});

test("PDP-3 navigation-only steps reject operation placeholders", () => {
  const navigationOnlyStep = { action: null, actionRef: null, canonicalOperationRef: null };
  assert.doesNotThrow(() => assertOperationRequiresAction(navigationOnlyStep, "J-test step 1"));
  assert.throws(() => assertOperationRequiresAction({
    ...navigationOnlyStep,
    canonicalOperationRef: "media.operation.job-lifecycle",
  }, "J-test step 1"), /cannot bind an operation without an explicit action/u);
});


test("PDP-3 step operation candidates follow the explicit PDP-1 action crosswalk and remain proposals", () => {
  const journeys = readYaml(`${experience}/journey-registry.yaml`);
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const explicit = operations.sourceDenominators.uiProductActions.explicitOperationIds;
  const exact = operations.sourceDenominators.uiProductActions.exactOwnerReviewedSliceBindings;
  const selectedCandidateActions = new Set(Object.keys(explicit));
  let mappedOccurrences = 0;
  const mappedActionIds = new Set();
  for (const journey of journeys.journeys) {
    const contract = readYaml(`${experience}/${journey.contract}`);
    for (const step of contract.steps ?? []) {
      if (!selectedCandidateActions.has(step.action)) continue;
      const exactCandidate = journey.id === "J-02" ? exact[step.action] : undefined;
      assert.equal(step.canonicalOperationRef, exactCandidate ?? explicit[step.action], `${journey.id}/${step.action} must match the exact PDP-1 crosswalk`);
      assert.match(step.bindingStatus?.canonicalOperationRef ?? "", /pending/u, `${journey.id}/${step.action} remains runtime-admission pending`);
      mappedOccurrences++;
      mappedActionIds.add(step.action);
    }
  }
  assert.equal(mappedActionIds.size, 13);
  assert.equal(mappedOccurrences, 16);
  assert.match(operations.scopeStatus, /proposal-only/u);
});
