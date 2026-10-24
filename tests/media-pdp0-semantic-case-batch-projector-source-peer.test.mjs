import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewDir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const peerRecordRef = `${reviewDir}/cohort-02.r6.independent-peer-2026-10-23.json`;
const [CAPS, REQS, LEAF, CROSSWALK] = MEDIA_PDP0_BATCH_TARGETS;
const asJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const canonical = (value) => JSON.stringify(stable(value));
const digest = (value) => createHash('sha256').update(Buffer.from(canonical(value))).digest('hex');
const read = (ref) => fs.readFileSync(path.join(root, ref));
const readJson = (ref) => JSON.parse(read(ref).toString('utf8'));

function liveSources() {
  return Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, read(ref)]));
}

function liveBinding(capability) {
  const definition = capability.ownerDefinition;
  return {
    operation: capability.operation,
    typedInputSlots: definition.typedInputSlots,
    successOutputs: definition.successOutputs,
    nonSuccessOutputs: definition.nonSuccessOutputs,
    errors: definition.errors,
    requiredAuthority: capability.requiredAuthority,
    explicitUnsupportedCases: capability.explicitUnsupportedCases,
  };
}

function sourceNamedCase(capability) {
  const definition = capability.ownerDefinition;
  const binding = liveBinding(capability);
  return {
    given: `The request provides exactly these typed inputs ${JSON.stringify(binding.typedInputSlots)} and obeys unsupported boundaries ${JSON.stringify(binding.explicitUnsupportedCases)}.`,
    when: `Invoke ${capability.id}.${capability.operation} with the declared operation identity.`,
    then: `Return the exact success outputs ${JSON.stringify(binding.successOutputs)}; failures remain bounded by ${JSON.stringify(binding.nonSuccessOutputs)}, ${JSON.stringify(binding.errors)}, and authority ${JSON.stringify(binding.requiredAuthority)}.`,
  };
}

function createPositiveBatch(sources, capability) {
  const operation = {
    kind: 'APPEND_CAPABILITY_CASE', rowId: 'AUD-SOURCE-PEER-NAMED-CASE',
    operationId: 'op-source-peer-named-case', optionId: 'option-source-peer-named-case',
    targetId: capability.id, casePolarity: 'POSITIVE', semanticBinding: liveBinding(capability),
    record: sourceNamedCase(capability),
  };
  const postimages = buildSemanticBatchPostimages(sources, [operation]);
  const sourcePins = Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, hashMediaBytes(sources[ref])]));
  const expectedPostimageSha256 = Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, hashMediaBytes(postimages[ref])]));
  const manifest = sealSemanticBatchManifest({
    schemaVersion: 'media.pdp0.semantic-case-batch.v1', sequence: 1,
    batchId: 'source-peer-valid-named-case', predecessorCandidateSha256: null,
    builderIdentity: 'agent:/root/source-peer-test-builder', sourcePins, expectedPostimageSha256,
    rootChoiceRef: `${reviewDir}/test-source-peer.root-choice.json`,
    peerReviewRef: `${reviewDir}/test-source-peer.independent-peer.json`, operations: [operation],
  });
  return {manifest, manifestBytes: candidateManifestBytes(manifest), declaredPostimages: postimages};
}

function hashMediaBytes(bytes) { return hashSemanticBatchBytes(bytes); }

