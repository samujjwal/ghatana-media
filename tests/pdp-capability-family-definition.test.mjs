import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = require('yaml');
const capabilitiesText = await readFile('.product-experience/pdp-0-product-truth/capabilities.yaml', 'utf8');
const capabilities = parse(capabilitiesText);

test('capability families are exact leaf groupings without inherited operations or readiness', () => {
  const policy = capabilities.familyDefinitionPolicy;
  assert.equal(policy.id, 'media.capability-family-definition.v1');
  assert.equal(policy.scopeStatus, 'OWNER_DEFINED_DEFINITION_ONLY');
  assert.match(policy.purpose, /not a dispatchable aggregate operation/u);
  assert.match(policy.familyMembership, /does not copy, broaden, or override/u);
  assert.match(policy.capabilityIntentIdentity, /never substitutes for an exact leaf capabilityIntentId/u);
  assert.match(policy.capabilityIntentIdentity, /PDP-1 defines any concrete operations downstream/u);
  assert.match(policy.statusInheritance, /does not imply implementation, license admission, qualification, runtime availability/u);
  assert.match(policy.featureCompleteness, /does not prove that every desired behavior is modeled/u);
  assert.equal(policy.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(policy.independentReview, 'OPEN');

  const leaves = new Set(capabilities.capabilities.map((leaf) => leaf.id));
  assert.ok(capabilities.families.length > 0);
  for (const family of capabilities.families) {
    assert.ok(family.capabilityIds.length > 0, `${family.id} has declared members`);
    for (const member of family.capabilityIds) assert.ok(leaves.has(member), `${family.id} member ${member} resolves to an exact leaf`);
  }
  assert.ok(policy.sourceRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#families'));
  assert.ok(policy.sourceRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities'));
  assert.equal(policy.sourceRefs.some((ref) => ref.includes('/pdp-1-domain-data/')), false);
  for (const family of capabilities.families) {
    assert.equal(Object.hasOwn(family, 'operationRefs'), false, `${family.id} does not inherit operation bindings`);
    assert.equal(Object.hasOwn(family, 'operationContractRef'), false, `${family.id} is not a concrete operation`);
  }
});
