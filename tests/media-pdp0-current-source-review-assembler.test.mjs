import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {
  PDP0_CRITERIA, PDP0_DIRECT_REVIEW_REF, PDP0_MATRIX_REF, PDP0_READINESS_REF, PDP0_STATUS_REF,
  PDP0_REVIEW_INPUT_DIRECTORY, buildPdp0CurrentSourceReviewCandidate, directDefinitionDecisionRef, reviewRecordPath,
  validatePdp0CurrentSourceReviewRecord,
} from '../scripts/lib/media-pdp0-current-source-review-assembler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));

const digest = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const files = new Map();
  const testLogs = {};
  for (const id of PDP0_CRITERIA) {
    const sourceRef = `.product-experience/pdp-0-product-truth/${id}.yaml`;
    const testRef = `tests/${id}.test.mjs`;
    files.set(sourceRef, `source ${id}\n`);
    files.set(testRef, `test ${id}\n`);
    const log = `PASS ${id}\n`;
    files.set(`docs/implementation/verification/pdp-38/${id}.log`, log);
    testLogs[id] = {status: 'PASS', testCount: 1, passedTestCount: 1, skippedTestCount: 0, outputSha256: digest(log),
      testSourceFingerprints: {[testRef]: digest(`test ${id}\n`)},
      sourceCut: {changedDuringVerification: [], changedBeforeReport: [], fingerprints: {[sourceRef]: digest(`source ${id}\n`), [testRef]: digest(`test ${id}\n`)}}};
  }
  const sourceShaSet = Object.fromEntries([...files.entries()].filter(([ref]) => !ref.endsWith('.log')).map(([ref, text]) => [ref, digest(text)]));
  const status = {schemaVersion: 'fixture.v1', phase: 'PDP-0', status: 'IN_PROGRESS', mainSha: 'b'.repeat(40), sourceShaSet,
    sourceRecordCount: {capabilityLeafAdjudications: 462}, directDevelopmentCriteria: Object.fromEntries(PDP0_CRITERIA.map(id => [id,
      {testStatus: 'PASS', testCount: 1, passedTestCount: 1, skippedTestCount: 0}])), testsActuallyRun: testLogs};
  const readiness = {tasks: PDP0_CRITERIA.map(id => ({id, priorEvidenceSources: [`.product-experience/pdp-0-product-truth/${id}.yaml`], taskSpecificSourceDone: 'VERIFIED_IN_CURRENT_SOURCE', originalLedgerStatus: 'partial'}))};
  const directReview = {records: PDP0_CRITERIA.map(id => ({taskId: id, status: 'APPROVED_DIRECT_DEFINITION_CRITERION',
    currentCorrectiveReview: {sourceFingerprints: {}} , historicalCorrectiveReviews: [{decisionRef: `.product-experience/decision-log.md#HIST-${id}`}]}))};
  const matrix = {recordKind: 'PDP_SURFACE_PHASE_STATUS_MATRIX', summary: {totalSurfaceIdentities: 54, physical: 26, compositions: 7, logicalConsumers: 21}};
  files.set(PDP0_STATUS_REF, `${JSON.stringify(status)}\n`);
  files.set(PDP0_READINESS_REF, `${JSON.stringify(readiness)}\n`);
  files.set(PDP0_DIRECT_REVIEW_REF, `${JSON.stringify(directReview)}\n`);
  files.set(PDP0_MATRIX_REF, `${JSON.stringify(matrix)}\n`);
  files.set('.product-experience/source-manifest.yaml', 'fixture source manifest\n');
  files.set('.product-experience/acceptance.yaml', 'fixture acceptance source\n');
  for (const id of PDP0_CRITERIA) {
    const sourceRef = id === 'P0-08' ? '.product-experience/acceptance.yaml' : `.product-experience/pdp-0-product-truth/${id}.yaml`;
    const testRef = `tests/${id}.test.mjs`;
    files.set(`${PDP0_REVIEW_INPUT_DIRECTORY}/${id}.json`, JSON.stringify({schemaVersion: 'media.pdp0.current-source-review-record.v1', criterionId: id,
      reviewedSources: [{sourceRef, sha256: digest(files.get(sourceRef))}, {sourceRef: testRef, sha256: digest(files.get(testRef))}]}));
  }
  const read = ref => {
    if (!files.has(ref)) throw new Error(`missing fixture ${ref}`);
    return files.get(ref);
  };
  const statusRecordSha256 = digest(read(PDP0_STATUS_REF));
  const records = Object.fromEntries(PDP0_CRITERIA.map((id, index) => {
    const sourceRef = `.product-experience/pdp-0-product-truth/${id}.yaml`;
    const testRef = `tests/${id}.test.mjs`;
    const criterionReceipt = testLogs[id];
    const findings = id === 'P0-07' ? [{id: 'P0-07-FAMILY-CASE-SEMANTIC-FIT-UNKNOWN-231', classification: 'UNKNOWN_REVIEW_REQUIRED', evidenceRef: '.product-experience/pdp-0-product-truth/P0-07.yaml', finding: '231 family-case semantic-fit rows remain unresolved.', owner: 'UNKNOWN', correction: 'Classify exact existing rows against feature meaning.', nextAction: 'Keep open pending owner disposition.'}]
      : id === 'P0-08' ? [{id: 'P0-08-P0-010-INDEPENDENT-OUTCOME-ABSENT', classification: 'BLOCKED_EXTERNAL_INDEPENDENT', evidenceRef: '.product-experience/acceptance.yaml#ACCEPT-INPUT-P0-010', finding: 'No appointed independent P0-010 result exists.', owner: 'Independent PDP-0 reviewer / Lifecycle authority', correction: 'Obtain the real reviewer outcome through the owner workflow.', nextAction: 'Keep P0-010 NOT_PERFORMED.'}] : [];
    const reviewNotes = {
      reviewKind: 'AI_TECHNICAL_CURRENT_SOURCE_REVIEW',
      criterionIdentity: {criterionId: id, readinessTaskRef: `${PDP0_READINESS_REF}#tasks/${id}`, directDefinitionCriterionRecord: 'APPROVED_DIRECT_DEFINITION_CRITERION', directDefinitionDecisionRef: null, readinessCriterionState: 'VERIFIED_IN_CURRENT_SOURCE', originalTaskState: 'partial'},
      baseline: {repositoryHead: status.mainSha, workingTree: 'DIRTY_PRESERVED', campaign: 'Media PDP-0', macroStage: 'DISCOVERY', exactPhase: 'PDP-0 Product Truth', registeredIdentityDenominator: {physicalCandidates: 26, compositionSurfacesIncludingRoot: 7, logicalConsumers: 21, registeredIdentities: 54}, requestedCurrentMaterialPathDenominator: 207, sourcePinObservation: {reportedCurrentMaterialPathDenominator: 207, phaseStatusSourcePinRefs: 188, wholeFilePinsComparedAgainstLiveBytes: 167, wholeFilePinMismatches: 0, sectionPins: 21, sectionPinCurrentness: 'NOT_EVALUATED_BY_THIS_BOUNDED_REVIEW', wholeCutCurrentnessClaim: 'NOT_MADE', sectionPinBackerFilesMissing: []}, sourceCurrentnessClaim: 'NOT_MADE; technical source review only'},
      criterionMeaning: {scope: `Exact source review scope for ${id}.`, observations: ['Technical review considered current source meaning.'], nonClaims: ['No acceptance or closure.']},
      findings,
      verifierReceipt: {statusRecordRef: PDP0_STATUS_REF, currentStatusRecordHashedInCriterionVerification: true, testReceiptRef: `docs/implementation/verification/pdp-38/${id}.log`, testReceiptSha256: digest(read(`docs/implementation/verification/pdp-38/${id}.log`)), testStatus: 'PASS', testCount: criterionReceipt.testCount, passedTestCount: criterionReceipt.passedTestCount, skippedTestCount: criterionReceipt.skippedTestCount, outputSha256: criterionReceipt.outputSha256, command: 'node --test', distinction: 'Source checks only; no phase acceptance.'},
      sourceCoverage: {sourceRefsWithCurrentWholeFileHashes: Number(id.slice(-2)) >= 5 ? 8 : 7, sourceRefMap: 'reviewedSources binds exact source hashes', knownUnknowns: id === 'P0-07' ? ['231 family-case semantic-fit rows remain unresolved.'] : id === 'P0-08' ? ['P0-010 reviewer outcome remains absent.'] : []},
      nextAction: 'Keep all independent acceptance and native gates separate.',
      reviewerBoundary: {role: 'AI technical source reviewer only', ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', phaseStatusEffect: 'NONE'},
    };
    return [id, {
      schemaVersion: 'media.pdp0.current-source-review-record.v4', criterionId: id, phaseScope: 'PDP-0',
      reviewer: {identity: index < 4 ? 'agent:thread:reviewer-a' : 'agent:thread:reviewer-d', reviewRole: 'DISTINCT_TECHNICAL_REVIEWER', reviewRecordRef: reviewRecordPath(id)},
      scopeRef: `${PDP0_READINESS_REF}#tasks/${id}`,
      reviewedSources: [
        PDP0_READINESS_REF, PDP0_STATUS_REF, PDP0_DIRECT_REVIEW_REF, '.product-experience/source-manifest.yaml',
        `docs/implementation/verification/pdp-38/${id}.log`, ...(id === 'P0-08' ? ['.product-experience/acceptance.yaml'] : [sourceRef]), testRef,
        ...(Number(id.slice(-2)) >= 5 ? [`${PDP0_REVIEW_INPUT_DIRECTORY}/${id}.json`] : []),
      ].map(ref => ({sourceRef: ref, sha256: digest(read(ref))})),
      reviewDisposition: Number(id.slice(-2)) >= 5 ? 'REUSE_PRIOR_REVIEW' : 'FRESH_REVIEW',
      ...(Number(id.slice(-2)) >= 5 ? {priorReview: {ref: `${PDP0_REVIEW_INPUT_DIRECTORY}/${id}.json`, sha256: digest(read(`${PDP0_REVIEW_INPUT_DIRECTORY}/${id}.json`)), reuseDisposition: 'REVIEWED_PRIOR_INPUT_AFTER_CURRENT_CUT_REVALIDATION'}} : {}),
      criterionVerification: {statusRecordRef: PDP0_STATUS_REF, statusRecordSha256,
        testReceiptRef: `docs/implementation/verification/pdp-38/${id}.log`, testReceiptSha256: digest(read(`docs/implementation/verification/pdp-38/${id}.log`)),
        testStatus: 'PASS', testCount: 1, passedTestCount: 1, skippedTestCount: 0, outputSha256: testLogs[id].outputSha256},
      reviewConclusion: 'SOURCE_MEANING_REVIEWED; FINDINGS_ARE_SEPARATELY_TYPED', reviewNotes: JSON.stringify(reviewNotes),
      authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', phaseStatusEffect: 'NONE'},
    }];
  }));
  return {status, readiness, directReview, matrix, records, read};
}

