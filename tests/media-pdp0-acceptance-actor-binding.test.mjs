import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requirementsPath = '.product-experience/pdp-0-product-truth/requirements.yaml';
const requireFromTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireFromTools('yaml').parse;
const source = parseYaml(fs.readFileSync(path.join(root, requirementsPath), 'utf8'));

export function validateDeclarativeActorBindings(document) {
  const errors = [];
  const profile = document?.declarativeProductionProfile;
  const requirements = document?.requirements;
  const clauses = profile?.acceptanceClauses;
  if (!Array.isArray(requirements)) errors.push('requirements must be an array');
  if (!Array.isArray(clauses) || clauses.length !== 61) errors.push('declarative profile must contain exactly 61 acceptance clauses');
  const byId = new Map((requirements ?? []).map(row => [row.id, row]));
  const rule = String(profile?.actorBindingRule ?? '');
  if (!rule.trim()) errors.push('declarative profile actorBindingRule is required');
  if (!/inherits[\s\S]*actor references[\s\S]*responsibility roles[\s\S]*product intent/i.test(rule)
      || !/do not[\s\S]{0,40}redefine or grant authority/i.test(rule)) {
    errors.push('actorBindingRule must inherit parent actorRefs, actorRoles and traceToIntentIds without granting authority');
  }
  for (const clause of clauses ?? []) {
    const parent = byId.get(clause.parentRequirementId);
    if (!parent) { errors.push(`${clause.id}: unknown parentRequirementId ${clause.parentRequirementId}`); continue; }
    for (const field of ['actorRefs', 'actorRoles', 'traceToIntentIds']) {
      const expected = parent[field];
      if (!Array.isArray(expected) || expected.length === 0) errors.push(`${clause.id}: parent has no ${field}`);
      if (JSON.stringify(clause[field] ?? expected) !== JSON.stringify(expected)) errors.push(`${clause.id}: ${field} must inherit exact parent values`);
    }
    for (const field of ['given', 'when', 'then', 'rejection']) {
      if (typeof clause[field] !== 'string' || !clause[field].trim()) errors.push(`${clause.id}: missing case-local ${field}`);
    }
  }
  return errors;
}

test('all declarative clauses bind exact parent actors, roles and intent while retaining local outcomes', () => {
  assert.deepEqual(validateDeclarativeActorBindings(source), []);
  const parents = new Map(source.requirements.map(row => [row.id, row]));
  for (const clause of source.declarativeProductionProfile.acceptanceClauses) {
    const parent = parents.get(clause.parentRequirementId);
    assert.deepEqual(clause.actorRefs ?? parent.actorRefs, parent.actorRefs, `${clause.id} actorRefs`);
    assert.deepEqual(clause.actorRoles ?? parent.actorRoles, parent.actorRoles, `${clause.id} actorRoles`);
    assert.deepEqual(clause.traceToIntentIds ?? parent.traceToIntentIds, parent.traceToIntentIds, `${clause.id} traceToIntentIds`);
    assert.ok(clause.then.trim());
    assert.ok(clause.rejection.trim());
  }
});

test('unknown parent requirement fails closed', () => {
  const mutated = structuredClone(source);
  mutated.declarativeProductionProfile.acceptanceClauses[0].parentRequirementId = 'MEDIA-REQ-INVENTED';
  assert.ok(validateDeclarativeActorBindings(mutated).some(error => /unknown parentRequirementId/.test(error)));
});

test('missing parent actor binding fails closed', () => {
  const mutated = structuredClone(source);
  const parent = mutated.requirements.find(row => row.id === mutated.declarativeProductionProfile.acceptanceClauses[0].parentRequirementId);
  parent.actorRefs = [];
  assert.ok(validateDeclarativeActorBindings(mutated).some(error => /parent has no actorRefs/.test(error)));
});

test('profile rule cannot grant authority to actors or responsibility roles', () => {
  const mutated = structuredClone(source);
  mutated.declarativeProductionProfile.actorBindingRule = 'Actors and responsibility roles grant authority to perform every requested operation.';
  assert.ok(validateDeclarativeActorBindings(mutated).some(error => /without granting authority/.test(error)));
});
