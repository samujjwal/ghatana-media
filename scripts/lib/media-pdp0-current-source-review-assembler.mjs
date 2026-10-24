import {createHash} from 'node:crypto';
import path from 'node:path';
import {fingerprintPxdDecisionSection} from '../lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {pdp0PhaseScopedSourcePins} from '../report-media-pdp-readiness.mjs';

export const PDP0_CRITERIA = Object.freeze(Array.from({length: 8}, (_, index) => `P0-${String(index + 1).padStart(2, '0')}`));
export const PDP0_STATUS_REF = 'docs/implementation/pdp-0-phase-dev-status.json';
export const PDP0_READINESS_REF = 'docs/implementation/media-pdp-38-readiness.json';
export const PDP0_DIRECT_REVIEW_REF = 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json';
export const PDP0_MATRIX_REF = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
export const PDP0_REVIEW_INPUT_DIRECTORY = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

function assertKeys(value, allowed, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  requireValue(!unknown.length, `${label} has unrecognized fields: ${unknown.join(', ')}`);
}

export function reviewRecordPath(criterionId) {
  requireValue(PDP0_CRITERIA.includes(criterionId), `unknown PDP-0 direct criterion ${criterionId}`);
  return `${PDP0_REVIEW_INPUT_DIRECTORY}/${criterionId}.v4.json`;
}

export function directDefinitionDecisionRef(directRecord) {
  return typeof directRecord?.decisionRef === 'string' ? directRecord.decisionRef : null;
}

