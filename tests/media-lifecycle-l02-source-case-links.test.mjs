import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const parseYaml = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const componentContracts = parseYaml(fs.readFileSync('.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'utf8')).components;

const proposal = JSON.parse(fs.readFileSync('config/closure/media-product-definition/l02-source-case-links.json', 'utf8'));
const obligations = JSON.parse(fs.readFileSync('config/closure/media-product-definition/obligations.json', 'utf8'));
const simulationPackage = JSON.parse(fs.readFileSync('libs/media-experience-simulation/package.json', 'utf8'));
const obligationIds = obligations.map(({ id }) => id);
const obligationsById = new Map(obligations.map((obligation) => [obligation.id, obligation]));
const screenContractsDirectory = '.product-experience/pdp-3-product-experience/screen-contracts';
const screenContractFiles = fs.readdirSync(screenContractsDirectory)
  .filter((file) => file.endsWith('.yaml'))
  .map((file) => path.join(screenContractsDirectory, file));

function registeredTestBody(source, testName) {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`test\\([\"']${escaped}[\"']\\s*,\\s*(?:async\\s+)?\\(\\)\\s*=>\\s*\\{([\\s\\S]*?)(?=\\n\\s*test\\(|$)`, 'u').exec(source);
  return match?.[1];
}

function screenFixtureRefs(screenId) {
  const matches = screenContractFiles
    .map((sourcePath) => ({ sourcePath, source: fs.readFileSync(sourcePath, 'utf8') }))
    .filter(({ source }) => source.split('\n').some((line) => line.trim() === `screenId: ${screenId}`));
  assert.equal(matches.length, 1, `expected one exact screen contract for ${screenId}`);

  const lines = matches[0].source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('fixtures:'));
  if (start < 0) return [];
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && line && !/^\s|^#/.test(line)) break;
    block.push(line);
  }
  return [...new Set(block.flatMap((line) => line.match(/media\.scenario\.[a-z0-9-]+/gu) ?? []))];
}