// The temporary workflow models file wiring only. The reviewer identity is resolved from
// the fixed source-controlled technical review record, and this harness claims no signature.
function installTestWorkflow(batch, {forgedPeer = false} = {}) {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp0-source-peer-'));
  const authorityRef = '.product-experience/authority-map.yaml';
  const decisionLogRef = '.product-experience/decision-log.md';
  for (const ref of [authorityRef, peerRecordRef]) {
    const target = path.join(repositoryRoot, ref);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, ref), target);
  }
  const bindings = batch.manifest.operations.map((operation) => ({
    rowId: operation.rowId, optionId: operation.optionId,
    operationDigest: digest([operation]), operationIds: [operation.operationId],
  }));
  const pxdId = 'PXD-998';
  const section = `### ${pxdId} — Test-only batch binding\n\nCandidate ${batch.manifest.candidateSha256}\n${bindings.map((x) => `${x.rowId} ${x.optionId} ${x.operationDigest}`).join('\n')}\n`;
  const decisionLogPath = path.join(repositoryRoot, decisionLogRef);
  fs.mkdirSync(path.dirname(decisionLogPath), {recursive: true});
  fs.writeFileSync(decisionLogPath, `${section}\n`);
  const decisionLogBytes = fs.readFileSync(decisionLogPath);
  const authorityMapBytes = fs.readFileSync(path.join(repositoryRoot, authorityRef));
  const candidateFileSha256 = hashMediaBytes(batch.manifestBytes);
  const pxd = fingerprintPxdDecisionSection(decisionLogBytes.toString('utf8'), pxdId);
  const rootChoice = {
    schemaVersion: 'media.pdp0.semantic-case-batch-root-choice.v2', ref: batch.manifest.rootChoiceRef,
    candidateSha256: batch.manifest.candidateSha256, candidateFileSha256,
    sourcePins: batch.manifest.sourcePins, expectedPostimageSha256: batch.manifest.expectedPostimageSha256,
    sourceOwner: {role: 'media-product', authorityRef: `${authorityRef}#/canonicalPdpPhases/@id=PDP-0/semanticOwner`},
    builderIdentity: batch.manifest.builderIdentity, ownerAdoption: 'UNKNOWN',
    authorityMapSha256: hashMediaBytes(authorityMapBytes), decisionRef: `${decisionLogRef}#${pxdId}`,
    decisionLogSha256: hashMediaBytes(decisionLogBytes), decisionSectionSha256: pxd.sha256,
    decisions: bindings.map(({rowId, operationIds, operationDigest, optionId}) => ({rowId, operationIds, operationDigest, optionId, disposition: 'APPROVE_EXACT_PROPOSAL'})),
  };
  const peerRegistry = readJson(peerRecordRef);
  const identity = `codex-thread:${peerRegistry.reviewer.fullThreadId}`;
  const peerReview = {
    schemaVersion: 'media.pdp0.semantic-case-batch-peer-review.v2', ref: batch.manifest.peerReviewRef,
    reviewKind: 'INDEPENDENT_READ_ONLY_SOURCE_CONTENT_PEER', reviewStatus: 'PASS',
    reviewer: {role: peerRegistry.reviewer.role, identity: forgedPeer ? 'agent:unregistered-peer' : identity, registryRef: peerRecordRef},
    candidateSha256: batch.manifest.candidateSha256, candidateFileSha256,
    sourcePins: batch.manifest.sourcePins, expectedPostimageSha256: batch.manifest.expectedPostimageSha256,
    findings: [], rows: bindings.map(({rowId, operationIds, operationDigest}) => ({rowId, operationIds, operationDigest, verdict: 'PASS', findings: []})),
  };
  for (const [ref, bytes] of [[batch.manifest.rootChoiceRef, asJson(rootChoice)], [batch.manifest.peerReviewRef, asJson(peerReview)]]) {
    const target = path.join(repositoryRoot, ref);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes);
  }
  return repositoryRoot;
}

test('projects one live named case through an exact owner decision and registered independent-peer workflow; preserves 462 owner rows', () => {
  const sources = liveSources();
  const caps = YAML.parse(sources[CAPS].toString());
  const capability = caps.capabilities.find((item) => item.id === 'media.speech.transcription.file');
  assert.ok(capability, 'named capability resolves in current source');
  const batch = createPositiveBatch(sources, capability);
  const repositoryRoot = installTestWorkflow(batch);
  const projected = projectMediaPdp0SemanticCaseBatches({baseSources: sources, batches: [batch], repositoryRoot});
  assert.equal(projected.status, 'EXACT_SOURCE_POSTIMAGES_PROJECTED; CANONICAL_APPLY_NOT_PERFORMED');
  assert.equal(projected.boundedCasPlan.baseOwnerAdjudicationIdentityCount, 462);
  assert.equal(projected.boundedCasPlan.sourceWrite, 'NOT_PERFORMED');
  assert.equal(YAML.parse(projected.sourcePostimages[CAPS].bytes.toString()).capabilities.find((item) => item.id === capability.id).acceptanceCases.at(-1).when, batch.manifest.operations[0].record.when);
});

