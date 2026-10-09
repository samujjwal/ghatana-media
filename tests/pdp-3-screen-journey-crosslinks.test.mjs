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

function assertOperationRequiresAction(step, label, journeyId, operationById, ownerActionById = new Map()) {
  if (!step.action && !step.actionRef) {
    const operationRef = step.canonicalOperationRef ?? null;
    if (operationRef === null) return;
    if (step.ownerActionRef) {
      const ownerAction = ownerActionById.get(step.ownerActionRef);
      assert.ok(ownerAction, `${label} owner action is an exact registered action`);
      assert.equal(ownerAction.operationRef, operationRef, `${label} owner action and operation identity agree`);
      assert.equal(ownerAction.runtimeAdmission, "NOT_ADMITTED", `${label} owner action remains definition-only`);
      return;
    }
    const allowedJ01Queries = {
      "J01-2": { view: "media.view.resume-work", operationRef: "media.operation-slice.list-projects" },
      "J01-4": { view: "media.view.work-in-project", operationRef: "media.operation-slice.inspect-project" },
    };
    const allowedQuery = journeyId === "J-01" ? allowedJ01Queries[step.stepId] : null;
    if (!allowedQuery || step.view !== allowedQuery.view || operationRef !== allowedQuery.operationRef) {
      assert.fail(`${label} cannot bind an operation without an explicit action`);
    }
    const operation = operationById.get(operationRef);
    assert.equal(operation?.operationKind, "QUERY", `${label} operation without an action must be a read-only query`);
    assert.equal(operation?.executionAdmission, "NOT_ADMITTED", `${label} query remains definition-only`);
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
  const ownerActions = actions.ownerDefinedActions ?? [];
  const actionIds = new Set([...actions.actions, ...ownerActions].map((action) => action.id));
  const operationRecords = [
    ...(operations.operations ?? []),
    ...(operations.individualOperationContracts?.records ?? []),
    ...(operations.ownerDefinedOperationContracts?.records ?? []),
    ...(operations.capabilityOperationContracts?.records ?? []),
  ];
  const operationIds = new Set(operationRecords.map((operation) => operation.id));
  const operationById = new Map(operationRecords.map((operation) => [operation.id, operation]));
  const ownerActionById = new Map(ownerActions.map((action) => [action.id, action]));
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
    const stepScenarioRefs = (contract.steps ?? []).flatMap((step, index) => {
      const refs = step.scenarioRefs ?? [];
      assertUniqueKnownRefs(refs, scenarioIds, `${journey.id}.steps[${index}].scenarioRefs`);
      return refs;
    });
    const declaredScenarioRefs = new Set([...(contract.scenarioRefs ?? []), ...stepScenarioRefs]);
    assert.equal(declaredScenarioRefs.size > 0, seededJourneyIds.has(journey.id),
      `${journey.id} top-level plus exact step-level scenario links must agree with the exact-seed coverage register`);
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
      assertOperationRequiresAction(step, `${journey.id} step ${step.view}`, journey.id, operationById, ownerActionById);
    }
  }
  assert.equal(stepCount, 130);
  assert.equal(seededJourneyIds.size, 4);
  assert.equal(linkedSteps, 130);
  assert.equal(unresolvedViewSteps, 0);
  assert.equal(journeys.coverageObservation.stepBindings.screenContractRef.blocker.startsWith("none;"), true);
  assert.equal(linkedViewJourneyRefs, 132);
  assert.deepEqual({ actionLinks, requirementLinks, capabilityLinks, outcomeLinks, operationLinks }, {
    // `step.action` is the retained historical screen-consequence subset. The
    // current 120 action/actionRef bindings and one owner action are asserted
    // separately against currentStepBindingObservation below.
    actionLinks: 18, requirementLinks: 40, capabilityLinks: 41, outcomeLinks: 72, operationLinks: 95,
  });
});

