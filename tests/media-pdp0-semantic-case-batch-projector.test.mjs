import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {
  MEDIA_PDP0_BATCH_TARGETS,
  buildSemanticBatchPostimages,
  candidateManifestBytes,
  hashSemanticBatchBytes,
  projectMediaPdp0SemanticCaseBatches,
  sealSemanticBatchManifest,
} from '../scripts/lib/media-pdp0-semantic-case-batch-projector.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REVIEW_DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const PEER_RECORD_REF = `${REVIEW_DIR}/cohort-02.r6.independent-peer-2026-10-23.json`;
const [CAPS, REQS, LEAF, CROSSWALK] = MEDIA_PDP0_BATCH_TARGETS;
const asYaml = (value) => Buffer.from(YAML.stringify(value));
const asJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const canonical = (value) => JSON.stringify(stable(value));
const digest = (value) => createHash('sha256').update(Buffer.from(canonical(value))).digest('hex');
const copyBatches = (batches) => batches.map((batch) => ({
  ...batch,
  manifest: structuredClone(batch.manifest),
  manifestBytes: Buffer.from(batch.manifestBytes),
  declaredPostimages: Object.fromEntries(Object.entries(batch.declaredPostimages).map(([ref, bytes]) => [ref, Buffer.from(bytes)])),
}));

function baseSources() {
  const ownerRows = Array.from({length: 462}, (_, index) => ({id: `owner-${String(index + 1).padStart(3, '0')}`, decision: 'PRESERVE', rationale: `base rationale ${index + 1}`, evidence: {source: `leaf-${index + 1}`}}));
  const trustRows = ownerRows.map(({id}, index) => ({id: `trust-${id}`, source: `trust source ${index + 1}`}));
  const capExisting = {
    id: 'cap-existing', operation: 'save', title: 'Existing', requirementIds: ['req-existing'],
    requiredAuthority: ['workspace.write'], explicitUnsupportedCases: ['archived source cannot be changed'],
    ownerDefinition: {typedInputSlots: [{slotId: 'input', sourceType: 'MediaAsset', required: true}], successOutputs: [{artifactType: 'saved-result'}], nonSuccessOutputs: {REJECTED: [], UNKNOWN_OUTCOME: []}, errors: ['INVALID_REQUEST', 'UNKNOWN_OUTCOME'], semanticOutcomeContract: {result: 'The input is saved as a versioned result.'}},
    acceptanceCases: [{given: 'old input', when: 'old action', then: 'old result'}], unrelated: {preserve: true}
  };
  return {
    [CAPS]: asYaml({schemaVersion: 'test.capabilities.v1', retainedRootField: {sentinel: 'caps'}, capabilities: [capExisting]}),
    [REQS]: asYaml({schemaVersion: 'test.requirements.v1', retainedRootField: ['requirements'], requirements: [{id: 'req-existing', statement: 'existing requirement', capabilityIds: ['cap-existing'], acceptanceCases: [{id: 'req-existing-case', given: 'old', when: 'old', then: 'old'}], unrelated: {preserve: true}}]}),
    [LEAF]: asYaml({schemaVersion: 'test.leaf-review.v1', unrelated: {preserve: 'leaf'}, ownerCapabilityLeafAdjudication: {authority: 'historical', exactLeafCount: 462, records: ownerRows}, ownerTrustReconstructionDispositions: {authority: 'historical trust', records: trustRows}}),
    [CROSSWALK]: asJson({schemaVersion: 'test.crosswalk.v1', unrelated: {preserve: true}, rows: [{auditId: 'AUD-BASE-001', status: 'existing'}]}),
  };
}

const hashes = (sources) => Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, hashSemanticBatchBytes(sources[ref])]));
const operation = (kind, rowId, operationId, optionId, targetId, record, extra = {}) => ({kind, rowId, operationId, optionId, targetId, record, ...extra});

