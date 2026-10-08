import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const candidatePath = '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json';
const projection = JSON.parse(await readFile(candidatePath, 'utf8'));
const model = projection.candidateModel;
const goals = parse(await readFile('.product-experience/pdp-0-product-truth/goals-jtbd.yaml', 'utf8'));
const intentResolutions = parse(await readFile('.product-experience/pdp-0-product-truth/intent-resolutions.yaml', 'utf8'));
const journeyCatalog = parse(await readFile('.product-experience/pdp-0-product-truth/journey-catalog.yaml', 'utf8'));
const journeyResolutions = parse(await readFile('.product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml', 'utf8'));
const requirementSource = parse(await readFile('.product-experience/pdp-0-product-truth/requirements.yaml', 'utf8'));
const actorsAndResponsibilities = parse(await readFile('.product-experience/pdp-0-product-truth/actors-responsibilities.yaml', 'utf8'));
const constitution = parse(await readFile('.product-experience/pdp-0-product-truth/constitution.yaml', 'utf8'));

test('PDP-0 projects only the exact resolved P0-04 user intent actor and priority decisions', () => {
  const resolutions = new Map(intentResolutions.intents.map((item) => [item.id, item]));
  const actorIds = new Set(actorsAndResponsibilities.actors.map(({ id }) => id));
  assert.equal(resolutions.size, goals.intents.length, 'each source intent has exactly one resolution record');
  for (const intent of goals.intents) {
    const resolution = resolutions.get(intent.id);
    assert.ok(resolution, `${intent.id} has a resolution record`);
    assert.ok(['must', 'should', 'could', 'wont'].includes(resolution.priority), `${intent.id} has an explicit allowed priority`);
    assert.ok(resolution.priorityRationale?.length, `${intent.id} explains its priority decision`);
    assert.ok(resolution.priorityEvidenceRefs?.length, `${intent.id} cites priority evidence`);
    if (resolution.actorStatus === 'resolved') {
      assert.ok(actorIds.has(resolution.actorRef), `${intent.id} references a defined actor`);
      assert.ok(intent.actorRefs.includes(resolution.actorRef), `${intent.id} initiator is listed by its source intent`);
      assert.ok(resolution.actorRationale?.length, `${intent.id} explains its actor decision`);
      assert.ok(resolution.actorEvidenceRefs?.length, `${intent.id} cites actor evidence`);
    } else {
      assert.equal(resolution.actorStatus, 'unresolved', `${intent.id} uses an explicit resolution status`);
      assert.equal(resolution.actorRef, null, `${intent.id} does not fabricate an actor`);
    }
  }
  for (const intent of intentResolutions.intents) {
    for (const evidenceRef of [...(intent.actorEvidenceRefs ?? []), ...(intent.priorityEvidenceRefs ?? [])]) {
      const targetId = evidenceRef.match(/#\/intents\/(\d+)$/u)?.[1];
      if (targetId !== undefined) assert.ok(goals.intents[Number(targetId)], `${intent.id} evidence ${evidenceRef} resolves`);
    }
  }
  const expected = goals.intents.flatMap((intent) => {
    const resolution = resolutions.get(intent.id);
    return resolution.actorStatus === 'resolved'
      ? [{ id: intent.id, actor: resolution.actorRef, intent: intent.description, priority: resolution.priority }]
      : [];
  });
  assert.deepEqual(model.userIntents, expected);
  assert.equal(model.userIntents.length, 19);
  assert.equal(projection.candidateMappingReview.unresolvedUserIntentIds.length, 0);
  assert.ok(projection.sourceAuthorities.some(({ sourceRef }) => sourceRef.endsWith('/intent-resolutions.yaml')));
  assert.equal(projection.acceptance, 'NOT_CLAIMED');
});

test('PDP-0 preserves exact collaborator actor lists and only resolved initiating actors', () => {
  const resolutions = new Map(journeyResolutions.journeys.map((item) => [item.id, item]));
  assert.equal(resolutions.size, journeyCatalog.journeys.length, 'each source journey has exactly one actor resolution record');
  for (const resolution of journeyResolutions.journeys) {
    const journey = journeyCatalog.journeys.find(({ id }) => id === resolution.id);
    assert.ok(journey, `${resolution.id} is a source journey`);
    assert.deepEqual(resolution.collaboratorActorRefs, journey.actors, `${resolution.id} retains all and only source collaborators in source order`);
    assert.equal(new Set(resolution.collaboratorActorRefs).size, resolution.collaboratorActorRefs.length, `${resolution.id} has no duplicate collaborators`);
    if (resolution.actorStatus === 'resolved') {
      assert.ok(journey.actors.includes(resolution.initiatingActorRef), `${resolution.id} initiator is a source collaborator`);
      assert.ok(resolution.rationale?.length, `${resolution.id} explains its initiating actor`);
      assert.ok(resolution.evidenceRefs?.length, `${resolution.id} cites actor evidence`);
    } else {
      assert.equal(resolution.actorStatus, 'unresolved', `${resolution.id} uses an explicit resolution status`);
      assert.equal(resolution.initiatingActorRef, null, `${resolution.id} does not fabricate an initiating actor`);
    }
  }
  const expected = journeyCatalog.journeys.map((journey) => {
    const resolution = resolutions.get(journey.id);
    return [{
      id: journey.id,
      name: journey.title,
      ...(resolution.actorStatus === 'resolved' ? { actorRef: resolution.initiatingActorRef } : {}),
      actorRefs: resolution.collaboratorActorRefs,
      steps: [journey.preconditions, journey.completion],
      ...(journey.outcomeRefs?.length === 1 ? { desiredOutcomeRef: journey.outcomeRefs[0] } : {}),
    }];
  }).flat();
  assert.deepEqual(model.journeys, expected);
  assert.equal(model.journeys.length, 30);
  assert.equal(model.journeys.filter(({ actorRef }) => actorRef !== undefined).length, 30);
  assert.equal(model.journeys.filter(({ actorRef }) => actorRef === undefined).length, 0);
  assert.equal(model.journeys.reduce((count, journey) => count + journey.actorRefs.length, 0), 95);
  for (const journey of model.journeys) {
    assert.equal(new Set(journey.actorRefs).size, journey.actorRefs.length, `${journey.id} has no duplicate source actor refs`);
    if (journey.actorRef) assert.ok(journey.actorRefs.includes(journey.actorRef), `${journey.id} primary actor is a source collaborator`);
  }
  assert.equal(projection.candidateMappingReview.unresolvedJourneyIds.length, 0);
  assert.deepEqual(
    new Set(projection.candidateMappingReview.unresolvedJourneyIds),
    new Set(journeyCatalog.journeys.filter(({ id }) => resolutions.get(id).actorStatus !== 'resolved').map(({ id }) => id)),
  );
  assert.ok(projection.sourceAuthorities.some(({ sourceRef }) => sourceRef.endsWith('/journey-actor-resolutions.yaml')));
});

test('PDP-0 requirement trace targets are limited to resolvable intents and unresolved targets stay in the review', () => {
  const resolved = new Set(model.userIntents.map(({ id }) => id));
  const unresolved = new Map(projection.candidateMappingReview.intentTracesWithUnresolvedTargets.map((item) => [item.requirementId, item.unresolvedIntentRefs]));
  for (const requirement of requirementSource.requirements) {
    const projected = model.requirements.find(({ id }) => id === requirement.id);
    assert.deepEqual(projected.traceToIntentIds, requirement.traceToIntentIds.filter((id) => resolved.has(id)));
    for (const target of projected.traceToIntentIds) assert.ok(resolved.has(target));
  }
  assert.equal(projection.candidateMappingReview.intentTracesWithUnresolvedTargets.length, 0);
  assert.equal([...unresolved.values()].flat().length, 0);
});

test('PDP-0 maps owner-resolved invariants, trust contexts, and accountability without merging authority types', () => {
  assert.deepEqual(model.invariants, constitution.invariants.records.map(({ id, statement, violation }) => ({ id, statement, violation })));
  const expectedTrustContexts = actorsAndResponsibilities.trustContexts.contexts.map((context) => ({
    id: context.id,
    level: context.trustLevel,
    description: `${context.dataSensitivity}; ${context.effectScope}. ${context.auditRationale}`,
    auditRequired: context.auditRequired,
  }));
  assert.deepEqual(model.trustContexts, expectedTrustContexts);
  const expectedOwnership = actorsAndResponsibilities.ownershipRules.rules.map((rule) => ({
    id: rule.id,
    concern: rule.concern,
    owner: rule.accountableRoleRef,
  }));
  assert.deepEqual(model.ownershipRules, expectedOwnership);
  assert.deepEqual(projection.candidateMappingReview.ownershipRuleDetails, actorsAndResponsibilities.ownershipRules.rules.map((rule) => ({
    id: rule.id,
    accountableRoleRef: rule.accountableRoleRef,
    executionAuthority: rule.executionAuthority,
    contractOwner: rule.contractOwner ?? null,
    bindingStatus: rule.bindingStatus ?? null,
  })));
  assert.equal(model.invariants.length, 7);
  assert.equal(model.trustContexts.length, 4);
  assert.equal(model.ownershipRules.length, 5);
  assert.equal(projection.candidateMappingReview.ownerDecisionStatus.includes('PENDING'), true);
});
