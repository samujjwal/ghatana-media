import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const { parseDocument } = toolsRequire('yaml');
const Ajv2020 = toolsRequire('ajv/dist/2020').default ?? toolsRequire('ajv/dist/2020');
const {
  createOperationDefinitionFixture,
  createStaleDraftRevisionDefinitionFixture,
  createStepBranchDefinitionFixture,
  createVersionMismatchGuardDefinitionFixture,
} = await import('../libs/media-experience-simulation/src/fixtures.ts');

const registryDocument = parseDocument(await readFile('.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml', 'utf8'), { uniqueKeys: true });
assert.deepEqual(registryDocument.errors, [], 'scenario fixture registry parses without YAML syntax or duplicate-key errors');
const registry = registryDocument.toJS();
const journeyRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/journey-registry.yaml', 'utf8'));
const fixtureIndex = parse(await readFile('.product-experience/explorer/scenario-fixtures.yaml', 'utf8'));
const sourceBindings = parse(await readFile('.product-experience/pdp-3-product-experience/experience-source-bindings.yaml', 'utf8'));
const actionRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/action-registry.yaml', 'utf8'));
const stateModels = parse(await readFile('.product-experience/pdp-0-product-truth/state-models.yaml', 'utf8'));
const domainStates = parse(await readFile('.product-experience/pdp-1-domain-data/states.yaml', 'utf8'));
const stepOracles = parse(await readFile('.product-experience/pdp-3-product-experience/step-definition-oracles.yaml', 'utf8'));
const operationSource = parse(await readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'));
const versionBindingSource = parse(await readFile('.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml', 'utf8'));
const ownerWireSource = parse(await readFile('.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml', 'utf8'));
const simulationSource = await readFile('libs/media-experience-simulation/src/fixtures.ts', 'utf8');
const journeyDirectory = '.product-experience/pdp-3-product-experience/journey-contracts';
const stepOraclePath = '.product-experience/pdp-3-product-experience/step-definition-oracles.yaml';

function simulationSeedKeys(source) {
  const seedMap = source.match(/const seeds: Record<FixtureId, MediaExperienceState> = \{([\s\S]*?)\n\};/u)?.[1];
  assert.ok(seedMap, 'simulation fixture source has a bounded seeds record');
  return [...seedMap.matchAll(/^\s+"([^"]+)":/gmu)].map(([, key]) => key);
}

function projectOperationSchema(schema, operation) {
  const scalarTypes = operationSource.capabilityOperationContracts.scalarTypes;
  const ownerRecord = ownerWireSource.records.find((row) => row.actionRef === operation.actionRef);
  const canonicalReferenceSchema = (ref) => {
    const key = ref.replaceAll('.', '_');
    const definition = ownerWireSource.$defs.canonicalReferences[key];
    assert.ok(definition, `${ref} has an exact PDP-1 canonical identity schema`);
    return structuredClone(definition);
  };
  const resolveOwnerRef = (ref) => {
    if (ref === '#/$defs/targetBoundConfirmation') return structuredClone(ownerWireSource.$defs.targetBoundConfirmation);
    if (ref === '#/$defs/canonicalReferenceAny') return structuredClone(ownerWireSource.$defs.canonicalReferenceAny);
    const match = ref.match(/^#\/\$defs\/canonicalReferences\/([^/]+)$/u);
    if (match) return structuredClone(ownerWireSource.$defs.canonicalReferences[match[1]]);
    throw new Error(`Unresolved owner wire schema reference ${ref}`);
  };
  const inline = (value) => {
    if (Array.isArray(value)) return value.map(inline);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.$ref === 'string') return inline(resolveOwnerRef(value.$ref));
    if (value.type === 'CanonicalObjectReference') {
      return { oneOf: (value.allowedObjectRefs ?? []).map(canonicalReferenceSchema) };
    }
    if (typeof value.type === 'string' && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type)) {
      if (scalarTypes[value.type]?.validator) return inline(structuredClone(scalarTypes[value.type].validator));
      if (value.type === 'confirmation') return inline(structuredClone(ownerWireSource.$defs.targetBoundConfirmation));
      if (value.type === 'exact-operation-id') {
        return { type: 'string', enum: [operation.id] };
      }
      if (value.type === 'exact-owner-profile-ref') {
        const profileSchema = ownerRecord?.requestSchema?.properties?.renderProfileRef;
        assert.ok(profileSchema, `${operation.actionRef} has a source-bound render profile wire schema`);
        return inline(structuredClone(profileSchema));
      }
      throw new Error(`No exact schema projection for PDP-1 pseudo-type ${value.type} on ${operation.id}`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child)]));
  };
  return inline(schema);
}

function applyExactUnknownOutcomeConstraints(schema, sample) {
  for (const constraint of schema.allOf ?? []) {
    if (constraint.if?.properties?.outcome?.const !== 'UNKNOWN_OUTCOME') continue;
    for (const [property, propertySchema] of Object.entries(constraint.then?.properties ?? {})) {
      if (propertySchema.maxItems === 0) sample[property] = [];
    }
  }
  return sample;
}