test('assembles all eight criterion technical source reviews against current test receipts and frozen 54-surface source cut', () => {
  const input = fixture();
  const candidate = buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: input.records});
  assert.deepEqual(candidate.criteria.map(row => row.criterionId), PDP0_CRITERIA);
  assert.equal(candidate.sourceCut.campaignDenominator.totalSurfaceIdentities, 54);
  assert.equal(candidate.criteria.length, 8);
  assert.equal(candidate.statusBoundary.openFindingCount, 2);
  assert.deepEqual(candidate.findings.map(row => row.id), ['P0-07-FAMILY-CASE-SEMANTIC-FIT-UNKNOWN-231', 'P0-08-P0-010-INDEPENDENT-OUTCOME-ABSENT']);
  assert.equal(candidate.criteria.find(row => row.criterionId === 'P0-07').findings[0].owner, 'UNKNOWN');
  assert.equal(candidate.statusBoundary.pdp010Acceptance, 'NOT_PERFORMED');
  assert.equal(candidate.statusBoundary.phaseStatusEffect, 'NONE');
  assert.equal(candidate.preservedHistoricalReviewRefs.length, 8);
  assert.match(PDP0_REVIEW_INPUT_DIRECTORY, /media-pdp0-current-source-reviews/u);
});

test('rejects missing, extra, stale, out-of-cut or contradictory criterion review inputs', () => {
  const input = fixture();
  const missing = {...input.records}; delete missing['P0-04'];
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: missing}), /inventory mismatch/u);
  const extra = {...input.records, 'P0-09': {}};
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: extra}), /inventory mismatch/u);
  const stale = structuredClone(input.records);
  stale['P0-03'].reviewedSources[0].sha256 = 'a'.repeat(64);
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: stale}), /fingerprint is stale/u);
  const missingInput = structuredClone(input.records);
  missingInput['P0-05'].reviewedSources.pop();
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: missingInput}), /incomplete criterion|omits required/u);
  const falseAcceptance = structuredClone(input.records);
  falseAcceptance['P0-08'].authorityBoundary.pdp010Acceptance = 'ACCEPTED';
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: falseAcceptance}), /cannot assert acceptance/u);
  const malformedFinding = structuredClone(input.records);
  const notes = JSON.parse(malformedFinding['P0-07'].reviewNotes);
  delete notes.findings[0].owner;
  malformedFinding['P0-07'].reviewNotes = JSON.stringify(notes);
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: malformedFinding}), /unrecognized fields|incomplete typed finding|complete typed finding/u);
});

