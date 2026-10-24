import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002RebindCandidate} from '../scripts/lib/media-pdp0-aud-spec-002-rebind-candidate.mjs';
import {createHash} from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crosswalkRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const auditRef = 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json';
const capabilitiesRef = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const requirementsRef = '.product-experience/pdp-0-product-truth/requirements.yaml';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function inputs() {
  const crosswalkBytes = fs.readFileSync(path.join(root, crosswalkRef));
  const auditBytes = fs.readFileSync(path.join(root, auditRef));
  const capabilitiesBytes = fs.readFileSync(path.join(root, capabilitiesRef));
  const requirementsBytes = fs.readFileSync(path.join(root, requirementsRef));
  return {
    crosswalkBytes, auditBytes, capabilitiesBytes, requirementsBytes,
  };
}

test('proposes only the exact existing AUD-SPEC-002 typed compiler submeaning and preserves the PDP-1 migration handoff', () => {
  const source = inputs();
  const {candidate, postimageBytes, predecessorBytes, capabilitiesPostimageBytes, requirementsPostimageBytes} = buildAudSpec002RebindCandidate(source);
  const before = JSON.parse(predecessorBytes.toString('utf8'));
  const after = JSON.parse(postimageBytes.toString('utf8'));
  const beforeRow = before.rows.find(row => row.auditId === 'AUD-SPEC-002');
  const afterRow = after.rows.find(row => row.auditId === 'AUD-SPEC-002');
  assert.equal(candidate.status, 'CANDIDATE_PENDING_SOURCE_OWNER_AND_DISTINCT_PEER_REVIEW');
  assert.deepEqual(candidate.blockers, [
    'EXACT_ROOT_TECHNICAL_SOURCE_OWNER_DECISION_REQUIRED',
    'DISTINCT_TECHNICAL_PEER_REVIEW_OF_EXACT_POSTIMAGE_REQUIRED',
  ]);
  assert.equal(candidate.canonicalApply, 'NOT_PERFORMED');
  assert.equal(after.rows.length, 501);
  assert.deepEqual(after.rows.filter(row => row.auditId !== 'AUD-SPEC-002'), before.rows.filter(row => row.auditId !== 'AUD-SPEC-002'));
  assert.deepEqual(afterRow.pdp0EvidenceRefs, [
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.recipe.specification.compile',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-07',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-13',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14',
  ]);
  assert.notDeepEqual(afterRow.pdp0EvidenceRefs, beforeRow.pdp0EvidenceRefs);
  assert.equal(afterRow.disposition, 'BOUND_EXISTING');
  assert.equal(afterRow.proposedPdp0SourceChange, null);
  assert.equal(candidate.coverageAssessment.status, 'PROPOSED_SOURCE_POSTIMAGE_COVERS_COMPILATION_AND_BOUNDED_MIGRATION_CANDIDATE_MEANING');
  assert.equal(afterRow.laterPhaseHandoffs.gap, 'production-schema-migration-mechanics-unbound');
  assert.equal(afterRow.ownerApproval, 'NOT_CLAIMED');
  assert.equal(afterRow.definitionScopeBinding.runtimeAdmission, 'NOT_CLAIMED');
  assert.match(afterRow.phaseLocalRationale, /AC-13\/AC-14 proposal defines only a reviewable, version-bound migration candidate/u);
  const capability = candidate.sourceAmendment.capability;
  assert.equal(capability.id, 'media.recipe.specification.compile');
  assert.ok(capability.inputArtifactTypes.includes('versioned-target-production-specification-schema'));
  assert.ok(capability.inputArtifactTypes.includes('versioned-schema-migration-transformation'));
  assert.ok(capability.outputArtifactTypes.includes('reviewable-version-bound-schema-migration-candidate-and-semantic-diff'));
  assert.match(capability.outcome, /preserve the original specification/iu);
  const cases = new Map(candidate.sourceAmendment.requirement.acceptanceCases.map(item => [item.id, item]));
  assert.match(cases.get('MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-13').then, /semantic diff bound to the exact source specification, source schema, target schema, and transformation/u);
  assert.match(cases.get('MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14').then, /explicit UNKNOWN\/UNSUPPORTED/u);
  const yaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml');
  const capabilitiesAfter = yaml.parse(capabilitiesPostimageBytes.toString('utf8'));
  const requirementsAfter = yaml.parse(requirementsPostimageBytes.toString('utf8'));
  assert.deepEqual(capabilitiesAfter.capabilities.find(item => item.id === 'media.recipe.specification.compile'), capability);
  assert.deepEqual(requirementsAfter.requirements.find(item => item.id === 'MEDIA-REQ-CAP-RECIPE-TEMPLATE'), candidate.sourceAmendment.requirement);
  assert.equal(candidate.exactTargetFilePostimageSha256.capabilitiesYaml, digest(capabilitiesPostimageBytes));
  assert.equal(candidate.exactTargetFilePostimageSha256.requirementsYaml, digest(requirementsPostimageBytes));
  assert.deepEqual(capabilitiesAfter.capabilities.filter(item => item.id !== 'media.recipe.specification.compile'), yaml.parse(source.capabilitiesBytes.toString('utf8')).capabilities.filter(item => item.id !== 'media.recipe.specification.compile'));
  assert.deepEqual(requirementsAfter.requirements.filter(item => item.id !== 'MEDIA-REQ-CAP-RECIPE-TEMPLATE'), yaml.parse(source.requirementsBytes.toString('utf8')).requirements.filter(item => item.id !== 'MEDIA-REQ-CAP-RECIPE-TEMPLATE'));
});

test('candidate assembly stays authority-neutral even if unrelated decision-shaped inputs are supplied', () => {
  const source = inputs();
  const plain = buildAudSpec002RebindCandidate(source).candidate;
  const withClaims = buildAudSpec002RebindCandidate({...source, decision: {disposition: 'APPROVE'}, peerReview: {disposition: 'REVIEWED'}}).candidate;
  assert.deepEqual(withClaims, plain);
  assert.equal(withClaims.status, 'CANDIDATE_PENDING_SOURCE_OWNER_AND_DISTINCT_PEER_REVIEW');
  assert.deepEqual(withClaims.blockers, [
    'EXACT_ROOT_TECHNICAL_SOURCE_OWNER_DECISION_REQUIRED',
    'DISTINCT_TECHNICAL_PEER_REVIEW_OF_EXACT_POSTIMAGE_REQUIRED',
  ]);
  assert.equal(withClaims.canonicalApply, 'NOT_PERFORMED');
});

test('rejects changed audit source and malformed existing compiler acceptance criteria', () => {
  const source = inputs();
  const audit = JSON.parse(source.auditBytes.toString('utf8'));
  audit.originalAudit.inventory.find(row => row.audit_id === 'AUD-SPEC-002').capability = 'Different source feature';
  assert.throws(() => buildAudSpec002RebindCandidate({...source, auditBytes: Buffer.from(JSON.stringify(audit))}), /source meaning changed/u);
  const requirementsBytes = Buffer.from(source.requirementsBytes.toString('utf8').replace(
    'Reject invalid or unauthorized fields without project, asset, job, or external effects; unknown normalization or compiler support remains UNKNOWN or UNSUPPORTED rather than a claimed compiled result.',
    'no negative boundary',
  ));
  assert.throws(() => buildAudSpec002RebindCandidate({...source, requirementsBytes}), /AC-07 no longer covers/u);
});
