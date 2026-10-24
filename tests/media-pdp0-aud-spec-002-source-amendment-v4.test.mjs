import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002SourceAmendmentV4} from '../scripts/lib/media-pdp0-aud-spec-002-source-amendment-v4.mjs';
import {planAudSpec002V4SourceApply, applyAudSpec002V4SourceAmendment} from '../scripts/lib/media-pdp0-aud-spec-002-source-amendment-v4-apply.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const read = ref => fs.readFileSync(path.join(root, ref));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refs = {
  crosswalk: `${folder}/pdp0-501-disposition-crosswalk.json`,
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  capabilityLeafReview: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  applicationsChannels: '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  decisionLog: '.product-experience/decision-log.md',
  v2Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`,
  v2Postimage: `${folder}/AUD-SPEC-002-source-amendment-postimage.v2.json`,
  v2Crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v2.json`,
};
const inputs = () => ({
  crosswalkBytes: read(refs.crosswalk), auditBytes: read(refs.audit), capabilitiesBytes: read(refs.capabilities),
  requirementsBytes: read(refs.requirements), capabilityLeafReviewBytes: read(refs.capabilityLeafReview),
  applicationsChannelsBytes: read(refs.applicationsChannels), decisionLogBytes: read(refs.decisionLog),
  observedV2CandidateBytes: read(refs.v2Candidate), observedV2SourceAmendmentBytes: read(refs.v2Postimage), observedV2CrosswalkBytes: read(refs.v2Crosswalk),
});
const result = buildAudSpec002SourceAmendmentV4(inputs());
const yaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml');
const Ajv2020 = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('ajv/dist/2020');