test('rejects non-current receipts, mutated source cuts and a single-reviewer batch', () => {
  const input = fixture();
  const staleReceipt = structuredClone(input.records);
  staleReceipt['P0-02'].criterionVerification.outputSha256 = 'b'.repeat(64);
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: staleReceipt}), /not bound to the exact current/u);
  const changedCut = structuredClone(input.status);
  changedCut.testsActuallyRun['P0-06'].sourceCut.changedBeforeReport = ['source.yaml'];
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, status: changedCut, reviewRecords: input.records}), /supplied .* differs from the exact current source/u);
  const staleVerifierFingerprint = structuredClone(input.status);
  staleVerifierFingerprint.testsActuallyRun['P0-06'].sourceCut.fingerprints['tests/P0-06.test.mjs'] = 'c'.repeat(64);
  const staleStatusText = JSON.stringify(staleVerifierFingerprint);
  const staleStatusRecord = structuredClone(input.records['P0-06']);
  staleStatusRecord.criterionVerification.statusRecordSha256 = digest(staleStatusText);
  staleStatusRecord.reviewedSources.find(source => source.sourceRef === PDP0_STATUS_REF).sha256 = digest(staleStatusText);
  const staleRead = ref => ref === PDP0_STATUS_REF ? staleStatusText : input.read(ref);
  assert.throws(() => validatePdp0CurrentSourceReviewRecord(staleStatusRecord, 'P0-06', {
    status: staleVerifierFingerprint, readiness: input.readiness, directReview: input.directReview, read: staleRead,
  }), /verifier source cut fingerprint is stale/u);
  const oneReviewer = structuredClone(input.records);
  for (const record of Object.values(oneReviewer)) record.reviewer.identity = 'agent:thread:single-reviewer';
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: oneReviewer}), /distinct technical reviewer identities/u);
});

