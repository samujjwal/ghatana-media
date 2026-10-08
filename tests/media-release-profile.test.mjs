import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'config/release/internal-validation-only.json'), 'utf8'));
const checklist = fs.readFileSync(path.join(root, 'docs/qualification/R-05-release-profile-admission.md'), 'utf8');

test('internal validation profile is bounded and denies release activation', () => {
  assert.equal(profile.schemaVersion, 'ghatana.media.release-profile.v1');
  assert.equal(profile.profileVersion, 1);
  assert.equal(profile.releaseClass, 'INTERNAL_VALIDATION_ONLY');
  assert.equal(profile.commercialUse, false);
  assert.equal(profile.publicDistribution, false);
  assert.equal(profile.externalDeployment, false);
  assert.equal(profile.consumerCutover, false);
  assert.equal(profile.candidateStatus, 'REFERENCE_ONLY_NOT_A_RELEASE_CANDIDATE');
  assert.equal(profile.artifactIdentity.status, 'UNBOUND_NO_IMMUTABLE_CANDIDATE');
  for (const key of ['sourceRevision', 'buildDigest', 'sbomDigest']) {
    assert.equal(profile.artifactIdentity[key], null, `${key} must not imply a candidate exists`);
  }
  for (const value of Object.values(profile.dependencyAdmission)) {
    assert.equal(value, 'NOT_ADMITTED');
  }
  assert.match(profile.authority.doesNotAuthorize.join('\n'), /Lifecycle phase acceptance/u);
  assert.match(profile.authority.doesNotAuthorize.join('\n'), /license/u);
});

test('production admission criteria remain explicit and blocked', () => {
  assert.ok(profile.requiredProductionGates.length >= 8);
  assert.match(checklist, /Current status \|[\s\S]*`NOT_ADMITTED`/u);
  assert.match(checklist, /rollback procedure and test/u);
  assert.match(checklist, /No profile may promote/u);
});
