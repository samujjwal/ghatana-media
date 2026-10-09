import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { validateMediaTranscriptionSubmissionDefinition } from '../scripts/lib/media-transcription-submission-definition-validation.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const operations = yaml('.product-experience/pdp-1-domain-data/operations.yaml');
const actionContracts = yaml('.product-experience/pdp-1-domain-data/action-contracts.yaml');
const base = { operations, actionContracts };
const operationId = 'media.operation.transcription-submission';
const op = operations.operations.find(({ id }) => id === operationId);
const clone = () => structuredClone(base);
const mutableOp = (value) => value.operations.operations.find(({ id }) => id === operationId);

test('file-audio transcription submission definition', () => {
  assert.deepEqual(validateMediaTranscriptionSubmissionDefinition(base), []);
  assert.equal(operations.operations.indexOf(op), 3, 'preserve the existing submission record position');
  assert.deepEqual(op.inputSemantics.selectorValues, ['SUBMIT_OR_REPLAY', 'RECONCILE']);
  assert.equal(op.outputSemantics.acknowledgedOutcome, 'REQUEST_ACKNOWLEDGED');
  assert.match(op.scopeStatus, /runtime-NOT_ADMITTED/u);
});

test('submission definition rejects replay, authority, and finality overclaims', () => {
  assert.deepEqual(validateMediaTranscriptionSubmissionDefinition(base), []);

  const partialReplay = clone();
  mutableOp(partialReplay).inputSemantics.submitReplayRule = 'replay from requestId only';
  assert.match(validateMediaTranscriptionSubmissionDefinition(partialReplay).join('\n'), /exact declared fields/u);

  const fingerprintOmitsAuthority = clone();
  mutableOp(fingerprintOmitsAuthority).inputSemantics.requestFingerprint.fields = op.inputSemantics.requestFingerprint.fields.filter((field) => field !== 'tenantId');
  assert.match(validateMediaTranscriptionSubmissionDefinition(fingerprintOmitsAuthority).join('\n'), /trusted authority scope/u);

  const fingerprintNormalizes = clone();
  mutableOp(fingerprintNormalizes).inputSemantics.requestFingerprint.normalization = 'trim, case-fold, and fill omitted profile defaults';
  assert.match(validateMediaTranscriptionSubmissionDefinition(fingerprintNormalizes).join('\n'), /trusted authority scope/u);

  const callerGrantsRights = clone();
  mutableOp(callerGrantsRights).inputSemantics.authorityReferences = 'caller-provided consentRef and rightsEvidenceRef are authoritative grants';
  assert.match(validateMediaTranscriptionSubmissionDefinition(callerGrantsRights).join('\n'), /not be treated as rights/u);

  const languageInferred = clone();
  mutableOp(languageInferred).inputSemantics.languageIntent.AUTO_REQUESTED.rule = 'infer language automatically even when profile support is unknown';
  assert.match(validateMediaTranscriptionSubmissionDefinition(languageInferred).join('\n'), /cannot be inferred/u);

  const ackMeansCompleted = clone();
  mutableOp(ackMeansCompleted).outputSemantics.receiptMeaning = 'receipt proves recognition completed and transcript is approved';
  assert.match(validateMediaTranscriptionSubmissionDefinition(ackMeansCompleted).join('\n'), /must not assert job state/u);

  const receiptReadSkipsAuth = clone();
  mutableOp(receiptReadSkipsAuth).context.reconciliationReadAuthority = 'any caller may query whether a requestId exists';
  assert.match(validateMediaTranscriptionSubmissionDefinition(receiptReadSkipsAuth).join('\n'), /distinct current receipt-read authority/u);

  const dependsOnReturnedFingerprint = clone();
  mutableOp(dependsOnReturnedFingerprint).inputSemantics.submitSnapshot = 'construct snapshot from fingerprint returned by server after dispatch';
  assert.match(validateMediaTranscriptionSubmissionDefinition(dependsOnReturnedFingerprint).join('\n'), /retain the exact pre-dispatch request snapshot/u);

  const profileNotQualified = clone();
  mutableOp(profileNotQualified).inputSemantics.profileIdentity = 'profile name implies support';
  assert.match(validateMediaTranscriptionSubmissionDefinition(profileNotQualified).join('\n'), /qualification evidence current/u);

  const unknownSubmitField = clone();
  mutableOp(unknownSubmitField).inputSemantics.submitAllowedFields.push('debugMetadata');
  assert.match(validateMediaTranscriptionSubmissionDefinition(unknownSubmitField).join('\n'), /exact declared fields/u);

  const branchMixedPayload = clone();
  mutableOp(branchMixedPayload).inputSemantics.reconcileAllowedFields = [
    ...mutableOp(branchMixedPayload).inputSemantics.commonAllowedFields,
    ...mutableOp(branchMixedPayload).inputSemantics.submitRequiredFields,
    ...mutableOp(branchMixedPayload).inputSemantics.reconcileRequiredFields,
  ];
  assert.match(validateMediaTranscriptionSubmissionDefinition(branchMixedPayload).join('\n'), /exact declared fields/u);

  const callerSuppliedIdentity = clone();
  mutableOp(callerSuppliedIdentity).inputSemantics.submitAllowedFields.push('tenantId', 'principalId');
  assert.match(validateMediaTranscriptionSubmissionDefinition(callerSuppliedIdentity).join('\n'), /exact declared fields/u);

  const nullRequestId = clone();
  mutableOp(nullRequestId).inputSemantics.scalarNullability.requiredNonemptyStrings =
    mutableOp(nullRequestId).inputSemantics.scalarNullability.requiredNonemptyStrings.filter((field) => field !== 'requestId');
  assert.match(validateMediaTranscriptionSubmissionDefinition(nullRequestId).join('\n'), /scalar nullability must be explicit/u);

  const nullRightsEvidence = clone();
  mutableOp(nullRightsEvidence).inputSemantics.scalarNullability.rightsEvidenceRef = 'nullable caller-supplied rights evidence';
  assert.match(validateMediaTranscriptionSubmissionDefinition(nullRightsEvidence).join('\n'), /scalar nullability must be explicit/u);

  const implicitConsentDefault = clone();
  mutableOp(implicitConsentDefault).inputSemantics.scalarNullability.consentRef = 'if absent, assume no consent is needed';
  assert.match(validateMediaTranscriptionSubmissionDefinition(implicitConsentDefault).join('\n'), /scalar nullability must be explicit/u);

  const reconcileRequiresExecutionRights = clone();
  mutableOp(reconcileRequiresExecutionRights).preconditions.RECONCILE.push('current-consent-is-active-and-provider-profile-is-qualified-for-dispatch');
  assert.match(validateMediaTranscriptionSubmissionDefinition(reconcileRequiresExecutionRights).join('\n'), /effect gates and reconciliation read-only gates/u);

  const genericAuthorizationDemandsConsent = clone();
  mutableOp(genericAuthorizationDemandsConsent).authorization = 'all branches require current consent purpose profile and provider dispatch authority';
  assert.match(validateMediaTranscriptionSubmissionDefinition(genericAuthorizationDemandsConsent).join('\n'), /branch authorization must not require processing authority/u);

  const submitDropsRightsGuard = clone();
  mutableOp(submitDropsRightsGuard).preconditions.SUBMIT_OR_REPLAY = mutableOp(submitDropsRightsGuard).preconditions.SUBMIT_OR_REPLAY.filter((condition) => !condition.includes('current-rights-decision-verifies'));
  assert.match(validateMediaTranscriptionSubmissionDefinition(submitDropsRightsGuard).join('\n'), /effect gates and reconciliation read-only gates/u);
});