function liveSemanticBinding(sources, capabilityId) {
  const cap = YAML.parse(sources[CAPS].toString()).capabilities.find((item) => item.id === capabilityId);
  return {
    operation: cap.operation,
    typedInputSlots: cap.ownerDefinition.typedInputSlots,
    successOutputs: cap.ownerDefinition.successOutputs,
    nonSuccessOutputs: cap.ownerDefinition.nonSuccessOutputs,
    errors: cap.ownerDefinition.errors,
    requiredAuthority: cap.requiredAuthority,
    explicitUnsupportedCases: cap.explicitUnsupportedCases,
  };
}

function existingCapabilityCase(sources, polarity, id) {
  const binding = liveSemanticBinding(sources, 'cap-existing');
  const selector = 'cap-existing.save';
  const inputText = JSON.stringify(binding.typedInputSlots);
  if (polarity === 'POSITIVE') return {
    given: `Feature request has typed input slots ${inputText} and eligible authority ${JSON.stringify(binding.requiredAuthority)}.`,
    when: `Invoke ${selector} for the save feature.`,
    then: `Return success output ${JSON.stringify(binding.successOutputs)}.`,
  };
  return {
    given: `Feature request has typed input slots ${inputText} and unsupported conditions ${JSON.stringify(binding.explicitUnsupportedCases)}.`,
    when: `Invoke ${selector} for the save feature.`,
    then: `Return non-success ${JSON.stringify(binding.nonSuccessOutputs)} with errors ${JSON.stringify(binding.errors)} and authority ${JSON.stringify(binding.requiredAuthority)}.`,
  };
}

function createBatch({sources, sequence, predecessorCandidateSha256 = null, batchId, operations}) {
  const expectedPostimages = buildSemanticBatchPostimages(sources, operations);
  const body = {
    schemaVersion: 'media.pdp0.semantic-case-batch.v1', sequence, batchId, predecessorCandidateSha256,
    builderIdentity: 'agent:/root/semantic-case-batch-test-builder',
    sourcePins: hashes(sources), expectedPostimageSha256: hashes(expectedPostimages),
    rootChoiceRef: `${REVIEW_DIR}/test-${batchId}.root-choice.json`,
    peerReviewRef: `${REVIEW_DIR}/test-${batchId}.independent-typed-source-peer.json`,
    operations,
  };
  const manifest = sealSemanticBatchManifest(body);
  return {manifest, manifestBytes: candidateManifestBytes(manifest), declaredPostimages: expectedPostimages};
}

function rowBindings(operations) {
  return [...new Set(operations.map((item) => item.rowId))].map((rowId) => {
    const grouped = operations.filter((item) => item.rowId === rowId);
    return {rowId, operationIds: grouped.map((item) => item.operationId).sort(), operationDigest: digest(grouped.slice().sort((a, b) => a.operationId.localeCompare(b.operationId))), optionId: grouped[0].optionId};
  });
}

