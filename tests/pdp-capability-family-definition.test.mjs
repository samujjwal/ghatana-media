import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = require('yaml');
const [capabilitiesText, operationsText] = await Promise.all([
  readFile('.product-experience/pdp-0-product-truth/capabilities.yaml', 'utf8'),
  readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'),
]);
const capabilities = parse(capabilitiesText);
const operations = parse(operationsText);

test('capability families are exact leaf groupings without inherited operations or readiness', () => {
  const policy = capabilities.familyDefinitionPolicy;
  assert.equal(policy.id, 'media.capability-family-definition.v1');
  assert.equal(policy.scopeStatus, 'OWNER_DEFINED_DEFINITION_ONLY');
  assert.match(policy.purpose, /not a dispatchable aggregate operation/u);
  assert.match(policy.familyMembership, /does not copy, broaden, or override/u);
  assert.match(policy.operationIdentity, /never substitutes for a leaf operationRef/u);
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
  const operationRefs = new Set(operations.capabilityOperationContracts.records.flatMap((record) => record.capabilityRefs ?? [record.capabilityRef].filter(Boolean)));
  assert.ok(operationRefs.size > 0);
  assert.ok(policy.sourceRefs.includes('.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts.records'));
});