function validateLink(link) {
  assert.ok(obligationsById.has(link.obligationId), `stale obligation ${link.obligationId}`);
  const obligation = obligationsById.get(link.obligationId);
  assert.ok(obligation.caseIds.includes(link.caseId), `${link.caseId} is not a case of ${link.obligationId}`);
  const sourcePath = link.testIdentity?.sourcePath;
  if (link.method === 'SOURCE_DEFINITION_CONTRACT_ASSERTIONS') {
    const captionCases = {
      'media.definition-case.caption-version.register': {
        obligationId: 'media.pdp-1.requirement.media.operation.caption-version-write',
        testName: 'caption version registration definition',
        requiredVariables: [
          'missingSourceVersion', 'parentOmittedFromFingerprint', 'approvalPromoted',
          'executionAdmissionForged', 'legacyParentEquated', 'absenceAllowsRetry',
        ],
        assertions: [
          'assert.deepEqual(validateMediaCaptionVersionDefinitions(base), []);',
          'assert.deepEqual(write.inputSemantics.requiredFields',
          'assert.deepEqual(write.outputSemantics.successFields',
          'assert.match(write.scopeStatus, /runtime-NOT_ADMITTED/u);',
        ],
      },
      'media.definition-case.caption-version.compare': {
        obligationId: 'media.pdp-1.requirement.media.operation.caption-version-read',
        testName: 'caption version comparison definition',
        requiredVariables: [
          'sourceEquivalenceForged', 'pairIdentityDropped', 'requestSelectorRemoved',
          'unknownMayReplay', 'globalListAdded', 'approvalClaimed',
        ],
        assertions: [
          'assert.deepEqual(validateMediaCaptionVersionDefinitions(base), []);',
          'assert.deepEqual(read.inputSemantics.selectorKindValues',
          'assert.deepEqual(read.outputSemantics.EXACT_PAIR.requiredFields',
          'assert.deepEqual(read.outputSemantics.REGISTRATION_REQUEST.requiredFields',
          'assert.deepEqual(read.transition.transitionRefs, []);',
        ],
      },
    };
    const expected = captionCases[link.caseId];
    assert.ok(expected, `unexpected caption source-definition case ${link.caseId}`);
    assert.equal(link.obligationId, expected.obligationId);
    assert.equal(sourcePath, 'tests/media-caption-version-operation-definitions.test.mjs');
    assert.equal(link.testIdentity.testName, expected.testName);
    assert.equal(link.assertionEvidence, expected.assertions[0]);
    assert.ok(link.negativeAssertionVariables.length > 0, `${expected.testName} must link negative cases`);
    assert.equal(link.scope, 'PARTIAL_SOURCE_DEFINITION_ASSERTIONS_ONLY');
    assert.equal(link.admission, 'NOT_LIFECYCLE_ADMITTED');
    assert.equal(link.ownerDecisionRef, '.product-experience/decision-log.md#PXD-061');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const body = registeredTestBody(source, expected.testName);
    assert.ok(body, `unregistered source-definition test ${expected.testName}`);
    for (const assertion of expected.assertions) {
      assert.ok(body.includes(assertion), `${expected.testName} no longer includes required contract assertion ${assertion}`);
    }
    for (const variable of expected.requiredVariables) {
      assert.ok(link.negativeAssertionVariables.includes(variable), `source link omits required negative case ${variable}`);
    }
    for (const variable of link.negativeAssertionVariables) {
      assert.match(body, new RegExp(`\\b${variable}\\b`, 'u'), `${expected.testName} no longer declares negative case ${variable}`);
    }
    assert.ok(body.includes('validateMediaCaptionVersionDefinitions(') && body.includes(".join('\\n')"),
      `${expected.testName} negative cases must exercise the source validator`);
    return;
  }

  if (link.method === 'PARAMETERIZED_SOURCE_DEFINITION_ASSERTIONS') {
    assert.equal(sourcePath, 'tests/media-component-definition-proof-cases.test.mjs');
    const parameter = link.parameterizedCase;
    const component = componentContracts[parameter?.sourceRecordIndex];
    assert.ok(component && component.id === parameter.parameterValue, 'stale parameterized component source');
    assert.equal(parameter.parameterName, 'componentRef');
    assert.equal(parameter.sourcePopulationRef, '.product-experience/pdp-2-design-interface-system/component-contracts.yaml#/components');
    assert.equal(parameter.template, 'component definition proof: ${componentRef}');
    assert.equal(link.testIdentity.testName, `component definition proof: ${component.id}`);
    assert.equal(link.obligationId, `media.pdp-2.requirement.${component.id}`);
    assert.equal(link.caseId, `media.definition-case.component-binding.${component.id.slice('media.component.'.length)}`);
    assert.equal(link.ownerDecisionRef, '.product-experience/decision-log.md#PXD-057');
    assert.equal(link.admission, 'NOT_LIFECYCLE_ADMITTED');
    assert.equal(link.scope, 'PARTIAL_SOURCE_DEFINITION_ASSERTIONS_ONLY');
    assert.deepEqual(link.negativeAssertions, ['stale-role', 'missing-keyboard-source', 'forged-implementation-admission', 'missing-selected-component']);
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.ok(source.includes('test(`component definition proof: ${componentRef}`'));
    assert.ok(source.includes(link.assertionEvidence));
    assert.ok(source.includes('staleRole.definitionBindings[index].role'));
    assert.ok(source.includes('missingInteraction.definitionBindings[index].interactionSource'));
    assert.ok(source.includes('forgedAdmission.definitionBindings[index].implementationAdmission'));
    assert.ok(source.includes('missingRecord.definitionBindings.splice(index, 1)'));
    return;
  }

  assert.match(sourcePath ?? '', /^libs\/media-experience-simulation\/tests\/[a-z0-9-]+\.test\.mjs$/u,
    'test source is outside the registered simulation suite');
  assert.match(simulationPackage.scripts.test, /node --test tests\/\*\.test\.mjs/u,
    'source file is not registered by the simulation package test command');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const body = registeredTestBody(source, link.testIdentity?.testName ?? '');
  assert.ok(body, `unregistered test identity ${link.testIdentity?.testName}`);
  assert.ok(body.includes(`media.scenario.${link.caseId.slice('media.scenario.'.length)}`),
    `${link.testIdentity.testName} does not construct/assert the linked scenario`);
  if (link.obligationId.includes('.requirement.media.view.')) {
    const screenId = link.obligationId.slice('media.pdp-3.requirement.'.length);
    assert.ok(screenFixtureRefs(screenId).includes(link.caseId),
      `${link.caseId} is not named by the exact ${screenId} fixture binding`);
    assert.ok(link.assertionEvidence, `${link.obligationId} ${link.caseId} must name its exact assertion`);
  }
  if (link.assertionEvidence) {
    assert.ok(body.includes(link.assertionEvidence),
      `${link.testIdentity.testName} no longer asserts the linked effect`);
  }
  assert.equal(link.scope, 'PARTIAL_CASE_ASSERTIONS_ONLY');
}