test('P3-05 scenario payload and synthetic definition-oracle populations remain distinct', async () => {
  const scenarios = new Map(registry.fixtures.map((fixture) => [fixture.id, fixture]));
  const seeds = new Set(simulationSeedKeys(simulationSource));
  const indexed = new Map(fixtureIndex.fixtures.map((fixture) => [fixture.scenarioId, fixture]));
  const stateBindings = new Map(sourceBindings.scenarioStartingStateBindings.map((binding) => [binding.scenarioRef, binding]));
  const localContextBindings = new Map(sourceBindings.scenarioStartingContextBindings.records.map((binding) => [binding.scenarioRef, binding]));

  assert.equal(scenarios.size, 31, 'the authored scenario registry denominator remains explicit');
  assert.equal(seeds.size, 31, 'the pre-dispatch retry-eligibility oracle is now seeded in the Media simulation');
  assert.equal(indexed.size, 30, 'only indexed synthetic fixture payloads count as Explorer fixtures');
  assert.deepEqual(new Set(indexed.keys()), new Set([...seeds].filter((key) => key !== 'job-retry-eligible').map((key) => `media.scenario.${key}`)), 'retry eligibility is a Media definition fixture and is not added to the Explorer fixture index');
  assert.deepEqual(new Set(seeds), new Set([...scenarios.keys()].map((id) => id.slice('media.scenario.'.length)).filter((key) => seeds.has(key))));

  const unseeded = [...scenarios.keys()].filter((id) => !seeds.has(id.slice('media.scenario.'.length))).sort();
  assert.deepEqual(unseeded, []);
  const retryAction = actionRegistry.actions.find(({ id }) => id === 'media.action.retry-job');
  assert.deepEqual(retryAction.scenarioRefs, ['media.scenario.job-retry-eligible', 'media.scenario.job-retry-ineligible'], 'the action authority links both retry proposals while payload availability is tracked independently');
  assert.match(retryAction.effect, /new-fenced-attempt/u);
  assert.ok(retryAction.scenarioRefs.every((id) => /no-local-retry-reducer/u.test(scenarios.get(id).pdp3PayloadState)));
  assert.match(scenarios.get('media.scenario.job-retry-eligible').pdp3PayloadState, /pre-dispatch-eligibility-fixture-seeded; retry-request-not-dispatched/u);
  assert.equal(scenarios.get('media.scenario.job-retry-ineligible').sourceFixtureRef, 'FIXTURE-PROVIDER-AMBIGUITY');
  assert.match(scenarios.get('media.scenario.job-retry-ineligible').pdp3PayloadState, /unknown-outcome-branch-seeded/u);

  const pdp1CanonicalStateRefs = new Set(domainStates.stateMachines.flatMap(({ machineId, stateIds }) =>
    stateIds.map((stateId) => `${machineId}.${stateId}`)));
  const canonicalStartBindings = [...stateBindings.values()].filter(({ startingStateRef }) => pdp1CanonicalStateRefs.has(startingStateRef));
  const sourceSeededWithoutCanonicalStart = [...seeds]
    .map((key) => `media.scenario.${key}`)
    .filter((id) => !pdp1CanonicalStateRefs.has(stateBindings.get(id)?.startingStateRef))
    .sort();
  const sourceSeededWithoutAnyStateLink = sourceSeededWithoutCanonicalStart
    .filter((id) => !stateBindings.has(id) && !localContextBindings.has(id));
  assert.equal(stateBindings.size, 16, 'exact source-state links include the two retry outcome states and exclude local-only contexts');
  assert.equal(canonicalStartBindings.length, 16, 'only PDP-1 enumerated state IDs count as canonical starts');
  assert.deepEqual(sourceSeededWithoutCanonicalStart, [
    'media.scenario.alignment-required',
    'media.scenario.caption-conflict',
    'media.scenario.caption-corrected',
    'media.scenario.caption-source-mismatch',
    'media.scenario.caption-version-comparison',
    'media.scenario.consent-revoked',
    'media.scenario.first-use-empty',
    'media.scenario.identity-required',
    'media.scenario.intent-unavailable',
    'media.scenario.language-uncertain',
    'media.scenario.project-create-outcome-unknown',
    'media.scenario.project-created-empty',
    'media.scenario.upload-interrupted',
    'media.scenario.upload-outcome-unknown',
    'media.scenario.workspace-access-denied',
  ], 'seeded payloads without exact PDP-1 canonical starting-state links remain individually visible');
  assert.ok(sourceSeededWithoutCanonicalStart.every((id) => seeds.has(id.slice('media.scenario.'.length))));
  assert.deepEqual(sourceSeededWithoutAnyStateLink, [],
    'every noncanonical start is explicitly owned by a typed local synthetic context instead of a PDP state');
  assert.deepEqual(new Set(sourceSeededWithoutCanonicalStart), new Set(localContextBindings.keys()),
    'local context coverage exactly matches the seeded scenarios without canonical state links');
  assert.equal(sourceSeededWithoutAnyStateLink.length, 0);
  const canonicalModelIds = new Set(stateModels.models.map(({ modelId }) => modelId));
  const consentModel = stateModels.models.find(({ modelId }) => modelId === 'media-rights-and-consent');
  const domainConsentMachine = domainStates.stateMachines.find(({ machineId }) => machineId === 'media-rights-and-consent');
  assert.ok(consentModel.consentStates.includes('REVOKED'));
  assert.equal(consentModel.states, undefined, 'the consent axis has no explicitly terminal-annotated state records');
  assert.deepEqual(domainConsentMachine.stateIds, [], 'PDP-1 confirms no owner-selected canonical rights/consent machine states');
  const consentContext = localContextBindings.get('media.scenario.consent-revoked');
  assert.equal(consentContext.contextKind, 'RIGHTS_AND_CONSENT_LOCAL');
  assert.deepEqual(consentContext.canonicalStateRefs, [], 'consent fixture state remains local until a canonical P1 state exists');
  assert.equal(stateBindings.get('media.scenario.job-retry-ineligible').startingStateRef, 'media-job.OUTCOME_UNKNOWN',
    'the ineligible retry seed uses the exact canonical state for its explicit unknown-outcome branch');
  assert.match(sourceBindings.status, /^proposal-only;/u,
    'source-state cross-references remain proposals pending independent review');
  assert.ok(!domainConsentMachine.stateIds.includes('REVOKED'),
    'the local context does not imply an owner-selected PDP-1 rights/consent machine state');
  assert.match(simulationSource, /"consent-revoked": \{[\s\S]*?consentState: "REVOKED"/u,
    'the exact synthetic fixture records the same consent-axis state');
  assert.match(simulationSource, /"job-retry-ineligible": \{[\s\S]*?state: "OUTCOME_UNKNOWN",[\s\S]*?attemptState: "OUTCOME_UNKNOWN",[\s\S]*?finality: "UNKNOWN"/u,
    'the ineligible retry fixture represents only the explicitly sourced unknown-outcome branch');
  assert.equal(canonicalModelIds.has('media-first-use'), false,
    'first-use payloads lack a matching canonical first-use state model');
  assert.equal(canonicalModelIds.has('media-caption'), false,
    'caption and transcript payload dimensions lack a matching canonical content state model');
  const uploadStates = new Set(stateModels.models.find(({ modelId }) => modelId === 'media-upload-and-artifact')
    .states.map((state) => typeof state === 'string' ? state : state.id));
  assert.equal(uploadStates.has('INTERRUPTED'), false,
    'the interrupted-upload payload has no exact canonical upload state');
  assert.equal(uploadStates.has('OUTCOME_UNKNOWN'), false,
    'the upload-outcome-unknown payload has no exact canonical upload state');
  assert.equal(canonicalStartBindings.length + sourceSeededWithoutCanonicalStart.length + unseeded.length, scenarios.size);

  const journeyFiles = (await readdir(journeyDirectory)).filter((file) => file.endsWith('.yaml'));
  const journeys = await Promise.all(journeyFiles.map(async (file) => parse(await readFile(`${journeyDirectory}/${file}`, 'utf8'))));
  assert.equal(journeys.length, 30);
  const seededJourneyIds = registry.journeyCoverage.journeysWithExactSimulationSeeds;
  const unseededJourneyIds = registry.journeyCoverage.journeysWithoutExactSimulationSeeds;
  assert.equal(seededJourneyIds.length, 4);
  assert.equal(unseededJourneyIds.length, 26, 'these journeys lack rich state scenario payloads');
  assert.equal(registry.stepDefinitionOracleCoverage.records.length, 130, 'all journey steps still have bounded definition oracles');
  assert.equal(new Set([...seededJourneyIds, ...unseededJourneyIds]).size, 30);
  assert.deepEqual(new Set(journeys.map(({ journeyId }) => journeyId)), new Set([...seededJourneyIds, ...unseededJourneyIds]));
  assert.match(registry.journeyCoverage.status, /bounded-step-definition-oracles-cover-all-30/u);
  assert.match(fixtureIndex.status, /deterministic-synthetic-fixtures/u);
  assert.match(fixtureIndex.status, /Tools-host-binding-pending/u);
});

test('P3-05 every scenario has a typed synthetic payload, exact start binding, and explicit channel disposition', () => {
  const records = sourceBindings.scenarioFixtureBindings.records;
  assert.equal(records.length, 31);
  assert.match(sourceBindings.scenarioFixtureBindings.status,
    /^ALL_31_SCENARIOS_HAVE_EXACT_TYPED_SYNTHETIC_PAYLOAD_AND_STATE_OR_CONTEXT_LINKS; JOURNEY_CHANNELS_INHERITED_ONLY_FROM_EXACT_SCENARIO_REFERENCES; DEFINITION_ONLY$/u);
  const byScenario = new Map(records.map((record) => [record.scenarioRef, record]));
  assert.deepEqual(new Set(byScenario.keys()), new Set(registry.fixtures.map(({ id }) => id)));

  for (const fixture of registry.fixtures) {
    const binding = byScenario.get(fixture.id);
    assert.equal(binding.sourceFixtureRef, fixture.sourceFixtureRef);
    assert.match(binding.payloadSourceRef, new RegExp(`fixtures\\.ts#seeds/${fixture.id.slice('media.scenario.'.length)}`, 'u'));
    assert.ok(['FirstUseExperienceState', 'ArtifactIntakeExperienceState', 'ArtifactVerificationExperienceState', 'TranscriptionExperienceState'].includes(binding.typedPayload));
    assert.ok(binding.startingStateBindingRef !== 'null' || binding.startingContextBindingRef !== 'null');
    assert.equal(binding.runtimeAdmission, 'NOT_ADMITTED');
    assert.ok(['PROPOSAL_ONLY; NOT_OWNER_ACCEPTED', 'PRE_DISPATCH_ELIGIBILITY_ONLY; NO_RETRY_DISPATCH'].includes(binding.oracleDisposition));
    assert.ok(binding.journeyContractRefs.length > 0);
    assert.ok(binding.channelRefs.length > 0);
    assert.ok(binding.actionRefs.every((actionRef) => actionRegistry.actions.some((action) => action.id === actionRef)));
    assert.ok(binding.canonicalOperationRefs.every((operationRef) => /^(media\.operation|media\.operation-slice)\./u.test(operationRef)));
  }

  const retry = byScenario.get('media.scenario.job-retry-eligible');
  const retryDefinition = registry.fixtures.find(({ id }) => id === 'media.scenario.job-retry-eligible');
  assert.equal(retry.oracleDisposition, 'PRE_DISPATCH_ELIGIBILITY_ONLY; NO_RETRY_DISPATCH');
  assert.match(retryDefinition.initialConditions, /prior-effect-is-explicitly-reconciled-as-no-effect/u);
  assert.match(retryDefinition.initialConditions, /current-actor-authority-policy-rights-consent-license-resource-and-deployment-checks-pass/u);
  assert.match(retryDefinition.initialConditions, /profile-is-current-and-qualified/u);
  assert.match(retryDefinition.initialConditions, /retry-budget-is-current-and-available/u);
  assert.equal(retryDefinition.eligibilityEvidenceStatus, 'SOURCE_EVIDENCE_UNRESOLVED; CONDITIONAL_SCENARIO_NON_EXECUTABLE; ORACLE_UNKNOWN');
  assert.match(registry.scenarioCoverage.rules.retry, /unknown outcome always denies dispatch/u);
});

test('P3-05 exact scenario and operation-family fixture links represent all 30 journeys', async () => {
  const operationFixtures = registry.operationFamilyDefinitionFixtures.records;
  const existingScenarioIds = new Set(registry.fixtures.map(({ id }) => id));
  const definitionFixtureIds = new Set(operationFixtures.map(({ definitionFixtureRef }) => definitionFixtureRef));
  const linkedScenarioIds = new Set();
  const linkedDefinitionFixtureIds = new Set();
  const linkedExistingScenarioIds = new Set();
  let exactStepLinkCount = 0;
  const seededScenarioJourneys = new Set();
  const scenarioLinkedSteps = new Set();
  const journeysWithAnyFixtureLink = new Set();
  const contracts = new Map();
  for (const file of await readdir(journeyDirectory)) {
    if (!file.endsWith('.yaml')) continue;
    const contract = parse(await readFile(`${journeyDirectory}/${file}`, 'utf8'));
    contracts.set(contract.journeyId, contract);
    for (const [index, step] of contract.steps.entries()) {
      for (const scenarioRef of step.scenarioRefs ?? []) {
        assert.ok(existingScenarioIds.has(scenarioRef), `${scenarioRef} is registered as a scenario`);
        linkedScenarioIds.add(scenarioRef);
        journeysWithAnyFixtureLink.add(contract.journeyId);
        if (existingScenarioIds.has(scenarioRef)) {
          linkedExistingScenarioIds.add(scenarioRef);
          seededScenarioJourneys.add(contract.journeyId);
          scenarioLinkedSteps.add(`${contract.journeyId}:${step.stepId ?? index + 1}`);
          exactStepLinkCount += 1;
        }
      }
      for (const definitionFixtureRef of step.definitionFixtureRefs ?? []) {
        assert.ok(definitionFixtureIds.has(definitionFixtureRef), `${definitionFixtureRef} is registered as a definition fixture`);
        linkedDefinitionFixtureIds.add(definitionFixtureRef);
        journeysWithAnyFixtureLink.add(contract.journeyId);
      }
    }
  }
  assert.equal(linkedExistingScenarioIds.size, 31);
  assert.equal(linkedScenarioIds.size, 31);
  assert.equal(linkedDefinitionFixtureIds.size, 26);
  assert.equal(seededScenarioJourneys.size, 4);
  assert.equal(scenarioLinkedSteps.size, 19);
  assert.equal(exactStepLinkCount, 38);
  assert.equal(journeysWithAnyFixtureLink.size, 30);

  const records = operationFixtures;
  assert.equal(records.length, 26);
  const operationById = new Map([
    ...operationSource.ownerDefinedOperationContracts.records,
    ...operationSource.capabilityOperationContracts.records,
    ...operationSource.individualOperationContracts.records,
  ].map((row) => [row.id, row]));
  const journeyFixtureIds = new Set();
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, validateFormats: false, allErrors: true });
  for (const row of records) {
    const contract = contracts.get(row.journeyRef);
    assert.ok(contract, `${row.journeyRef} has a source contract`);
    const stepIndex = Number(row.stepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    assert.ok(Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex < contract.steps.length, `${row.fixtureId} links an exact journey step`);
    assert.equal(row.stepRef, `.product-experience/pdp-3-product-experience/${journeyRegistry.journeys.find(({ id }) => id === row.journeyRef).contract}#/steps/${stepIndex}`);
    assert.ok((contract.steps[stepIndex].definitionFixtureRefs ?? []).includes(row.definitionFixtureRef), `${row.definitionFixtureRef} is linked from its exact journey step`);
    const oracleStep = stepOracles.journeys.find(({ journeyId }) => journeyId === row.journeyRef).steps.find(({ id }) => id === row.stepId);
    assert.ok(oracleStep, `${row.fixtureId} has an exact step oracle`);
    const exactOperationRefs = [
      ...(oracleStep.canonicalBindings?.operationRefs ?? []),
      ...(oracleStep.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? []),
    ];
    assert.ok(exactOperationRefs.includes(row.operationRef), `${row.operationRef} is bound to this exact step`);
    assert.equal(row.actionRef, oracleStep.actionRef);
    assert.equal(row.definitionFixtureRef, row.fixtureId);
    assert.equal(definitionFixtureIds.has(row.definitionFixtureRef), true);
    assert.deepEqual(row.guardRefs, oracleStep.canonicalBindings?.guardRefs ?? oracleStep.guardRefs ?? []);
    assert.deepEqual(row.authorityRefs, oracleStep.canonicalBindings?.authorityRefs ?? []);
    const operation = operationById.get(row.operationRef);
    assert.ok(operation?.requestSchema && operation?.resultSchema, `${row.operationRef} exposes both exact schemas`);
    assert.equal(row.requestSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#${row.operationRef}/requestSchema`);
    assert.equal(row.resultSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#${row.operationRef}/resultSchema`);
    const projectedRequestSchema = projectOperationSchema(operation.requestSchema, operation);
    const projectedResultSchema = projectOperationSchema(operation.resultSchema, operation);
    const sample = createOperationDefinitionFixture({
      fixtureId: row.fixtureId,
      journeyRef: row.journeyRef,
      stepRef: row.stepRef,
      actionRef: row.actionRef,
      capabilityRef: row.capabilityRef,
      operationRef: row.operationRef,
      requestSchemaRef: row.requestSchemaRef,
      resultSchemaRef: row.resultSchemaRef,
      requestSchema: projectedRequestSchema,
      resultSchema: projectedResultSchema,
    });
    assert.deepEqual(sample, createOperationDefinitionFixture({
      fixtureId: row.fixtureId,
      journeyRef: row.journeyRef,
      stepRef: row.stepRef,
      actionRef: row.actionRef,
      capabilityRef: row.capabilityRef,
      operationRef: row.operationRef,
      requestSchemaRef: row.requestSchemaRef,
      resultSchemaRef: row.resultSchemaRef,
      requestSchema: projectedRequestSchema,
      resultSchema: projectedResultSchema,
    }), `${row.fixtureId} is deterministic`);
    assert.equal(ajv.validate(projectedRequestSchema, sample.request), true, `${row.fixtureId} request matches the exact P1 schema projection: ${JSON.stringify(ajv.errors)}`);
    assert.equal(ajv.validate(projectedResultSchema, sample.resultShape), true, `${row.fixtureId} result shape ${JSON.stringify(sample.resultShape)} matches the exact P1 schema projection: ${JSON.stringify(ajv.errors)}`);
    assert.equal(sample.synthetic, true);
    assert.equal(sample.resultIsOwnerEvidence, false);
    assert.equal(sample.dispatch, 'NEVER');
    assert.equal(sample.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(sample.synthetic, true, `${row.fixtureId} marks the whole schema-derived value set synthetic, including any schema constants`);
    const rejectedExtraField = { ...sample.request, __unexpectedSyntheticField: true };
    assert.equal(ajv.validate(projectedRequestSchema, rejectedExtraField), false, `${row.fixtureId} rejects unknown request fields`);
    const requiredRequestField = operation.requestSchema.required?.[0];
    assert.ok(requiredRequestField, `${row.operationRef} defines a required request field`);
    const missingRequiredField = { ...sample.request };
    delete missingRequiredField[requiredRequestField];
    assert.equal(ajv.validate(projectedRequestSchema, missingRequiredField), false, `${row.fixtureId} rejects a missing required request field`);
    const outcomeSchema = projectedResultSchema.properties?.outcome;
    if (Array.isArray(outcomeSchema?.enum)) {
      const unknownOutcome = { ...sample.resultShape, outcome: '__UNDECLARED_SYNTHETIC_OUTCOME__' };
      assert.equal(ajv.validate(projectedResultSchema, unknownOutcome), false, `${row.fixtureId} rejects an outcome outside the exact P1 enum`);
    }
    journeyFixtureIds.add(row.journeyRef);
  }
  assert.equal(journeyFixtureIds.size, 26);
  assert.equal(new Set([...seededScenarioJourneys, ...journeyFixtureIds]).size, 30);
});

test('P3-05 step fixture matrix binds all 130 steps and schema-backed operations to exact source refs', async () => {
  const records = registry.stepDefinitionOracleCoverage.records;
  assert.equal(records.length, 130);
  const oracleByJourney = new Map(stepOracles.journeys.map((journey) => [journey.journeyId, journey]));
  const operationSources = [
    ['operations', operationSource.operations],
    ['ownerDefinedOperationContracts/records', operationSource.ownerDefinedOperationContracts.records],
    ['individualOperationContracts/records', operationSource.individualOperationContracts.records],
    ['capabilityOperationContracts/records', operationSource.capabilityOperationContracts.records],
  ];
  const operationsById = new Map(operationSources.flatMap(([, rows]) => rows.map((operation) => [operation.id, operation])));
  // Arrays under `operations` use @id directly; named catalogs use records/@id.
  let scenarioReferenceCount = 0;
  let ownerWireOperationOccurrenceCount = 0;
  const ownerWireRows = new Set();
  for (const fixture of records) {
    const oracleJourney = oracleByJourney.get(fixture.journeyRef);
    const stepIndex = Number(fixture.stepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const oracleStep = oracleJourney?.steps[stepIndex];
    assert.ok(oracleStep, `${fixture.fixtureId} resolves to an exact step oracle`);
    const contract = parse(await readFile(fixture.stepRef.split('#')[0], 'utf8'));
    const contractStep = contract.steps[stepIndex];
    assert.deepEqual(fixture.scenarioRefs, contractStep.scenarioRefs ?? [], `${fixture.fixtureId} mirrors only its exact step scenario refs`);
    scenarioReferenceCount += fixture.scenarioRefs.length;
    assert.match(fixture.fixtureDisposition, /^SYNTHETIC_/u, `${fixture.fixtureId} is explicitly synthetic`);
    assert.equal(fixture.canonicalStateOrOwnerEvidence, 'NOT_ASSERTED_BY_THIS_FIXTURE');
    assert.equal(fixture.dispatch, 'NEVER');
    assert.equal(fixture.replay, 'NEVER');
    assert.equal(fixture.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(fixture.ownerAcceptedOutcomeOracle, false);

    const exactOperationRefs = [
      ...(oracleStep.canonicalBindings?.operationRefs ?? []),
      ...(oracleStep.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? []),
    ];
    assert.deepEqual(fixture.operationRefs, [...new Set(exactOperationRefs)], `${fixture.fixtureId} mirrors exact canonical operations without duplicate option references`);
    for (const operationRef of exactOperationRefs) {
      const operation = operationsById.get(operationRef);
      const wire = operation?.ownerWireSchema;
      if (!wire?.requestSchema || !wire?.resultSchema) continue;
      ownerWireOperationOccurrenceCount += 1;
      ownerWireRows.add(fixture.fixtureId);
      const collection = operationSource.operations.some(({ id }) => id === operationRef)
        ? 'operations'
        : operationSource.ownerDefinedOperationContracts.records.some(({ id }) => id === operationRef)
          ? 'ownerDefinedOperationContracts/records'
          : operationSource.individualOperationContracts.records.some(({ id }) => id === operationRef)
            ? 'individualOperationContracts/records'
            : 'capabilityOperationContracts/records';
      const base = `.product-experience/pdp-1-domain-data/operations.yaml#${collection}/@id=${operationRef}/ownerWireSchema`;
      assert.ok(fixture.operationSchemaRefs.includes(`${base}/requestSchema`), `${fixture.fixtureId} links ${operationRef} request schema`);
      assert.ok(fixture.operationSchemaRefs.includes(`${base}/resultSchema`), `${fixture.fixtureId} links ${operationRef} result schema`);
    }
  }
  assert.equal(scenarioReferenceCount, 38, 'only the 38 registered seeded step links are copied into their exact fixture rows');
  assert.equal(ownerWireOperationOccurrenceCount, 18);
  assert.equal(ownerWireRows.size, 16);
  const j02ArtifactVersionRead = records.find(({ journeyRef, stepRef }) => journeyRef === 'J-02' && stepRef.endsWith('/steps/4'));
  assert.ok(j02ArtifactVersionRead, 'J-02 step 5 has its exact P3-05 matrix row');
  assert.equal(j02ArtifactVersionRead.actionRef, 'media.action.inspect-source');
  assert.deepEqual(j02ArtifactVersionRead.operationRefs, ['media.operation-slice.inspect-artifact-version']);
  assert.deepEqual(j02ArtifactVersionRead.operationSchemaRefs, [
    '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation-slice.inspect-artifact-version/ownerWireSchema/requestSchema',
    '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation-slice.inspect-artifact-version/ownerWireSchema/resultSchema',
  ]);
  assert.equal(j02ArtifactVersionRead.fixtureDisposition, 'SYNTHETIC_DEFINITION_ONLY_EXACT_TYPED_LINKS');
  assert.deepEqual(j02ArtifactVersionRead.typedGuardFixtureRefs, [
    {
      guardRef: 'exact-artifact-and-immutable-version-identity',
      fixtureInstanceRef: '.product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml#guardContracts/records/11/stepRefs/0',
    },
    {
      guardRef: 'current-read-authority',
      fixtureInstanceRef: '.product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml#guardContracts/records/12/stepRefs/4',
    },
  ]);
  assert.deepEqual(j02ArtifactVersionRead.unboundGuardRefs, []);
  assert.equal(j02ArtifactVersionRead.dispatch, 'NEVER');
  assert.equal(j02ArtifactVersionRead.replay, 'NEVER');
  assert.equal(j02ArtifactVersionRead.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(j02ArtifactVersionRead.ownerAcceptedOutcomeOracle, false);

  const j02StepOracle = oracleByJourney.get('J-02').steps[4];
  assert.equal(j02StepOracle.actionRef, 'media.action.inspect-source');
  assert.deepEqual(j02StepOracle.canonicalOperationRefs, ['media.operation-slice.inspect-artifact-version']);
  assert.deepEqual(j02StepOracle.guardRefs, ['exact-artifact-and-immutable-version-identity', 'current-read-authority']);
  assert.deepEqual(j02StepOracle.canonicalBindings.stateRefs, [], 'the read operation has no product-state binding');
  assert.deepEqual(j02StepOracle.canonicalBindings.guardRefs, ['exact-artifact-and-immutable-version-identity', 'current-read-authority']);
  const exactRequestRef = j02ArtifactVersionRead.operationSchemaRefs[0];
  const exactResultRef = j02ArtifactVersionRead.operationSchemaRefs[1];
  assert.deepEqual(j02StepOracle.canonicalBindings.sourceRefs, [
    exactRequestRef,
    exactResultRef,
    '.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml#/steps/4',
  ]);
  assert.deepEqual(j02StepOracle.canonicalBindings.primaryOperationRefs, ['media.operation-slice.inspect-artifact-version']);
  assert.deepEqual(j02StepOracle.canonicalBindings.supportingObservationOperationRefs, []);
  assert.deepEqual(j02StepOracle.canonicalBindings.ownerStateRefs, []);
  assert.equal(j02StepOracle.canonicalBindings.stateBindingDisposition,
    'NO_CURRENT_STATE_BINDING; exact-version recorded integrity/lifecycle disposition is a time-scoped read result and establishes no current product state.');
  assert.match(j02StepOracle.canonicalBindings.ownerResultSemantics,
    /time-scoped recorded integrity\/lifecycle disposition at observedAt\. This does not establish current availability/u);
  assert.deepEqual(j02StepOracle.scenarioBindings.primaryOperationRefs, ['media.operation-slice.inspect-artifact-version']);
  assert.deepEqual(j02StepOracle.scenarioBindings.supportingObservationOperationRefs, []);
  assert.deepEqual(j02StepOracle.scenarioBindings.ownerStateRefs, []);
  assert.doesNotMatch(JSON.stringify(j02StepOracle), /artifact\.lifecycle\.observe\.v1|separate typed observer operation|current-state claim/u);
  assert.equal(j02StepOracle.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(j02StepOracle.inputCases.map(({ expectedDecision }) => expectedDecision), [
    'READ_ONLY_DEFINITION_OBSERVATION',
    'DENY_WITHOUT_EFFECT',
    'HOLD_WITHOUT_EFFECT_OR_REPLAY',
  ]);
});

test('P3-05 audits 26 journeys without typed Media state seeds while preserving operation definition links', async () => {
  const audit = registry.unseededJourneyFixtureAudit;
  const stepCoverage = new Map(registry.stepDefinitionOracleCoverage.records.map((row) => [`${row.journeyRef}:${row.stepRef}`, row]));
  assert.equal(registry.stepDefinitionOracleCoverage.journeyCount, 30);
  assert.equal(registry.stepDefinitionOracleCoverage.stepCount, 130);
  assert.equal(stepCoverage.size, 130, 'P3-05 has one exact fixture record for every canonical journey step');
  assert.equal(audit.planJourneyDenominator, 30);
  assert.equal(audit.scenarioSeededJourneyCount, 4);
  assert.equal(audit.unseededJourneyCount, 26);
  assert.equal(audit.records.length, 26);
  assert.match(audit.status, /^ALL_26_UNSEEDED_JOURNEYS_HAVE_BOUNDED_SYNTHETIC_DEFINITION_ORACLES;/u);
  assert.match(audit.status, /UNBOUND_START_AND_AUTHORITY_FACTS_REMAIN_UNKNOWN/u);

  const journeyFiles = (await readdir(journeyDirectory)).filter((file) => file.endsWith('.yaml'));
  const contracts = new Map(await Promise.all(journeyFiles.map(async (file) => {
    const contract = parse(await readFile(`${journeyDirectory}/${file}`, 'utf8'));
    return [contract.journeyId, contract];
  })));
  const oracleJourneys = new Map(stepOracles.journeys.map((journey) => [journey.journeyId, journey]));
  const operationFixtures = new Map(registry.operationFamilyDefinitionFixtures.records.map((fixture) => [fixture.journeyRef, fixture]));
  const seededJourneyIds = new Set(registry.journeyCoverage.journeysWithExactSimulationSeeds);
  const auditJourneyIds = new Set();
  for (const row of audit.records) {
    assert.ok(!auditJourneyIds.has(row.journeyRef), `duplicate journey audit ${row.journeyRef}`);
    auditJourneyIds.add(row.journeyRef);
    assert.ok(!seededJourneyIds.has(row.journeyRef), `${row.journeyRef} is already scenario-seeded`);
    const contract = contracts.get(row.journeyRef);
    const oracleJourney = oracleJourneys.get(row.journeyRef);
    assert.ok(contract && oracleJourney, `${row.journeyRef} has its contract and definition oracle`);
    assert.equal(row.journeyContractRef,
      `.product-experience/pdp-3-product-experience/${journeyRegistry.journeys.find(({ id }) => id === row.journeyRef).contract}`);
    const declaredScenarioRefs = [
      ...(contract.scenarioRefs ?? []),
      ...(contract.steps ?? []).flatMap((step) => step.scenarioRefs ?? []),
    ];
    assert.deepEqual(row.scenarioRefs, declaredScenarioRefs, `${row.journeyRef} audit mirrors exact contract scenario refs`);
    assert.deepEqual(declaredScenarioRefs, [], `${row.journeyRef} has no typed Media state scenario seed`);
    assert.equal(row.oracleStepCount, contract.steps.length);
    assert.equal(row.oracleSteps.length, contract.steps.length);
    assert.equal(row.fixtureDisposition.startsWith('BOUNDED_SYNTHETIC_DEFINITION_FIXTURE;'), true);
    const operationFixture = operationFixtures.get(row.journeyRef);
    assert.ok(operationFixture, `${row.journeyRef} has an exact source-linked operation definition fixture`);
    const operationFixtureIndex = registry.operationFamilyDefinitionFixtures.records.indexOf(operationFixture);
    assert.equal(row.operationDefinitionFixtureRef, operationFixture.definitionFixtureRef);
    assert.equal(row.operationDefinitionFixtureSourceRef,
      `.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml#/operationFamilyDefinitionFixtures/records/${operationFixtureIndex}`);
    const fixtureStepIndex = Number(operationFixture.stepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    assert.ok(Number.isInteger(fixtureStepIndex));
    assert.equal(operationFixture.stepRef, `${row.journeyContractRef}#/steps/${fixtureStepIndex}`);
    assert.ok(contract.steps[fixtureStepIndex].definitionFixtureRefs.includes(operationFixture.definitionFixtureRef));
    assert.equal(operationFixture.syntheticValues, true);
    assert.equal(operationFixture.resultDisposition.includes('NO_OWNER_EVIDENCE'), true);
    assert.equal(operationFixture.dispatch, 'NEVER');
    assert.equal(operationFixture.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(operationFixture.requestSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#${operationFixture.operationRef}/requestSchema`);
    assert.equal(operationFixture.resultSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#${operationFixture.operationRef}/resultSchema`);
    assert.match(row.missingMeaning, /No source-supported fixture asserts the typed starting source\/object version, current actor authority, or owner denial outcome/u);
    assert.match(row.missingMeaning, /These facts remain UNKNOWN; synthetic results are not owner outcomes/u);
    assert.match(row.caseCoverage.positive, /^CONDITIONAL_SCHEMA_SAMPLE_AND_PASS_GUARD/u);
    assert.match(row.caseCoverage.denied, /^CONDITIONAL_GUARD_VERDICT/u);
    const applicability = audit.branchApplicabilityAudit.rows.find(({ journeyRef }) => journeyRef === row.journeyRef);
    if (applicability.unknownOutcomeOperationRefs.length > 0) {
      assert.match(row.caseCoverage.unknown, /^BOUNDED_SCHEMA_UNKNOWN_OUTCOME/u);
    } else {
      assert.match(row.caseCoverage.unknown, /^NOT_APPLICABLE_TO_BOUND_OPERATION_OUTCOME/u);
    }
    if (row.journeyRef === 'J-29') {
      assert.match(row.caseCoverage.recovery, /^BOUNDED_UNKNOWN_WITH_EXACT_QUERY_EXCEPTION/u);
      assert.match(row.missingMeaning, /PXD-160 query is a supporting observation definition only/u);
    } else {
      assert.match(row.caseCoverage.recovery, /^BOUNDED_SAFE_NO_QUERY_UNKNOWN/u);
    }
    assert.equal(row.phaseDisposition, 'P3_05_DEFINITION_COMPLETE_SYNTHETIC_ONLY; UNBOUND_START_AUTHORITY_FACTS_REMAIN_UNKNOWN');
    assert.equal(row.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(row.ownerAcceptedOutcomeOracle, false);
    assert.match(row.missingMeaning, /typed starting source\/object version/u);
    const branchAudit = audit.branchApplicabilityAudit.rows.find(({ journeyRef }) => journeyRef === row.journeyRef);
    assert.ok(branchAudit, `${row.journeyRef} has an explicit branch applicability disposition`);
    const exactBoundOperationRefs = new Set(oracleJourney.steps.flatMap((step) => [
      ...(step.canonicalBindings?.operationRefs ?? []),
      ...(step.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? []),
    ]));
    const exactUnknownOutcomeRefs = [...exactBoundOperationRefs].filter((operationRef) => {
      const operation = [
        ...operationSource.ownerDefinedOperationContracts.records,
        ...operationSource.capabilityOperationContracts.records,
        ...operationSource.individualOperationContracts.records,
      ].find((candidate) => candidate.id === operationRef);
      return operation?.resultSchema?.properties?.outcome?.enum?.includes('UNKNOWN_OUTCOME') ?? false;
    }).sort();
    assert.deepEqual([...branchAudit.unknownOutcomeOperationRefs].sort(), exactUnknownOutcomeRefs,
      `${row.journeyRef} unknown-outcome applicability follows exact bound P1 result schemas`);
    if (branchAudit.versionBoundStepCount > 0) {
      assert.match(branchAudit.staleDisposition, /^CONDITIONAL_EXACT_VERSION_GUARD/u);
    } else {
      assert.equal(row.journeyRef, 'J-28');
      assert.match(branchAudit.staleDisposition, /^NOT_APPLICABLE_TO_CANONICAL_STALE_BRANCH/u);
    }
    const sourceRecoveryRuleCount = contract.steps.filter((step, index) => step.recovery
      || oracleJourney.steps[index].recovery
      || oracleJourney.steps[index].sessionRecoveryDefinition).length;
    assert.equal(branchAudit.recoveryRuleSourceStepCount, sourceRecoveryRuleCount, `${row.journeyRef} recovery disposition count follows exact source steps`);
    if (row.journeyRef === 'J-29') {
      assert.match(branchAudit.recoveryDisposition, /^PXD-160_BINDS_ONE_EXACT_SAME_SESSION_QUERY/u);
    } else {
      assert.match(branchAudit.recoveryDisposition, /^UNIMPLEMENTED_TYPED_RECOVERY_OBSERVATION/u);
    }

    for (const [index, auditStep] of row.oracleSteps.entries()) {
      const oracleStep = oracleJourney.steps[index];
      const contractStep = contract.steps[index];
      assert.equal(auditStep.sourceRef, `${row.journeyContractRef}#/steps/${index}`);
      assert.equal(auditStep.sourceRef, oracleStep.sourceRef);
      assert.deepEqual(auditStep.scenarioRefs, contractStep.scenarioRefs ?? []);
      assert.deepEqual(auditStep.operationRefs,
        [...(oracleStep.canonicalBindings?.operationRefs ?? []), ...(oracleStep.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? [])]);
      assert.deepEqual(auditStep.stateRefs, oracleStep.canonicalBindings?.stateRefs ?? []);
      assert.deepEqual(auditStep.guardRefs, oracleStep.canonicalBindings?.guardRefs ?? []);
      assert.equal(auditStep.fixtureOracleStatus, contractStep.fixtureOracle?.status ?? 'EXACT_STEP_ORACLE_AND_FIXTURE_COVERAGE_LINKED');
      const stepFixture = stepCoverage.get(`${row.journeyRef}:${auditStep.sourceRef}`);
      assert.ok(stepFixture, `${row.journeyRef}/${index + 1} has an exact bounded fixture record`);
      assert.equal(stepFixture.stepOracleRef, auditStep.oracleRef);
      assert.equal(stepFixture.dispatch, 'NEVER');
      assert.equal(stepFixture.replay, 'NEVER');
      assert.equal(stepFixture.runtimeAdmission, 'NOT_ADMITTED');
      assert.equal(stepFixture.ownerAcceptedOutcomeOracle, false);
      assert.equal(stepFixture.canonicalStateOrOwnerEvidence, 'NOT_ASSERTED_BY_THIS_FIXTURE');
      assert.ok(stepFixture.typedGuardFixtureRefs.length || stepFixture.unboundGuardRefs.length === 0
        || stepFixture.fixtureDisposition === 'SYNTHETIC_FIXTURE_ONLY_UNBOUND_PREDICATE_NO_DISPATCH',
      `${row.journeyRef}/${index + 1} cannot pass based on a verdict-only placeholder`);
      const hasBoundActionOrOperation = Boolean(oracleStep.actionRef)
        || (oracleStep.canonicalBindings?.operationRefs?.length ?? 0) > 0
        || (oracleStep.canonicalBindings?.capabilityOptions?.length ?? 0) > 0;
      for (const branch of ['positiveCases', 'deniedCases', 'unknownCases']) {
        const cases = oracleStep.branchOracles?.[branch] ?? [];
        if (hasBoundActionOrOperation) {
          assert.ok(cases.length > 0, `${row.journeyRef}/${index + 1} needs explicit ${branch} branch-oracle cases for its bound effect/query`);
        }
        assert.equal(auditStep.branchCaseCounts[branch], cases.length);
        for (const [caseIndex, item] of cases.entries()) {
          assert.equal(typeof item.case, 'string', `${row.journeyRef}/${index + 1} ${branch} case is named`);
          assert.equal(typeof item.guardVerdict, 'string', `${row.journeyRef}/${index + 1} ${branch} verdict is explicit`);
          assert.equal(item.runtimeAdmission ?? 'NOT_ADMITTED', 'NOT_ADMITTED');
          assert.equal(item.ownerAcceptedOutcomeOracle ?? false, false);
          assert.equal(item.typedFixturePayload, undefined, 'guard verdict cases do not silently become typed state fixtures');
          const branchName = branch === 'positiveCases' ? 'positive' : branch === 'deniedCases' ? 'denied' : 'unknown';
          if (branchName === 'unknown' && item.expectedDecision === 'NON_EXECUTABLE_NO_ACTION_DISPATCH') {
            assert.equal(item.guardVerdict, 'UNKNOWN');
            assert.throws(() => createStepBranchDefinitionFixture({
              fixtureId: `media.definition-branch.${row.journeyRef.toLowerCase()}.step-${String(index + 1).padStart(2, '0')}.unknown-${caseIndex + 1}`,
              sourceRef: `.product-experience/pdp-3-product-experience/step-definition-oracles.yaml#journeys/${stepOracles.journeys.findIndex(({ journeyId }) => journeyId === row.journeyRef)}/steps/${index}/branchOracles/${branch}/${caseIndex}`,
              journeyRef: row.journeyRef,
              stepRef: auditStep.sourceRef,
              branch: 'unknown',
              case: item.case,
              guardVerdict: item.guardVerdict,
              expectedDecision: item.expectedDecision,
            }), /unknown branch must preserve the source hold-without-replay decision/u,
            `${row.journeyRef}/${index + 1} leaves unresolved action identity non-executable instead of fabricating a runnable branch fixture`);
            continue;
          }
          const oracleJourneyIndex = stepOracles.journeys.findIndex(({ journeyId }) => journeyId === row.journeyRef);
          const branchFixture = createStepBranchDefinitionFixture({
            fixtureId: `media.definition-branch.${row.journeyRef.toLowerCase()}.step-${String(index + 1).padStart(2, '0')}.${branchName}-${caseIndex + 1}`,
            sourceRef: `.product-experience/pdp-3-product-experience/step-definition-oracles.yaml#journeys/${oracleJourneyIndex}/steps/${index}/branchOracles/${branch}/${caseIndex}`,
            journeyRef: row.journeyRef,
            stepRef: auditStep.sourceRef,
            branch: branchName,
            case: item.case,
            guardVerdict: item.guardVerdict,
            expectedDecision: item.expectedDecision,
            ...(item.selectedCapabilityRef ? { selectedCapabilityRef: item.selectedCapabilityRef } : {}),
            ...(item.selectedOperationRef ? { selectedOperationRef: item.selectedOperationRef } : {}),
          });
          assert.equal(branchFixture.synthetic, true);
          assert.equal(branchFixture.ownerAcceptedOutcomeOracle, false);
          assert.equal(branchFixture.dispatch, 'NEVER');
          assert.equal(branchFixture.runtimeAdmission, 'NOT_ADMITTED');
          assert.equal('authorityEvidence' in branchFixture, false);
          assert.equal('typedFixturePayload' in branchFixture, false);
        }
      }
    }
  }
  assert.deepEqual(auditJourneyIds, new Set(registry.journeyCoverage.journeysWithoutExactSimulationSeeds));
});

test('P3-05 branch fixtures project exact guard cases without becoming state or authority evidence', () => {
  const journeyIndex = stepOracles.journeys.findIndex(({ journeyId }) => journeyId === 'J-05');
  const stepIndex = stepOracles.journeys[journeyIndex].steps.findIndex(({ id }) => id === 'J-05.step-01');
  const step = stepOracles.journeys[journeyIndex].steps[stepIndex];
  const caseFor = (branch, index = 0) => {
    const item = step.branchOracles[`${branch}Cases`][index];
    const sourceRef = `.product-experience/pdp-3-product-experience/step-definition-oracles.yaml#journeys/${journeyIndex}/steps/${stepIndex}/branchOracles/${branch}Cases/${index}`;
    return createStepBranchDefinitionFixture({
      fixtureId: `media.definition-branch.j-05.step-01.${branch}-${index + 1}`,
      sourceRef,
      journeyRef: 'J-05',
      stepRef: step.sourceRef,
      branch: branch === 'positive' ? 'positive' : branch === 'denied' ? 'denied' : 'unknown',
      case: item.case,
      guardVerdict: item.guardVerdict,
      expectedDecision: item.expectedDecision,
      ...(item.selectedCapabilityRef ? { selectedCapabilityRef: item.selectedCapabilityRef } : {}),
      ...(item.selectedOperationRef ? { selectedOperationRef: item.selectedOperationRef } : {}),
    });
  };

  const positive = caseFor('positive', 0);
  const denied = caseFor('denied');
  const unknown = caseFor('unknown');
  assert.equal(positive.sourceRef, '.product-experience/pdp-3-product-experience/step-definition-oracles.yaml#journeys/0/steps/0/branchOracles/positiveCases/0');
  assert.equal(positive.selectedCapabilityRef, 'media.vision.detect');
  assert.equal(denied.guardVerdict, 'DENIED');
  assert.equal(denied.expectedDecision, 'DENY_WITHOUT_EFFECT');
  assert.equal(unknown.guardVerdict, 'UNKNOWN');
  assert.equal(unknown.expectedDecision, 'HOLD_WITHOUT_EFFECT_OR_REPLAY');
  for (const fixture of [positive, denied, unknown]) {
    assert.equal(fixture.fixtureKind, 'STEP_GUARD_BRANCH_INPUT');
    assert.equal(fixture.synthetic, true);
    assert.equal(fixture.dispatch, 'NEVER');
    assert.equal(fixture.ownerAcceptedOutcomeOracle, false);
    assert.equal(fixture.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal('scenarioRef' in fixture, false, 'branch inputs remain separate from the 31 state scenarios');
    assert.equal('startingState' in fixture, false, 'guard verdicts never synthesize canonical state');
    assert.equal('authorityEvidence' in fixture, false, 'guard verdicts never synthesize authorization evidence');
  }
  assert.throws(() => createStepBranchDefinitionFixture({
    fixtureId: 'denied-with-pass', sourceRef: denied.sourceRef, journeyRef: denied.journeyRef,
    stepRef: denied.stepRef, branch: 'denied', case: denied.case, guardVerdict: 'PASS',
    expectedDecision: 'DENY_WITHOUT_EFFECT',
  }), /requires DENIED guard verdict/u);
  assert.throws(() => createStepBranchDefinitionFixture({
    fixtureId: 'unknown-replay', sourceRef: unknown.sourceRef, journeyRef: unknown.journeyRef,
    stepRef: unknown.stepRef, branch: 'unknown', case: unknown.case, guardVerdict: 'UNKNOWN',
    expectedDecision: 'RETRY_AUTOMATICALLY',
  }), /hold-without-replay/u);
  assert.throws(() => createStepBranchDefinitionFixture({
    fixtureId: 'missing-source', sourceRef: ' ', journeyRef: 'J-05', stepRef: step.sourceRef,
    branch: 'positive', case: positive.case, guardVerdict: 'PASS', expectedDecision: positive.expectedDecision,
  }), /exact source and case identities/u);
  assert.throws(() => createStepBranchDefinitionFixture({
    fixtureId: 'stale-is-not-a-generic-branch', sourceRef: positive.sourceRef, journeyRef: 'J-05',
    stepRef: step.sourceRef, branch: 'stale', case: positive.case, guardVerdict: 'UNKNOWN',
    expectedDecision: 'HOLD_WITHOUT_EFFECT_OR_REPLAY',
  }), /does not infer an unlisted branch category/u);
});

test('P3-05 reuses the exact version-mismatch guard for all source-bound stale branches', () => {
  const audit = registry.unseededJourneyFixtureAudit.branchApplicabilityAudit;
  const stepFixtureByRef = new Map(registry.stepDefinitionOracleCoverage.records.map((row) => [row.stepRef, row]));
  const unseededJourneyIds = new Set(registry.journeyCoverage.journeysWithoutExactSimulationSeeds);
  const boundRows = versionBindingSource.records.filter((row) => row.versionDisposition === 'EXACT_CANONICAL_VERSION_TUPLE_REQUIRED'
    && unseededJourneyIds.has(row.journeyRef)
    && row.objectBindings.some((binding) => binding.versionTupleFields.length > 0));
  assert.equal(boundRows.length, 66);
  assert.equal(audit.reusableVersionMismatchGuardFixture.applicableExactVersionBoundStepCount, boundRows.length);
  const byJourney = new Map();
  for (const row of boundRows) {
    assert.match(row.versionBindingRule, /missing, stale, foreign-tenant, mismatched, or substituted-latest identity is UNKNOWN/iu);
    assert.ok(row.versionFieldBindings.some(({ canonicalVersionIdentityRequirement }) =>
      canonicalVersionIdentityRequirement?.missingOrStaleDisposition === 'UNKNOWN'));
    byJourney.set(row.journeyRef, (byJourney.get(row.journeyRef) ?? 0) + 1);
    const identity = row.versionFieldBindings.find(({ canonicalVersionIdentityRequirement }) =>
      canonicalVersionIdentityRequirement?.missingOrStaleDisposition === 'UNKNOWN')?.canonicalVersionIdentityRequirement;
    assert.ok(identity?.exactTupleFields?.length, `${row.id} gives the exact tuple fields for its stale definition input`);
    const staleFixture = createVersionMismatchGuardDefinitionFixture({
      fixtureId: `media.definition-fixture.version-mismatch.${row.id}`,
      sourceRef: `.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=${row.id}`,
      journeyRef: row.journeyRef,
      stepRef: row.stepRef,
      versionDisposition: row.versionDisposition,
      versionBindingRule: row.versionBindingRule,
      missingOrStaleDisposition: identity.missingOrStaleDisposition,
      exactVersionTupleFields: identity.exactTupleFields,
    });
    assert.deepEqual(stepFixtureByRef.get(row.stepRef)?.versionMismatchFixtureRefs, [staleFixture.fixtureId],
      `${row.id} exact stale mismatch fixture is linked from its canonical step oracle`);
    assert.equal(staleFixture.expectedGuardVerdict, 'UNKNOWN', `${row.id} stale input fails closed`);
    assert.equal(staleFixture.expectedEffect, 'NONE');
    assert.equal(staleFixture.expectedDecision, 'HOLD_WITHOUT_EFFECT_OR_REPLAY');
    assert.equal(staleFixture.conditionEvaluated, false);
    assert.equal(staleFixture.dispatch, 'NEVER');
    assert.equal(staleFixture.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal('authorityEvidence' in staleFixture, false);
    assert.equal('runtimeResult' in staleFixture, false);
  }
  assert.equal(byJourney.size, 25);
  assert.equal([...byJourney.keys()].includes('J-28'), false);
  for (const auditRow of audit.rows) {
    assert.equal(auditRow.versionBoundStepCount, byJourney.get(auditRow.journeyRef) ?? 0, `${auditRow.journeyRef} exact stale applicability count`);
  }

  const sampleRow = boundRows.find(({ stepSemanticDefinitionId }) => stepSemanticDefinitionId === 'J-05.step-01');
  const exactObjectBinding = sampleRow.objectBindings.find(({ versionTupleFields }) => versionTupleFields.length > 0);
  const exactVersionIdentity = sampleRow.versionFieldBindings.find(({ objectRef }) => objectRef === exactObjectBinding.objectRef)
    ?.canonicalVersionIdentityRequirement;
  assert.ok(exactVersionIdentity, 'sample exact-version source row binds the canonical identity tuple');
  const fixture = createVersionMismatchGuardDefinitionFixture({
    fixtureId: audit.reusableVersionMismatchGuardFixture.fixtureId,
    sourceRef: `.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=${sampleRow.id}`,
    journeyRef: sampleRow.journeyRef,
    stepRef: sampleRow.stepRef,
    versionDisposition: sampleRow.versionDisposition,
    versionBindingRule: sampleRow.versionBindingRule,
    missingOrStaleDisposition: exactVersionIdentity.missingOrStaleDisposition,
    exactVersionTupleFields: exactVersionIdentity.exactTupleFields,
  });
  assert.deepEqual(Object.keys(fixture.syntheticExpectedTuple), exactVersionIdentity.exactTupleFields);
  assert.deepEqual(Object.keys(fixture.syntheticPresentedTuple), exactVersionIdentity.exactTupleFields);
  assert.notDeepEqual(fixture.syntheticPresentedTuple, fixture.syntheticExpectedTuple, 'synthetic version tokens express a mismatch only');
  assert.equal(fixture.syntheticExpectedTuple.tenantId, fixture.syntheticPresentedTuple.tenantId);
  assert.equal(fixture.syntheticExpectedTuple.artifactId, fixture.syntheticPresentedTuple.artifactId);
  assert.notEqual(fixture.syntheticExpectedTuple.versionId, fixture.syntheticPresentedTuple.versionId);
  const canonicalReferenceSchema = ownerWireSource.$defs.canonicalReferences['media_domain_artifact-version'];
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, validateFormats: false, allErrors: true });
  assert.equal(ajv.validate(canonicalReferenceSchema, {
    objectType: exactObjectBinding.objectRef,
    identity: fixture.syntheticExpectedTuple,
  }), true, `expected synthetic identity follows exact PDP-1 schema: ${JSON.stringify(ajv.errors)}`);
  assert.equal(ajv.validate(canonicalReferenceSchema, {
    objectType: exactObjectBinding.objectRef,
    identity: fixture.syntheticPresentedTuple,
  }), true, `presented synthetic identity follows exact PDP-1 schema: ${JSON.stringify(ajv.errors)}`);
  assert.equal(fixture.conditionEvaluated, false);
  assert.equal(fixture.expectedGuardVerdict, 'UNKNOWN');
  assert.equal(fixture.expectedDecision, 'HOLD_WITHOUT_EFFECT_OR_REPLAY');
  assert.equal(fixture.expectedEffect, 'NONE');
  assert.equal(fixture.dispatch, 'NEVER');
  assert.equal(fixture.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal('canonicalState' in fixture, false);
  assert.equal('authorityEvidence' in fixture, false);
  assert.equal('runtimeResult' in fixture, false);
  assert.throws(() => createVersionMismatchGuardDefinitionFixture({
    fixtureId: 'j-28-not-version-bound', sourceRef: 'step-version-binding-contracts.yaml#records/@id=media.step-version-binding.j-28-01.v1',
    journeyRef: 'J-28', stepRef: '.product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/steps/0',
    versionDisposition: 'NO_CANONICAL_VERSION_TUPLE_REQUIRED', versionBindingRule: 'no version tuple',
    missingOrStaleDisposition: 'UNKNOWN', exactVersionTupleFields: [],
  }), /source does not define an exact version mismatch as UNKNOWN/u);

  const operationById = new Map([
    ...operationSource.ownerDefinedOperationContracts.records,
    ...operationSource.capabilityOperationContracts.records,
    ...operationSource.individualOperationContracts.records,
  ].map((row) => [row.id, row]));
  const unknownOutcomeOperationRefs = new Set(audit.rows.flatMap((row) => row.unknownOutcomeOperationRefs));
  assert.ok(unknownOutcomeOperationRefs.size > 0);
  for (const operationRef of unknownOutcomeOperationRefs) {
    const operation = operationById.get(operationRef);
    assert.ok(operation, `${operationRef} is an exact PDP-1 operation`);
    assert.ok(operation.resultSchema?.properties?.outcome?.enum?.includes('UNKNOWN_OUTCOME'), `${operationRef} declares unknown outcome in its result schema`);
  }
  for (const row of audit.rows) {
    assert.equal(row.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(row.ownerAcceptedOutcomeOracle, false);
    if (row.journeyRef === 'J-29') {
      assert.match(row.recoveryDisposition, /^PXD-160_BINDS_ONE_EXACT_SAME_SESSION_QUERY/u);
      assert.equal(row.boundRecoveryObservationQueryStepCount, 1);
      assert.equal(row.unimplementedRecoveryRuleSourceStepCount, 3);
    } else {
      assert.match(row.recoveryDisposition, /^UNIMPLEMENTED_TYPED_RECOVERY_OBSERVATION/u);
    }
  }
});

test('P3-05 recovery observation binds one exact same-session query while remaining definition-only', async () => {
  const audit = registry.unseededJourneyFixtureAudit.branchApplicabilityAudit;
  const boundary = audit.typedRecoveryObservationBoundary;
  assert.equal(boundary.status, 'ONE_EXACT_PXD_160_SAME_SESSION_QUERY_BOUND; OTHER_RECOVERY_RULES_REMAIN_UNIMPLEMENTED');
  assert.equal(boundary.unimplementedJourneyCount, 26);
  assert.equal(boundary.boundRecoveryObservationQueryCount, 1);
  assert.equal(boundary.boundRecoveryObservationStepRef,
    '.product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/steps/1');
  assert.equal(boundary.unimplementedRecoveryRuleSourceStepCount, 105);
  assert.equal(boundary.conditionEvaluated, false);
  assert.equal(boundary.dispatch, 'NEVER');
  assert.equal(boundary.replay, 'NEVER');
  assert.equal(boundary.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(boundary.ownerAcceptedOutcomeOracle, false);
  assert.match(boundary.sourceReason, /one exact J-29 recovery QUERY/u);
  assert.match(boundary.sourceReason, /other recovery rule source steps still lack/u);

  const sourceCounts = new Map();
  for (const contract of await Promise.all((await readdir(journeyDirectory))
    .filter((file) => file.endsWith('.yaml'))
    .map(async (file) => parse(await readFile(`${journeyDirectory}/${file}`, 'utf8'))))) {
    const oracle = stepOracles.journeys.find(({ journeyId }) => journeyId === contract.journeyId);
    const count = contract.steps.filter((step, index) => step.recovery
      || oracle.steps[index].recovery
      || oracle.steps[index].sessionRecoveryDefinition).length;
    sourceCounts.set(contract.journeyId, count);
  }
  assert.equal(audit.rows.length, 26);
  assert.equal(audit.rows.reduce((sum, row) => sum + row.recoveryRuleSourceStepCount, 0), 106);
  for (const row of audit.rows) {
    const sourceCount = sourceCounts.get(row.journeyRef);
    assert.equal(row.recoveryRuleSourceStepCount, sourceCount, `${row.journeyRef} only counts source recovery-bearing steps`);
    if (sourceCount === 0) {
      assert.match(row.recoveryDisposition, /^NOT_APPLICABLE/u, `${row.journeyRef} without recovery text cannot inherit the gap`);
    } else if (row.journeyRef === 'J-29') {
      assert.match(row.recoveryDisposition, /^PXD-160_BINDS_ONE_EXACT_SAME_SESSION_QUERY/u);
    } else {
      assert.match(row.recoveryDisposition, /^UNIMPLEMENTED_TYPED_RECOVERY_OBSERVATION/u);
      assert.match(row.recoveryDisposition, /only to this row's recoveryRuleSourceStepCount/u);
    }
  }

  const ownerQueries = new Map(operationSource.ownerDefinedOperationContracts.records.map((operation) => [operation.id, operation]));
  const sessionRead = ownerQueries.get('media.operation.stream-session.inspect.v1');
  const consentRead = ownerQueries.get('media.operation.consent-record-inspect.v1');
  const recoveryRead = ownerQueries.get('media.operation.stream-session.inspect-execution-recovery.v1');
  assert.deepEqual(Object.keys(sessionRead.requestSchema.properties), ['sessionId']);
  assert.deepEqual(Object.keys(sessionRead.resultSchema.properties), ['sessionId', 'observation', 'observedAt', 'readVersion']);
  assert.match(sessionRead.readSemantics, /does not connect, reconnect, close, or acknowledge a frame/u);
  assert.deepEqual(Object.keys(consentRead.requestSchema.properties), ['consentId']);
  assert.match(consentRead.readSemantics, /not a current permitted-use decision/u);
  assert.ok(!JSON.stringify(sessionRead.resultSchema).match(/lease|fencing|frame|budget/iu));
  assert.ok(!JSON.stringify(consentRead.resultSchema).match(/lease|fencing|frame|budget|currentness/iu));
  assert.deepEqual(Object.keys(recoveryRead.requestSchema.properties), ['sessionId']);
  assert.deepEqual(Object.keys(recoveryRead.resultSchema.properties), ['sessionId', 'observation', 'observedAt', 'readVersion']);
  assert.match(JSON.stringify(recoveryRead.resultSchema), /consentCurrentness/u);
  assert.match(JSON.stringify(recoveryRead.resultSchema), /resolvedFrameOutcomeCoverage/u);
  assert.match(recoveryRead.readSemantics, /never dispatches or replays work/u);
  assert.deepEqual(operationSource.ownerConsentRevisionObservationContract.requestSchema.required,
    ['queryId', 'consentId', 'purposeRef']);
  assert.ok(!JSON.stringify(operationSource.ownerConsentRevisionObservationContract.resultSchema).match(/lease|fencing|frame|budget/iu));

  const liveRecovery = stepOracles.journeys.find(({ journeyId }) => journeyId === 'J-29');
  const recoveryStep = liveRecovery.steps.find(({ id }) => id === 'J-29.step-02');
  assert.deepEqual(recoveryStep.canonicalBindings.operationRefs, [], 'the supporting observation QUERY is not promoted into a domain mutation');
  assert.deepEqual(recoveryStep.canonicalBindings.supportingObservationOperationRefs,
    ['media.operation.stream-session.inspect.v1', 'media.operation.consent-record-inspect.v1', 'media.operation.stream-session.inspect-execution-recovery.v1']);
  assert.equal(recoveryStep.supportingObservationDecisionRef,
    '.product-experience/decision-log.md#PXD-160');
  assert.equal(recoveryStep.sessionRecoveryDefinition.candidateOperationRef, 'media.operation.stream-session.inspect-execution-recovery.v1');
  assert.match(recoveryStep.sessionRecoveryDefinition.candidateOperationStatus, /EXACT_PXD_160_SUPPORTING_QUERY; SINGLE_SNAPSHOT; DISPATCH_NONE; RUNTIME_NOT_ADMITTED/u);
  assert.equal(recoveryStep.sessionRecoveryDefinition.runtimeAdmission, 'NOT_ADMITTED');
});

test('P3-05 caption-draft stale-revision fixtures are schema-only conditional denial inputs', () => {
  const audit = registry.unseededJourneyFixtureAudit.branchApplicabilityAudit;
  const operation = operationSource.operations.find(({ id }) => id === 'media.operation.caption-draft-write');
  assert.ok(operation);
  assert.equal(operation.preconditions[4], 'expectedDraftRevision-matches-current-session-local-draft');
  const requestSchema = operation.ownerWireSchema.requestSchema;
  const bindingRecords = operationSource.ownerDefinedJourneyOperationBindings.records;
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, validateFormats: false, allErrors: true });
  assert.equal(audit.staleDraftRevisionFixtures.count, 2);
  for (const row of audit.staleDraftRevisionFixtures.records) {
    const oracleJourney = stepOracles.journeys.find(({ journeyId }) => journeyId === row.journeyRef);
    const stepIndex = Number(row.stepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const oracleStep = oracleJourney.steps[stepIndex];
    const exactOperationRefs = [
      ...(oracleStep.canonicalOperationRefs ?? []),
      ...(oracleStep.canonicalBindings?.operationRefs ?? []),
    ];
    assert.ok(exactOperationRefs.includes(audit.staleDraftRevisionFixtures.operationRef), `${row.journeyRef}/${row.stepId} binds the exact caption draft operation`);
    const bindingId = row.failClosedCaseRef.match(/@id=([^/]+)\/failClosedCases\/0$/u)?.[1];
    const operationBinding = bindingRecords.find(({ id }) => id === bindingId);
    assert.ok(operationBinding);
    assert.match(operationBinding.failClosedCases[0], /stale draft revision.*rejects without advancing the draft/iu);
    assert.match(row.expectedDraftRevisionPreconditionRef, /operations.yaml#operations\/@id=media\.operation\.caption-draft-write\/preconditions\/4$/u);
    const fixture = createStaleDraftRevisionDefinitionFixture({
      fixtureId: row.fixtureId,
      sourceRefs: [row.stepRef, row.failClosedCaseRef, row.expectedDraftRevisionPreconditionRef, audit.staleDraftRevisionFixtures.requestSchemaRef],
      journeyRef: row.journeyRef,
      stepRef: row.stepRef,
      operationRef: audit.staleDraftRevisionFixtures.operationRef,
      requestSchemaRef: audit.staleDraftRevisionFixtures.requestSchemaRef,
      requestSchema,
    });
    assert.equal(ajv.validate(requestSchema, fixture.request), true, `${row.fixtureId} synthetic request matches exact owner wire schema: ${JSON.stringify(ajv.errors)}`);
    assert.equal(fixture.requestIsSyntheticSchemaSample, true);
    assert.equal(Number.isSafeInteger(fixture.request.expectedDraftRevision), true);
    assert.equal(fixture.conditionEvaluated, false);
    assert.equal(fixture.expectedDecision, 'REJECT_WITHOUT_ADVANCE_IF_CONDITION_HOLDS');
    assert.equal(fixture.dispatch, 'NEVER');
    assert.equal(fixture.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal('currentDraftRevision' in fixture, false);
    assert.equal('result' in fixture, false);
    assert.equal('effectApplied' in fixture, false);
  }
  const invalidRequestSchema = structuredClone(requestSchema);
  invalidRequestSchema.required = invalidRequestSchema.required.filter((field) => field !== 'expectedDraftRevision');
  assert.throws(() => createStaleDraftRevisionDefinitionFixture({
    fixtureId: 'invalid-stale-draft-schema', sourceRefs: ['source'], journeyRef: 'J-16', stepRef: 'step',
    operationRef: 'media.operation.caption-draft-write', requestSchemaRef: 'schema', requestSchema: invalidRequestSchema,
  }), /does not bind expectedDraftRevision as an integer/u);
});

test('P3-05 bounded unknown-result and no-query recovery oracles remain synthetic and fail closed', async () => {
  const audit = registry.unseededJourneyFixtureAudit.branchApplicabilityAudit;
  const unknownCorpus = audit.boundedOperationUnknownOutcomeFixtures;
  const recoveryCorpus = audit.boundedRecoveryNoQueryFixtures;
  const recoveryQueryCorpus = audit.boundedRecoveryObservationQueries;
  assert.equal(unknownCorpus.uniqueOperationCount, 44);
  assert.equal(unknownCorpus.sourceBindingOccurrenceCount, 59);
  assert.equal(unknownCorpus.boundStepOperationCount, 48);
  assert.equal(unknownCorpus.records.length, 48);
  assert.equal(recoveryCorpus.recoveryStepCount, 105);
  assert.equal(recoveryCorpus.records.length, 105);
  assert.equal(recoveryQueryCorpus.recordCount, 1);
  assert.equal(recoveryQueryCorpus.records.length, 1);
  assert.match(unknownCorpus.status, /^SCHEMA_VALID_SYNTHETIC_RESULT_FIXTURES/u);
  assert.match(recoveryCorpus.status, /^SAFE_NO_QUERY_UNKNOWN/u);

  const sourceUnknownOperationRefs = new Set(audit.rows.flatMap((row) => row.unknownOutcomeOperationRefs));
  const fixtureUnknownOperationRefs = new Set(unknownCorpus.records.map((row) => row.operationRef));
  assert.deepEqual(fixtureUnknownOperationRefs, sourceUnknownOperationRefs,
    'the bounded unknown-result corpus covers exactly the operation refs declared by the per-journey source audit');
  let sourceBindingOccurrences = 0;
  const sourceStepBindings = new Map(unknownCorpus.records.map((row) => [`${row.journeyRef}:${row.stepRef}`, row]));
  for (const row of sourceStepBindings.values()) {
    const oracleJourney = stepOracles.journeys.find(({ journeyId }) => journeyId === row.journeyRef);
    const stepIndex = Number(row.stepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const oracleStep = oracleJourney?.steps[stepIndex];
    const exactOperationRefs = [
      ...(oracleStep?.canonicalBindings?.operationRefs ?? []),
      ...(oracleStep?.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? []),
    ];
    sourceBindingOccurrences += exactOperationRefs.filter((operationRef) => sourceUnknownOperationRefs.has(operationRef)).length;
  }
  assert.equal(sourceBindingOccurrences, unknownCorpus.sourceBindingOccurrenceCount);

  const operationById = new Map([
    ...operationSource.ownerDefinedOperationContracts.records,
    ...operationSource.capabilityOperationContracts.records,
    ...operationSource.individualOperationContracts.records,
  ].map((row) => [row.id, row]));
  const fixtureIdSet = new Set();
  const bindingSet = new Set();
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, validateFormats: false, allErrors: true });
  for (const row of unknownCorpus.records) {
    assert.ok(!fixtureIdSet.has(row.fixtureRef), `unique unknown-result fixture ${row.fixtureRef}`);
    fixtureIdSet.add(row.fixtureRef);
    const oracleJourney = stepOracles.journeys.find(({ journeyId }) => journeyId === row.journeyRef);
    const stepIndex = Number(row.stepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const oracleStep = oracleJourney?.steps[stepIndex];
    assert.ok(oracleStep, `${row.fixtureRef} exact step oracle exists`);
    assert.equal(row.stepRef, oracleStep.sourceRef);
    assert.equal(row.oracleStepRef, `${stepOraclePath}#journeys/${stepOracles.journeys.indexOf(oracleJourney)}/steps/${stepIndex}`);
    const exactOperationRefs = [
      ...(oracleStep.canonicalBindings?.operationRefs ?? []),
      ...(oracleStep.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? []),
    ];
    assert.ok(exactOperationRefs.includes(row.operationRef), `${row.operationRef} is bound to ${row.stepRef}`);
    const operation = operationById.get(row.operationRef);
    assert.ok(operation?.resultSchema?.properties?.outcome?.enum?.includes('UNKNOWN_OUTCOME'), `${row.operationRef} has an exact P1 unknown result enum`);
    assert.equal(row.requestSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#${row.operationRef}/requestSchema`);
    assert.equal(row.resultSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#${row.operationRef}/resultSchema`);
    const requestSchema = projectOperationSchema(operation.requestSchema, operation);
    const resultSchema = projectOperationSchema(operation.resultSchema, operation);
    const outcomeSchema = resultSchema.properties?.outcome;
    assert.ok(outcomeSchema && Array.isArray(outcomeSchema.enum));
    resultSchema.properties.outcome = { ...outcomeSchema, const: 'UNKNOWN_OUTCOME' };
    delete resultSchema.properties.outcome.enum;
    const sample = createOperationDefinitionFixture({
      fixtureId: row.fixtureRef,
      journeyRef: row.journeyRef,
      stepRef: row.stepRef,
      actionRef: oracleStep.actionRef ?? 'source-bound-operation-without-action-ref',
      capabilityRef: null,
      operationRef: row.operationRef,
      requestSchemaRef: row.requestSchemaRef,
      resultSchemaRef: row.resultSchemaRef,
      requestSchema,
      resultSchema,
    });
    applyExactUnknownOutcomeConstraints(resultSchema, sample.resultShape);
    assert.equal(ajv.validate(requestSchema, sample.request), true, `${row.fixtureRef} request schema: ${JSON.stringify(ajv.errors)}`);
    assert.equal(ajv.validate(resultSchema, sample.resultShape), true, `${row.fixtureRef} UNKNOWN_OUTCOME schema: ${JSON.stringify(ajv.errors)}`);
    assert.equal(sample.resultShape.outcome, 'UNKNOWN_OUTCOME');
    assert.equal(sample.synthetic, true);
    assert.equal(sample.resultIsOwnerEvidence, false);
    assert.equal(sample.dispatch, 'NEVER');
    assert.equal(sample.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(row.synthetic, true);
    assert.equal(row.expectedOutcome, 'UNKNOWN_OUTCOME');
    assert.equal(row.sameIdentityDisposition, 'REUSE_EXACT_SYNTHETIC_REQUEST_ONLY; no replacement request identity');
    assert.equal(row.dispatch, 'NEVER');
    assert.equal(row.replay, 'NEVER');
    assert.equal(row.ownerAcceptedOutcomeOracle, false);
    assert.equal(row.runtimeAdmission, 'NOT_ADMITTED');
    const requestIdentity = sample.request.requestId ?? JSON.stringify(sample.request);
    assert.equal(requestIdentity.length > 0, true, `${row.fixtureRef} preserves an exact request identity for observation`);
    bindingSet.add(`${row.journeyRef}:${row.stepRef}:${row.operationRef}`);
  }
  assert.equal(bindingSet.size, 48);

  const contractsByJourney = new Map();
  for (const row of registry.unseededJourneyFixtureAudit.records) {
    contractsByJourney.set(row.journeyRef, parse(await readFile(row.journeyContractRef, 'utf8')));
  }
  const recoveryIds = new Set();
  const recoverySources = new Set();
  for (const row of recoveryCorpus.records) {
    assert.ok(!recoveryIds.has(row.fixtureRef), `unique recovery fixture ${row.fixtureRef}`);
    recoveryIds.add(row.fixtureRef);
    const contract = contractsByJourney.get(row.journeyRef);
    const oracleJourney = stepOracles.journeys.find(({ journeyId }) => journeyId === row.journeyRef);
    const stepIndex = Number(row.stepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const contractStep = contract?.steps[stepIndex];
    const oracleStep = oracleJourney?.steps[stepIndex];
    assert.ok(contractStep && oracleStep, `${row.fixtureRef} has exact journey and oracle steps`);
    assert.equal(row.stepRef, oracleStep.sourceRef);
    assert.ok(contractStep.recovery || oracleStep.recovery || oracleStep.sessionRecoveryDefinition, `${row.fixtureRef} is tied to source recovery text`);
    assert.ok(row.recoverySourceRef.startsWith(row.stepRef.split('#/steps/')[0]), `${row.fixtureRef} source is within its exact journey contract`);
    assert.equal(row.recoveryOracleStepRef, `${stepOraclePath}#journeys/${stepOracles.journeys.indexOf(oracleJourney)}/steps/${stepIndex}`);
    assert.equal(row.oracleKind, 'SAFE_NO_QUERY_UNKNOWN_WHILE_TYPED_RECOVERY_IS_UNIMPLEMENTED');
    assert.equal(row.synthetic, true);
    assert.equal(row.conditionEvaluated, false);
    assert.equal(row.expectedObservation, 'UNKNOWN');
    assert.equal(row.expectedDecision, 'HOLD_WITHOUT_EFFECT_OR_REPLAY');
    assert.equal(row.dispatch, 'NEVER');
    assert.equal(row.replay, 'NEVER');
    assert.equal(row.ownerAcceptedOutcomeOracle, false);
    assert.equal(row.runtimeAdmission, 'NOT_ADMITTED');
    recoverySources.add(`${row.journeyRef}:${row.stepRef}`);
  }
  assert.equal(recoverySources.size, 105);
  assert.ok(!recoveryCorpus.records.some(({ journeyRef, stepRef }) => journeyRef === 'J-29' && stepRef.endsWith('/steps/1')),
    'the exact query-bound J-29 step is excluded from the no-query unknown corpus');
  const liveSession = recoveryQueryCorpus.records[0];
  assert.equal(liveSession.journeyRef, 'J-29');
  assert.ok(liveSession.stepRef.endsWith('/steps/1'));
  assert.equal(liveSession.operationRef, 'media.operation.stream-session.inspect-execution-recovery.v1');
  assert.equal(liveSession.operationKind, 'QUERY');
  assert.deepEqual(liveSession.snapshotIdentityFields, ['sessionId', 'observedAt', 'readVersion']);
  assert.deepEqual(liveSession.requiredObservationFields, [
    'canonicalStateRef', 'stateAuthorityRef', 'stateEvidenceRef', 'consentRef', 'consentRevision',
    'consentCurrentness', 'purposeRef', 'purposeRevision', 'purposeCurrentness', 'leaseVersion',
    'leaseCurrentness', 'fencingToken', 'lastAcknowledgedSequence', 'nextSequence',
    'resolvedFrameOutcomeCoverage', 'resolvedFrameOutcomeRange', 'resolvedFrameOutcomeRefs',
    'reconnectBudgetRemaining',
  ]);
  assert.equal(liveSession.conditionEvaluated, false);
  assert.equal(liveSession.dispatch, 'NEVER');
  assert.equal(liveSession.replay, 'NEVER');
  assert.equal(liveSession.ownerAcceptedOutcomeOracle, false);
  assert.equal(liveSession.runtimeAdmission, 'NOT_ADMITTED');
});
