import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertRootSelectedCurrent7Preimages, validateRootSelectedSourceIntegrationR7Operations, sha256R7} from '../scripts/lib/media-pdp0-root-selected-source-integration-projector-r7.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const read = ref => fs.readFileSync(path.join(root, ref));
const json = ref => JSON.parse(read(ref));
const splitLedgerRef = `${folder}/media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json`;
const split = json(splitLedgerRef);

test('R8 split candidate is pinned to all seven current preimages and four exact postimages', () => {
  assert.equal(split.candidateRevision, 'R8_LINEAGE_SUCCESSOR_CANDIDATE_ONLY');
  assert.equal(split.candidateSchemaStatus, 'NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED');
  assert.equal(split.rootMappingDecision.optionId, 'B_SPLIT_BY_OPERATION_SCOPE');
  assert.equal(split.sourceBaseline.targets.length, 7);
  assert.equal(split.outputPostimages.length, 4);
  assert.equal(split.validation.canonicalApply, 'NONE');
  for (const pin of split.sourceBaseline.targets) assert.equal(sha256R7(read(pin.targetRef)), pin.preimageSha256, `stale ${pin.targetRef}`);
  for (const output of split.outputPostimages) assert.equal(sha256R7(read(output.postimageRef)), output.postimageSha256, `postimage mismatch ${output.targetRef}`);
  const leaf = split.outputPostimages.find(row => row.targetRef.endsWith('capability-leaf-review.yaml'));
  const sourceLeaf = split.sourceBaseline.targets.find(row => row.targetRef === leaf.targetRef);
  assert.equal(leaf.postimageSha256, sourceLeaf.preimageSha256, 'leaf review source is preserved byte-identically');
  assert.equal(split.counts.ownerAdjudicationMutations, 0);
  assert.equal(split.counts.trustReconstructionMutations, 0);
});

test('R8 split parent-case operations carry resolvable exact source case and polarity', () => {
  const cases = split.operations.filter(op => op.kind === 'APPEND_REQUIREMENT_CASE');
  assert.equal(cases.length, 58);
  for (const op of cases) {
    assert.ok(op.sourceCapabilityId);
    assert.ok(op.sourceCapabilityCaseId);
    assert.ok(['POSITIVE', 'NEGATIVE'].includes(op.polarity));
    assert.equal(op.record.sourceCapabilityId, op.sourceCapabilityId);
    assert.equal(op.record.sourceCapabilityCaseId, op.sourceCapabilityCaseId);
    assert.equal(op.record.polarity, op.polarity);
  }
  assert.equal(validateRootSelectedSourceIntegrationR7Operations(split.operations), true);
});

test('duplicate operation identities are rejected', () => {
  const ops = structuredClone(split.operations);
  ops.push(structuredClone(ops[0]));
  assert.throws(() => validateRootSelectedSourceIntegrationR7Operations(ops), /duplicate operationId/);
});

test('unregistered owner and trust mutation kinds are rejected', () => {
  for (const kind of ['ADD_OWNER_ADJUDICATION', 'ADD_TRUST_RECONSTRUCTION', 'ADD_CROSSWALK_ROW']) {
    const op = {...structuredClone(split.operations[0]), operationId:`forged-${kind}`, kind};
    assert.throws(() => validateRootSelectedSourceIntegrationR7Operations([op]), /unregistered R7 candidate operation kind/);
  }
});

test('crosswalk patches cannot write fields outside the declared trace allowlist', () => {
  const op = structuredClone(split.operations.find(row => row.kind === 'PATCH_CROSSWALK_TRACE'));
  op.patch.ownerDecision = {approved:true};
  assert.throws(() => validateRootSelectedSourceIntegrationR7Operations([op]), /undeclared field/);
});

test('missing source case identity or mismatched parent polarity is rejected', () => {
  const original = structuredClone(split.operations.find(row => row.kind === 'APPEND_REQUIREMENT_CASE'));
  const missingLink = structuredClone(original);
  delete missingLink.sourceCapabilityCaseId;
  assert.throws(() => validateRootSelectedSourceIntegrationR7Operations([missingLink]), /invalid parent requirement relation/);
  const badPolarity = structuredClone(original);
  badPolarity.polarity = badPolarity.polarity === 'POSITIVE' ? 'NEGATIVE' : 'POSITIVE';
  assert.throws(() => validateRootSelectedSourceIntegrationR7Operations([badPolarity]), /invalid parent requirement relation/);
});

test('stale or missing current7 preimages fail closed', () => {
  const baseline = json(`${folder}/media-pdp0-quality2target-current-source-baseline-2026-10-23.json`).currentTargets;
  const current = Object.fromEntries(baseline.map(row => [row.targetRef, read(row.targetRef)]));
  assert.equal(assertRootSelectedCurrent7Preimages(baseline, current), true);
  const stale = {...current, [baseline[4].targetRef]:Buffer.from('stale')};
  assert.throws(() => assertRootSelectedCurrent7Preimages(baseline, stale), /stale or missing current7 preimage/);
  const missing = {...current}; delete missing[baseline[5].targetRef];
  assert.throws(() => assertRootSelectedCurrent7Preimages(baseline, missing), /stale or missing current7 preimage/);
});

test('frozen R8 proposal pins H review while keeping adoption and apply decisions unset', () => {
  const freezeRef=`${folder}/media-pdp0-root-selected-source-integration-r8.freeze.v1.json`;
  const proposalRef=`${folder}/media-pdp0-root-selected-source-integration-r8.source-adoption-cas-proposal.r2.candidate.v1.json`;
  const peerRef=`${folder}/media-pdp0-root-selected-source-integration-r8.independent-peer.source-peer-r2.json`;
  const freeze=json(freezeRef), proposal=json(proposalRef), peer=json(peerRef);
  assert.equal(freeze.selectedBranch,'split');
  assert.equal(freeze.independentPeer.reviewStatus,'PASS');
  assert.equal(freeze.independentPeer.sha256,sha256R7(read(peerRef)));
  assert.equal(peer.reviewStatus,'PASS');
  assert.equal(proposal.decisionChain.independentFinalPeerReview.status,'PASS_TECHNICAL_ONLY');
  assert.equal(proposal.executionGate.proposalExecutableNow,false);
  assert.equal(proposal.executionGate.canonicalApply,'NONE');
  assert.equal(proposal.decisionChain.sourceOwnerDecision.status,'NOT_SET');
  assert.equal(proposal.decisionChain.rootAdoptionDecision.status,'NOT_SET');
  assert.equal(proposal.decisionChain.applyAuthorization.status,'NOT_SET');
  assert.equal(proposal.candidate.schemaRegistration,'NOT_REGISTERED_PENDING_AUTHORIZED_REGISTRATION');
});