test("PDP-3 coverage preserves historical action counts and exposes current per-step dispositions", () => {
  const journeys = readYaml(`${experience}/journey-registry.yaml`);
  const historical = journeys.coverageObservation;
  const observation = journeys.currentStepBindingObservation;
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
  assert.equal(actionBindings.length, 120, "current exact source action refs are counted by occurrence");
  let ownerActionBindings = 0;
  let explicitChoiceSets = 0;
  let passiveQueries = 0;
  let noDispatchGates = 0;
  for (const journey of journeys.journeys) {
    const contract = readYaml(`${experience}/${journey.contract}`);
    for (const step of contract.steps ?? []) {
      const semantics = step.stepDefinitionSemantics;
      if (step.ownerActionRef) ownerActionBindings++;
      if (semantics?.action?.choiceSet || semantics?.choiceSet) explicitChoiceSets++;
      if (semantics?.bindingStatus === "PASSIVE_CANONICAL_QUERY_NO_ACTION_DISPATCH") passiveQueries++;
      if (semantics?.action?.semanticRole === "NO_DOMAIN_DISPATCH_OBSERVATION_OR_GATE") noDispatchGates++;
    }
  }
  assert.equal(ownerActionBindings, 1);
  assert.equal(explicitChoiceSets, 5);
  assert.equal(passiveQueries, 1);
  assert.equal(noDispatchGates, 3);
  assert.equal(historical.status, "HISTORICAL_SOURCE_INVENTORY_SUPERSEDED_BY_CURRENT_STEP_BINDING_OBSERVATION; NOT_CURRENT");
  assert.equal(historical.historicalObservationDisposition.priorStepActionBindingCount, 18);
  assert.equal(historical.historicalObservationDisposition.priorUnresolvedStepActionBindingCount, 112);
  assert.equal(observation.orderedStepCount, stepCount);
  assert.deepEqual(observation.actionDispositionCounts, {
    exactSourceActionRef: actionBindings.length,
    ownerDefinedActionRef: ownerActionBindings,
    explicitUnselectedChoiceSet: explicitChoiceSets,
    passiveCanonicalQueryWithoutActionDispatch: passiveQueries,
    explicitNoDispatchObservationOrGate: noDispatchGates,
    unresolvedStepActionBinding: 0,
  });
  assert.equal(observation.acceptanceBoundary.includes("do not establish independent PDP-3 acceptance"), true);
  assert.equal(historical.stepBindings.screenContractRef.linked, screenContractRefCount);
  assert.equal(historical.stepBindings.screenContractRef.unresolved, stepCount - screenContractRefCount);
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
      const semanticAction = step.action ?? step.actionRef ?? null;
      const semantics = step.stepDefinitionSemantics;
      if (journeyId === "J-29" && index < 3) {
        assert.equal(semanticAction, null, `${journeyId}/${step.stepId} remains an explicit observation/gate without dispatch`);
        assert.equal(step.ownerActionRef, undefined);
        assert.equal(semantics.bindingStatus, "OWNER_DEFINED_LIVE_SESSION_RECOVERY_SEMANTICS; OPERATION_BINDING_AND_INDEPENDENT_REVIEW_OPEN");
        assert.equal(semantics.action.semanticRole, "NO_DOMAIN_DISPATCH_OBSERVATION_OR_GATE");
        assert.equal(semantics.canonicalBindings.canonicalOperationRef, null);
      } else if (journeyId === "J-29") {
        assert.equal(step.ownerActionRef, "media.action.request-live-session-reconnect");
        assert.equal(semantics.canonicalBindings.canonicalOperationRef, "media.operation.capability.media-stream-session-reconnect");
        assert.equal(semantics.action.runtimeAdmission, "NOT_ADMITTED");
        assert.match(semantics.bindingStatus, /PXD_077; INDEPENDENT_ACCEPTANCE_AND_RUNTIME_OPEN/u);
      } else {
        const expectedAction = index < 3
          ? "media.action.inspect-effective-processing-constraints"
          : "media.action.select-eligible-processing-profile";
        assert.equal(semanticAction, expectedAction, `${journeyId}/${step.stepId} preserves its current exact action source`);
        assert.equal(semantics.action.actionRef, expectedAction);
        assert.equal(semantics.action.runtimeAdmission, "NOT_ADMITTED");
        if (index < 3) {
          assert.equal(semantics.canonicalBindings.canonicalOperationRef, "media.operation.action.inspect-effective-processing-constraints");
        } else {
          assert.equal(semantics.canonicalBindings.canonicalOperationRef, null,
            "local profile selection does not inherit a domain operation by label");
        }
      }
    }
  }
  assert.equal(journeyRegistry.coverageObservation.stepBindings.screenContractRef.linked, 130);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.screenContractRef.unresolved, 0);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.screenContractRef.acceptance,
    undefined, "source mapping does not imply screen admission or behavior acceptance");
  assert.equal(journeyRegistry.currentStepBindingObservation.status,
    "CURRENT_SOURCE_INVENTORY_ONLY; INDEPENDENT_REVIEW_AND_RUNTIME_OPEN");
});

