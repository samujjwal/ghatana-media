import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002SourceAmendmentV3} from '../scripts/lib/media-pdp0-aud-spec-002-source-amendment-v3.mjs';
import {schema} from '../scripts/plan-media-pdp0-aud-spec-002-source-amendment-v3.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const read = ref => fs.readFileSync(path.join(root, ref));
const refs = {
  crosswalk: `${folder}/pdp0-501-disposition-crosswalk.json`,
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  trust: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  v2Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`,
  v2Postimage: `${folder}/AUD-SPEC-002-source-amendment-postimage.v2.json`,
  v2Crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v2.json`,
};
const input = () => ({
  crosswalkBytes: read(refs.crosswalk), auditBytes: read(refs.audit), capabilitiesBytes: read(refs.capabilities),
  requirementsBytes: read(refs.requirements), capabilityLeafReviewBytes: read(refs.trust),
  observedV2CandidateBytes: read(refs.v2Candidate), observedV2SourceAmendmentBytes: read(refs.v2Postimage), observedV2CrosswalkBytes: read(refs.v2Crosswalk),
});
const yaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml');

test('v3 makes the migration result conditional and preserves the ordinary compile output', () => {
  const {candidate, sourceAmendment, capabilityPostimage, requirementPostimage, crosswalkPostimage, postimages} = buildAudSpec002SourceAmendmentV3(input());
  const cap = yaml.parse(capabilityPostimage.toString('utf8')).capabilities.find(row => row.id === 'media.recipe.specification.compile');
  const req = yaml.parse(requirementPostimage.toString('utf8')).requirements.find(row => row.id === 'MEDIA-REQ-CAP-RECIPE-TEMPLATE');
  const outputs = cap.ownerDefinition.successOutputs;
  assert.equal(outputs.find(row => row.artifactType === 'normalized-semantic-graph-and-reviewable-project-plan-candidate').requiredOnSuccess, true);
  const migration = outputs.find(row => row.artifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff');
  assert.equal(migration.requiredOnSuccess, false);
  assert.equal(migration.requiredWhenSelector, migration.resultVariants[0].selector);
  assert.match(migration.resultVariants[0].selector, /sourceSpecification=EXACT_VERSIONED;sourceSchema=EXACT_VERSIONED;targetSchema=EXACT_VERSIONED;transformation=EXACT_DECLARED;transformationSupport=SUPPORTED/u);
  assert.equal(migration.resultVariants[0].disposition, 'NO_MIGRATION_APPLIED');
  assert.equal(req.acceptanceCases.find(row => row.id === 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15').then.includes('do not require or emit a migration candidate'), true);
  assert.equal(req.acceptanceCases.find(row => row.id === 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14').id, 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14');
  assert.equal(sourceAmendment.ordinaryCompileContract.migrationCandidateEmitted, false);
  assert.equal(sourceAmendment.unsupportedOrUnknownContract.migrationCandidate, 'NONE');
  assert.equal(postimages['.product-experience/pdp-0-product-truth/capabilities.yaml'].equals(capabilityPostimage), true);
  assert.equal(JSON.parse(crosswalkPostimage.toString('utf8')).rows.find(row => row.auditId === 'AUD-SPEC-002').pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15'), true);
  assert.equal(candidate.canonicalApply, 'NOT_PERFORMED');
  assert.equal(candidate.effects.sourceStatus, 'UNCHANGED');
});

test('v3 records the frozen-v2 pin mismatch and does not invent missing capability adjudication or trust records', () => {
  const {candidate, sourceAmendment} = buildAudSpec002SourceAmendmentV3(input());
  assert.equal(candidate.previousReviewedCandidateSha256, 'ab9c5455c50df60c33066b0253f996f67885f78429047a6afa995e845b65d867');
  assert.equal(sourceAmendment.predecessorFrozenV2.bytesRecovered, false);
  assert.equal(sourceAmendment.supersedesObservedButUnapprovedV2Bytes.classification, 'LOCAL_REGENERATION_OBSERVATION_ONLY_NOT_FROZEN_PREDECESSOR');
  assert.equal(sourceAmendment.matchingOwnerTrustBranch.observedOwnerCapabilityAdjudicationRecordCount, 0);
  assert.equal(sourceAmendment.matchingOwnerTrustBranch.currentTrustReconstructionRecordCount, 0);
  assert.equal(sourceAmendment.matchingOwnerTrustBranch.noRecordInvented, true);
  assert.ok(candidate.blockers.includes('MATCHING_OWNER_TRUST_BRANCH_REQUIRES_EXISTING_OWNER_CAPABILITY_ADJUDICATION'));
});

test('v3 component hash is independently reproducible and the candidate passes its strict schema', () => {
  const {candidate, sourceAmendmentBytes, capabilityPostimage, requirementPostimage, crosswalkPostimage} = buildAudSpec002SourceAmendmentV3(input());
  const components = {
    capabilityYaml: createHash('sha256').update(capabilityPostimage).digest('hex'),
    requirementsYaml: createHash('sha256').update(requirementPostimage).digest('hex'),
    crosswalkJson: createHash('sha256').update(crosswalkPostimage).digest('hex'),
    sourceAmendmentJson: createHash('sha256').update(sourceAmendmentBytes).digest('hex'),
  };
  assert.deepEqual(candidate.componentPostimageSha256, components);
  assert.equal(candidate.candidatePostimageSha256, createHash('sha256').update(JSON.stringify(components)).digest('hex'));
  const Ajv2020 = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('ajv/dist/2020');
  const ajv = new Ajv2020({strict: true});
  assert.equal(ajv.compile(schema)(candidate), true);
  assert.equal(ajv.compile(schema)({...candidate, accidentalField: true}), false);
  assert.equal(ajv.compile(schema)({...candidate, unresolvedOwnerTrustBranch: {...candidate.unresolvedOwnerTrustBranch, observedOwnerCapabilityAdjudicationRecordCount: 1}}), false);
});
