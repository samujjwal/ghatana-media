import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  validatePdp2R1InterfaceReviewSuccessorImpact,
  validatePdp1InterfaceReviewPinRefreshImpact,
  validatePdp1DevStatusTestRefreshImpact,
  validatePdp1OwnerStatusJoinTestTransition,
  validatePdp1ThreeReviewSourceTransition,
  validatePdp1TypedObservationTestRefreshImpact,
} from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = 'docs/implementation/observations/media-discovery-pdp1-three-review-source-transition-2026-10-14.json';
const predecessorPath = 'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json';
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const digest = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`;

function inputs(record = readJson(recordPath)) {
  const predecessor = readJson(predecessorPath);
  const status = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet;
  const semantic = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints;
  const pxd164 = readJson('docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json');
  const observedPaths = new Set([
    ...record.sourceTransitions.map(({ path: sourcePath }) => sourcePath),
    'tests/pdp-truth-domain-typed-observations.test.mjs',
    ...pxd164.sourceDeltas.map(({ path: sourcePath }) => sourcePath),
    ...Object.keys(pxd164.verificationInputs),
  ]);
  return {
    record,
    observedDigests: Object.fromEntries([...observedPaths].map((sourcePath) => [sourcePath, digest(sourcePath)])),
    statusPins: status,
    semanticPins: semantic,
  };
}

test('PDP-1 three-review transition binds exact R16/current hashes and internal-only boundary', () => {
  const input = inputs();
  const result = validatePdp1ThreeReviewSourceTransition(input.record, input);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.rowChecks.length, 3);
  assert.equal(result.suppliedRecordMatchesDisk, true);
});

test('typed-observation test refresh is bound by its own exact test-only impact', () => {
  const testPath = 'tests/pdp-truth-domain-typed-observations.test.mjs';
  const input = inputs();
  const impact = validatePdp1TypedObservationTestRefreshImpact(undefined, {
    testInputDigests: { [testPath]: input.observedDigests[testPath] },
  });
  assert.equal(impact.valid, true, JSON.stringify(impact));
  assert.equal(impact.recordId, 'MEDIA-DISCOVERY-PDP1-TYPED-OBSERVATION-TEST-REFRESH-2026-10-14-R1');
  assert.equal(impact.predecessorTestSha256, 'sha256:e824ac21970a39795f6d4abd1dc9c1965bbf941024ea03b2aba58f903966916a');
  assert.equal(impact.liveTestSha256, input.observedDigests[testPath]);
});

test('PDP-1 three-review transition rejects wrong predecessor/current hashes and selectors', () => {
  for (const mutate of [
    (record) => { record.sourceTransitions[0].predecessorSha256 = 'sha256:wrong'; },
    (record) => { record.sourceTransitions[1].observedSha256 = 'sha256:wrong'; },
    (record) => { record.sourceTransitions[2].path = 'tests/other.test.mjs'; },
    (record) => { record.sourceTransitions.reverse(); },
    (record) => { record.authority.authorizationEvidence.authorizedTransitions[0].observedSha256 = 'sha256:wrong'; },
  ]) {
    const input = inputs();
    mutate(input.record);
    assert.equal(validatePdp1ThreeReviewSourceTransition(input.record, input).valid, false);
  }
});

test('PDP-1 three-review transition rejects pin drift, boundary inflation, and substituted records', () => {
  const input = inputs();
  const wrongObserved = inputs();
  wrongObserved.observedDigests[input.record.sourceTransitions[0].path] = 'sha256:wrong';
  assert.equal(validatePdp1ThreeReviewSourceTransition(wrongObserved.record, wrongObserved).valid, false);

  const wrongStatus = inputs();
  wrongStatus.statusPins[input.record.sourceTransitions[0].path] = 'wrong';
  assert.equal(validatePdp1ThreeReviewSourceTransition(wrongStatus.record, wrongStatus).valid, false);

  const wrongSemantic = inputs();
  wrongSemantic.semanticPins[input.record.sourceTransitions[1].path] = 'wrong';
  assert.equal(validatePdp1ThreeReviewSourceTransition(wrongSemantic.record, wrongSemantic).valid, false);

  for (const [field, value] of [
    ['externalOwnerAcceptance', 'ACCEPTED'],
    ['independentAcceptance', 'ACCEPTED'],
    ['nativeClosure', 'CLOSED'],
    ['runtimeAdmission', 'ADMITTED'],
    ['release', 'READY'],
  ]) {
    const boundary = inputs();
    boundary.record.boundaries[field] = value;
    assert.equal(validatePdp1ThreeReviewSourceTransition(boundary.record, boundary).valid, false);
  }

  const substituted = inputs();
  substituted.record.decision.status = 'OTHER';
  assert.equal(validatePdp1ThreeReviewSourceTransition(substituted.record, substituted).valid, false);
});

test('PDP-1 interface-review refresh chains through the authorized PDP-2 R5 successor', () => {
  const valid = validatePdp1InterfaceReviewPinRefreshImpact();
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(valid.predecessorAuthorization.recordRef,
    'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json');
  assert.equal(valid.predecessorAuthorization.recordId, 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R5');
  assert.equal(valid.predecessorAuthorization.predecessorSha256,
    'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76');
  assert.equal(valid.predecessorAuthorization.observedSha256,
    'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd');
  assert.equal(valid.predecessorAuthorization.authorized, true);
  assert.equal(valid.predecessorSha256, valid.predecessorAuthorization.observedSha256);
  assert.equal(valid.successorAuthorization.valid, true, JSON.stringify(valid.successorAuthorization));
  assert.equal(valid.successorAuthorization.predecessorSha256, valid.predecessorSha256);
  assert.equal(valid.successorAuthorization.observedSha256,
    digest('.product-experience/interface-parity/current-source-review.json'));
});

test('PDP-2 additional R1 authorizes only the exact PDP-1 interface-review terminal transition', () => {
  const recordPath = 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json';
  const record = readJson(recordPath);
  const valid = validatePdp2R1InterfaceReviewSuccessorImpact(record, { recordPath });
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(valid.recordId, 'MEDIA-DISCOVERY-PDP2-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R1');
  assert.equal(valid.predecessorSha256,
    'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd');
  assert.equal(valid.observedSha256,
    'sha256:64796cfb0db909a36e030041b2d51d02fd19fc115d703cc16bca37116f92ed06');

  const mutations = [
    (candidate) => { candidate.sourceDeltas[1].predecessorSha256 = 'sha256:wrong'; },
    (candidate) => { candidate.sourceDeltas[1].observedSha256 = 'sha256:wrong'; },
    (candidate) => { candidate.sourceDeltas.reverse(); },
    (candidate) => { candidate.sourceDeltas.push(structuredClone(candidate.sourceDeltas[1])); },
    (candidate) => { candidate.sourceDeltas.splice(1, 1); },
    (candidate) => { candidate.authority.userAuthorization.authorizedTransitions[1].observedSha256 = 'sha256:wrong'; },
    (candidate) => { candidate.authority.userAuthorization.authorizedTransitions.reverse(); },
    (candidate) => { candidate.authority.userAuthorization.authorizedTransitions.push(structuredClone(candidate.authority.userAuthorization.authorizedTransitions[1])); },
    (candidate) => { candidate.authority.userAuthorization.authorizedTransitions.splice(1, 1); },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(record);
    mutate(candidate);
    assert.equal(validatePdp2R1InterfaceReviewSuccessorImpact(candidate, { recordPath }).valid, false);
  }
});

test('PDP-1 dev-status test successor accepts only the exact intermediate-to-live chain', () => {
  const testPath = 'tests/media-pdp-p1-dev-status.test.mjs';
  const recordPath = 'docs/implementation/observations/media-discovery-pdp1-dev-status-test-refresh-2026-10-14-r1.json';
  const record = readJson(recordPath);
  const live = digest(testPath);
  const valid = validatePdp1DevStatusTestRefreshImpact(record, {
    testInputDigests: { [testPath]: live },
    recordPath,
  });
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(valid.predecessorTestSha256,
    'sha256:8362bf108a1f05577e6cdc858cd1565c6afc4193eea102a475e0b1d145abc9ad');
  assert.equal(valid.observedSha256, live);

  const wrongTerminal = validatePdp1DevStatusTestRefreshImpact(record, {
    testInputDigests: { [testPath]: 'sha256:wrong' },
    recordPath,
  });
  assert.equal(wrongTerminal.valid, false);
  const wrongPredecessor = structuredClone(record);
  wrongPredecessor.sourceTransition.predecessorSha256 = 'sha256:wrong';
  assert.equal(validatePdp1DevStatusTestRefreshImpact(wrongPredecessor, {
    testInputDigests: { [testPath]: live },
    recordPath,
  }).valid, false);
});

test('PDP-1 owner-status-join test refresh is an exact test-only currentness disposition', () => {
  const testPath = 'tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs';
  const recordPath = 'docs/implementation/observations/media-discovery-pdp1-owner-status-join-test-refresh-2026-10-14-r3.json';
  const record = readJson(recordPath);
  const testInputDigests = { [testPath]: digest(testPath) };
  const valid = validatePdp1OwnerStatusJoinTestTransition(record, { testInputDigests, recordPath });
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(valid.exactR4Successor, true, 'R3 remains valid only as historical evidence through its exact R4 successor.');
  assert.equal(valid.sourcePath, testPath);
  assert.equal(valid.predecessorRef, 'docs/implementation/observations/media-discovery-pdp1-owner-status-join-test-refresh-2026-10-14-r2.json');
  assert.equal(valid.predecessorDigest, 'sha256:89a8fb541ea527c4b314a7c1c1b588b4465ca33ca2107cc9b7315b4c951c68aa');

  assert.equal(record.sourceTransition.productMeaningChange, 'NONE');

  const staleR3Bytes = validatePdp1OwnerStatusJoinTestTransition(record, {
    testInputDigests: { [testPath]: 'sha256:7373bb3f4e165274086a92b6d496ee845503ce7e261a4d40967efd1db75e737d' },
    recordPath,
  });
  assert.equal(staleR3Bytes.valid, false, 'Restoring only R3 test bytes cannot bypass the exact R4 successor.');

  const wrongPredecessor = structuredClone(record);
  wrongPredecessor.sourceTransition.predecessorSha256 = 'sha256:wrong';
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(wrongPredecessor, { testInputDigests, recordPath }).valid, false);

  const wrongCurrent = { ...testInputDigests, [testPath]: 'sha256:wrong' };
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(record, { testInputDigests: wrongCurrent, recordPath }).valid, false);

  const inflated = structuredClone(record);
  inflated.boundaries.ownerAcceptance = 'ACCEPTED';
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(inflated, { testInputDigests, recordPath }).valid, false);

  const wrongP0 = structuredClone(record);
  wrongP0.predecessor.pdp0ExitSha256 = 'sha256:wrong';
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(wrongP0, { testInputDigests, recordPath }).valid, false);

  const wrongP0Currentness = structuredClone(record);
  wrongP0Currentness.predecessor.pdp0CurrentnessSha256 = 'sha256:wrong';
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(wrongP0Currentness, { testInputDigests, recordPath }).valid, false);

  const wrongSuccessor = structuredClone(record);
  wrongSuccessor.predecessor.sha256 = 'sha256:wrong';
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(wrongSuccessor, { testInputDigests, recordPath }).valid, false);
});