test("J-02 upload workflow binds exact slices and preserves verification authority", () => {
  const c=readYaml(`${experience}/journey-contracts/upload-import-and-verify-artifact.yaml`);
  const records=readYaml(".product-experience/pdp-1-domain-data/operations.yaml").individualOperationContracts.records;
  const ids=new Set(records.map(x=>x.id));
  assert.equal(c.runtimeAdmission,"NOT_ADMITTED");
  assert.equal(c.definitionReview.status,"SOURCE_DEFINED_OWNER_ACCEPTED");
  assert.match(c.definitionReview.boundary,/phase acceptance and runtime admission remain separate/u);
  assert.deepEqual(c.steps[1].requiredOperationRefs,["media.operation-slice.begin-upload"]);
  assert.equal(c.steps[1].transitionRef,null,"begin-upload creates/replays the upload session but does not complete it");
  assert.equal(c.steps[1].transitionDisposition.status,"NOT_APPLICABLE_TO_BEGIN_UPLOAD; NO_DOMAIN_TRANSITION");
  assert.match(c.steps[1].transitionDisposition.reason,/separate J02-3 resume workflow owns complete-upload/u);
  assert.equal(c.steps[1].stepDefinitionSemantics.canonicalBindings.transitionRef,null);
  assert.equal(c.steps[1].stepDefinitionSemantics.transitionApplicability.transitionRef,null);
  assert.equal(c.steps[2].transitionRef,"media-upload-and-artifact/T01","only complete-upload’s resume workflow can enter VERIFYING");
  assert.deepEqual(c.steps[2].resumeWorkflow.orderedOperationRefs,["media.operation-slice.inspect-upload","media.operation-slice.append-upload-chunk","media.operation-slice.complete-upload"]);
  assert.ok(c.steps[2].resumeWorkflow.guards.some(x=>x.includes("unknown")&&x.includes("never-authorizes")));
  assert.ok(c.steps[2].resumeWorkflow.guards.some(x=>x.includes("never-authorizes-append")&&x.includes("FINALIZING")));
  assert.deepEqual(c.steps.map(x=>x.actorRefs),Array(5).fill(["media.creator","media.editor"]));
  assert.deepEqual(c.steps.map(x=>x.transitionDisposition.status),["NOT_APPLICABLE_WITH_REASON","NOT_APPLICABLE_TO_BEGIN_UPLOAD; NO_DOMAIN_TRANSITION","APPLICABLE_WITH_BOUNDS","NOT_APPLICABLE_WITH_REASON","NOT_APPLICABLE_WITH_REASON"]);
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

test("J-01 passive project reads admit only their exact source identity, view, and unadmitted QUERY", () => {
  const valid = {
    stepId: "J01-2", view: "media.view.resume-work", canonicalOperationRef: "media.operation-slice.list-projects",
  };
  const queries = new Map([[valid.canonicalOperationRef, { operationKind: "QUERY", executionAdmission: "NOT_ADMITTED" }]]);
  assert.doesNotThrow(() => assertOperationRequiresAction(valid, "J-01 step 2", "J-01", queries));
  assert.throws(() => assertOperationRequiresAction({ ...valid, view: "media.view.work-in-project" }, "wrong view", "J-01", queries), /cannot bind/u);
  assert.throws(() => assertOperationRequiresAction({ ...valid, canonicalOperationRef: "media.operation-slice.inspect-project" }, "swapped query", "J-01", queries), /cannot bind/u);
  assert.throws(() => assertOperationRequiresAction({ ...valid, stepId: "J01-3" }, "wrong step", "J-01", queries), /cannot bind/u);
  assert.throws(() => assertOperationRequiresAction(valid, "wrong operation kind", "J-01", new Map([
    [valid.canonicalOperationRef, { operationKind: "COMMAND", executionAdmission: "NOT_ADMITTED" }],
  ])), /read-only query/u);
  assert.throws(() => assertOperationRequiresAction(valid, "admitted operation", "J-01", new Map([
    [valid.canonicalOperationRef, { operationKind: "QUERY", executionAdmission: "ADMITTED" }],
  ])), /definition-only/u);
});


test("PDP-3 step operation candidates follow the explicit PDP-1 action crosswalk and remain proposals", () => {
  const journeys = readYaml(`${experience}/journey-registry.yaml`);
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const actions = readYaml(`${experience}/action-registry.yaml`);
  const explicit = operations.sourceDenominators.uiProductActions.explicitOperationIds;
  const exact = operations.sourceDenominators.uiProductActions.exactOwnerReviewedSliceBindings;
  const selectedCandidateActions = new Set(Object.keys(explicit));
  const operationRecords = [
    ...(operations.operations ?? []),
    ...(operations.individualOperationContracts?.records ?? []),
    ...(operations.ownerDefinedOperationContracts?.records ?? []),
    ...(operations.capabilityOperationContracts?.records ?? []),
  ];
  const operationIds = new Set(operationRecords.map(({ id }) => id));
  const actionById = new Map(actions.actions.map((action) => [action.id, action]));
  let mappedOccurrences = 0;
  const mappedActionIds = new Set();
  for (const journey of journeys.journeys) {
    const contract = readYaml(`${experience}/${journey.contract}`);
    for (const step of contract.steps ?? []) {
      const actionRef = step.action ?? step.actionRef;
      if (!selectedCandidateActions.has(actionRef)) continue;
      const action = actionById.get(actionRef);
      assert.ok(action, `${actionRef} resolves to an authored action`);
      assert.equal(action.actionDefinitionSemantics.typedDefinition.runtimeAdmission, "NOT_ADMITTED",
        `${journey.id}/${actionRef} source candidate remains unadmitted`);
      const typedRefs = action.actionDefinitionSemantics.typedDefinition.exactOperationRefs;
      assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, typedRefs,
        `${journey.id}/${actionRef} step uses its exact current action operation set`);
      assert.ok(typedRefs.every((ref) => operationIds.has(ref)), `${journey.id}/${actionRef} operation refs resolve`);
      assert.ok(operationIds.has(explicit[actionRef]), `${journey.id}/${actionRef} retains its family-level source candidate`);
      if (step.canonicalOperationRef != null) {
        assert.ok(typedRefs.includes(step.canonicalOperationRef), `${journey.id}/${actionRef} canonical binding is an exact operation`);
      }
      for (const ref of step.requiredOperationRefs ?? []) {
        assert.ok(operationIds.has(ref), `${journey.id}/${actionRef} required operation ${ref} resolves`);
      }
      if (exact[actionRef]) {
        const exactRefs = actionRef === "media.action.resume-artifact-upload"
          ? exact.resumeWorkflow
          : [exact[actionRef]];
        assert.deepEqual(typedRefs, exactRefs, `${journey.id}/${actionRef} matches the exact owner-reviewed PDP-1 slice`);
      }
      if (journey.id === "J-03" && step.stepId === "J03-2") {
        assert.equal(step.decisionRef, ".product-experience/decision-log.md#PXD-072");
        assert.equal(step.sourceDecisionRef, ".product-experience/decision-log.md#PXD-070");
        assert.equal(step.grammarDecisionRef, ".product-experience/decision-log.md#PXD-071");
        assert.deepEqual(step.requiredOperationRefs, ["media.operation.transcription-submission"]);
        assert.deepEqual(step.stateRefs, []);
        assert.equal(step.transitionDisposition.transitionRef, null);
        assert.equal(step.definitionVerification?.runtimeAdmission, "NOT_ADMITTED");
        assert.equal(action.actionDefinitionSemantics.operationRef, "media.operation.transcription-submission");
        assert.equal(action.actionDefinitionSemantics.effectKind, "REQUEST_ACCEPTANCE");
        assert.equal(action.actionDefinitionSemantics.reversibility.kind, "UNKNOWN");
        assert.equal(action.actionDefinitionSemantics.publicEffect, undefined);
        assert.equal(action.actionDefinitionSemantics.publicFinality, undefined);
        assert.match(step.submissionSemantics.asynchronousBoundary, /no job state(?:, provider execution)?/u);
        assert.match(step.submissionSemantics.reconciliation, /separately rechecked current scoped receipt-read authority/u);
        assert.match(step.bindingStatus?.canonicalOperationRef ?? "", /SOURCE_DEFINED_OWNER_ACCEPTED/u);
      } else if (journey.id === "J-03" && step.stepId === "J03-4") {
        assert.equal(step.decisionRef, ".product-experience/decision-log.md#PXD-064");
        assert.equal(step.definitionVerification?.runtimeAdmission, "NOT_ADMITTED");
        assert.match(step.bindingStatus?.canonicalOperationRef ?? "", /query[- ]bound/u,
          "PXD-064 defines this exact read query while runtime admission remains pending");
      } else if (journey.id === "J-03" && ["J03-5", "J03-6"].includes(step.stepId)) {
        const expectedAction = step.stepId === "J03-5" ? "media.action.correct-caption" : "media.action.align-caption-timing";
        const expectedKind = step.stepId === "J03-5" ? "TEXT_CORRECTION" : "TIMING_ALIGNMENT";
        assert.equal(actionRef, expectedAction);
        assert.equal(step.decisionRef, ".product-experience/decision-log.md#PXD-068");
        assert.equal(step.sourceDecisionRef, ".product-experience/decision-log.md#PXD-066");
        assert.equal(step.grammarDecisionRef, ".product-experience/decision-log.md#PXD-067");
        assert.deepEqual(step.requiredOperationRefs, ["media.operation.caption-draft-write"]);
        assert.equal(step.draftEditSemantics.editKind, expectedKind);
        assert.equal(step.transitionDisposition.status, "NOT_APPLICABLE_WITH_REASON");
        assert.equal(step.transitionDisposition.transitionRef, null);
        assert.equal(step.definitionVerification?.runtimeAdmission, "NOT_ADMITTED");
        assert.equal(action.actionDefinitionSemantics.operationRef, "media.operation.caption-draft-write");
        assert.equal(action.actionDefinitionSemantics.effectKind, "LOCAL_DRAFT_UPDATE");
        assert.equal(action.actionDefinitionSemantics.reversibility.kind, "CONDITIONAL");
        assert.equal(action.actionDefinitionSemantics.publicBooleanDisposition, "PUBLIC_BOOLEAN_NOT_REPRESENTABLE");
        assert.equal(action.actionDefinitionSemantics.publicEffect, undefined);
        assert.equal(action.actionDefinitionSemantics.publicFinality, undefined);
        assert.match(step.bindingStatus?.canonicalOperationRef ?? "", /draft-write-bound/u);
      }
      mappedOccurrences++;
      mappedActionIds.add(actionRef);
    }
  }
  assert.equal(mappedActionIds.size, 13, "13 of the 14 family-level candidates occur in current journey steps");
  assert.equal(mappedOccurrences, 31, "count current mapped action occurrences, including actionRef-bound steps");
  assert.match(operations.scopeStatus, /proposal-only/u);
});