function installTestWorkflow(batches) {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp0-batch-workflow-'));
  const authorityRef = '.product-experience/authority-map.yaml';
  const decisionLogRef = '.product-experience/decision-log.md';
  const decisionLogPath = path.join(repositoryRoot, decisionLogRef);
  const authorityPath = path.join(repositoryRoot, authorityRef);
  fs.mkdirSync(path.dirname(authorityPath), {recursive: true});
  fs.writeFileSync(authorityPath, fs.readFileSync(path.join(ROOT, authorityRef)));
  const peerRecordPath = path.join(repositoryRoot, PEER_RECORD_REF);
  fs.mkdirSync(path.dirname(peerRecordPath), {recursive: true});
  fs.copyFileSync(path.join(ROOT, PEER_RECORD_REF), peerRecordPath);

  const sections = batches.map((batch, index) => {
    const pxdId = `PXD-${String(901 + index).padStart(3, '0')}`;
    const bindings = rowBindings(batch.manifest.operations);
    const rows = bindings.map((binding) => `${binding.rowId} ${binding.optionId} ${binding.operationDigest}`).join('\n');
    return {pxdId, section: `### ${pxdId} — Test-only exact batch decision\n\nCandidate ${batch.manifest.candidateSha256}\nBatch ${batch.manifest.batchId}\n${rows}\n`};
  });
  const decisionLogText = `${sections.map((entry) => entry.section).join('\n')}\n`;
  fs.writeFileSync(decisionLogPath, decisionLogText);
  const decisionLogSha256 = hashSemanticBatchBytes(Buffer.from(decisionLogText));
  const authorityMapSha256 = hashSemanticBatchBytes(fs.readFileSync(authorityPath));

  for (const [index, batch] of batches.entries()) {
    const rootRef = path.join(repositoryRoot, batch.manifest.rootChoiceRef);
    const peerRef = path.join(repositoryRoot, batch.manifest.peerReviewRef);
    fs.mkdirSync(path.dirname(rootRef), {recursive: true});
    fs.mkdirSync(path.dirname(peerRef), {recursive: true});
    const bindings = rowBindings(batch.manifest.operations);
    const decisionSectionSha256 = fingerprintPxdDecisionSection(decisionLogText, sections[index].pxdId).sha256;
    const candidateFileSha256 = hashSemanticBatchBytes(batch.manifestBytes);
    const rootChoice = {
      schemaVersion: 'media.pdp0.semantic-case-batch-root-choice.v2', ref: batch.manifest.rootChoiceRef,
      candidateSha256: batch.manifest.candidateSha256, candidateFileSha256,
      sourcePins: batch.manifest.sourcePins, expectedPostimageSha256: batch.manifest.expectedPostimageSha256,
      sourceOwner: {role: 'media-product', authorityRef: '.product-experience/authority-map.yaml#/canonicalPdpPhases/@id=PDP-0/semanticOwner'},
      builderIdentity: batch.manifest.builderIdentity,
      ownerAdoption: 'UNKNOWN', authorityMapSha256, decisionRef: `${decisionLogRef}#${sections[index].pxdId}`,
      decisionLogSha256, decisionSectionSha256,
      decisions: bindings.map(({rowId, operationIds, operationDigest, optionId}) => ({rowId, operationIds, operationDigest, optionId, disposition: 'APPROVE_EXACT_PROPOSAL'})),
    };
    const peerReview = {
      schemaVersion: 'media.pdp0.semantic-case-batch-peer-review.v2', ref: batch.manifest.peerReviewRef,
      reviewKind: 'INDEPENDENT_READ_ONLY_SOURCE_CONTENT_PEER', reviewStatus: 'PASS',
      reviewer: {
        role: 'DISTINCT_SOURCE_CONTENT_PEER',
        identity: `codex-thread:${JSON.parse(fs.readFileSync(path.join(repositoryRoot, PEER_RECORD_REF), 'utf8')).reviewer.fullThreadId}`,
        registryRef: PEER_RECORD_REF,
      },
      candidateSha256: batch.manifest.candidateSha256, candidateFileSha256,
      sourcePins: batch.manifest.sourcePins, expectedPostimageSha256: batch.manifest.expectedPostimageSha256,
      findings: [],
      rows: bindings.map(({rowId, operationIds, operationDigest}) => ({rowId, operationIds, operationDigest, verdict: 'PASS', findings: []})),
    };
    fs.writeFileSync(rootRef, asJson(rootChoice));
    fs.writeFileSync(peerRef, asJson(peerReview));
  }
  return repositoryRoot;
}

