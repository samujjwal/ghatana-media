import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMediaPdp0AqPxd216OwnerApplicationProposal} from '../scripts/prepare-media-pdp0-aq-pxd216-owner-application-proposal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('owner/application candidates bind AQ and PXD-216 v5 without decisions or canonical writes', () => {
  const result = buildMediaPdp0AqPxd216OwnerApplicationProposal({repositoryRoot: root});
  const [owner, clarification, proposal] = Object.values(result.outputFiles);

  assert.equal(owner.state, 'DECISION_NOT_RECORDED; CANDIDATE_FOR_AUTHENTIC_SOURCE_OWNER');
  assert.equal(owner.protectedInputs.denominators.surfaceIdentities, 54);
  assert.equal(owner.protectedInputs.denominators.phaseCells, 216);
  assert.equal(owner.protectedInputs.denominators.capabilities, 469);
  assert.equal(owner.protectedInputs.denominators.auditRows, 501);
  assert.equal(owner.independentMappingAdjudications.requiredForRows.length, 6);
  assert.equal(clarification.state, 'CONDITIONAL_OWNER_REVIEW_CANDIDATE; NOT_ADOPTED');
  assert.deepEqual(clarification.affectedRows.map(row => row.sourceOrderIndex), [59, 60, 61, 62, 63, 64]);
  assert.ok(clarification.affectedRows.every(row => row.noDefaultDecision === true));
  assert.equal(proposal.state, 'PROPOSAL_ONLY; OWNER_DECISION_AND_ROOT_TECHNICAL_REVIEW_PENDING');
  assert.deepEqual(proposal.writesInThisProposal, []);
  assert.equal(proposal.authorityBoundary.rootDecision, 'NOT_AUTHORED');
  assert.equal(proposal.authorityBoundary.canonicalApply, 'NONE');
  assert.ok(proposal.forbiddenWrites.includes('docs/implementation/pdp-0-phase-dev-status.json'));
  assert.ok(proposal.forbiddenWrites.includes('docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'));
  for (const [ref, value] of Object.entries(result.outputFiles)) {
    assert.equal(fs.readFileSync(path.join(root, ref), 'utf8'), `${JSON.stringify(value, null, 2)}\n`);
  }
});