test('v4 separates the migration input predicate from the exact PXD-128 output selector', () => {
  const capabilityFile = yaml.parse(result.postimages[refs.capabilities].toString('utf8'));
  const capability = capabilityFile.capabilities.find(row => row.id === 'media.recipe.specification.compile');
  const [graph, migration] = capability.ownerDefinition.successOutputs;
  assert.equal(graph.artifactType, 'normalized-semantic-graph-and-reviewable-project-plan-candidate');
  assert.equal(graph.requiredOnSuccess, true);
  assert.equal(migration.requiredOnSuccess, false);
  assert.equal(migration.requiredWhenSelector, 'migrationIntent=SCHEMA_MIGRATION;sourceSpecification=EXACT_VERSIONED;sourceSchema=EXACT_VERSIONED;targetSchema=EXACT_VERSIONED;transformation=EXACT_DECLARED;transformationSupport=SUPPORTED');
  assert.equal(migration.resultVariants[0].selector, result.candidate.resultVariantSelector);
  assert.match(migration.resultVariants[0].selector, /^resultKind=SUPPORTED_VERSION_BOUND_SCHEMA_MIGRATION_CANDIDATE_AND_SEMANTIC_DIFF;originRelation=SOURCE_DERIVED;epistemicDisposition=SOURCE_DERIVED_TRANSFORMATION;/u);
  assert.notEqual(migration.requiredWhenSelector, migration.resultVariants[0].selector);

  const review = yaml.parse(result.postimages[refs.capabilityLeafReview].toString('utf8'));
  const trust = review.ownerTrustReconstructionDispositions.records.find(row => row.capabilityRef === capability.id);
  assert.equal(trust.outputBranches.length, 2);
  assert.equal(trust.outputBranches[1].outcomes[0].when, result.candidate.resultVariantSelector);
  assert.equal(trust.outputBranches[1].when, `outputArtifactType=${migration.artifactType};${result.candidate.resultVariantSelector}`);
  assert.equal(trust.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(trust.acceptanceEffect, 'none');
});

test('v4 keeps ordinary compile and migration outcomes distinct in PDP-0 acceptance cases', () => {
  const requirementFile = yaml.parse(result.postimages[refs.requirements].toString('utf8'));
  const requirement = requirementFile.requirements.find(row => row.id === 'MEDIA-REQ-CAP-RECIPE-TEMPLATE');
  const ac15 = requirement.acceptanceCases.find(row => row.id.endsWith('-AC-15'));
  const ac16 = requirement.acceptanceCases.find(row => row.id.endsWith('-AC-16'));
  const ac17 = requirement.acceptanceCases.find(row => row.id.endsWith('-AC-17'));
  assert.match(ac15.then, /do not require or emit a migration candidate/u);
  assert.match(ac16.then, /required reviewable version-bound migration candidate and semantic diff/u);
  assert.match(ac16.rejection, /Do not apply the migration/u);
  assert.match(ac17.then, /UNKNOWN\/UNSUPPORTED/u);
  assert.match(ac17.then, /no migration candidate/u);
});

test('v4 adds one PXD-207 scoped extension row and preserves all historic 462 records in order', () => {
  const before = yaml.parse(inputs().capabilityLeafReviewBytes.toString('utf8'));
  const after = yaml.parse(result.postimages[refs.capabilityLeafReview].toString('utf8'));
  const historicOwner = before.ownerCapabilityLeafAdjudication.records;
  const historicTrust = before.ownerTrustReconstructionDispositions.records;
  assert.equal(historicOwner.length, 462);
  assert.equal(historicTrust.length, 462);
  assert.equal(after.ownerCapabilityLeafAdjudication.records.length, 463);
  assert.equal(after.ownerTrustReconstructionDispositions.records.length, 463);
  assert.deepEqual(after.ownerCapabilityLeafAdjudication.records.slice(0, 462), historicOwner);
  assert.deepEqual(after.ownerTrustReconstructionDispositions.records.slice(0, 462), historicTrust);
  const adjudication = after.ownerCapabilityLeafAdjudication.records.at(-1);
  assert.equal(adjudication.id, 'media.capability-adjudication.recipe-specification-compile');
  assert.equal(adjudication.channelApplicability.length, 11);
  assert.equal(adjudication.channelApplicability.filter(row => row.disposition === 'SOURCE_DECLARED_DEFINITION_APPLICABLE').length, 1);
  assert.equal(adjudication.channelApplicability.find(row => row.disposition === 'SOURCE_DECLARED_DEFINITION_APPLICABLE').channelRef, 'media.channel.cli');
  assert.equal(adjudication.runtimeAvailability, 'UNKNOWN');
  assert.equal(adjudication.independentAcceptance, 'P0-010-independent-review-open');
});

test('v4 candidate schema rejects mutation and hashes all four exact target postimages', () => {
  const validator = new Ajv2020({strict: true}).compile(result.schema);
  assert.equal(validator(result.candidate), true);
  assert.equal(result.candidate.exactFileTargets.length, 4);
  for (const [targetRef, bytes] of Object.entries(result.postimages)) {
    const target = result.candidate.exactFileTargets.find(row => row.targetRef === targetRef);
    assert.ok(target);
    assert.equal(target.postimageSha256, hash(bytes));
  }
  assert.equal(validator({...result.candidate, canonicalApply: 'PERFORMED'}), false);
  assert.equal(validator({...result.candidate, resultVariantSelector: 'migrationIntent=SCHEMA_MIGRATION'}), false);
  assert.equal(validator({...result.candidate, exactFileTargets: [...result.candidate.exactFileTargets].reverse()}), false);
  assert.equal(validator({...result.candidate, extensionRegistration: {...result.candidate.extensionRegistration, historicalOwnerRowsPreserved: 461}}), false);
  const amendmentValidator = new Ajv2020({strict: true}).compile(result.sourceAmendmentSchema);
  assert.equal(amendmentValidator(result.sourceAmendment), true);
  assert.equal(amendmentValidator({...result.sourceAmendment, historicalBoundary: {...result.sourceAmendment.historicalBoundary, historic462TrustRows: 'REPLACED'}}), false);
});

test('v4 candidate schema rejects altered source pins and output selectors', () => {
  const validator = new Ajv2020({strict: true}).compile(result.schema);
  assert.equal(validator({...result.candidate, sourceBindings: {...result.candidate.sourceBindings, decisionLogSha256: '0'.repeat(64)}}), true);
  assert.notEqual(result.candidate.sourceBindings.decisionLogSha256, '0'.repeat(64));
  assert.equal(validator({...result.candidate, resultVariantSelector: 'migrationIntent=SCHEMA_MIGRATION'}), false);
  assert.equal(validator({...result.candidate, postimageSha256: {...result.candidate.postimageSha256, capabilityLeafReviewYaml: '0'.repeat(64)}}), true);
  assert.notEqual(result.candidate.postimageSha256.capabilityLeafReviewYaml, '0'.repeat(64));
});

test('v4 apply adapter refuses missing owner/peer records and changed exact target bytes', () => {
  const candidateText = `${JSON.stringify(result.candidate, null, 2)}\n`;
  const sourceBytes = {
    [refs.capabilities]: inputs().capabilitiesBytes,
    [refs.requirements]: inputs().requirementsBytes,
    [refs.crosswalk]: inputs().crosswalkBytes,
    [refs.capabilityLeafReview]: inputs().capabilityLeafReviewBytes,
  };
  const base = {
    candidate: result.candidate, candidateText, rebuiltCandidate: result.candidate,
    sourceBindings: result.candidate.sourceBindings, sourceBytes, postimageBytes: result.postimages,
  };
  assert.throws(() => planAudSpec002V4SourceApply(base), /v4 source-owner decision/u);
  const changed = {...base, postimageBytes: {...result.postimages, [refs.capabilityLeafReview]: Buffer.from('changed')}};
  assert.throws(() => planAudSpec002V4SourceApply(changed), /source bytes differ/u);
  assert.throws(() => applyAudSpec002V4SourceAmendment({root, plan: {schemaVersion: 'media.pdp0.source-amendment-cas-plan.v2', blockers: ['review pending']}, targets: []}), /not fully reviewed and authorized/u);
});