test('L-02 source-link proposal preserves all obligations and validates exact existing test identities', () => {
  assert.equal(proposal.status, 'SOURCE_LINK_PROPOSAL_PARTIAL_NOT_EXECUTION_ADMITTED');
  assert.deepEqual(proposal.obligationIds, obligationIds, 'proposal denominator must preserve every obligation ID in source order');
  assert.equal(new Set(proposal.obligationIds).size, 347);
  assert.equal(new Set(proposal.candidateLinks.map(({ obligationId }) => obligationId)).size, 40);
  assert.equal(proposal.candidateLinks.length, 61);
  assert.equal(proposal.unmappedObligationIds.length, 307);
  assert.deepEqual(new Set(proposal.unmappedObligationIds), new Set(obligationIds.filter((id) =>
    !proposal.candidateLinks.some((link) => link.obligationId === id))));

  const links = new Set();
  for (const link of proposal.candidateLinks) {
    const key = `${link.obligationId}\0${link.caseId}`;
    assert.ok(!links.has(key), `duplicate source link ${link.obligationId} ${link.caseId}`);
    links.add(key);
    validateLink(link);
  }

  const captionDefinitionLinks = proposal.candidateLinks.filter((link) => link.method === 'SOURCE_DEFINITION_CONTRACT_ASSERTIONS');
  assert.deepEqual(captionDefinitionLinks.map(({ caseId }) => caseId).sort(), [
    'media.definition-case.caption-version.compare',
    'media.definition-case.caption-version.register',
  ]);

  const sourceAvailableLinks = proposal.candidateLinks.filter((link) => link.caseId === 'media.scenario.source-available');
  assert.deepEqual(sourceAvailableLinks.map(({ obligationId }) => obligationId).sort(), [
    'media.pdp-3.requirement.j-03',
    'media.pdp-3.requirement.media.view.select-source',
  ]);
  assert.ok(sourceAvailableLinks.every((link) => link.assertionEvidence), 'source-available links must name their exact executable assertion');

});

test('L-02 source links reject stale cases and unregistered or unrelated test identities', () => {
  const valid = proposal.candidateLinks[0];
  assert.throws(() => validateLink({ ...valid, obligationId: 'media.pdp-3.requirement.deleted' }), /stale obligation/u);
  assert.throws(() => validateLink({ ...valid, caseId: 'media.scenario.deleted' }), /is not a case/u);
  assert.throws(() => validateLink({
    ...valid,
    testIdentity: { ...valid.testIdentity, testName: 'missing test declaration' },
  }), /unregistered test identity/u);
  assert.throws(() => validateLink({
    ...valid,
    testIdentity: { ...valid.testIdentity, sourcePath: 'tests/pdp-0-final.test.mjs' },
  }), /outside the registered simulation suite/u);
  const linkWithAssertionEvidence = proposal.candidateLinks.find((link) => link.assertionEvidence);
  assert.ok(linkWithAssertionEvidence, 'candidate links with assertion evidence must be validated');
  assert.throws(() => validateLink({
    ...linkWithAssertionEvidence,
    assertionEvidence: 'assertion evidence that is not present in the test',
  }), /no longer asserts the linked effect/u);
});


test('parameterized definition cases reject swapped scope, parameters and invented admission', () => {
  const valid = proposal.candidateLinks.find((link) => link.method === 'PARAMETERIZED_SOURCE_DEFINITION_ASSERTIONS');
  assert.ok(valid);
  for (const mutate of [
    (link) => { link.parameterizedCase.parameterValue = 'media.component.deleted'; },
    (link) => { link.testIdentity.testName = 'invented test'; },
    (link) => { link.scope = 'FULL_OBLIGATION_PASS'; },
    (link) => { link.admission = 'ADMITTED'; },
    (link) => { link.ownerDecisionRef = 'invented decision'; },
    (link) => { link.testIdentity.sourcePath = 'apps/invented-test.mjs'; },
  ]) { const link = structuredClone(valid); mutate(link); assert.throws(() => validateLink(link)); }
});

test('caption source-definition links reject invented case identity, partial-scope promotion, admission and missing negatives', () => {
  const links = proposal.candidateLinks.filter((link) => link.method === 'SOURCE_DEFINITION_CONTRACT_ASSERTIONS');
  assert.equal(links.length, 2);
  for (const valid of links) {
    validateLink(valid);
    for (const mutate of [
      (link) => { link.caseId = 'media.definition-case.caption-version.invented'; },
      (link) => { link.testIdentity.testName = 'invented caption test'; },
      (link) => { link.assertionEvidence = 'assert(true);'; },
      (link) => { link.negativeAssertionVariables = link.negativeAssertionVariables.slice(1); },
      (link) => { link.scope = 'FULL_OBLIGATION_PASS'; },
      (link) => { link.admission = 'LIFECYCLE_ADMITTED'; },
      (link) => { link.ownerDecisionRef = '.product-experience/decision-log.md#PXD-999'; },
    ]) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      assert.throws(() => validateLink(candidate));
    }
  }
});
