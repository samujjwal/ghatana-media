import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateExperienceDefinition } from '@ghatana/experience-specification';

const projectionBytes = readFileSync(new URL('./experience-specification.candidate.json', import.meta.url));
const projection = JSON.parse(projectionBytes);
const sourceIds = JSON.parse(readFileSync(new URL('./reference-inventory.json', import.meta.url)));
const authority = { resolveReference: (kind, ref) => sourceIds[kind]?.includes(ref) === true };

test('actual Media experience candidate validates through the isolated packed public contract', (t) => {
  t.diagnostic(`Actual copied candidate sha256:${createHash('sha256').update(projectionBytes).digest('hex')}; development artifact only; no publication or phase acceptance`);
  assert.equal(projection.projectionStatus, 'GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT');
  const model = projection.candidateModel;
  assert.equal(model.effects.length, 145);
  assert.equal(model.finality.length, 145);
  assert.doesNotThrow(() => validateExperienceDefinition(model, authority));
});
test('packed public validator rejects conflicting enum/boolean effect and unresolved external references', () => {
  const copy = structuredClone(projection.candidateModel);
  const effect = copy.effects.find(value => value.reversibilityDisposition === 'UNKNOWN');
  assert.ok(effect);
  effect.reversible = true;
  assert.throws(() => validateExperienceDefinition(copy, authority));
  assert.throws(() => validateExperienceDefinition(projection.candidateModel, {resolveReference: () => false}));
});
