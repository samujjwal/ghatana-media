import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = require('yaml');
const base = '.product-experience/pdp-3-product-experience';
const journeyDir = `${base}/journey-contracts`;

function resolveSourceRef(reference, documents) {
  assert.equal(typeof reference, 'string', 'immediate result source ref is a string');
  const hashIndex = reference.indexOf('#');
  assert.ok(hashIndex > 0 && hashIndex < reference.length - 1, `complete source ref: ${reference}`);
  const sourcePath = reference.slice(0, hashIndex);
  const fragment = reference.slice(hashIndex + 1);
  assert.ok(existsSync(sourcePath), `source file exists: ${sourcePath}`);
  let value = documents.get(sourcePath);
  assert.notEqual(value, undefined, `source file is parsed: ${sourcePath}`);

  const segments = fragment.replace(/^\//u, '').split('/').filter(Boolean);
  for (const rawSegment of segments) {
    const segment = decodeURIComponent(rawSegment.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (Array.isArray(value)) {
      if (/^\d+$/u.test(segment)) value = value[Number(segment)];
      else {
        const selector = segment.match(/^@([^=]+)=(.*)$/u);
        assert.ok(selector, `array selector is exact in ${reference}: ${segment}`);
        value = value.find((item) => item?.[selector[1]] === selector[2]);
      }
    } else if (value && typeof value === 'object' && Object.hasOwn(value, segment)) {
      value = value[segment];
    } else if (value && typeof value === 'object') {
      const selector = segment.match(/^@([^=]+)=(.*)$/u);
      if (!selector) throw new assert.AssertionError({ message: `unresolvable source segment ${segment} in ${reference}` });
      value = Object.entries(value).find(([key, item]) => key === selector[2] || item?.[selector[1]] === selector[2])?.[1];
    } else {
      value = undefined;
    }
    assert.notEqual(value, undefined, `source fragment resolves at ${segment}: ${reference}`);
  }
  assert.notEqual(value, null, `source fragment is not null: ${reference}`);
  return value;
}

const journeyFiles = (await readdir(journeyDir)).filter((file) => file.endsWith('.yaml')).sort();
const journeys = await Promise.all(journeyFiles.map(async (file) => ({
  file,
  definition: parse(await readFile(`${journeyDir}/${file}`, 'utf8')),
})));
const sourcePaths = new Set();
for (const { definition } of journeys) {
  for (const step of definition.steps ?? []) {
    const ref = step.stepDefinitionSemantics?.stepSourceFacts?.resultSourceRef;
    for (const item of Array.isArray(ref) ? ref : [ref]) if (typeof item === 'string') sourcePaths.add(item.split('#', 1)[0]);
  }
}
const documents = new Map(await Promise.all([...sourcePaths].map(async (sourcePath) => [
  sourcePath,
  parse(await readFile(sourcePath, 'utf8')),
])));

test('all 130 journey steps bind an immediate result to an exact resolvable source', () => {
  const steps = journeys.flatMap(({ definition }) => definition.steps.map((step, index) => ({
    journeyId: definition.journeyId,
    ordinal: index + 1,
    step,
  })));
  assert.equal(steps.length, 130);
  for (const { journeyId, ordinal, step } of steps) {
    const facts = step.stepDefinitionSemantics?.stepSourceFacts;
    assert.ok(facts, `${journeyId}/${ordinal} has step source facts`);
    assert.equal(typeof facts.result, 'string', `${journeyId}/${ordinal} has an immediate result`);
    assert.ok(facts.result.trim(), `${journeyId}/${ordinal} immediate result is non-empty`);
    if (facts.resultDisposition === 'CONDITIONAL_NO_RESULT_UNTIL_EXPLICIT_ACTION_CHOICE') {
      const semantics = step.stepDefinitionSemantics;
      assert.match(facts.result, /No result or dispatch occurs until the user explicitly chooses/u);
      assert.equal(semantics.bindingStatus, 'EXPLICIT_ACTION_SET_NO_DEFAULT');
      assert.equal(semantics.domainOperationDisposition, 'NO_OPERATION_SELECTED');
      assert.equal(semantics.choiceSet.status, 'SOURCE_BOUND_ACTION_SET; USER_SELECTION_REQUIRED');
      assert.equal(semantics.choiceSet.selectedActionRef, null);
      assert.equal(semantics.choiceSet.defaultActionRef, null);
      assert.ok(semantics.choiceSet.options.length > 1);
      assert.deepEqual(semantics.choiceSet.options.map(({ actionRef }) => actionRef), semantics.candidateActionRefs);
    } else {
      assert.equal(facts.resultDisposition, 'SOURCE_BOUND_IMMEDIATE_RESULT', `${journeyId}/${ordinal} result disposition`);
    }
    const references = Array.isArray(facts.resultSourceRef) ? facts.resultSourceRef : [facts.resultSourceRef];
    assert.ok(references.length > 0 && references.every((ref) => typeof ref === 'string'), `${journeyId}/${ordinal} exact result refs`);
    assert.ok(!references.some((ref) => ref === 'journey.terminalSuccess' || /#\/terminalSuccess$/u.test(ref)),
      `${journeyId}/${ordinal} terminal journey outcome is not an immediate result source`);
    for (const reference of references) resolveSourceRef(reference, documents);
  }
});

test('source-backed result refs do not contradict the journey step mirror', () => {
  for (const { definition } of journeys) {
    for (const [index, step] of definition.steps.entries()) {
      if (Object.hasOwn(step, 'result')) {
        assert.deepEqual(step.stepDefinitionSemantics.stepSourceFacts.result, step.result,
          `${definition.journeyId}/${index + 1} preserves an explicitly declared source result`);
      }
    }
  }
});

test('J-03 job-status mirror uses the bounded P1 query result while its historical snapshot stays pinned', () => {
  const definition = journeys.find(({ definition: item }) => item.journeyId === 'J-03')?.definition;
  assert.ok(definition, 'J-03 journey exists');
  const step = definition.steps[2];
  const expected = 'Immediate result is limited to the exact P1 query result schema fields requestId, exactTargetRef, ownerReceipt, and observedAt. Job progress and finality remain UNKNOWN because the selected observer contract does not bind those fields; no transcript or caption finality or completion is inferred.';

  assert.equal(step.stepDefinitionSemantics.ordinal, 3);
  assert.equal(step.result, expected, 'current journey-step mirror preserves the bounded P1 query result');
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.result, expected, 'current source facts use the same bounded result');
  assert.equal(step.historicalSourceBinding.fields.result, 'progress-and-finality-reflect-owning-job-state',
    'pinned historical result remains historical and unchanged');
});
