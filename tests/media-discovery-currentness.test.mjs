import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureRepositorySourceCurrentness as captureRepository } from '@ghatana/verification-planner';
import { observeMediaDiscoveryCurrentness, resolveMediaPdp0Cells } from '../scripts/media-discovery-currentness.mjs';
import {
  assertMediaPdp0CurrentnessOutputAvailable,
  buildMediaPdp0SuccessorImpactDisposition,
  classifyMediaPdp0R12SuccessorImpact,
  classifyMediaPdp0R12SuccessorImpactR2,
  classifyMediaPdp0R12SuccessorImpactR3,
  classifyMediaPdp0R11SuccessorImpact,
  mediaPdp0R12SuccessorSupportFileHashes,
  mediaPdp0R12SuccessorR2SupportFileHashes,
  mediaPdp0R12SuccessorR3SupportFileHashes,
  mediaPdp0R11SuccessorSupportFileHashes,
  resolveMediaPdp0CurrentnessOutputPath,
  resolveMediaPdp0SuccessorPredecessorExitPath,
  resolveMediaPdp0SuccessorCurrentnessSuffix,
} from '../scripts/record-media-discovery-pdp0-currentness.mjs';

const dimensions = {
  ownerGraphFingerprint: digest('a'),
  physicalCatalogFingerprint: digest('b'),
  providerRegistryFingerprint: digest('c'),
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-discovery-currentness-'));
  fs.mkdirSync(path.join(root, '.product-experience'), { recursive: true });
  fs.writeFileSync(path.join(root, '.product-experience/truth.md'), 'current truth\n');
  const cell = {
    cellId: 'media-root:PDP-0',
    surfaceId: 'media-root',
    phase: 'PDP-0',
    paths: ['.product-experience/truth.md'],
    ...dimensions,
  };
  return { root, cell };
}

function digest(char) { return `sha256:${char.repeat(64)}`; }