test('unknown dispatch and reconciliation stay nonterminal and non-replayable', () => {
  const missingIsNoEffect = clone();
  mutableOp(missingIsNoEffect).error.reconciliation = 'missing record proves no dispatch and permits a new requestId';
  assert.match(validateMediaTranscriptionSubmissionDefinition(missingIsNoEffect).join('\n'), /missing reconciliation evidence/u);

  const autoRetry = clone();
  mutableOp(autoRetry).retry = 'automatically submit with a fresh requestId after timeout';
  assert.match(validateMediaTranscriptionSubmissionDefinition(autoRetry).join('\n'), /blind command replay/u);

  const noUnknown = clone();
  mutableOp(noUnknown).unknownOutcome = 'timeout is definitive failure; retry immediately';
  assert.match(validateMediaTranscriptionSubmissionDefinition(noUnknown).join('\n'), /same-key reconciliation/u);

  const submissionAddsStateEdge = clone();
  mutableOp(submissionAddsStateEdge).transition.transitionRefs = ['media.job.QUEUED'];
  assert.match(validateMediaTranscriptionSubmissionDefinition(submissionAddsStateEdge).join('\n'), /must not imply/u);

  const streamExpanded = clone();
  mutableOp(streamExpanded).scopeStatus = 'all transcription modes runtime-QUALIFIED';
  assert.match(validateMediaTranscriptionSubmissionDefinition(streamExpanded).join('\n'), /file-audio scoped/u);

  const conflictErasesOldReceipt = clone();
  mutableOp(conflictErasesOldReceipt).error.conflictScope = 'conflict proves no prior request exists and clears the key';
  assert.match(validateMediaTranscriptionSubmissionDefinition(conflictErasesOldReceipt).join('\n'), /definitive no-effect rejection/u);

  const denialProvesKeyUnused = clone();
  mutableOp(denialProvesKeyUnused).error.refusalScope = 'preflight denial proves no prior request exists under this key';
  assert.match(validateMediaTranscriptionSubmissionDefinition(denialProvesKeyUnused).join('\n'), /definitive no-effect rejection/u);

  const cancellationReversesAck = clone();
  mutableOp(cancellationReversesAck).cancellation = 'cancellation reverses the submission receipt and prior dispatch';
  assert.match(validateMediaTranscriptionSubmissionDefinition(cancellationReversesAck).join('\n'), /must not be reversed/u);
});