function validThreeBatchChain() {
  const base = baseSources();
  const firstOperations = [
    operation('APPEND_CAPABILITY_CASE', 'AUD-CASE-001', 'op-1a', 'option-case-1', 'cap-existing', existingCapabilityCase(base, 'POSITIVE', 'case-1a'), {casePolarity: 'POSITIVE', semanticBinding: liveSemanticBinding(base, 'cap-existing')}),
    operation('APPEND_REQUIREMENT_CASE', 'AUD-CASE-001', 'op-1b', 'option-case-1', 'req-existing', {id: 'req-case-1', given: 'valid source', when: 'save', then: 'saved'}),
  ];
  const first = createBatch({sources: base, sequence: 1, batchId: 'case-batch-1', operations: firstOperations});
  const projected1 = buildSemanticBatchPostimages(base, firstOperations);
  const secondOperations = [
    operation('APPEND_CAPABILITY_CASE', 'AUD-CASE-002', 'op-2a', 'option-case-2', 'cap-existing', existingCapabilityCase(projected1, 'NEGATIVE', 'case-2a'), {casePolarity: 'NEGATIVE', semanticBinding: liveSemanticBinding(projected1, 'cap-existing')}),
    operation('APPEND_REQUIREMENT_CASE', 'AUD-CASE-002', 'op-2b', 'option-case-2', 'req-existing', {id: 'req-case-2', given: 'invalid source', when: 'save', then: 'rejected'}),
  ];
  const second = createBatch({sources: projected1, sequence: 2, predecessorCandidateSha256: first.manifest.candidateSha256, batchId: 'case-batch-2', operations: secondOperations});
  const projected2 = buildSemanticBatchPostimages(projected1, secondOperations);
  const capInputs = [{slotId: 'asset', sourceType: 'MediaAsset', required: true}];
  const capOutputs = [{artifactType: 'published-asset'}];
  const nonSuccess = {REJECTED: [], UNKNOWN_OUTCOME: []};
  const errors = ['INVALID_REQUEST', 'UNKNOWN_OUTCOME'];
  const authority = ['asset.write'];
  const unsupported = ['missing asset'];
  const operationSelector = 'cap-new.publish';
  const meaningOps = [
    operation('ADD_CAPABILITY_DEFINITION', 'AUD-MEANING-001', 'op-3a', 'option-meaning', 'cap-new', {id: 'cap-new', title: 'New meaning', operation: 'publish', requirementIds: ['req-existing'], requiredAuthority: authority, explicitUnsupportedCases: unsupported, ownerDefinition: {typedInputSlots: capInputs, successOutputs: capOutputs, nonSuccessOutputs: nonSuccess, errors, semanticOutcomeContract: {result: 'The asset is published.'}}, acceptanceCases: [
      {polarity: 'POSITIVE', given: `input ${JSON.stringify(capInputs)}`, when: `Invoke ${operationSelector}`, then: `success ${JSON.stringify(capOutputs)}`},
      {polarity: 'NEGATIVE', given: `input ${JSON.stringify(capInputs)} unsupported ${JSON.stringify(unsupported)}`, when: `Invoke ${operationSelector}`, then: `failure ${JSON.stringify(nonSuccess)} errors ${JSON.stringify(errors)} authority ${JSON.stringify(authority)}`},
    ]}),
    operation('APPEND_REQUIREMENT_CASE', 'AUD-MEANING-001', 'op-3b', 'option-meaning', 'req-existing', {id: 'case-meaning', given: 'valid asset', when: 'publish', then: 'published asset'}),
    operation('APPEND_REQUIREMENT_CAPABILITY_BINDING', 'AUD-MEANING-001', 'op-3c', 'option-meaning', 'req-existing', null, {capabilityId: 'cap-new'}),
    operation('ADD_OWNER_ADJUDICATION', 'AUD-MEANING-001', 'op-3d', 'option-meaning', null, {id: 'owner-new', disposition: 'PENDING_SOURCE_OWNER_ADOPTION', sourceRef: 'cap-new'}),
    operation('ADD_TRUST_RECONSTRUCTION', 'AUD-MEANING-001', 'op-3e', 'option-meaning', null, {id: 'trust-new', status: 'REVIEW_PENDING', sourceRef: 'cap-new'}),
    operation('ADD_CROSSWALK_ROW', 'AUD-MEANING-001', 'op-3f', 'option-meaning', null, {auditId: 'AUD-MEANING-001', target: 'cap-new', status: 'source-bound'}),
  ];
  const third = createBatch({sources: projected2, sequence: 3, predecessorCandidateSha256: second.manifest.candidateSha256, batchId: 'meaning-batch-3', operations: meaningOps});
  const batches = [first, second, third];
  const repositoryRoot = installTestWorkflow(batches);
  return {base, batches, repositoryRoot, expected: buildSemanticBatchPostimages(projected2, meaningOps)};
}

