import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { validateComponentDefinitionBindings } from '../scripts/check-media-design-conformance.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const read = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const bindings = read('.product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml');
const contracts = read('.product-experience/pdp-2-design-interface-system/component-contracts.yaml');
const mutate = (change) => { const copy = structuredClone(bindings); change(copy); return validateComponentDefinitionBindings(copy, contracts); };

test('all 31 existing definitions retain exact role, anatomy, interaction and accessibility ownership', () => {
  assert.deepEqual(validateComponentDefinitionBindings(bindings, contracts), []);
  assert.equal(bindings.definitionBindings.filter((record) => record.disposition === 'CONTRACT_ONLY').length, 28);
  assert.equal(bindings.definitionBindings.filter((record) => record.disposition === 'PUBLIC_COMPONENT_CONTRACT').length, 3);
});

test('missing, duplicate, stale and unknown component definitions fail without reducing the population', () => {
  for (const change of [
    (copy) => copy.definitionBindings.pop(),
    (copy) => { copy.definitionBindings[1] = copy.definitionBindings[0]; },
    (copy) => { copy.definitionBindings[0].componentRef = 'media.component.invented'; },
    (copy) => { copy.definitionBindings[0].contractRef += '.stale'; },
    (copy) => { copy.definitionBindings[0].role = 'guessed from its name'; },
    (copy) => { copy.definitionBindings[0].interactionSource = null; },
  ]) assert.ok(mutate(change).length);
});

test('definition classification cannot impersonate implementation or independent acceptance', () => {
  for (const change of [
    (copy) => { copy.definitionBindingReview.implementationAdmission = 'ADMITTED'; },
    (copy) => { copy.definitionBindingReview.independentConformance = 'PASS'; },
    (copy) => { copy.definitionBindings[0].implementationAdmission = 'ADMITTED'; },
    (copy) => { copy.definitionBindingReview.decisionRef = '.product-experience/decision-log.md#PXD-026'; },
  ]) assert.ok(mutate(change).length);
});

test('public contracts require exact export and prop sources; contract-only records cannot invent props', () => {
  assert.ok(mutate((copy) => { copy.definitionBindings.find((record) => record.disposition === 'PUBLIC_COMPONENT_CONTRACT').publicExport += 'Invented'; }).length);
  assert.ok(mutate((copy) => { copy.definitionBindings.find((record) => record.disposition === 'PUBLIC_COMPONENT_CONTRACT').requiredProps = []; }).length);
  assert.ok(mutate((copy) => { copy.definitionBindings.find((record) => record.disposition === 'CONTRACT_ONLY').publicExport = '@ghatana/design-system#Card'; }).length);
});