test('rejects the malformed R4 named-case batch with undefined operations and empty live inputs/outputs', () => {
  const sources = liveSources();
  const r4 = readJson(`${reviewDir}/cohort-02.r4.json`);
  const features = r4.exactFeatureCasePostimages;
  const cases = features.flatMap((row) => row.cases.map((record) => ({row, record})));
  assert.equal(features.length, 60);
  assert.equal(cases.length, 120);
  assert.equal(cases.filter(({record}) => JSON.stringify(record).includes('undefined')).length, 120);
  assert.equal(cases.filter(({record}) => record.given.includes('typed inputs []')).length, 60);
  assert.equal(cases.filter(({record}) => record.then.includes('declared output []')).length, 60);
  const operations = cases.map(({row, record}, index) => ({
    kind: 'APPEND_CAPABILITY_CASE', rowId: row.auditId,
    operationId: `r4-malformed-${String(index + 1).padStart(3, '0')}`,
    optionId: `r4-${row.auditId}`, targetId: row.capabilityId, record,
    casePolarity: index % 2 === 0 ? 'POSITIVE' : 'NEGATIVE',
    semanticBinding: {operation: undefined, typedInputSlots: [], successOutputs: [], nonSuccessOutputs: {}, errors: [], requiredAuthority: [], explicitUnsupportedCases: []},
  }));
  assert.throws(() => buildSemanticBatchPostimages(sources, operations), /exact live operation\/input\/output\/failure contract/u);
});

test('rejects a forged peer identity even when candidate, owner decision, and row verdicts otherwise bind', () => {
  const sources = liveSources();
  const caps = YAML.parse(sources[CAPS].toString());
  const capability = caps.capabilities.find((item) => item.id === 'media.speech.transcription.file');
  const batch = createPositiveBatch(sources, capability);
  const repositoryRoot = installTestWorkflow(batch, {forgedPeer: true});
  assert.throws(
    () => projectMediaPdp0SemanticCaseBatches({baseSources: sources, batches: [batch], repositoryRoot}),
    /does not resolve to the fixed technical review record/u,
  );
});

test('reprojects all 248 peer-approved case operations on the exact v7 six-file baseline', () => {
  const proposalRef = `${reviewDir}/media-pdp0-231-cases-v7-consolidated-projection.v1.json`;
  const proposal = readJson(proposalRef);
  const sourceBytes = {};
  for (const pin of proposal.exactSixFileBase) {
    const bytes = read(pin.postimageRef);
    assert.equal(hashMediaBytes(bytes), pin.sha256, `${pin.postimageRef} must match the exact v7 pin`);
    if (MEDIA_PDP0_BATCH_TARGETS.includes(pin.targetRef)) sourceBytes[pin.targetRef] = bytes;
  }
  assert.equal(proposal.operations.length, 248);
  assert.ok(proposal.operations.every((operation) => ['APPEND_CAPABILITY_CASE', 'APPEND_REQUIREMENT_CASE'].includes(operation.kind)));
  const postimages = buildSemanticBatchPostimages(sourceBytes, proposal.operations);
  for (const target of proposal.projectedTargetSet) {
    assert.equal(hashMediaBytes(postimages[target.targetRef]), target.postimageSha256, `${target.targetRef} postimage must reproduce exactly`);
    assert.deepEqual(postimages[target.targetRef], read(target.postimageRef));
  }
  assert.equal(proposal.counts.rootChoicesSelected, 0);
  assert.equal(proposal.canonicalApply, 'NOT_PERFORMED');
});

test('rejects a peer evidence binding that disagrees with the exact live source contract', () => {
  const proposal = readJson(`${reviewDir}/media-pdp0-231-cases-v7-consolidated-projection.v1.json`);
  const sourceBytes = {};
  for (const pin of proposal.exactSixFileBase) {
    if (MEDIA_PDP0_BATCH_TARGETS.includes(pin.targetRef)) sourceBytes[pin.targetRef] = read(pin.postimageRef);
  }
  const operations = structuredClone(proposal.operations);
  const evidenced = operations.find((operation) => operation.caseSemanticEvidence);
  assert.ok(evidenced, 'at least one peer-reviewed narrative case must carry its source semantic contract');
  evidenced.caseSemanticEvidence.semanticContract.typedInputSlots = [];
  assert.throws(
    () => buildSemanticBatchPostimages(sourceBytes, operations),
    /omits exact current typed inputs or operation and has no matching peer-reviewed source evidence/u,
  );
});
