import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const parse = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const base = '.product-experience/pdp-3-product-experience';
const read = (path) => parse(readFileSync(path, 'utf8'));
const registry = read(`${base}/screen-registry.yaml`);
const actionDoc = read(`${base}/action-registry.yaml`);
const actions = new Map([
  ...(actionDoc.actions ?? []).map((action) => [action.id, { action, collection: 'actions' }]),
  ...(actionDoc.ownerDefinedActions ?? []).map((action) => [action.id, { action, collection: 'ownerDefinedActions' }]),
]);
const operationDoc = read('.product-experience/pdp-1-domain-data/operations.yaml');
const wireContracts = read('.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml').records;
const wireByAction = new Map(wireContracts.map((record) => [record.actionRef, record]));
const fixtureDoc = read(`${base}/scenario-fixture-registry.yaml`);
const fixtures = new Set(fixtureDoc.fixtures.map(({ id }) => id));
const scenarioBindings = read(`${base}/journey-scenario-bindings.yaml`).records;
const scenarioByScreen = new Map();
for (const binding of scenarioBindings) {
  for (const stepRef of binding.journeyContractStepRefs ?? []) {
    const match = stepRef.match(/^(.*)#\/steps\/(\d+)$/u);
    if (!match) continue;
    const journey = read(match[1]);
    const step = journey.steps?.[Number(match[2])];
    const viewRef = step?.view ?? step?.viewRef;
    if (!viewRef) continue;
    const refs = scenarioByScreen.get(viewRef) ?? new Set();
    refs.add(binding.scenarioRef);
    scenarioByScreen.set(viewRef, refs);
  }
}
const journeyFiles = readdirSync(`${base}/journey-contracts`).map((name) => `${base}/journey-contracts/${name}`);
const journeyStepsByView = new Map();
for (const file of journeyFiles) {
  const journey = read(file);
  for (const step of journey.steps ?? []) {
    const viewRef = step.view ?? step.viewRef;
    if (!viewRef) continue;
    const rows = journeyStepsByView.get(viewRef) ?? [];
    rows.push({ journeyRef: journey.journeyId, step });
    journeyStepsByView.set(viewRef, rows);
  }
}
const canonicalDomains = new Set(read('.product-experience/pdp-1-domain-data/domain-objects.yaml').objects.map(({ id }) => id));
const tokenAliases = new Set(read('.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml').aliases.map(({ id }) => id));
const recipes = read('.product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml').recipes;
const templates = read('.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml').templates;
const layouts = read('.product-experience/pdp-2-design-interface-system/gui/layout.yaml').layouts;
const components = new Set(read('.product-experience/pdp-2-design-interface-system/component-contracts.yaml').components.map(({ id }) => id));
const accessibility = read('.product-experience/pdp-2-design-interface-system/accessibility.yaml');
const screenSchema = read(`${base}/screen-contract-schema.yaml`);
const actorAuthority = read('.product-experience/pdp-0-product-truth/actors-responsibilities.yaml');
const principalKindById = new Map(actorAuthority.principals.map(({ id, kind }) => [id, kind]));
const humanUsageActorIds = new Set(actorAuthority.actors
  .filter(({ principalRef }) => principalKindById.get(principalRef) === 'human')
  .map(({ id }) => id));
const keyboardRule = accessibility.accessibilityRules.find(({ id }) => id === 'media.a11y.keyboard-equivalence');
const viewStateDispositions = new Map(read(`${base}/view-state-binding-dispositions.yaml`).views.map((record) => [record.viewRef, record]));
const sourceOps = new Set([
  ...(operationDoc.operations ?? []).map((record) => record.id),
  ...(operationDoc.individualOperationContracts?.records ?? []).map((record) => record.id),
  ...(operationDoc.ownerDefinedOperationContracts?.records ?? []).map((record) => record.id),
  ...(operationDoc.capabilityOperationContracts?.records ?? []).flatMap((record) => record.operationRefs ?? []),
  ...[...actions.values()].flatMap(({ action }) => action.actionDefinitionSemantics?.typedDefinition?.exactOperationRefs ?? []),
  ...[...journeyStepsByView.values()].flat().flatMap(({ step }) => [step.canonicalOperationRef, ...(step.requiredOperationRefs ?? [])]).filter((item) => typeof item === 'string'),
]);
const contracts = new Map();
for (const screen of [...registry.screens, ...registry.laneViews]) {
  const file = `${base}/${screen.contractRefs[0]}`;
  contracts.set(screen.id, { file, doc: read(file) });
}

function exactActionRowErrors(screenId, row) {
  const errors = [];
  const found = actions.get(row.actionId);
  if (!found) return [`${screenId}: dangling action ${row.actionId}`];
  const typed = found.action.actionDefinitionSemantics?.typedDefinition;
  if (!typed) return [`${screenId}: missing typed definition ${row.actionId}`];
  const sourceRef = `${base}/action-registry.yaml#${found.collection}/@id=${row.actionId}/actionDefinitionSemantics/typedDefinition`;
  const exactOps = [...new Set(typed.exactOperationRefs ?? [])];
  if (row.effectRef !== sourceRef) errors.push(`${screenId}: ${row.actionId} has dangling or stale effectRef`);
  if (row.consequence !== typed.effect) errors.push(`${screenId}: ${row.actionId} effect drift`);
  if (JSON.stringify(row.operationRefs ?? []) !== JSON.stringify(exactOps)) errors.push(`${screenId}: ${row.actionId} exact operation refs drift`);
  if (row.operationRef !== (exactOps.length === 1 ? exactOps[0] : null)) errors.push(`${screenId}: ${row.actionId} singular operation ref drift`);
  if (row.finality !== typed.finality || row.reversibilityDisposition !== typed.reversibilityDisposition
    || row.confirmationDisposition !== typed.confirmationDisposition) errors.push(`${screenId}: ${row.actionId} finality/reversibility drift`);
  if (JSON.stringify(row.guardRefs ?? []) !== JSON.stringify(typed.applicabilityGuards ?? [])) errors.push(`${screenId}: ${row.actionId} guard refs drift`);
  if (row.failureRecovery !== typed.failureRecovery) errors.push(`${screenId}: ${row.actionId} recovery drift`);
  if (JSON.stringify(row.actorRefs ?? []) !== JSON.stringify(typed.actorRefs ?? [])) errors.push(`${screenId}: ${row.actionId} actor refs drift`);
  if (row.runtimeAdmission !== 'NOT_ADMITTED') errors.push(`${screenId}: ${row.actionId} claims runtime admission`);
  return errors;
}

function assertResolvedScreenEntryExit(screenId, doc) {
  for (const field of ['entry', 'exit']) {
    assert.ok((doc[field] ?? []).length > 0, `${screenId}: ${field} definition is present`);
    const status = doc.fieldBindingStatus?.[field];
    assert.equal(typeof status, 'string', `${screenId}: ${field} has a binding disposition`);
    assert.ok(status.trim().length > 0, `${screenId}: ${field} binding disposition is nonempty`);
    assert.doesNotMatch(status, /unresolved|no-canonical-reference-declared|no-direct-canonical-reference/iu,
      `${screenId}: ${field} disposition must resolve its required binding or state an applicable disposition`);
  }
}

function assertHumanScreenAudience(screenId, actors) {
  for (const actorId of actors ?? []) {
    assert.ok(humanUsageActorIds.has(actorId), `${screenId}: ${actorId} is not a human Web screen-audience actor`);
  }
}

test('47 screen contracts bind every action consequence to its exact typed action definition', () => {
  assert.equal(contracts.size, 47);
  let rowCount = 0;
  for (const [screenId, { doc }] of contracts) {
    assert.ok((doc.actionConsequences ?? []).length > 0, `${screenId} needs at least one action consequence`);
    for (const row of doc.actionConsequences) {
      rowCount++;
      assert.deepEqual(exactActionRowErrors(screenId, row), []);
    }
  }
  assert.equal(rowCount, 183);
});

test('47 screen action lists include every action with a declared consequence', () => {
  assert.equal(contracts.size, 47);
  for (const [screenId, { doc }] of contracts) {
    const listed = new Set(doc.actions ?? []);
    for (const { actionId } of doc.actionConsequences ?? []) {
      assert.ok(listed.has(actionId), `${screenId}: consequence action ${actionId} is missing from the allowed actions list`);
    }
  }
});

test('operation and token refs are exact or carry a narrow non-applicable disposition', () => {
  for (const [screenId, { doc }] of contracts) {
    const sourcedOps = new Set((doc.actionConsequences ?? []).flatMap((row) => row.operationRefs ?? []));
    for (const operation of doc.operationRefs ?? []) {
      assert.ok(sourceOps.has(operation), `${screenId}: dangling operation ${operation}`);
    }
    for (const operation of sourcedOps) assert.ok(doc.operationRefs.includes(operation), `${screenId}: missing sourced operation ${operation}`);
    if (!(doc.operationRefs ?? []).length) {
      assert.match(doc.operationBindingStatus ?? '', /NO_APPLICABLE/u, `${screenId}: empty operation refs need a reason`);
      assert.match(doc.operationBindingStatus ?? '', /negative/u, `${screenId}: operation non-applicability needs a negative case`);
    }
    for (const token of doc.tokenDependencies ?? []) assert.ok(tokenAliases.has(token), `${screenId}: dangling token alias ${token}`);
    if (!(doc.tokenDependencies ?? []).length) {
      assert.match(doc.tokenBindingStatus ?? '', /NO_APPLICABLE_SCREEN_LOCAL_TOKEN_DEPENDENCY/u, `${screenId}: empty token refs need a scoped disposition`);
      assert.match(doc.tokenBindingStatus ?? '', /negative/u, `${screenId}: token non-applicability needs a negative case`);
    }
  }
});

test('domain refs resolve and fixture applicability follows exact screen-step links or the P3-B/P3-F preview boundary', () => {
  for (const [screenId, { doc }] of contracts) {
    const steps = journeyStepsByView.get(screenId) ?? [];
    const expectedDomain = new Set([
      ...(doc.actionConsequences ?? []).flatMap((row) => wireByAction.get(row.actionId)?.domainObjectRefs ?? []),
      ...steps.flatMap(({ step }) => step.objectRefs ?? []),
    ]);
    for (const objectRef of doc.domainObjectRefs ?? []) {
      assert.ok(canonicalDomains.has(objectRef), `${screenId}: dangling domain object ${objectRef}`);
    }
    for (const objectRef of expectedDomain) {
      assert.ok(doc.domainObjectRefs.includes(objectRef), `${screenId}: missing exact source object ${objectRef}`);
    }
    if (!(doc.domainObjectRefs ?? []).length) {
      assert.match(doc.domainObjectBindingStatus ?? '', /NO_APPLICABLE|BLOCKED_EXACT_DOMAIN_OBJECT_CROSSWALK_MISSING/u, `${screenId}: empty domain refs need a typed disposition`);
      assert.match(doc.domainObjectBindingStatus ?? '', /negative/u, `${screenId}: empty domain refs need a negative case`);
    }
    const screenFixtures = scenarioByScreen.get(screenId) ?? new Set();
    for (const fixture of doc.fixtures?.refs ?? []) {
      assert.ok(fixtures.has(fixture), `${screenId}: dangling fixture ${fixture}`);
      if (!screenFixtures.has(fixture)) {
        assert.ok((doc.fixtures.unlinkedScreenFixtureRefs ?? []).includes(fixture), `${screenId}: unlinked fixture must be declared as a residual`);
        assert.match(doc.fixtures.status ?? '', /NO_APPLICABLE|unlinked refs are retained as proposals/u, `${screenId}: unlinked fixture status must identify the preview boundary`);
        assert.match(doc.fixtures.status ?? '', /negative/u, `${screenId}: unlinked fixture status needs a negative boundary`);
        assert.ok((doc.fixtures.negativeCases ?? []).length > 0, `${screenId}: unlinked fixture needs negative coverage`);
      }
    }
    if (!(doc.fixtures?.refs ?? []).length) {
      assert.match(doc.fixtures?.status ?? '', /NO_APPLICABLE_FIXTURE_FOR_P3B_CONTRACT_PREVIEW/u, `${screenId}: definition-only preview may have no fixture`);
      assert.match(doc.fixtures?.status ?? '', /P3-F/u, `${screenId}: preview disposition must cite P3-F`);
      assert.match(doc.fixtures?.status ?? '', /negative/u, `${screenId}: missing fixture needs a negative boundary`);
      assert.ok((doc.fixtures?.negativeCases ?? []).length > 0, `${screenId}: missing fixture needs a negative case`);
    }
  }
});


test('47 screens bind reciprocal P2 recipes, component contracts, responsive rules, keyboard semantics, and display-state dispositions', () => {
  assert.equal(contracts.size, 47);
  assert.ok(keyboardRule, 'the P2 keyboard-equivalence rule resolves');
  for (const [screenId, { doc }] of contracts) {
    const template = templates.find(({ id }) => id === doc.templateId);
    assert.ok(template, `${screenId}: exact template resolves`);
    const exactRecipes = recipes.filter(({ templateRef }) => templateRef === doc.templateId);
    assert.equal(exactRecipes.length, 1, `${screenId}: template has one exact recipe`);
    assert.deepEqual(doc.recipeIds, [exactRecipes[0].id], `${screenId}: exact recipe binding`);
    assert.ok(template.recipeRefs.includes(exactRecipes[0].id), `${screenId}: template reciprocally binds recipe`);
    assert.ok([...(template.patterns ?? []), ...Object.keys(template.patternOverlays ?? {})].includes(exactRecipes[0].semanticPattern), `${screenId}: recipe pattern is valid for its template`);
    for (const component of doc.componentIds ?? []) assert.ok(components.has(component), `${screenId}: dangling component ${component}`);
    assert.equal(doc.keyboardSemantics?.sourceRef, '.product-experience/pdp-2-design-interface-system/accessibility.yaml#/accessibilityRules/@id=media.a11y.keyboard-equivalence', `${screenId}: keyboard rule source`);
    assert.equal(doc.keyboardSemantics?.rule, keyboardRule.requirement, `${screenId}: keyboard semantics drift`);
    assert.equal(doc.displayStateBindingRef, `${base}/view-state-binding-dispositions.yaml#views/@viewRef=${screenId}`, `${screenId}: display-state binding ref`);
    const stateDisposition = viewStateDispositions.get(screenId);
    assert.ok(stateDisposition, `${screenId}: display-state disposition exists`);
    assert.deepEqual(doc.states ?? [], stateDisposition.displayedStates, `${screenId}: displayed states map exactly`);
    const responsive = doc.responsiveBehavior;
    assert.equal(responsive?.ref ?? responsive?.reference ?? responsive?.sourceRef, '.product-experience/pdp-2-design-interface-system/gui/layout.yaml#layoutRules.responsive', `${screenId}: global responsive rule ref`);
    assert.deepEqual((responsive.layoutRules ?? []).map(({ layoutRef, responsiveRule }) => {
      const id = layoutRef.match(/@id=([^/]+)$/u)?.[1];
      const sourceLayout = layouts.find((layout) => layout.id === id);
      assert.ok(sourceLayout, `${screenId}: layout rule source resolves`);
      assert.equal(responsiveRule, sourceLayout.responsiveRule, `${screenId}: layout responsive rule drift`);
      return id;
    }), doc.layoutIds, `${screenId}: exact selected layouts have responsive rules`);
  }
});

test('47 screen and lane-view contracts have resolved entry/exit dispositions', () => {
  const views = [...registry.screens, ...registry.laneViews];
  assert.equal(views.length, 47);
  assert.equal(new Set(views.map(({ id }) => id)).size, 47);
  for (const view of views) {
    assert.equal(view.contractRefs.length, 1, `${view.id}: exactly one contract is bound`);
    const contract = contracts.get(view.id)?.doc;
    assert.ok(contract, `${view.id}: exact contract is loaded`);
    assert.equal(contract.screenId, view.id, `${view.id}: screen contract identity is exact`);
    assertResolvedScreenEntryExit(view.id, contract);
  }

  const sample = structuredClone(contracts.get('media.view.check-job-outcome').doc);
  sample.fieldBindingStatus.entry = 'unresolved-no-direct-canonical-reference';
  assert.throws(() => assertResolvedScreenEntryExit(sample.screenId, sample), /entry disposition must resolve/u,
    'negative control: unresolved entry bindings fail');
  sample.fieldBindingStatus.entry = 'Exact source-bound entry disposition';
  sample.fieldBindingStatus.exit = 'unresolved-no-direct-canonical-reference';
  assert.throws(() => assertResolvedScreenEntryExit(sample.screenId, sample), /exit disposition must resolve/u,
    'negative control: unresolved exit bindings fail');
});

test('screen audience actors are scoped to human Web users, separately from channel-agnostic action actors', () => {
  assert.equal(screenSchema.actorSemantics.screenAudienceField, 'actors');
  assert.equal(screenSchema.actorSemantics.actionActorField, 'actionConsequences[].actorRefs');
  assert.equal(screenSchema.actorSemantics.sourceRef,
    '.product-experience/pdp-0-product-truth/actors-responsibilities.yaml#/interpretation/actorsModel');
  assert.match(screenSchema.actorSemantics.actionActorMeaning, /do not imply that this Web screen exposes the action to every listed actor/u);

  for (const [screenId, { doc }] of contracts) assertHumanScreenAudience(screenId, doc.actors);

  const jobStatus = contracts.get('media.view.job-status').doc;
  const retry = jobStatus.actionConsequences.find(({ actionId }) => actionId === 'media.action.retry-job');
  assert.ok(retry.actorRefs.includes('media.automation-client'),
    'the canonical retry action keeps its machine-actor allowance');
  assert.ok(!jobStatus.actors.includes('media.automation-client'),
    'the Web-screen audience does not inherit every action-level actor');
  assert.throws(() => assertHumanScreenAudience('negative-control', [...jobStatus.actors, 'media.automation-client']),
    /not a human Web screen-audience actor/u,
    'negative control: machine actors cannot be placed in the Web audience list');
});

test('source-link validators reject dangling action, operation, token, and fixture references', () => {
  const [screenId, { doc }] = contracts.entries().next().value;
  const row = structuredClone(doc.actionConsequences[0]);
  row.effectRef = `${base}/action-registry.yaml#actions/@id=media.action.not-real/actionDefinitionSemantics/typedDefinition`;
  assert.ok(exactActionRowErrors(screenId, row).some((error) => error.includes('dangling or stale effectRef')));
  assert.ok(!sourceOps.has('media.operation.not-real'));
  assert.ok(!tokenAliases.has('media.token.not-real'));
  assert.ok(!fixtures.has('media.scenario.not-real'));
});