test('projects a three-batch source-pinned chain through authority-map and PXD workflow records; preserves 462 base adjudications', () => {
  const {base, batches, repositoryRoot, expected} = validThreeBatchChain();
  const baseSnapshot = Object.fromEntries(Object.entries(base).map(([ref, bytes]) => [ref, Buffer.from(bytes)]));
  const projected = projectMediaPdp0SemanticCaseBatches({baseSources: base, batches, repositoryRoot});
  assert.equal(projected.status, 'EXACT_SOURCE_POSTIMAGES_PROJECTED; CANONICAL_APPLY_NOT_PERFORMED');
  assert.deepEqual(projected.batches.map((item) => item.batchId), ['case-batch-1', 'case-batch-2', 'meaning-batch-3']);
  assert.deepEqual(Object.fromEntries(Object.entries(projected.sourcePostimages).map(([ref, item]) => [ref, item.bytes])), expected);
  assert.deepEqual(projected.boundedCasPlan.finalTargets.map(({targetRef}) => targetRef).sort(), [...MEDIA_PDP0_BATCH_TARGETS].sort());
  assert.equal(projected.boundedCasPlan.baseOwnerAdjudicationIdentityCount, 462);
  assert.equal(projected.boundedCasPlan.finalOwnerAdjudicationIdentityCount, 463);
  assert.equal(projected.boundedCasPlan.canonicalApply, 'NOT_PERFORMED');
  assert.equal(projected.boundedCasPlan.sourceWrite, 'NOT_PERFORMED');
  assert.deepEqual(base, baseSnapshot, 'projection must not mutate caller-owned source bytes');
  assert.ok(projected.boundedCasPlan.batchPlans.every((plan) => plan.canonicalApply === 'NOT_PERFORMED'));

  const projectedCaps = YAML.parse(projected.sourcePostimages[CAPS].bytes.toString());
  const projectedReqs = YAML.parse(projected.sourcePostimages[REQS].bytes.toString());
  const projectedLeaf = YAML.parse(projected.sourcePostimages[LEAF].bytes.toString());
  const projectedCrosswalk = JSON.parse(projected.sourcePostimages[CROSSWALK].bytes.toString());
  assert.deepEqual(projectedCaps.capabilities[0].unrelated, {preserve: true});
  assert.deepEqual(projectedCaps.retainedRootField, {sentinel: 'caps'});
  assert.deepEqual(projectedReqs.requirements[0].unrelated, {preserve: true});
  assert.deepEqual(projectedReqs.retainedRootField, ['requirements']);
  assert.deepEqual(projectedLeaf.unrelated, {preserve: 'leaf'});
  assert.deepEqual(projectedLeaf.ownerCapabilityLeafAdjudication.records.slice(0, 462), YAML.parse(base[LEAF].toString()).ownerCapabilityLeafAdjudication.records);
  assert.deepEqual(projectedCrosswalk.rows[0], {auditId: 'AUD-BASE-001', status: 'existing'});
  assert.deepEqual(projectedCrosswalk.unrelated, {preserve: true});
  assert.equal(projectedReqs.requirements[0].capabilityIds.at(-1), 'cap-new');
});

test('rejects stale current-source pins and a batch based on anything other than the immediately preceding candidate', () => {
  const {base, batches, repositoryRoot} = validThreeBatchChain();
  const stale = copyBatches(batches);
  stale[1].manifest.sourcePins[CAPS] = '0'.repeat(64);
  const staleBody = {...stale[1].manifest};
  delete staleBody.candidateSha256;
  stale[1].manifest = sealSemanticBatchManifest(staleBody);
  stale[1].manifestBytes = candidateManifestBytes(stale[1].manifest);
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base, batches: stale, repositoryRoot}), /source preimages are stale/u);
  const wrongPredecessor = copyBatches(batches);
  wrongPredecessor[2].manifest.predecessorCandidateSha256 = 'f'.repeat(64);
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base, batches: wrongPredecessor, repositoryRoot}), /predecessor candidate/u);
});

