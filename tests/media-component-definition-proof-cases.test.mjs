import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { validateComponentDefinitionBindings } from '../scripts/check-media-design-conformance.mjs';
const parse = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const contracts = parse(fs.readFileSync('.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'utf8'));
const bindings = parse(fs.readFileSync('.product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml', 'utf8'));
// One parameterized executable case per existing component; metadata only, never rendered/AT conformance.
for (const { id: componentRef } of contracts.components) {
  test(`component definition proof: ${componentRef}`, () => {
    const index = bindings.definitionBindings.findIndex((entry) => entry.componentRef === componentRef);
    assert.ok(index >= 0, `missing selected definition ${componentRef}`);
    assert.deepEqual(validateComponentDefinitionBindings(bindings, contracts), []);
    const staleRole = structuredClone(bindings);
    staleRole.definitionBindings[index].role = 'invented role';
    assert.ok(validateComponentDefinitionBindings(staleRole, contracts).some((message) => message.includes(`stale component role: ${componentRef}`)));
    const missingInteraction = structuredClone(bindings);
    missingInteraction.definitionBindings[index].interactionSource = 'missing-source';
    assert.ok(validateComponentDefinitionBindings(missingInteraction, contracts).some((message) => message.includes(`missing exact keyboard definition: ${componentRef}`)));
    const forgedAdmission = structuredClone(bindings);
    forgedAdmission.definitionBindings[index].implementationAdmission = 'ADMITTED';
    assert.ok(validateComponentDefinitionBindings(forgedAdmission, contracts).some((message) => message.includes(`unqualified component disposition: ${componentRef}`)));
    const missingRecord = structuredClone(bindings);
    missingRecord.definitionBindings.splice(index, 1);
    assert.ok(validateComponentDefinitionBindings(missingRecord, contracts).some((message) => message.includes(`unbound component definition: ${componentRef}`)));
  });
}