test('PDP-0 successor currentness selects immutable R10 and R12 through R15 outputs', () => {
  const legacyPath = resolveMediaPdp0CurrentnessOutputPath(false);
  const successorPath = resolveMediaPdp0CurrentnessOutputPath(true);
  const r11SuccessorPath = resolveMediaPdp0CurrentnessOutputPath(true, '2026-10-14-current-cut-r12');
  const r12SuccessorPath = resolveMediaPdp0CurrentnessOutputPath(true, '2026-10-14-current-cut-r13');
  const r12R2SuccessorPath = resolveMediaPdp0CurrentnessOutputPath(true, '2026-10-14-current-cut-r14');
  const r12R3SuccessorPath = resolveMediaPdp0CurrentnessOutputPath(true, '2026-10-14-current-cut-r15');
  assert.equal(legacyPath, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-13.json');
  assert.equal(successorPath, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json');
  assert.equal(r11SuccessorPath, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json');
  assert.equal(r12SuccessorPath, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r13.json');
  assert.equal(r12R2SuccessorPath, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r14.json');
  assert.equal(r12R3SuccessorPath, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r15.json');
  assert.equal(resolveMediaPdp0SuccessorCurrentnessSuffix('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1'), '2026-10-14-current-cut-r13');
  assert.equal(resolveMediaPdp0SuccessorCurrentnessSuffix('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2'), '2026-10-14-current-cut-r14');
  assert.equal(resolveMediaPdp0SuccessorCurrentnessSuffix('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3'), '2026-10-14-current-cut-r15');
  assert.equal(resolveMediaPdp0SuccessorCurrentnessSuffix('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2', '2026-10-14-current-cut-r14'), '2026-10-14-current-cut-r14');
  assert.equal(resolveMediaPdp0SuccessorCurrentnessSuffix('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3', '2026-10-14-current-cut-r15'), '2026-10-14-current-cut-r15');
  assert.throws(() => resolveMediaPdp0SuccessorCurrentnessSuffix('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2', 'wrong-suffix'), /requires canonical output suffix 2026-10-14-current-cut-r14/);
  assert.equal(resolveMediaPdp0SuccessorCurrentnessSuffix('UNMAPPED-SUCCESSOR-RECORD', 'caller-suffix'), 'caller-suffix');
  assert.notEqual(successorPath, legacyPath);
  const checked = assertMediaPdp0CurrentnessOutputAvailable(successorPath, () => false);
  assert.ok(checked.endsWith(successorPath));
  assert.throws(() => assertMediaPdp0CurrentnessOutputAvailable(successorPath, () => true), /Refusing to overwrite immutable observation/);
});

test('R3 observation builder selects immutable R12 exit as its predecessor', () => {
  const r3Record = { recordId: 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3' };
  assert.equal(
    resolveMediaPdp0SuccessorPredecessorExitPath(r3Record),
    'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json',
  );
});

test('R2 and R3 successor CLIs reject noncanonical suffixes before writing observations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp0-r2-suffix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const impactPath = path.join(root, 'r2-impact.json');
  const wrongSuffix = '2026-10-14-r2-wrong-suffix';
  const outputPath = path.join(process.cwd(), 'docs/implementation/observations', `media-discovery-pdp0-currentness-${wrongSuffix}.json`);
  fs.writeFileSync(impactPath, JSON.stringify({ recordId: 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2' }));
  const result = spawnSync(process.execPath, [
    path.resolve('scripts/record-media-discovery-pdp0-currentness.mjs'),
    '--successor-impact', impactPath, wrongSuffix,
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires canonical output suffix 2026-10-14-current-cut-r14/);
  assert.equal(fs.existsSync(outputPath), false);
  const r3WrongSuffix = '2026-10-14-r3-wrong-suffix';
  const r3OutputPath = path.join(process.cwd(), 'docs/implementation/observations', `media-discovery-pdp0-currentness-${r3WrongSuffix}.json`);
  fs.writeFileSync(impactPath, JSON.stringify({ recordId: 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3' }));
  const r3Result = spawnSync(process.execPath, [
    path.resolve('scripts/record-media-discovery-pdp0-currentness.mjs'),
    '--successor-impact', impactPath, r3WrongSuffix,
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(r3Result.status, 0);
  assert.match(r3Result.stderr, /requires canonical output suffix 2026-10-14-current-cut-r15/);
  assert.equal(fs.existsSync(r3OutputPath), false);
});

test('PDP-0 R12 successor R2 binds the exact R1 record digest and only corrects the gap census pin', () => {
  const exitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
  const currentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
  const r1Path = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r1.json';
  const r2Path = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r2.json';
  const exit = JSON.parse(fs.readFileSync(path.join(process.cwd(), exitPath), 'utf8'));
  const currentness = JSON.parse(fs.readFileSync(path.join(process.cwd(), currentnessPath), 'utf8'));
  const priorImpactBytes = fs.readFileSync(path.join(process.cwd(), r1Path));
  const r1 = JSON.parse(priorImpactBytes.toString('utf8'));
  const deltas = r1.sourceDeltas.map((delta) => delta.path === '.product-experience/gaps.yaml'
    ? { ...delta, observedSha256: 'sha256:7635137e6eb0e22659a3effde4f2076f94ce6429c58cefca2ae41469c952e8a0' }
    : delta);
  const comparisons = Object.keys(exit.sourceCurrentness.sourceContentDigests).sort().map((sourcePath) => {
    const delta = deltas.find((candidate) => candidate.path === sourcePath);
    return { path: sourcePath, recordedDigest: exit.sourceCurrentness.sourceContentDigests[sourcePath],
      currentDigest: delta?.observedSha256 ?? exit.sourceCurrentness.sourceContentDigests[sourcePath],
      disposition: delta ? 'CHANGED' : 'MATCH' };
  });
  const technical = { physicalCompositeConsumerCells: currentness.physicalCompositeConsumerCells,
    denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 },
    materialPathDenominator: { uniquePaths: 146 },
    lifecycleSourceCurrentness: { continuity: 'CONTINUOUS', consistencyStable: true, zeroWorkEligibleAtCapture: true } };
  const record = structuredClone(r1);
  record.recordId = 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2';
  record.supersedes = { recordId: r1.recordId, sha256: 'sha256:e5f837db065f2b6c99e721ee9f748b319266e911de3b21a1e30c055437e18ebe' };
  record.campaign.scope = 'Exact R12-to-successor four-path census/projection correction; R2 supersedes R1 by exact digest, with R12 retained as the predecessor cut; 356 generated source records plus one manifest projection (357 total); no PDP-0 meaning change.';
  record.projectionDenominator = { generatedSourceRecords: 356, manifestProjectionRecords: 1, total: 357 };
  record.sourceDeltas = deltas;
  record.limitations = 'This scoped internal disposition covers only the exact R12 four-path census/projection correction. R2 supersedes the R1 impact record by exact digest while retaining R12 as the source predecessor. It records 356 generated source records plus one manifest projection (357 total) and asserts no PDP-0 meaning change. It does not claim owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization.';
  record.supportFileSha256s = mediaPdp0R12SuccessorR2SupportFileHashes();
  const classify = (changed = record, candidatePath = r2Path, pinSet = comparisons) => classifyMediaPdp0R12SuccessorImpactR2(
    pinSet, changed, candidatePath, technical,
    { recordBytes: Buffer.from(JSON.stringify(changed)), priorExit: exit, priorCurrentness: currentness, priorImpactBytes });
  assert.deepEqual(classify()?.map(({ path: sourcePath }) => sourcePath), deltas.map(({ path: sourcePath }) => sourcePath));
  assert.equal(classify({ ...record, supersedes: { ...record.supersedes, sha256: digest('0') } }), null);
  assert.equal(classify({ ...record, sourceDeltas: record.sourceDeltas.map((delta, index) => index === 1 ? { ...delta, observedSha256: digest('0') } : delta) }), null);
  assert.equal(classify({ ...record, decision: { ...record.decision, ownerAcceptance: 'ACCEPTED' } }), null);
  assert.equal(classify(record, 'docs/implementation/observations/wrong-record.json'), null);
  assert.equal(classify(record, r2Path, comparisons.filter(({ path: sourcePath }) => sourcePath !== '.product-experience/gaps.yaml')), null);
});

test('PDP-0 R12 successor R3 preserves R2 local GAP-12 dispositions and admits only the exact Lifecycle package transition', () => {
  const exitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
  const currentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
  const r2Path = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r2.json';
  const r3Path = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r3.json';
  const exit = JSON.parse(fs.readFileSync(path.join(process.cwd(), exitPath), 'utf8'));
  const priorCurrentness = JSON.parse(fs.readFileSync(path.join(process.cwd(), currentnessPath), 'utf8'));
  const currentnessR14 = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r14.json'), 'utf8'));
  const priorR2Bytes = fs.readFileSync(path.join(process.cwd(), r2Path));
  const priorR2 = JSON.parse(priorR2Bytes.toString('utf8'));
  const deltas = priorR2.sourceDeltas;
  const comparisons = Object.keys(exit.sourceCurrentness.sourceContentDigests).sort().map((sourcePath) => {
    const delta = deltas.find((candidate) => candidate.path === sourcePath);
    return { path: sourcePath, recordedDigest: exit.sourceCurrentness.sourceContentDigests[sourcePath],
      currentDigest: delta?.observedSha256 ?? exit.sourceCurrentness.sourceContentDigests[sourcePath],
      disposition: delta ? 'CHANGED' : 'MATCH' };
  });
  const technical = {
    ...currentnessR14,
    denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 },
    materialPathDenominator: { uniquePaths: 146 },
  };
  const lifecycleDelta = {
    repositoryId: 'ghatana-lifecycle', path: 'package.json',
    classification: 'LIFECYCLE_TOOLING_CHECK_REGISTRATION_NO_PDP0_MEANING',
    predecessorSha256: 'sha256:41c42b77f2fa20e1831f32ae116ae49d07ed8150b0b00265cda64e27f55f47bd',
    observedSha256: 'sha256:6e24f0d78a3ce1521c1e7f3246ae09df4d93f42e75dc9525017b0549ac88ae4f',
    exactChange: 'Adds check:lifecycle:explorer-campaign-conformance only.',
    pdp0MeaningChange: 'NONE', pdp0MeaningIdsChanged: [], externalOwnerAcceptance: 'NOT_CLAIMED', freshCurrentnessRequired: true,
  };
  const record = structuredClone(priorR2);
  record.recordId = 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3';
  record.supersedes = { recordId: priorR2.recordId, sha256: 'sha256:7b14877d3103ba63933521c95766114d068d3d450f803ae66e2bc9af422b9d22' };
  record.campaign.scope = 'R3 preserves R2 exact four-path GAP-12 census/projection dispositions and adds only the authorized ghatana-lifecycle/package.json check:lifecycle:explorer-campaign-conformance registration; R12 remains the predecessor cut; no PDP-0 meaning change.';
  record.authority.userAuthorization = 'Exact Lifecycle package transition authorized by the user for internal PDP-0 no-meaning impact disposition.';
  record.authority.authorizationEvidence = {
    source: 'DIRECT_USER_AUTHORIZATION_REPORTED_IN_CURRENT_TASK',
    userReply: 'The direct user instruction authorizes the exact Lifecycle package transition for internal PDP-0 no-meaning disposition.',
    authorizedScope: 'Register only the exact Lifecycle package script addition, preserve the four R2 local GAP-12 classifications, and record no PDP-0 meaning change. Do not claim external acceptance or Lifecycle closure.',
    noMeaningChange: true, externalAcceptance: false,
  };
  record.externalSourceDeltas = [lifecycleDelta];
  record.decision.status = 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_R2_DELTAS_AND_EXACT_LIFECYCLE_TRANSITION';
  record.decision.externalLifecycleTransition = 'INTERNAL_NO_PDP0_MEANING_CHANGE';
  record.limitations = 'This internal disposition preserves R2 exact four-path local GAP-12 census/projection classifications and covers only the exact Lifecycle package.json addition of check:lifecycle:explorer-campaign-conformance. R12 remains the source predecessor; R3 supersedes the R2 impact record by exact digest. No PDP-0 meaning change, external owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization is claimed.';
  record.supportFileSha256s = mediaPdp0R12SuccessorR3SupportFileHashes();
  const persistedRecordBytes = fs.readFileSync(path.join(process.cwd(), r3Path));
  assert.deepEqual(JSON.parse(persistedRecordBytes.toString('utf8')), record);
  const classify = (changed = record, candidatePath = r3Path, priorBytes = priorR2Bytes, technicalInput = technical) => classifyMediaPdp0R12SuccessorImpactR3(
    comparisons, changed, candidatePath, technicalInput,
    { recordBytes: changed === record ? persistedRecordBytes : Buffer.from(JSON.stringify(changed)), priorR2Bytes: priorBytes, priorR2, priorExit: exit, priorCurrentness });
  const result = classify();
  assert.deepEqual(result?.sourceClassifications?.map(({ path: sourcePath }) => sourcePath), deltas.map(({ path: sourcePath }) => sourcePath));
  assert.deepEqual(result?.externalContractDisposition, {
    repositoryId: 'ghatana-lifecycle', path: 'package.json', classification: lifecycleDelta.classification,
    authorityRef: r3Path, authoritySha256: `sha256:${createHash('sha256').update(persistedRecordBytes).digest('hex')}`,
    predecessorSha256: lifecycleDelta.predecessorSha256, observedSha256: lifecycleDelta.observedSha256,
    externalOwnerAcceptance: 'NOT_CLAIMED', independentSignoff: 'NOT_CLAIMED', lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED', delivery: 'BLOCKED', release: 'NOT_AUTHORIZED',
  });
  const outputDisposition = buildMediaPdp0SuccessorImpactDisposition(record, r3Path, result);
  const persistedDisposition = JSON.parse(JSON.stringify(outputDisposition));
  assert.equal(outputDisposition.recordId, record.recordId);
  assert.equal(outputDisposition.authorityRef, r3Path);
  assert.equal(outputDisposition.externalContractDisposition.observedSha256, lifecycleDelta.observedSha256);
  assert.equal(persistedDisposition.externalContractDisposition.predecessorSha256, lifecycleDelta.predecessorSha256);
  assert.equal(outputDisposition.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(outputDisposition.independentSignoff, 'NOT_CLAIMED');
  assert.equal(outputDisposition.lifecycleClosure, 'NOT_ENTERED');
  assert.equal(outputDisposition.runtime, 'NOT_ADMITTED');
  assert.equal(outputDisposition.delivery, 'BLOCKED');
  assert.equal(outputDisposition.release, 'NOT_AUTHORIZED');
  assert.equal(classify({ ...record, externalSourceDeltas: [{ ...lifecycleDelta, observedSha256: digest('0') }] }), null);
  assert.equal(classify({ ...record, externalSourceDeltas: [{ ...lifecycleDelta, exactChange: 'Also changes another script.' }] }), null);
  assert.equal(classify({ ...record, externalSourceDeltas: [{ ...lifecycleDelta, predecessorSha256: digest('0') }] }), null);
  assert.equal(classify({ ...record, supersedes: { ...record.supersedes, sha256: digest('0') } }), null);
  assert.equal(classify(record, 'docs/implementation/observations/wrong-r3.json'), null);
  assert.equal(classify(record, r3Path, Buffer.from('tampered R2 record')), null);
  const addedExternal = structuredClone(technical);
  addedExternal.externalOwnerContracts.repositories.push({ repositoryId: 'unexpected-external', files: [] });
  assert.equal(classify(record, r3Path, priorR2Bytes, addedExternal), null);
});

test('PDP-0 R11 successor classifier accepts only the exact PDP-1 generated projection delta', () => {
  const exitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json';
  const currentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json';
  const impactPath = 'docs/implementation/observations/media-discovery-pdp0-r11-successor-impact-2026-10-14-r1.json';
  const exit = JSON.parse(fs.readFileSync(path.join(process.cwd(), exitPath), 'utf8'));
  const currentness = JSON.parse(fs.readFileSync(path.join(process.cwd(), currentnessPath), 'utf8'));
  const candidatePath = '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json';
  const oldDigest = 'sha256:13c0789a6fa94c51abfbc60da8465e340406947a3f5a1dff4ec5a37bcef7e341';
  const newDigest = 'sha256:6cfb42b2fbf2e24ca904ab93ca98c905a6b892069f811f2f73166d7dc7e8de49';
  const topology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const comparisons = Object.keys(exit.sourceCurrentness.sourceContentDigests).sort().map((sourcePath) => ({
    path: sourcePath,
    recordedDigest: exit.sourceCurrentness.sourceContentDigests[sourcePath],
    currentDigest: sourcePath === candidatePath ? newDigest : exit.sourceCurrentness.sourceContentDigests[sourcePath],
    disposition: sourcePath === candidatePath ? 'CHANGED' : 'MATCH',
  }));
  assert.deepEqual(comparisons.filter((entry) => entry.disposition === 'CHANGED').map((entry) => entry.path), [candidatePath]);
  for (const supportPath of [
    'scripts/record-media-discovery-pdp0-currentness.mjs',
    'scripts/lib/media-discovery-pdp0-phase-exit.mjs',
    'tests/media-discovery-currentness.test.mjs',
    'tests/media-discovery-pdp0-phase-exit.test.mjs',
  ]) assert.equal(Object.hasOwn(exit.sourceCurrentness.sourceContentDigests, supportPath), false);
  const technical = {
    physicalCompositeConsumerCells: currentness.physicalCompositeConsumerCells,
    denominators: topology,
    materialPathDenominator: { uniquePaths: 146 },
    lifecycleSourceCurrentness: { continuity: 'CONTINUOUS', consistencyStable: true, zeroWorkEligibleAtCapture: true },
  };
  const impact = {
    schemaVersion: 'media.discovery.pdp0-successor-source-impact.v1',
    recordId: 'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1',
    campaign: {
      repository: 'samujjwal/ghatana-media', stage: 'DISCOVERY', activePhase: 'PDP-0',
      scope: 'Exact R11-to-successor PDP-1 generated decision-source inventory projection; no PDP-0 meaning change.',
    },
    authority: {
      decisionRole: 'SCOPED_INTERNAL_PDP0_SOURCE_IMPACT_REVIEW',
      humanIndependentSignatureProvided: false,
      externalContractOwnerAcceptanceProvided: false,
      nativeLifecycleReceiptProvided: false,
    },
    predecessorCut: {
      phase: 'PDP-0', exitRef: exitPath,
      exitSha256: 'sha256:fe8e73184cf385328a4974a9a3b2aad84ff9033fb999c80c10f49c3db066c4ea',
      currentnessRef: currentnessPath,
      currentnessSha256: 'sha256:b6986cd2e93241c9962d1215977c99f899949f87da15a72d8087e6ad130d7026',
      materialSourceSetFingerprint: 'sha256:d9fc2839dc341cb05250e31093a2250678a9004febffaf290d4852e29f7282f1',
      materialPathCount: 146, topology,
    },
    sourceDeltas: [{
      path: candidatePath,
      phase: 'PDP-1',
      classification: 'PDP1_DECISION_SOURCE_INVENTORY_PROJECTION_NO_PDP0_MEANING',
      predecessorSha256: oldDigest,
      observedSha256: newDigest,
      pdp0MeaningChange: 'NONE',
      pdp0MeaningIdsChanged: [],
      freshCurrentnessRequired: true,
    }],
    decision: {
      status: 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_EXACT_R11_DELTA',
      pdp0MeaningDisposition: 'NO_PDP0_MEANING_CHANGE', ownerAcceptance: 'NOT_CLAIMED',
      independentSignoff: 'NOT_CLAIMED', lifecycleClosure: 'NOT_ENTERED', runtime: 'NOT_ADMITTED',
      delivery: 'BLOCKED', release: 'NOT_AUTHORIZED', freshTechnicalCurrentness: 'REQUIRED',
    },
    limitations: 'This scoped internal disposition covers only the exact R11 generated candidate transition as a PDP-1 decision-source inventory projection with no PDP-0 meaning change. It does not claim owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization.',
    supportFileSha256s: mediaPdp0R11SuccessorSupportFileHashes(),
  };
  const classify = (changed = impact, candidatePathOverride = impactPath) => classifyMediaPdp0R11SuccessorImpact(
    comparisons, changed, candidatePathOverride, technical,
    { recordBytes: Buffer.from(JSON.stringify(changed)), priorExit: exit, priorCurrentness: currentness },
  );
  assert.equal(classify()?.path, candidatePath);
  assert.equal(classify({ ...impact, predecessorCut: { ...impact.predecessorCut, exitSha256: 'sha256:' + '0'.repeat(64) } }), null);
  assert.equal(classify({ ...impact, predecessorCut: { ...impact.predecessorCut, exitRef: 'docs/implementation/observations/wrong-predecessor.json' } }), null);
  assert.equal(classify({ ...impact, predecessorCut: { ...impact.predecessorCut, currentnessSha256: 'sha256:' + '0'.repeat(64) } }), null);
  assert.equal(classify({ ...impact, decision: { ...impact.decision, status: 'OWNER_ACCEPTED' } }), null);
  const missingStatus = { ...impact, decision: { ...impact.decision } };
  delete missingStatus.decision.status;
  assert.equal(classify(missingStatus), null);
  assert.equal(classify({ ...impact, sourceDeltas: [{ ...impact.sourceDeltas[0], observedSha256: 'sha256:' + '0'.repeat(64) }] }), null);
  assert.equal(classify(impact, 'docs/implementation/observations/wrong-record.json'), null);
  assert.equal(classify({ ...impact, sourceDeltas: [...impact.sourceDeltas, { ...impact.sourceDeltas[0], path: 'unexpected.md' }] }), null);
  assert.equal(classify({ ...impact, supportFileSha256s: { ...impact.supportFileSha256s, 'scripts/record-media-discovery-pdp0-currentness.mjs': 'sha256:' + '0'.repeat(64) } }), null);
  assert.equal(classify({ ...impact, supportFileSha256s: { ...impact.supportFileSha256s, 'unexpected-support.mjs': 'sha256:' + '0'.repeat(64) } }), null);
  const missingSupportPin = { ...impact, supportFileSha256s: { ...impact.supportFileSha256s } };
  delete missingSupportPin.supportFileSha256s['tests/media-discovery-pdp0-phase-exit.test.mjs'];
  assert.equal(classify(missingSupportPin), null);
});

test('PDP-0 R12 successor classifier accepts only the exact four-path census/projection delta', () => {
  const exitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
  const currentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
  const impactPath = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r1.json';
  const exit = JSON.parse(fs.readFileSync(path.join(process.cwd(), exitPath), 'utf8'));
  const currentness = JSON.parse(fs.readFileSync(path.join(process.cwd(), currentnessPath), 'utf8'));
  const topology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const deltas = [
    ['.product-experience/artifact-identities.yaml', 'sha256:cd6709b2e3bfff3c0b824f6e7e3c2c12777f688259beabbdbfeb1a261bd568f6', 'sha256:ad898f0143460d256f8da39466fcc344016097b8740f47b3b28a18b260e12f3a', 'ARTIFACT_IDENTITY_CENSUS_ONLY'],
    ['.product-experience/gaps.yaml', 'sha256:3f58ca80e96f999960a4e4e0e91491a5f9a99bc9348223bbeb18426ba1cf4afd', 'sha256:4df3bad69c330b3649fe88a1797025f0a82de06f05d2ed3b5691608e5a5a6698', 'GAP_CENSUS_ONLY_CORRECTION'],
    ['.product-experience/source-manifest.yaml', 'sha256:76cdcbff690e6a3439580e0df6fc68dbf67e7105b38d8ad1c9c3e9cb8b36145a', 'sha256:3a5c7e92e7470ee11c8bd1779db31a27aba75461c16fef37785901544c0c29fd', 'GENERATED_SOURCE_MANIFEST_PROJECTION'],
    ['apps/media-experience-explorer/specification-artifacts.json', 'sha256:2aadeeffe41ea354f43a0824a069b1e21bfef5a31052e4dca8ceb68da9bcfc75', 'sha256:6cb5006b07b113dfa5cc1b41a78648be56e76910c60b60bd82f286c1593b8593', 'EXPLORER_ARTIFACT_INDEX_PROJECTION'],
  ];
  const changedPaths = new Set(deltas.map(([sourcePath]) => sourcePath));
  const comparisons = Object.keys(exit.sourceCurrentness.sourceContentDigests).sort().map((sourcePath) => {
    const delta = deltas.find(([candidate]) => candidate === sourcePath);
    return {
      path: sourcePath,
      recordedDigest: exit.sourceCurrentness.sourceContentDigests[sourcePath],
      currentDigest: delta?.[2] ?? exit.sourceCurrentness.sourceContentDigests[sourcePath],
      disposition: delta ? 'CHANGED' : 'MATCH',
    };
  });
  assert.deepEqual(comparisons.filter(({ disposition }) => disposition === 'CHANGED').map(({ path: sourcePath }) => sourcePath), [...changedPaths].sort());
  const technical = {
    physicalCompositeConsumerCells: currentness.physicalCompositeConsumerCells,
    denominators: topology,
    materialPathDenominator: { uniquePaths: 146 },
    lifecycleSourceCurrentness: { continuity: 'CONTINUOUS', consistencyStable: true, zeroWorkEligibleAtCapture: true },
  };
  const impact = {
    schemaVersion: 'media.discovery.pdp0-successor-source-impact.v1',
    recordId: 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1',
    campaign: {
      repository: 'samujjwal/ghatana-media', stage: 'DISCOVERY', activePhase: 'PDP-0',
      scope: 'Exact R12-to-successor four-path census/projection correction; no PDP-0 meaning change.',
    },
    authority: {
      delegate: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_AUTHORIZATION',
      decisionRole: 'SCOPED_INTERNAL_PDP0_SOURCE_IMPACT_REVIEW',
      userAuthorization: 'Register and recapture (Recommended)',
      authorizationEvidence: {
        source: 'DIRECT_USER_REPLY_IN_CURRENT_TASK',
        userReply: 'Register and recapture (Recommended)',
        authorizedScope: 'Register the existing delegated owner review as CROSS_PHASE_GOVERNANCE, regenerate its source projections, and recapture impacted currentness.',
        noMeaningChange: true,
        externalAcceptance: false,
      },
      humanIndependentSignatureProvided: false,
      qualifiedExternalSpecialistSignoffProvided: false,
      externalContractOwnerAcceptanceProvided: false,
      nativeLifecycleReceiptProvided: false,
    },
    predecessorCut: {
      phase: 'PDP-0', exitRef: exitPath,
      exitSha256: 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5',
      currentnessRef: currentnessPath,
      currentnessSha256: 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159',
      materialSourceSetFingerprint: 'sha256:1a121cf988ba4a34f6b603b1f230fd0494160a3c6142c064d8d5cc2a6aa45f94',
      materialPathCount: 146, topology,
    },
    sourceDeltas: deltas.map(([sourcePath, predecessorSha256, observedSha256, classification]) => ({
      path: sourcePath, phase: 'PDP-0', classification, predecessorSha256, observedSha256,
      pdp0MeaningChange: 'NONE', pdp0MeaningIdsChanged: [], freshCurrentnessRequired: true,
    })),
    decision: {
    status: 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_EXACT_R12_DELTAS',
      pdp0MeaningDisposition: 'NO_PDP0_MEANING_CHANGE', ownerAcceptance: 'NOT_CLAIMED',
      independentSignoff: 'NOT_CLAIMED', lifecycleClosure: 'NOT_ENTERED', runtime: 'NOT_ADMITTED',
      delivery: 'BLOCKED', release: 'NOT_AUTHORIZED', freshTechnicalCurrentness: 'REQUIRED',
    },
    limitations: 'This scoped internal disposition covers only the exact R12 four-path census/projection correction and asserts no additional PDP-0 meaning. It does not claim owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization.',
    supportFileSha256s: mediaPdp0R12SuccessorSupportFileHashes(),
  };
  const classify = (changed = impact, candidatePath = impactPath, pinSet = comparisons) => classifyMediaPdp0R12SuccessorImpact(
    pinSet, changed, candidatePath, technical,
    { recordBytes: Buffer.from(JSON.stringify(changed)), priorExit: exit, priorCurrentness: currentness },
  );
  assert.deepEqual(classify()?.map(({ path: sourcePath }) => sourcePath), deltas.map(([sourcePath]) => sourcePath));
  assert.equal(classify({ ...impact, predecessorCut: { ...impact.predecessorCut, exitSha256: digest('0') } }), null);
  assert.equal(classify({ ...impact, predecessorCut: { ...impact.predecessorCut, currentnessSha256: digest('0') } }), null);
  assert.equal(classify({ ...impact, sourceDeltas: impact.sourceDeltas.map((delta, index) => index ? delta : { ...delta, observedSha256: digest('0') }) }), null);
  assert.equal(classify(impact, 'docs/implementation/observations/wrong-record.json'), null);
  assert.equal(classify(impact, impactPath, comparisons.filter(({ path: sourcePath }) => sourcePath !== deltas[0][0])), null);
  assert.equal(classify({ ...impact, sourceDeltas: [...impact.sourceDeltas, { ...impact.sourceDeltas[0], path: 'unexpected.md' }] }), null);
  assert.equal(classify({ ...impact, sourceDeltas: impact.sourceDeltas.map((delta, index) => index ? delta : { ...delta, pdp0MeaningChange: 'CHANGED' }) }), null);
  assert.equal(classify({ ...impact, supportFileSha256s: { ...impact.supportFileSha256s, 'scripts/record-media-discovery-pdp0-currentness.mjs': digest('0') } }), null);
  assert.equal(classify({ ...impact, decision: { ...impact.decision, ownerAcceptance: 'ACCEPTED' } }), null);
  assert.equal(classify({ ...impact, authority: { ...impact.authority, externalContractOwnerAcceptanceProvided: true } }), null);
});

test('journal reset performs full validation and fails closed until continuity resumes', () => {
  const { root, cell } = fixture();
  const initial = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(initial.continuity, 'UNKNOWN');
  assert.equal(initial.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(initial.blockers.includes('LIFECYCLE_CONTINUITY_RESET_OR_UNKNOWN'));
  const resumed = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(resumed.continuity, 'CONTINUOUS');
  assert.equal(resumed.cells[0].sourceCurrentness, 'CURRENT');
  assert.equal(resumed.zeroWorkEligible, true);
  assert.deepEqual(resumed.cells[0].expectedPaths, ['.product-experience/truth.md']);
});

test('continuous captures reuse root-wide digests and project exact per-cell paths', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  observeMediaDiscoveryCurrentness(root, [cell]);
  const reused = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(reused.cells[0].sourceCurrentness, 'CURRENT');
  assert.deepEqual(Object.keys(reused.cells[0].fileContentDigests), cell.paths);
  assert.deepEqual(reused.cells[0].changedPaths, []);
});

test('membership additions and missing expected paths fail closed', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  fs.writeFileSync(path.join(root, 'unexpected.md'), 'new repository member');
  const membership = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(membership.continuity, 'UNKNOWN');
  assert.ok(membership.blockers.includes('UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE'));

  const missing = observeMediaDiscoveryCurrentness(root, [{
    ...cell,
    paths: [...cell.paths, '.product-experience/missing.md'],
  }]);
  assert.equal(missing.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(missing.cells[0].blockers.includes('EXPECTED_SOURCE_PATH_MISSING'));
});

test('missing, invalid, or inconsistent fingerprints are rejected before capture', () => {
  const { root, cell } = fixture();
  assert.throws(() => observeMediaDiscoveryCurrentness(root, [{ ...cell, ownerGraphFingerprint: null }]), /valid ownerGraphFingerprint/);
  assert.throws(() => observeMediaDiscoveryCurrentness(root, [{ ...cell, providerRegistryFingerprint: 'sha256:bad' }]), /valid providerRegistryFingerprint/);
  assert.throws(() => observeMediaDiscoveryCurrentness(root, [cell, {
    ...cell,
    cellId: 'other:PDP-0',
    ownerGraphFingerprint: digest('d'),
  }]), /same valid ownerGraphFingerprint/);
});

test('lock ownership failure remains unknown', () => {
  const { root, cell } = fixture();
  const directory = path.join(root, 'build/verification-index/source-currentness');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'capture.lock'), JSON.stringify({ pid: process.pid }));
  const result = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(result.continuity, 'UNKNOWN');
  assert.equal(result.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(result.blockers.includes('LIFECYCLE_CAPTURE_UNKNOWN'));
});

test('persistence failure returned by Lifecycle cannot produce currentness', () => {
  const { root, cell } = fixture();
  let calls = 0;
  const result = observeMediaDiscoveryCurrentness(root, [cell], {
    capture: (captureRoot, options) => {
      calls += 1;
      const actual = captureRepository(captureRoot, options);
      if (calls === 1) return actual;
      return {
        ...actual,
        status: 'UNKNOWN',
        freshness: 'UNKNOWN',
        zeroWorkEligible: false,
        journal: { ...actual.journal, continuity: 'UNKNOWN', resetReason: 'SOURCE_CURRENTNESS_PERSIST_FAILED' },
      };
    },
  });
  assert.equal(result.continuity, 'UNKNOWN');
  assert.equal(result.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(result.blockers.includes('LIFECYCLE_CAPTURE_UNKNOWN'));
});

test('external fingerprint changes since the prior capture fail closed', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  observeMediaDiscoveryCurrentness(root, [cell]);
  let calls = 0;
  const result = observeMediaDiscoveryCurrentness(root, [cell], {
    capture: (captureRoot, options) => {
      const actual = captureRepository(captureRoot, options);
      calls += 1;
      return calls === 1 ? {
        ...actual,
        zeroWorkEligible: false,
        journal: { ...actual.journal, externalChanges: [{ dimension: 'provider-registry' }] },
      } : actual;
    },
  });
  assert.equal(result.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(result.blockers.includes('EXTERNAL_FINGERPRINT_CHANGE_SINCE_PRIOR_CAPTURE'));
});

test('a material edit between root-wide captures is reported as a source race', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  let calls = 0;
  const result = observeMediaDiscoveryCurrentness(root, [cell], {
    capture: (captureRoot, options) => {
      const actual = captureRepository(captureRoot, options);
      calls += 1;
      if (calls === 1) fs.writeFileSync(path.join(root, '.product-experience/truth.md'), 'raced truth\n');
      return actual;
    },
  });
  assert.equal(result.continuity, 'UNKNOWN');
  assert.ok(result.blockers.includes('SOURCE_RACE_DURING_CAPTURE'));
});

test('stable changed cell paths stay unknown despite caller-supplied authorization strings', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  observeMediaDiscoveryCurrentness(root, [cell]);
  fs.writeFileSync(path.join(root, '.product-experience/truth.md'), 'stable edit\n');
  const changed = observeMediaDiscoveryCurrentness(root, [cell], {
    changeAuthorizations: {
      '.product-experience/truth.md': {
        sourcePath: '.product-experience/truth.md',
        classification: 'NON_SEMANTIC_DOCUMENTATION_UPDATE',
        authorityRef: 'owner-decision#MDO-02',
        authorizedBy: 'media-product-owner',
      },
    },
  });
  assert.equal(changed.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.deepEqual(changed.cells[0].changedPaths, ['.product-experience/truth.md']);
  assert.ok(changed.cells[0].blockers.includes('SOURCE_PATH_CHANGED_SINCE_PRIOR_CAPTURE'));
  assert.equal(changed.cells[0].zeroWorkEligible, false);
  assert.equal(changed.zeroWorkEligible, false);

  const stable = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(stable.cells[0].sourceCurrentness, 'CURRENT');
  assert.deepEqual(stable.cells[0].changedPaths, []);
});

test('PDP-0 resolver binds the authoritative 26/6+1/17 inventory without losing applicability details', () => {
  const resolved = resolveMediaPdp0Cells(process.cwd(), dimensions);
  assert.deepEqual(resolved.denominator, {
    physicalCandidates: 26,
    semanticCompositions: 6,
    repositoryRoots: 1,
    consumers: 17,
    totalCells: 50,
  });
  assert.equal(new Set(resolved.cells.map((cell) => cell.cellId)).size, 50);
  assert.equal(resolved.cells.every((cell) => cell.phase === 'PDP-0' && cell.paths.includes(resolved.basis.ownerDecision)), true);

  const byId = new Map(resolved.cells.map((cell) => [cell.surfaceId, cell]));
  const streaming = byId.get('media.physical.modules-video-streaming');
  assert.equal(streaming.cellType, 'PHYSICAL_CANDIDATE');
  assert.equal(streaming.applicability.disposition, 'NO_IMPLEMENTATION_ADMITTED');
  assert.ok(streaming.applicability.capabilityIntentIds.includes('media.stream.session.open'));
  const vision = byId.get('media.composition.vision-and-multimodal-analysis');
  const root = byId.get('media.composition.repository-root');
  assert.ok(vision.paths.includes('modules/video-streaming/build.gradle.kts'));
  assert.ok(vision.meaningRefs.capabilityIntentIds.includes('media.stream.session.open'));
  assert.ok(root.paths.includes('modules/video-streaming/build.gradle.kts'));
  assert.ok(root.paths.includes('.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml'));
  assert.ok(resolved.cells.every((cell) => cell.paths.length > 0 && cell.applicability?.rationale));
  assert.ok(resolved.cells.every((cell) => cell.meaningRefs && cell.mappings));
  assert.equal(byId.get('media.physical.adapters-ledger').applicability.disposition, 'NOT_APPLICABLE_SUPPORT');

  const voiceUi = byId.get('media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react');
  assert.deepEqual(voiceUi.applicability.capabilityIntentIds, ['media.speech.synthesis.text-to-speech']);
  const consumer = byId.get('media.surface.ui-library');
  assert.equal(consumer.applicability.disposition, 'APPLICABLE_CONSUMER');
  assert.equal(consumer.mappings.registryAuthority, '.product-experience/surface-registry.yaml');
  const agentTools = byId.get('media.surface.agent-tools');
  assert.equal(agentTools.mappings.bindingState, 'CONTRACT_ONLY');
  assert.equal(agentTools.mappings.handlerSourceObservation.classification, 'LEGACY_SUBSUMED_NOT_ADMITTED');
  assert.equal(agentTools.mappings.handlerSourceObservation.operationAssociation, 'media.physical.runtime-contracts');
  assert.deepEqual(agentTools.mappings.physicalRefs, ['media.physical.runtime-contracts', 'media.physical.libs-common']);
  assert.ok(agentTools.paths.includes('.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml'));
  assert.equal(agentTools.paths.some((sourcePath) => sourcePath === agentTools.mappings.handlerSourceObservation.sourcePath), false);
  assert.equal(agentTools.paths.filter((sourcePath) => sourcePath.startsWith(`${agentTools.mappings.handlerSourceObservation.sourcePath}/`)).length, 6);
  for (const cell of resolved.cells.filter((entry) => entry.cellType === 'CONSUMER')) {
    for (const physicalId of cell.mappings.physicalRefs) {
      assert.ok(byId.get(physicalId).mappings.consumerSurfaceRefs.includes(cell.surfaceId));
    }
  }
});

test('PDP-0 successor currentness resolver exposes all 55 new cells without changing the historical 50-cell contract', () => {
  const current = resolveMediaPdp0Cells(process.cwd(), {
    ...dimensions,
    campaignScope: 'recorder-studio-successor',
  });
  assert.deepEqual(current.denominator, {
    physicalCandidates: 26,
    semanticCompositions: 7,
    repositoryRoots: 1,
    consumers: 21,
    totalCells: 55,
  });
  const ids = new Set(current.cells.map((cell) => cell.surfaceId));
  for (const id of [
    'media.surface.experience-recorder',
    'media.surface.capture-agent',
    'media.surface.presentation-studio',
    'media.surface.interactive-demo-player',
    'media.composition.experience-recorder-studio',
  ]) assert.ok(ids.has(id), id);
  assert.equal(current.cells.length, 55);
  assert.ok(current.cells.every((cell) => cell.paths.length > 0));
});