test('rejects source edits after the current phase status captured its source cut', () => {
  const input = fixture();
  const baseRead = input.read;
  input.read = ref => ref === '.product-experience/pdp-0-product-truth/P0-04.yaml'
    ? 'changed after verifier cut\n'
    : baseRead(ref);
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: input.records}), /phase source pin is stale/u);
});

test('validates the four frozen v4 technical reviews against live source-cut selectors and exact PXD bytes', () => {
  const read = ref => fs.readFileSync(path.resolve(root, ref), 'utf8');
  const status = JSON.parse(read(PDP0_STATUS_REF));
  const readiness = JSON.parse(read(PDP0_READINESS_REF));
  const directReview = JSON.parse(read(PDP0_DIRECT_REVIEW_REF));
  for (const id of ['P0-01', 'P0-02', 'P0-03', 'P0-04']) {
    const record = JSON.parse(read(reviewRecordPath(id)));
    validatePdp0CurrentSourceReviewRecord(record, id, {status, readiness, directReview, read});
    const notes = JSON.parse(record.reviewNotes);
    assert.equal(notes.baseline.sourcePinObservation.wholeCutCurrentnessClaim, 'NOT_MADE');
    if (notes.baseline.sourcePinObservation.sectionPinBackerFilesMissing.length > 0) {
      assert.ok(notes.findings.some(finding => finding.classification === 'SOURCE_PIN_COVERAGE_INCOMPLETE'));
    }
  }
});

