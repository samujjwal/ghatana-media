import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parse = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
const read = (relative) => parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const review = read('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml');
const journey = read('.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml');
const operations = read('.product-experience/pdp-1-domain-data/operations.yaml');
const goals = read('.product-experience/pdp-0-product-truth/goals-jtbd.yaml');
const channels = read('.product-experience/pdp-0-product-truth/applications-channels.yaml');
const profiles = read('.product-experience/pdp-0-product-truth/profile-semantics.yaml');
const sourceSlices = new Map(operations.individualOperationContracts.records.map((record) => [record.id, record]));
const channelIds = new Set(channels.channels.map(({ id }) => id));
const intentIds = new Set(goals.intents.map(({ id }) => id));
const outcomeIds = new Set(goals.outcomes.map(({ id }) => id));
const profileAxisIds = new Set(profiles.profileAxes.map(({ id }) => id));
const selected = new Map(review.leaves.filter(({ id }) => [
  'media.artifact.upload', 'media.artifact.upload.resume', 'media.artifact.inspect', 'media.artifact.import',
].includes(id)).map((leaf) => [leaf.id, leaf]));

function step(stepId) { return journey.steps.find((item) => item.stepId === stepId); }

test('J-02 source-mapped definition slice binds only upload, same-upload resume, and exact artifact metadata inspection', () => {
  const expected = {
    'media.artifact.upload': {
      stepId: 'J02-2',
      operationRefs: ['media.operation-slice.begin-upload', 'media.operation-slice.append-upload-chunk', 'media.operation-slice.complete-upload'],
      stepOperationRefs: ['media.operation-slice.begin-upload'],
    },
    'media.artifact.upload.resume': {
      stepId: 'J02-3',
      operationRefs: ['media.operation-slice.inspect-upload', 'media.operation-slice.append-upload-chunk', 'media.operation-slice.complete-upload'],
      stepOperationRefs: ['media.operation-slice.inspect-upload', 'media.operation-slice.append-upload-chunk', 'media.operation-slice.complete-upload'],
    },
    'media.artifact.inspect': {
      stepId: 'J02-5',
      operationRefs: ['media.operation-slice.inspect-artifact'],
      stepOperationRefs: ['media.operation-slice.inspect-artifact'],
    },
  };
  assert.equal(review.denominatorReconciliation.capabilityLeaves, 462);
  assert.equal(review.denominatorReconciliation.unresolvedCoverageDispositions, 383,
    'the historical operation-evidence review retains its full-leaf denominator');
  assert.equal(review.ownerCapabilityLeafAdjudication.records.filter((row) =>
    row.ownerDisposition === 'MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY').length, 383,
  'the current P0 owner adjudication resolves those machine capability meanings without requiring operation IDs');
  assert.equal(selected.size, 4);
  for (const [capabilityId, binding] of Object.entries(expected)) {
    const leaf = selected.get(capabilityId);
    const slice = leaf.ownerDefinitionSlice;
    const sourceStep = step(binding.stepId);
    assert.ok(sourceStep, `${binding.stepId} is an exact J-02 step`);
    assert.equal(slice.status, 'OWNER_ACCEPTED_J02_DEFINITION_SLICE; broader-leaf-applicability-and-runtime-not-admitted');
    assert.equal(slice.decisionRef, '.product-experience/decision-log.md#PXD-050');
    assert.equal(slice.journeyRef, '.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml');
    assert.deepEqual(slice.journeyStepRefs, [binding.stepId]);
    assert.deepEqual(slice.intentRefs, [journey.intent]);
    assert.deepEqual(slice.outcomeRefs, journey.outcomes);
    assert.deepEqual(slice.actorRefs, sourceStep.actorRefs);
    assert.deepEqual(slice.channelRefs, journey.channels);
    assert.deepEqual(slice.operationSliceRefs, binding.operationRefs);
    assert.deepEqual(sourceStep.requiredOperationRefs, binding.stepOperationRefs);
    assert.ok(slice.operationSliceRefs.every((id) => sourceSlices.has(id)), `${capabilityId} maps only to canonical individual operation slices`);
    assert.deepEqual(slice.sourceContractRefs, binding.operationRefs.map((id) =>
      `.product-experience/pdp-1-domain-data/operations.yaml#/individualOperationContracts/records/${operations.individualOperationContracts.records.findIndex((record) => record.id === id)}`));
    assert.ok(slice.intentRefs.every((id) => intentIds.has(id)));
    assert.ok(slice.outcomeRefs.every((id) => outcomeIds.has(id)));
    assert.ok(slice.actorRefs.every((id) => journey.actors.includes(id)));
    assert.ok(slice.channelRefs.every((id) => channelIds.has(id)));
    assert.ok(slice.profileApplicability.noProcessingProfileClaim);
    assert.deepEqual(slice.profileApplicability.notApplicableAxes, ['quality-intent', 'delivery-profile']);
    assert.deepEqual(slice.profileApplicability.noTransformationProfileValuesSelected, ['preservation-mode']);
    assert.deepEqual(slice.profileApplicability.unresolvedAxes, ['execution-location', 'resource', 'reproducibility']);
    const expectedAxes = ['execution-location', 'resource', 'quality-intent', 'preservation-mode', 'delivery-profile', 'reproducibility'];
    const axisIds = {
      'execution-location': 'PROFILE-AXIS-EXECUTION-LOCATION',
      resource: 'PROFILE-AXIS-RESOURCE',
      'quality-intent': 'PROFILE-AXIS-QUALITY-INTENT',
      'preservation-mode': 'PROFILE-AXIS-PRESERVATION',
      'delivery-profile': 'PROFILE-AXIS-DELIVERY',
      reproducibility: 'PROFILE-AXIS-REPRODUCIBILITY',
    };
    assert.ok(expectedAxes.every((axis) => profileAxisIds.has(axisIds[axis])), 'all named axes exist in canonical profile semantics');
    assert.ok([...slice.profileApplicability.unresolvedAxes, ...slice.profileApplicability.notApplicableAxes]
      .every((axis) => profileAxisIds.has(axisIds[axis])),
      'profile bounds use exact canonical axes and are not silently inferred from unrelated profile fields');
    assert.match(slice.definitionBoundary, /runtime admission/u);
    assert.ok([...slice.profileApplicability.unresolvedAxes, ...slice.profileApplicability.notApplicableAxes,
      ...slice.profileApplicability.noTransformationProfileValuesSelected].every((axis) => profileAxisIds.has(axisIds[axis])));
  }
});