test('rejects caller-authored review bytes, missing choices, non-PASS reviews, and forged peer identities', () => {
  const {base, batches, repositoryRoot} = validThreeBatchChain();
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base, batches: [{...batches[0], rootChoiceBytes: asJson({role: 'media-product'}), peerReviewBytes: asJson({verdict: 'PASS'})}, ...batches.slice(1)], repositoryRoot}), /caller-supplied root\/peer JSON bytes are rejected/u);

  const noChoice = copyBatches(batches);
  const rootPath = path.join(repositoryRoot, noChoice[0].manifest.rootChoiceRef);
  const root = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
  root.decisions.pop();
  fs.writeFileSync(rootPath, asJson(root));
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base, batches: noChoice, repositoryRoot}), /cover every changed row exactly once/u);

  const {base: base2, batches: batches2, repositoryRoot: root2} = validThreeBatchChain();
  const peerPath = path.join(root2, batches2[0].manifest.peerReviewRef);
  const peer = JSON.parse(fs.readFileSync(peerPath, 'utf8'));
  peer.reviewStatus = 'REQUEST_CHANGES';
  fs.writeFileSync(peerPath, asJson(peer));
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base2, batches: batches2, repositoryRoot: root2}), /actual independent read-only PASS/u);

  const {base: base3, batches: batches3, repositoryRoot: root3} = validThreeBatchChain();
  const samePeerPath = path.join(root3, batches3[0].manifest.peerReviewRef);
  const same = JSON.parse(fs.readFileSync(samePeerPath, 'utf8'));
  same.reviewer.identity = 'media-product';
  fs.writeFileSync(samePeerPath, asJson(same));
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base3, batches: batches3, repositoryRoot: root3}), /does not resolve to the fixed technical review record/u);

  const {base: base4, batches: batches4, repositoryRoot: root4} = validThreeBatchChain();
  const r4PeerRef = `${REVIEW_DIR}/cohort-02.r4.independent-peer.v1.json`;
  fs.copyFileSync(path.join(ROOT, r4PeerRef), path.join(root4, batches4[0].manifest.peerReviewRef));
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base4, batches: batches4, repositoryRoot: root4}), /peer review file ref does not match candidate binding/u);
});

test('rejects duplicate/conflicting operations, malformed meaning bundles, and operation/input/output semantic mismatches', () => {
  const {base, batches, repositoryRoot} = validThreeBatchChain();
  const duplicateOperation = batches[0].manifest.operations.map((item) => ({...item, operationId: 'same-op'}));
  assert.throws(() => buildSemanticBatchPostimages(base, duplicateOperation), /duplicate operationId/u);
  const duplicateCase = [batches[0].manifest.operations[0], {...batches[0].manifest.operations[0], operationId: 'op-duplicate-case'}];
  assert.throws(() => buildSemanticBatchPostimages(base, duplicateCase), /duplicate\/conflicting capability case/u);
  const incompleteBundle = [batches[2].manifest.operations[0]];
  assert.throws(() => buildSemanticBatchPostimages(base, incompleteBundle), /missing typed companion operation/u);

  const wrongOperation = {...batches[0].manifest.operations[0], semanticBinding: {...batches[0].manifest.operations[0].semanticBinding, operation: 'other-operation'}};
  assert.throws(() => buildSemanticBatchPostimages(base, [wrongOperation]), /exact live operation\/input\/output\/failure contract/u);
  const wrongOutput = {...batches[0].manifest.operations[0], record: {...batches[0].manifest.operations[0].record, then: 'Return a substituted output.'}};
  assert.throws(() => buildSemanticBatchPostimages(base, [wrongOutput]), /exact success outputs/u);

  const altered = copyBatches(batches);
  altered[2].declaredPostimages[CROSSWALK] = Buffer.from('\n{}\n');
  assert.throws(() => projectMediaPdp0SemanticCaseBatches({baseSources: base, batches: altered, repositoryRoot}), /declared source postimage bytes differ/u);
});