test('v3 accepts fresh review without predecessor and rejects missing or forged reuse predecessor', () => {
  const input = fixture();
  const candidate = buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: input.records});
  assert.equal(input.records['P0-01'].reviewDisposition, 'FRESH_REVIEW');
  assert.equal(candidate.criteria.find(row => row.criterionId === 'P0-01').reviewedSourceCount, 7);
  const missing = structuredClone(input.records);
  missing['P0-05'].priorReview = undefined;
  delete missing['P0-05'].priorReview;
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: missing}), /priorReview/u);
  const forged = structuredClone(input.records);
  forged['P0-06'].priorReview.sha256 = 'f'.repeat(64);
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: forged}), /priorReview|fingerprint is stale/u);
  const falseFresh = structuredClone(input.records);
  falseFresh['P0-01'].priorReview = {ref: `${PDP0_REVIEW_INPUT_DIRECTORY}/P0-01.json`, sha256: digest(input.read(`${PDP0_REVIEW_INPUT_DIRECTORY}/P0-01.json`)), reuseDisposition: 'REVIEWED_PRIOR_INPUT_AFTER_CURRENT_CUT_REVALIDATION'};
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: falseFresh}), /fresh review cannot claim/u);
});

test('v4 JSON Schemas validate the fresh records and nullable direct-decision facts exactly', () => {
  const input = fixture();
  const candidate = buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: input.records});
  const folder = path.join(root, 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23');
  const Ajv2020 = requireTools('ajv/dist/2020').default;
  const ajv = new Ajv2020({allErrors: true});
  const readJson = name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
  const notesSchema = readJson('review-notes.v3.schema.json');
  const recordSchema = readJson('review-record.v4.schema.json');
  const candidateSchema = readJson('candidate.v4.schema.json');
  const validateNotes = ajv.compile(notesSchema);
  const validateRecord = ajv.compile(recordSchema);
  const validateCandidate = ajv.compile(candidateSchema);
  for (const id of ['P0-01', 'P0-02', 'P0-03', 'P0-04']) {
    const record = input.records[id];
    assert.equal(record.reviewDisposition, 'FRESH_REVIEW');
    assert.equal(record.reviewNotes && JSON.parse(record.reviewNotes).criterionIdentity.directDefinitionDecisionRef, null);
    assert.ok(validateRecord(record), JSON.stringify(validateRecord.errors));
    assert.ok(validateNotes(JSON.parse(record.reviewNotes)), JSON.stringify(validateNotes.errors));
  }
  assert.ok(validateCandidate(candidate), JSON.stringify(validateCandidate.errors));
  const actual = JSON.parse(fs.readFileSync(path.join(root, PDP0_DIRECT_REVIEW_REF), 'utf8'));
  for (const id of ['P0-01', 'P0-02', 'P0-03', 'P0-04']) {
    const row = actual.records.find(record => record.taskId === id);
    assert.equal(directDefinitionDecisionRef(row), null, `${id} direct decisionRef is absent and must remain null`);
  }
  const invented = structuredClone(input.records);
  const notes = JSON.parse(invented['P0-01'].reviewNotes);
  notes.criterionIdentity.directDefinitionDecisionRef = '.product-experience/decision-log.md#PXD-216';
  invented['P0-01'].reviewNotes = JSON.stringify(notes);
  assert.throws(() => buildPdp0CurrentSourceReviewCandidate({...input, reviewRecords: invented}), /contradicts exact current task\/direct-review sources/u);
});