test('remote import and verification-job observation do not inherit the accepted upload or artifact-inspect slice', () => {
  const importLeaf = selected.get('media.artifact.import');
  assert.equal(Object.hasOwn(importLeaf, 'ownerDefinitionSlice'), false,
    'J-02 upload definition does not classify remote import as upload');
  assert.ok(!selected.get('media.artifact.upload').ownerDefinitionSlice.operationSliceRefs.includes('media.operation-slice.inspect-artifact'));
  assert.ok(!selected.get('media.artifact.inspect').ownerDefinitionSlice.operationSliceRefs.includes('media.operation-slice.inspect-job'));
  const inspectSlice = selected.get('media.artifact.inspect').ownerDefinitionSlice;
  assert.match(inspectSlice.definitionBoundary, /does not dereference bytes.*T-02 verification/u);
  assert.match(inspectSlice.profileApplicability.identityRequirement, /exact immutable artifact version/u);
  const wireRead = sourceSlices.get('media.operation-slice.inspect-artifact');
  assert.ok(wireRead.requestFields.includes('artifactId'));
  assert.ok(!wireRead.requestFields.includes('versionId'), 'the observed read contract does not bind a versionId request field');
  assert.match(wireRead.finality, /metadata and object reference only/u, 'the observed wire read cannot prove the product-side version identity requirement');
  assert.ok(!inspectSlice.operationSliceRefs.includes('media.operation-slice.inspect-job'));
});