function currentRefHash(sourceRef, {status, read}) {
  const phasePins = status.sourceShaSet ?? {};
  const hash = sourceRef.match(/^(.*)#PXD-(\d{3})-section$/u);
  if (hash) {
    const decisionLog = read('.product-experience/decision-log.md');
    const actual = fingerprintPxdDecisionSection(decisionLog, hash[2]).sha256;
    requireValue(!phasePins[sourceRef] || phasePins[sourceRef] === actual, `current PDP-0 phase source pin is stale for ${sourceRef}`);
    return actual;
  }
  if (sourceRef.includes('#') && isSha(phasePins[sourceRef])) {
    const fileRef = sourceRef.split('#', 1)[0];
    let fileText;
    try { fileText = read(fileRef); } catch { throw new Error(`reviewed source is missing or unreadable: ${sourceRef}`); }
    if (isSha(phasePins[fileRef])) requireValue(sha256(fileText) === phasePins[fileRef], `current PDP-0 projection input is stale for ${sourceRef}`);
    return phasePins[sourceRef];
  }
  const fileRef = sourceRef.split('#', 1)[0];
  let fileText;
  try {
    fileText = read(fileRef);
  }
  catch { throw new Error(`reviewed source is missing or unreadable: ${sourceRef}`); }
  const actual = sha256(fileText);
  requireValue(!phasePins[sourceRef] || phasePins[sourceRef] === actual, `current PDP-0 phase source pin is stale for ${sourceRef}`);
  return actual;
}

export function validatePdp0CurrentSourceReviewRecord(record, criterionId, {status, readiness, directReview, read}) {
  const fields = ['schemaVersion', 'criterionId', 'phaseScope', 'reviewer', 'scopeRef', 'reviewedSources', 'criterionVerification', 'reviewConclusion', 'reviewNotes', 'authorityBoundary', 'reviewDisposition', 'priorReview'];
  assertKeys(record, fields, `${criterionId} review record`);
  requireValue(record.schemaVersion === 'media.pdp0.current-source-review-record.v4' && record.criterionId === criterionId && record.phaseScope === 'PDP-0', `${criterionId} review record identity or phase is invalid`);
  requireValue(['FRESH_REVIEW', 'REUSE_PRIOR_REVIEW'].includes(record.reviewDisposition), `${criterionId} reviewDisposition must explicitly select FRESH_REVIEW or REUSE_PRIOR_REVIEW`);
  assertKeys(record.reviewer, ['identity', 'reviewRole', 'reviewRecordRef'], `${criterionId} reviewer`);
  requireValue(typeof record.reviewer.identity === 'string' && record.reviewer.identity.trim().length > 0
    && record.reviewer.reviewRole === 'DISTINCT_TECHNICAL_REVIEWER'
    && record.reviewer.reviewRecordRef === reviewRecordPath(criterionId), `${criterionId} reviewer identity/role/reference is invalid`);
  requireValue(typeof record.scopeRef === 'string' && record.scopeRef === `${PDP0_READINESS_REF}#tasks/${criterionId}`, `${criterionId} scopeRef must identify the exact current criterion`);
  requireValue(record.reviewConclusion === 'SOURCE_MEANING_REVIEWED; FINDINGS_ARE_SEPARATELY_TYPED'
    && typeof record.reviewNotes === 'string' && record.reviewNotes.trim().length >= 20, `${criterionId} needs an explicit bounded source-review conclusion and notes`);
  let observations;
  try { observations = JSON.parse(record.reviewNotes); } catch { throw new Error(`${criterionId} reviewNotes must contain a structured technical review record`); }
  assertKeys(observations, ['reviewKind', 'criterionIdentity', 'baseline', 'criterionMeaning', 'findings', 'verifierReceipt', 'sourceCoverage', 'nextAction', 'reviewerBoundary'], `${criterionId} nested source review`);
  assertKeys(observations.criterionIdentity, ['criterionId', 'readinessTaskRef', 'directDefinitionCriterionRecord', 'directDefinitionDecisionRef', 'readinessCriterionState', 'originalTaskState'], `${criterionId} criterionIdentity`);
  assertKeys(observations.baseline, ['repositoryHead', 'workingTree', 'campaign', 'macroStage', 'exactPhase', 'registeredIdentityDenominator', 'requestedCurrentMaterialPathDenominator', 'sourcePinObservation', 'sourceCurrentnessClaim'], `${criterionId} review baseline`);
  assertKeys(observations.baseline.registeredIdentityDenominator, ['physicalCandidates', 'compositionSurfacesIncludingRoot', 'logicalConsumers', 'registeredIdentities'], `${criterionId} review denominator`);
  assertKeys(observations.baseline.sourcePinObservation, ['reportedCurrentMaterialPathDenominator', 'phaseStatusSourcePinRefs', 'wholeFilePinsComparedAgainstLiveBytes', 'wholeFilePinMismatches', 'sectionPins', 'sectionPinCurrentness', 'wholeCutCurrentnessClaim', 'sectionPinBackerFilesMissing'], `${criterionId} source-pin observation`);
  assertKeys(observations.criterionMeaning, ['scope', 'observations', 'nonClaims'], `${criterionId} criterionMeaning`);
  assertKeys(observations.verifierReceipt, ['statusRecordRef', 'currentStatusRecordHashedInCriterionVerification', 'testReceiptRef', 'testReceiptSha256', 'testStatus', 'testCount', 'passedTestCount', 'skippedTestCount', 'outputSha256', 'command', 'distinction'], `${criterionId} verifierReceipt`);
  assertKeys(observations.sourceCoverage, ['sourceRefsWithCurrentWholeFileHashes', 'sourceRefMap', 'knownUnknowns'], `${criterionId} sourceCoverage`);
  assertKeys(observations.reviewerBoundary, ['role', 'ownerApproval', 'independentAcceptance', 'pdp010Acceptance', 'phaseStatusEffect'], `${criterionId} reviewerBoundary`);
  requireValue(observations.reviewKind === 'AI_TECHNICAL_CURRENT_SOURCE_REVIEW'
    && observations.criterionIdentity?.criterionId === criterionId
    && observations.criterionIdentity.readinessTaskRef === `${PDP0_READINESS_REF}#tasks/${criterionId}`
    && observations.baseline?.exactPhase === 'PDP-0 Product Truth'
    && observations.baseline.repositoryHead === status.mainSha
    && observations.baseline.registeredIdentityDenominator?.physicalCandidates === 26
    && observations.baseline.registeredIdentityDenominator?.compositionSurfacesIncludingRoot === 7
    && observations.baseline.registeredIdentityDenominator?.logicalConsumers === 21
    && observations.baseline.registeredIdentityDenominator?.registeredIdentities === 54
    && observations.baseline.requestedCurrentMaterialPathDenominator === 207
    && observations.baseline.sourcePinObservation.reportedCurrentMaterialPathDenominator === 207
    && Number.isInteger(observations.baseline.sourcePinObservation.phaseStatusSourcePinRefs)
    && Number.isInteger(observations.baseline.sourcePinObservation.wholeFilePinsComparedAgainstLiveBytes)
    && observations.baseline.sourcePinObservation.wholeFilePinMismatches === 0
    && Number.isInteger(observations.baseline.sourcePinObservation.sectionPins)
    && typeof observations.baseline.sourcePinObservation.sectionPinCurrentness === 'string'
    && typeof observations.baseline.sourcePinObservation.wholeCutCurrentnessClaim === 'string'
    && observations.baseline.sourcePinObservation.wholeCutCurrentnessClaim === 'NOT_MADE'
    && Array.isArray(observations.baseline.sourcePinObservation.sectionPinBackerFilesMissing)
    && typeof observations.baseline.sourceCurrentnessClaim === 'string' && observations.baseline.sourceCurrentnessClaim.startsWith('NOT_MADE')
    && observations.criterionMeaning?.scope && Array.isArray(observations.criterionMeaning.observations)
    && Array.isArray(observations.criterionMeaning.nonClaims) && Array.isArray(observations.findings)
    && observations.sourceCoverage && Array.isArray(observations.sourceCoverage.knownUnknowns)
    && observations.sourceCoverage.sourceRefsWithCurrentWholeFileHashes === record.reviewedSources.length
    && observations.reviewerBoundary?.role === 'AI technical source reviewer only'
    && observations.reviewerBoundary.ownerApproval === 'NOT_CLAIMED'
    && observations.reviewerBoundary.independentAcceptance === 'NOT_CLAIMED'
    && observations.reviewerBoundary.pdp010Acceptance === 'NOT_PERFORMED'
    && observations.reviewerBoundary.phaseStatusEffect === 'NONE',
  `${criterionId} structured source review has an incomplete criterion, scope, findings, or authority boundary`);
  const readinessTask = readiness.tasks.find(task => task.id === criterionId);
  const directRecord = directReview.records.find(item => item.taskId === criterionId);
  const directDecisionRef = directDefinitionDecisionRef(directRecord);
  requireValue(observations.criterionIdentity.directDefinitionCriterionRecord === (directRecord?.status ?? 'ABSENT')
    && observations.criterionIdentity.directDefinitionDecisionRef === directDecisionRef
    && observations.criterionIdentity.readinessCriterionState === readinessTask.taskSpecificSourceDone
    && observations.criterionIdentity.originalTaskState === readinessTask.originalLedgerStatus,
  `${criterionId} structured criterion identity contradicts exact current task/direct-review sources`);
  for (const [index, finding] of observations.findings.entries()) {
    assertKeys(finding, ['id', 'classification', 'evidenceRef', 'finding', 'owner', 'correction', 'nextAction'], `${criterionId} finding ${index}`);
    requireValue(['id', 'classification', 'evidenceRef', 'finding', 'owner', 'correction', 'nextAction'].every(key => typeof finding[key] === 'string' && finding[key].trim())
      && /^[A-Z0-9][A-Z0-9-]+$/u.test(finding.id), `${criterionId} finding ${index} is not a complete typed finding`);
  }
  assertKeys(record.authorityBoundary, ['ownerApproval', 'independentAcceptance', 'pdp010Acceptance', 'phaseStatusEffect'], `${criterionId} authorityBoundary`);
  requireValue(record.authorityBoundary.ownerApproval === 'NOT_CLAIMED'
    && record.authorityBoundary.independentAcceptance === 'NOT_CLAIMED'
    && record.authorityBoundary.pdp010Acceptance === 'NOT_PERFORMED'
    && record.authorityBoundary.phaseStatusEffect === 'NONE', `${criterionId} source review cannot assert acceptance or change phase status`);
  requireValue(JSON.stringify(observations.reviewerBoundary) === JSON.stringify({
    role: 'AI technical source reviewer only', ownerApproval: record.authorityBoundary.ownerApproval,
    independentAcceptance: record.authorityBoundary.independentAcceptance, pdp010Acceptance: record.authorityBoundary.pdp010Acceptance,
    phaseStatusEffect: record.authorityBoundary.phaseStatusEffect,
  }), `${criterionId} nested reviewer authority boundary contradicts outer source record`);

  requireValue(Array.isArray(record.reviewedSources), `${criterionId} reviewedSources must be an array`);
  const pins = new Map();
  for (const [index, source] of record.reviewedSources.entries()) {
    assertKeys(source, ['sourceRef', 'sha256'], `${criterionId} reviewed source ${index}`);
    requireValue(typeof source.sourceRef === 'string' && isSha(source.sha256) && !pins.has(source.sourceRef), `${criterionId} reviewed source ${index} has invalid or duplicate identity/fingerprint`);
    const actual = currentRefHash(source.sourceRef, {status, read});
    requireValue(source.sha256 === actual, `${criterionId} source fingerprint is stale for ${source.sourceRef}`);
    const normalizedRef = path.posix.normalize(source.sourceRef.split('#', 1)[0]);
    requireValue(!path.posix.isAbsolute(normalizedRef) && normalizedRef !== '..' && !normalizedRef.startsWith('../'),
      `${criterionId} source reference escapes repository scope: ${source.sourceRef}`);
    pins.set(source.sourceRef, source.sha256);
  }
  let prior = null;
  if (record.reviewDisposition === 'FRESH_REVIEW') {
    requireValue(!Object.hasOwn(record, 'priorReview'), `${criterionId} fresh review cannot claim a prior review`);
  } else {
    assertKeys(record.priorReview, ['ref', 'sha256', 'reuseDisposition'], `${criterionId} priorReview`);
    requireValue(record.priorReview.reuseDisposition === 'REVIEWED_PRIOR_INPUT_AFTER_CURRENT_CUT_REVALIDATION'
      && record.priorReview.ref === `${PDP0_REVIEW_INPUT_DIRECTORY}/${criterionId}.json`
      && isSha(record.priorReview.sha256)
      && pins.get(record.priorReview.ref) === record.priorReview.sha256,
    `${criterionId} priorReview must identify the exact frozen v1 predecessor and include its hash in reviewedSources`);
    let priorText;
    try { priorText = read(record.priorReview.ref); prior = JSON.parse(priorText); } catch { throw new Error(`${criterionId} priorReview source is missing or invalid`); }
    requireValue(sha256(priorText) === record.priorReview.sha256
      && prior.schemaVersion === 'media.pdp0.current-source-review-record.v1' && prior.criterionId === criterionId,
    `${criterionId} priorReview is not the exact matching frozen v1 record`);
  }
  const currentSources = new Map([...pins.entries()].filter(([ref]) => ref !== record.priorReview?.ref));
  const predecessorDecisionRefs = new Set([
    directRecord?.decisionRef,
    directRecord?.currentCorrectiveReview?.decisionRef,
    directRecord?.currentSourceReview?.decisionRef,
    directRecord?.currentSourcePinRefresh?.decisionContextRef,
    ...(directRecord?.currentProjectionRefresh?.decisionContextRefs ?? []),
  ].filter(ref => typeof ref === 'string').map(ref => ref.match(/\.product-experience\/decision-log\.md#(PXD-\d{3})/u)?.[1]).filter(Boolean));
  for (const predecessor of prior?.reviewedSources ?? []) {
    if (predecessor.sourceRef.endsWith('/review-record.schema.json') || predecessor.sourceRef.endsWith('/review-record.example.json')) continue;
    if (predecessor.sourceRef === '.product-experience/decision-log.md') {
      for (const decisionId of predecessorDecisionRefs) {
        const sectionRef = `.product-experience/decision-log.md#${decisionId}-section`;
      requireValue(currentSources.has(sectionRef), `${criterionId} prior review used the whole decision log; the v3 review must bind exact predecessor section ${sectionRef}`);
      }
      continue;
    }
    requireValue(currentSources.get(predecessor.sourceRef) === predecessor.sha256,
      `${criterionId} cannot reuse prior review evidence because its source cut changed or was not re-reviewed: ${predecessor.sourceRef}`);
  }
  const testReceiptRef = `docs/implementation/verification/pdp-38/${criterionId}.log`;
  const anchors = [PDP0_READINESS_REF, PDP0_STATUS_REF, PDP0_DIRECT_REVIEW_REF, '.product-experience/source-manifest.yaml', testReceiptRef];
  const missingAnchors = anchors.filter(ref => !pins.has(ref));
  requireValue(!missingAnchors.length, `${criterionId} review omits required current source/status/test anchors: ${missingAnchors.join(', ')}`);
  requireValue([...pins.keys()].some(ref => ref.startsWith('tests/')), `${criterionId} review must inspect at least one criterion test source`);
  requireValue(criterionId === 'P0-08'
    ? pins.has('.product-experience/acceptance.yaml') || pins.has('.product-experience/acceptance.yaml#ACCEPT-INPUT-P0-010')
    : [...pins.keys()].some(ref => ref.startsWith('.product-experience/pdp-0-product-truth/')),
  `${criterionId} review omits the criterion's PDP-0 semantic source material`);
  for (const finding of observations.findings) {
    const findingSourcePath = finding.evidenceRef.split('#', 1)[0];
    requireValue(pins.has(finding.evidenceRef) || pins.has(findingSourcePath), `${criterionId} finding ${finding.id} evidence is not among reviewed sources`);
  }
  requireValue(!observations.sourceCoverage.knownUnknowns.length || observations.findings.length > 0,
    `${criterionId} review has unknowns but no typed finding records`);

  const receipt = status.testsActuallyRun?.[criterionId];
  const directResult = status.directDevelopmentCriteria?.[criterionId];
  requireValue(receipt && directResult?.testStatus === 'PASS' && receipt.status === 'PASS', `${criterionId} current direct criterion tests are not passing`);
  requireValue(receipt.testCount === directResult.testCount && receipt.passedTestCount === directResult.passedTestCount
    && receipt.skippedTestCount === directResult.skippedTestCount && receipt.passedTestCount + receipt.skippedTestCount === receipt.testCount,
  `${criterionId} verifier receipt counters contradict its status record`);
  const verifierCut = receipt.sourceCut;
  requireValue(verifierCut && Array.isArray(verifierCut.changedDuringVerification) && verifierCut.changedDuringVerification.length === 0,
    `${criterionId} verifier source cut changed during report`);
  if (Object.hasOwn(verifierCut, 'changedBeforeReport')) {
    requireValue(Array.isArray(verifierCut.changedBeforeReport) && verifierCut.changedBeforeReport.length === 0,
      `${criterionId} verifier source cut changed before report`);
  }
  requireValue(verifierCut.fingerprints && typeof verifierCut.fingerprints === 'object' && !Array.isArray(verifierCut.fingerprints)
    && Object.keys(verifierCut.fingerprints).length > 0, `${criterionId} verifier source cut has no exact fingerprint set`);
  const phaseScopedPins = pdp0PhaseScopedSourcePins();
  const notes = JSON.parse(record.reviewNotes);
  const explicitlyMissingBackers = new Set(notes.baseline?.sourcePinObservation?.sectionPinBackerFilesMissing ?? []);
  const unknowns = observations.sourceCoverage.knownUnknowns;
  const hasTypedSectionUnknown = observations.findings.some(finding => finding.classification === 'SOURCE_PIN_COVERAGE_INCOMPLETE');
  for (const [sourceRef, expectedSha256] of Object.entries(verifierCut.fingerprints)) {
    requireValue(typeof sourceRef === 'string' && isSha(expectedSha256), `${criterionId} verifier source cut contains an invalid fingerprint`);
    const fileRef = sourceRef.split('#', 1)[0];
    const normalized = path.posix.normalize(fileRef);
    requireValue(!path.posix.isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith('../'),
      `${criterionId} verifier source cut contains an invalid repository path: ${sourceRef}`);
    let actualSha256;
    if (Object.hasOwn(phaseScopedPins, sourceRef)) {
      actualSha256 = phaseScopedPins[sourceRef];
      requireValue(status.sourceShaSet?.[sourceRef] === expectedSha256,
        `${criterionId} verifier source cut fingerprint is not bound by the current status source set: ${sourceRef}`);
    }
    else {
      if (/#PXD-\d{3}-section$/u.test(sourceRef)) {
        actualSha256 = currentRefHash(sourceRef, {status, read});
      }
      else try { actualSha256 = currentRefHash(sourceRef, {status, read}); }
      catch {
        const declaredMissing = explicitlyMissingBackers.has(sourceRef)
          && unknowns.some(item => item.includes(sourceRef))
          && hasTypedSectionUnknown
          && notes.baseline?.sourcePinObservation?.wholeCutCurrentnessClaim === 'NOT_MADE';
        requireValue(declaredMissing && status.sourceShaSet?.[sourceRef] === expectedSha256,
          `${criterionId} verifier source cut input is missing without a typed currentness unknown: ${sourceRef}`);
        continue;
      }
    }
    requireValue(actualSha256 === expectedSha256, `${criterionId} verifier source cut fingerprint is stale: ${sourceRef}`);
  }
  const receiptText = read(testReceiptRef);
  const receiptSha = sha256(receiptText);
  requireValue(receiptSha === receipt.outputSha256, `${criterionId} exact test log does not match the recorded output fingerprint`);
  const statusSha = sha256(read(PDP0_STATUS_REF));
  requireValue(observations.verifierReceipt.statusRecordRef === PDP0_STATUS_REF
    && observations.verifierReceipt.currentStatusRecordHashedInCriterionVerification === true
    && observations.verifierReceipt.testReceiptRef === testReceiptRef
    && observations.verifierReceipt.testReceiptSha256 === receiptSha
    && observations.verifierReceipt.testStatus === receipt.status
    && observations.verifierReceipt.testCount === receipt.testCount
    && observations.verifierReceipt.passedTestCount === receipt.passedTestCount
    && observations.verifierReceipt.skippedTestCount === receipt.skippedTestCount
    && observations.verifierReceipt.outputSha256 === receipt.outputSha256,
  `${criterionId} nested verifier record contradicts current criterion output`);
  assertKeys(record.criterionVerification,
    ['statusRecordRef', 'statusRecordSha256', 'testReceiptRef', 'testReceiptSha256', 'testStatus', 'testCount', 'passedTestCount', 'skippedTestCount', 'outputSha256'],
    `${criterionId} criterionVerification`);
  const verification = record.criterionVerification;
  requireValue(verification.statusRecordRef === PDP0_STATUS_REF && verification.statusRecordSha256 === statusSha
    && verification.testReceiptRef === testReceiptRef && verification.testReceiptSha256 === receiptSha
    && verification.testStatus === receipt.status && verification.testCount === receipt.testCount
    && verification.passedTestCount === receipt.passedTestCount && verification.skippedTestCount === receipt.skippedTestCount
    && verification.outputSha256 === receipt.outputSha256,
  `${criterionId} review is not bound to the exact current phase status and full verifier output`);

  return {
    criterionId,
    reviewer: {...record.reviewer},
    scopeRef: record.scopeRef,
    reviewConclusion: record.reviewConclusion,
    reviewNotes: observations,
    findings: structuredClone(observations.findings),
    knownUnknowns: [...observations.sourceCoverage.knownUnknowns],
    reviewedSourceCount: pins.size,
    reviewedSourceFingerprints: Object.fromEntries([...pins.entries()].sort(([a], [b]) => a.localeCompare(b))),
    criterionVerification: {...verification},
    authorityBoundary: {...record.authorityBoundary},
  };
}

function currentPriorReviewPinMismatches({status, directReview, read}) {
  const mismatches = [];
  for (const record of directReview.records ?? []) {
    if (!PDP0_CRITERIA.includes(record.taskId)) continue;
    const pinnedValues = [];
    for (const review of [record.currentSourceReview, record.currentCorrectiveReview]) {
      for (const [sourceRef, priorSha256] of Object.entries(review?.sourceFingerprints ?? {})) pinnedValues.push({sourceRef, priorSha256});
    }
    for (const [field, pinMap] of [['currentSourcePinRefresh.predecessorSourceFingerprints', record.currentSourcePinRefresh?.predecessorSourceFingerprints],
      ['currentSourcePinRefresh.currentSourceFingerprints', record.currentSourcePinRefresh?.currentSourceFingerprints],
      ['currentProjectionRefresh.sourceFingerprints', record.currentProjectionRefresh?.sourceFingerprints]]) {
      for (const [sourceRef, priorSha256] of Object.entries(pinMap ?? {})) pinnedValues.push({sourceRef, priorSha256, pinField: field});
    }
    const refresh = record.currentSourcePinRefresh;
    if (refresh?.decisionContextFingerprint?.sourceRef) pinnedValues.push({sourceRef: refresh.decisionContextFingerprint.sourceRef, priorSha256: refresh.decisionContextFingerprint.sha256, pinField: 'currentSourcePinRefresh.decisionContextFingerprint'});
    for (const [sourceRef, priorSha256] of Object.entries(record.currentProjectionRefresh?.decisionContextFingerprints ?? {})) pinnedValues.push({sourceRef, priorSha256, pinField: 'currentProjectionRefresh.decisionContextFingerprints'});
    if (record.currentProjectionRefresh?.projectionArtifactRef) pinnedValues.push({sourceRef: record.currentProjectionRefresh.projectionArtifactRef, priorSha256: record.currentProjectionRefresh.projectionArtifactSha256, pinField: 'currentProjectionRefresh.projectionArtifactSha256'});
    for (const {sourceRef, priorSha256, pinField} of pinnedValues) {
      const currentSha256 = currentRefHash(sourceRef, {status, read});
      if (priorSha256 !== currentSha256) mismatches.push({criterionId: record.taskId, sourceRef, priorSha256, currentSha256, ...(pinField ? {pinField} : {})});
    }
  }
  const unique = new Map();
  for (const mismatch of mismatches) unique.set(`${mismatch.criterionId}:${mismatch.sourceRef}:${mismatch.pinField ?? 'sourceFingerprints'}`, mismatch);
  return [...unique.values()].sort((a, b) => `${a.criterionId}:${a.sourceRef}:${a.pinField ?? ''}`.localeCompare(`${b.criterionId}:${b.sourceRef}:${b.pinField ?? ''}`));
}

export function buildPdp0CurrentSourceReviewCandidate({status, readiness, directReview, matrix, reviewRecords, read}) {
  requireValue(status?.phase === 'PDP-0' && status.schemaVersion, 'current PDP-0 phase status is required');
  requireValue(readiness?.tasks && Array.isArray(readiness.tasks), 'current readiness task inventory is required');
  requireValue(directReview?.records && Array.isArray(directReview.records), 'immutable direct-criterion review source is required');
  requireValue(matrix?.campaign?.phase === 'PDP-0' || matrix?.recordKind === 'PDP_SURFACE_PHASE_STATUS_MATRIX', 'current PDP-0 surface matrix is required');
  for (const [ref, value] of [[PDP0_STATUS_REF, status], [PDP0_READINESS_REF, readiness], [PDP0_DIRECT_REVIEW_REF, directReview], [PDP0_MATRIX_REF, matrix]]) {
    let actual;
    try { actual = JSON.parse(read(ref)); } catch { throw new Error(`cannot load the source object for ${ref}`); }
    requireValue(JSON.stringify(actual) === JSON.stringify(value), `supplied ${ref} object differs from the exact current source`);
  }
  requireValue(reviewRecords && typeof reviewRecords === 'object', 'eight criterion review inputs are required');
  const missingIds = PDP0_CRITERIA.filter(id => !reviewRecords[id]);
  const extraIds = Object.keys(reviewRecords).filter(id => !PDP0_CRITERIA.includes(id));
  requireValue(!missingIds.length && !extraIds.length, `review input inventory mismatch; missing=[${missingIds.join(',')}], extra=[${extraIds.join(',')}]`);
  const statusSha256 = sha256(read(PDP0_STATUS_REF));
  const matrixSha256 = sha256(read(PDP0_MATRIX_REF));
  const reviews = PDP0_CRITERIA.map(id => validatePdp0CurrentSourceReviewRecord(reviewRecords[id], id, {status, readiness, directReview, read}));
  const distinctReviewers = new Set(reviews.map(review => review.reviewer.identity));
  requireValue(distinctReviewers.size >= 2, 'PDP-0 current-source review must include distinct technical reviewer identities');
  const reviewedCurrentSourceFingerprints = {};
  for (const review of reviews) for (const [sourceRef, sourceSha256] of Object.entries(review.reviewedSourceFingerprints)) {
    requireValue(!reviewedCurrentSourceFingerprints[sourceRef] || reviewedCurrentSourceFingerprints[sourceRef] === sourceSha256,
      `criterion reviews disagree on current source fingerprint for ${sourceRef}`);
    reviewedCurrentSourceFingerprints[sourceRef] = sourceSha256;
  }
  const sourceCut = {
    sourceRecordRef: PDP0_STATUS_REF,
    sourceRecordSha256: statusSha256,
    surfaceMatrixRef: PDP0_MATRIX_REF,
    surfaceMatrixSha256: matrixSha256,
    sourceShaSet: status.sourceShaSet,
    reviewedCurrentSourceFingerprints: Object.fromEntries(Object.entries(reviewedCurrentSourceFingerprints).sort(([a], [b]) => a.localeCompare(b))),
    sourceRecordCount: status.sourceRecordCount,
    campaignDenominator: matrix.summary ? {
      totalSurfaceIdentities: matrix.summary.totalSurfaceIdentities,
      physical: matrix.summary.physical,
      compositions: matrix.summary.compositions,
      logicalConsumers: matrix.summary.logicalConsumers,
    } : undefined,
  };
  const findings = reviews.flatMap(review => review.findings.map(finding => ({criterionId: review.criterionId, ...finding})));
  const findingIds = findings.map(finding => finding.id);
  requireValue(findingIds.every(id => typeof id === 'string' && id.length > 0) && new Set(findingIds).size === findingIds.length,
    'source review findings must have unique stable IDs');
  return {
    schemaVersion: 'media.pdp0.current-source-review-candidate.v4',
    artifactKind: 'COORDINATOR_ASSEMBLED_TECHNICAL_SOURCE_REVIEW_INPUTS',
    phaseScope: 'PDP-0',
    sourceCut,
    criteria: reviews,
    findings,
    priorReviewSourcePinMismatches: currentPriorReviewPinMismatches({status, directReview, read}),
    statusBoundary: {
      currentVerifierStatus: status.status,
      criterionTestStatus: 'PASS_FOR_ALL_EIGHT_DIRECT_CRITERION_SUITES',
      semanticSourceReview: 'TECHNICAL_REVIEW_INPUTS_ASSEMBLED; CRITERION_REVIEWS_RECORDED',
      openFindingCount: findings.length,
      openFindingIds: findingIds,
      ownerApproval: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
      pdp010Acceptance: 'NOT_PERFORMED',
      phaseStatusEffect: 'NONE',
      currentStatusMutation: 'NOT_PERFORMED',
    },
    preservedAuthorityRef: PDP0_DIRECT_REVIEW_REF,
    preservedHistoricalReviewRefs: directReview.records.flatMap(record => (record.historicalCorrectiveReviews ?? []).map(review => review.decisionRef)).filter(Boolean),
    claimBoundary: 'Technical current-source review inputs only. This candidate does not alter the canonical review authority or phase status, does not establish independent P0-010 acceptance, and does not claim PDP-0 DEV_COMPLETE, native proof, closure, qualification or Delivery readiness.',
  };
}

export function resolveReviewRecordFiles({read, directory = PDP0_REVIEW_INPUT_DIRECTORY}) {
  return Object.fromEntries(PDP0_CRITERIA.map(id => {
    const file = path.posix.join(directory, `${id}.v4.json`);
    try { return [id, JSON.parse(read(file))]; }
    catch { throw new Error(`missing or invalid criterion review input: ${file}`); }
  }));
}
