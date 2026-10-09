import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const read = path => readFileSync(resolve(root, path), 'utf8');

function readSourceFixture() {
  const operations = parse(read('.product-experience/pdp-1-domain-data/operations.yaml'));
  const openapi = parse(read('contracts/openapi/media.yaml'));
  return {
    operations: operations.individualOperationContracts.records,
    sourceDenominators: operations.sourceDenominators,
    actionBindings: parse(read('.product-experience/pdp-1-domain-data/action-contracts.yaml')).operationSliceBindings,
    transition: parse(read('.product-experience/pdp-1-domain-data/transitions.yaml')).transitionRecords.find(item => item.id === 'media-upload-and-artifact/T01'),
    verificationTransition: parse(read('.product-experience/pdp-1-domain-data/transitions.yaml')).transitionRecords.find(item => item.id === 'media-upload-and-artifact/T02'),
    stateAdjudication: parse(read('.product-experience/pdp-1-domain-data/state-adjudication.yaml')),
    policyAuthority: parse(read('.product-experience/pdp-0-product-truth/policy-authority-model.yaml')),
    qualificationPolicy: parse(read('.product-experience/pdp-0-product-truth/qualification-policy.yaml')),
    privacyPolicy: read('docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md'),
    domainObjects: parse(read('.product-experience/pdp-1-domain-data/domain-objects.yaml')).objects,
    openapi: openapi.paths,
    runtime: read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaUploadRequestFingerprint.java'),
    sdk: read('libs/audio-video-client/src/operations.ts'),
  };
}
const sourceFixture = readSourceFixture();
const fixture = () => structuredClone(sourceFixture);

function validate(f) {
  const errors = [];
  const get = suffix => f.operations.find(record => record.id === `media.operation-slice.${suffix}`);
  const begin = get('begin-upload');
  const append = get('append-upload-chunk');
  const complete = get('complete-upload');
  const inspectUpload = get('inspect-upload');
  const inspectArtifact = get('inspect-artifact');
  if (![begin, append, complete].every(Boolean)) return ['the three existing upload operations must remain individually bound'];
  for (const record of [begin, append, complete]) {
    if (record.contractVersion !== 1) errors.push(`${record.id}: version 1 is required`);
    if (record.ownerSemantics?.reviewStatus !== 'media-owner-accepted-bounded-definition; implementation-and-independent-qualification-open' || record.ownerDecisionRef !== '.product-experience/decision-log.md#PXD-046' || record.runtimeAdmission !== 'NOT_ADMITTED') {
      errors.push(`${record.id}: bounded owner definition must retain its exact decision and unadmitted runtime boundary`);
    }
    if (!record.ownerSemantics?.authority?.tenantAndPrincipal?.includes('trusted-host-authentication-context')) {
      errors.push(`${record.id}: tenant/principal fields cannot assert trusted identity`);
    }
    if (!record.ownerSemantics?.authority?.rightsAndConsent?.includes('does-not-grant')) {
      errors.push(`${record.id}: upload/artifact cannot grant rights or consent`);
    }
  }
  const beginWire = f.openapi['/api/v1/artifacts/uploads']?.post;
  const appendWire = f.openapi['/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}']?.put;
  const completeWire = f.openapi['/api/v1/artifacts/uploads/{uploadId}/complete']?.post;
  if (beginWire?.operationId !== begin.sourceOperation) errors.push('begin-upload OpenAPI identity changed');
  if (appendWire?.operationId !== append.sourceOperation) errors.push('append-upload OpenAPI identity changed');
  if (completeWire?.operationId !== complete.sourceOperation) errors.push('complete-upload OpenAPI identity changed');
  if (begin.ownerSemantics.replay?.keyScope?.join('|') !== 'tenantId|principalId|idempotencyKey') errors.push('begin replay scope must include tenant, principal, and key');
  if (begin.ownerSemantics.replay?.requestBinding !== 'canonical-full-upload-request-v1') errors.push('begin replay must bind the full request');
  if (!f.runtime.includes('media.upload-request-fingerprint.v1') || !f.runtime.includes('request.metadata()')) errors.push('full request fingerprint source binding is missing');
  if (!append.ownerSemantics.unknownOutcome?.automaticReplay?.includes('prohibited')) errors.push('append must prohibit automatic replay after unknown outcome');
  if (!f.sdk.includes('chunkIndex !== current.nextChunkIndex') || !f.sdk.includes('nextChunkIndex !== chunkIndex + 1')) errors.push('SDK no longer enforces contiguous chunk acknowledgement');
  if (completeWire?.parameters?.some(parameter => parameter.name === 'Idempotency-Key')) errors.push('bodyless completion must not be described as a request-key operation');
  if (!complete.ownerSemantics.completionReplay?.payloadHashIdempotency?.includes('not-a-valid-description')) errors.push('completion payload-hash declaration contradiction must remain explicit');
  if (complete.ownerSemantics.completionReplay?.completedUpload !== 'return-the-original-artifact-identity-and-immutable-content-observation') errors.push('completion replay must preserve the original artifact identity');
  if (begin.wireBinding?.operationId !== 'beginMediaUpload' || begin.wireBinding?.method !== 'POST'
    || begin.wireBinding?.path !== '/api/v1/artifacts/uploads'
    || begin.wireBinding?.responseSchema !== 'UploadSession'
    || !begin.requestHeaders?.includes('Idempotency-Key')) errors.push('begin must preserve exact idempotent HTTP wire contract');
  if (append.wireBinding?.operationId !== 'appendMediaChunk' || append.wireBinding?.method !== 'PUT'
    || append.wireBinding?.path !== '/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}'
    || append.wireBinding?.requestContentType !== 'application/octet-stream'
    || append.wireBinding?.runtimeObservedButUndeclared?.status !== 404) errors.push('append must preserve its exact binary wire shape and declared-versus-runtime 404 distinction');
  if (complete.wireBinding?.operationId !== 'completeMediaUpload' || complete.wireBinding?.requestBody !== 'absent'
    || complete.wireBinding?.callerRequestKey !== 'absent'
    || complete.wireBinding?.responseSchema !== 'MediaArtifact') errors.push('completion must remain bodyless and cannot invent a caller key');
  if (inspectUpload?.wireBinding?.operationId !== 'getMediaUpload' || inspectArtifact?.wireBinding?.operationId !== 'getMediaArtifact') errors.push('both scoped reads must retain exact existing HTTP identities');
  if (begin.operationKind !== 'COMMAND' || append.operationKind !== 'COMMAND' || complete.operationKind !== 'COMMAND') errors.push('the three upload mutations must remain distinct commands');
  if (begin.resourceScope !== 'tenant-and-owning-principal-scoped-upload-session' || append.resourceScope !== begin.resourceScope || complete.resourceScope !== begin.resourceScope) errors.push('upload commands must use one exact tenant-and-owning-principal scope');
  if (!begin.actionIntentRefs?.includes('media.action.begin-artifact-upload')
    || !append.actionIntentRefs?.includes('media.action.begin-artifact-upload')
    || !complete.actionIntentRefs?.includes('media.action.begin-artifact-upload')) errors.push('upload command intent must remain tied to the existing begin-upload action');
  const actionSlices = f.sourceDenominators.uiProductActions.exactOwnerReviewedSliceBindings;
  if (actionSlices?.resumeWorkflow?.join('|') !== [
    'media.operation-slice.inspect-upload', 'media.operation-slice.append-upload-chunk', 'media.operation-slice.complete-upload',
  ].join('|') || !actionSlices.boundary.includes('explicit-user-confirmation-before-append')) errors.push('resume action must be the exact guarded ordered workflow, without a new server operation');
  if (f.sourceDenominators.uiProductActions.explicitOperationIds['media.action.resume-artifact-upload'] !== 'media.operation.artifact-ingest') errors.push('PXD-029 family-level intent association must not be silently widened to wire equivalence');
  if (begin.stateBinding?.uploadSession?.startsWith('new-identity-enters-OPEN') !== true
    || append.stateBinding?.productLifecycle !== 'remains-RECEIVING; chunk-acknowledgement-does-not-enter-VERIFYING-or-AVAILABLE') errors.push('begin and append must not collapse upload-session progress into artifact availability');
  if (!complete.stateBinding?.transitionRefs?.includes('media-upload-and-artifact/T01')
    || !complete.stateBinding?.productLifecycle?.includes('VERIFYING-only')
    || !complete.stateBinding?.projectionLoss?.includes('are-not-AVAILABLE')) errors.push('completion must enter verification only and preserve unavailable artifact disposition');
  if (f.transition?.operationRefs?.join(',') !== 'media.operation-slice.complete-upload'
    || f.transition?.operationEdgeBounds?.acceptedEdge !== 'RECEIVING-to-VERIFYING-after-required-upload-bytes-and-SHA-256-are-verified'
    || f.transition?.operationEdgeBounds?.excludedEdges?.join(',') !== 'RECEIVING-to-REJECTED,RECEIVING-to-EXPIRED') errors.push('only the source-supported RECEIVING-to-VERIFYING edge may bind to completion');
  if (!f.actionBindings?.['media.operation-slice.inspect-upload']?.disposition?.startsWith('first-read-and-reconcile-step-in-ordered-resume-workflow;')
    || f.actionBindings?.['media.operation-slice.inspect-artifact']?.disposition !== 'exact-bounded-read-intent; no-bytes-rights-or-project-attachment') errors.push('inspection actions must remain bounded reads without mutation or access implications');
  if (!f.actionBindings?.['media.operation-slice.append-upload-chunk']?.disposition?.includes('explicit-user-confirmation')
    || !f.actionBindings?.['media.operation-slice.complete-upload']?.disposition?.includes('explicit-user-confirmation')
    || !f.actionBindings?.['media.operation-slice.append-upload-chunk']?.actionIntentRefs?.includes('media.action.resume-artifact-upload')
    || !f.actionBindings?.['media.operation-slice.complete-upload']?.actionIntentRefs?.includes('media.action.resume-artifact-upload')) errors.push('resume must be an explicitly guarded inspect-authorize-confirm-append-complete workflow');
  const uploadStateProjection = f.stateAdjudication?.machineDimensions?.find(item => item.machineId === 'media-upload-and-artifact')?.uploadSessionProjection;
  if (uploadStateProjection?.runtimeStates?.COMPLETED !== 'session-finalization-and-artifact-identity-observed; product-artifact-remains-VERIFYING-until-separate-required-disposition'
    || uploadStateProjection?.explicitNonMappings?.includes('UploadSession-COMPLETED-is-not-artifact-AVAILABLE') !== true) errors.push('upload COMPLETED must never imply product artifact AVAILABLE');
  const uploadDimension = f.stateAdjudication?.machineDimensions?.find(item => item.machineId === 'media-upload-and-artifact');
  if (Object.keys(uploadDimension?.acceptedBoundedMeanings ?? {}).sort().join(',') !== 'AVAILABLE,QUARANTINED,RECEIVING,REJECTED,VERIFYING'
    || uploadDimension?.boundedDecisionRef !== '.product-experience/decision-log.md#PXD-049'
    || uploadDimension?.remainingStateDisposition !== 'source-proposal-retained; only-RECEIVING-VERIFYING-AVAILABLE-QUARANTINED-REJECTED-meaning-guards-accepted-bounded-by-PXD-049') errors.push('bounded state decision must not accept unrelated lifecycle states');
  if (uploadDimension?.acceptedBoundedMeanings?.AVAILABLE !== 'all-applicable-verification-checks-currently-positive-for-the-exact-artifact-version-and-current-use-scope'
    || uploadDimension?.acceptedBoundedMeanings?.QUARANTINED !== 'required-evidence-is-missing-stale-unsupported-or-ambiguous; use-is-denied-pending-reconciliation'
    || uploadDimension?.acceptedBoundedMeanings?.REJECTED !== 'an-authoritative-format-security-rights-consent-or-policy-check-denied-the-artifact-or-intended-use') errors.push('state names must not be accepted without their exact bounded evidence meaning');
  const verification = f.verificationTransition;
  const verificationGate = uploadDimension?.verificationGate;
  if (verification?.ownerDecisionRef !== '.product-experience/decision-log.md#PXD-049'
    || verification?.operationRefs?.length !== 0
    || verification?.operationBinding !== 'no-existing-verification-operation-identity; definition-does-not-create-a-route-or-runtime-admission'
    || verification?.evidenceGuards?.subjectBinding !== 'exact-tenantId-artifactId-stable-opaque-immutable-versionId-byte-size-and-full-content-sha256-lowercase-64-hex-digits'
    || verificationGate?.runtimeAdmission !== 'NOT_ADMITTED') errors.push('verification semantics must be bounded definition only, with no invented operation or runtime admission');
  const requiredChecks = verification?.evidenceGuards?.requiredCheckRecords?.map(check => check.check).join('|');
  if (requiredChecks !== 'detected-format-and-format-policy|parser-and-security|rights-for-intended-use|consent-where-required|applicable-policy-and-retention'
    || verificationGate?.checkRecordFields?.join('|') !== 'tenantId|subjectArtifactId|subjectArtifactVersionId|byteSize|fullContentDigest|intendedUseOrNotApplicable|evaluatedPrincipalIdOrNotApplicable|checkKind|authorityRef|decision|observedAt|policyOrMethodVersion|evidenceRef|expiresAtOrNotApplicable'
    || verification?.evidenceGuards?.recordFields?.join('|') !== verificationGate?.checkRecordFields?.join('|')) errors.push('AVAILABLE must depend on exact-subject, source-authority check records for every required dimension');
  if (verification?.evidenceGuards?.requiredCheckRecords?.map(check => `${check.check}:${check.authority}`).join('|') !== [
    'detected-format-and-format-policy:existing-format-validation-and-policy-authority',
    'parser-and-security:existing-security-scanning-and-isolated-parser-policy',
    'rights-for-intended-use:existing-rights-authority',
    'consent-where-required:existing-tenant-and-principal-scoped-consent-authority',
    'applicable-policy-and-retention:existing-media-policy-and-retention-authority',
  ].join('|')) errors.push('verification cannot invent issuers or replace source-authority boundaries');
  const policyInputs = verificationGate?.policyCheckSourceRecords;
  const enforcementPoints = f.policyAuthority?.productPolicy?.enforcementPoints ?? [];
  if (!enforcementPoints.some(point => point.point === 'upload-and-import-admission' && point.requiredChecks.includes('detected-format'))
    || !enforcementPoints.some(point => point.point === 'artifact-fetch-and-cache-reuse' && point.requiredChecks.includes('current-rights'))
    || !f.qualificationPolicy?.securityAndRightsBaseline?.some(control => control.includes('validate detected formats'))
    || !f.privacyPolicy.includes('## 4. Consent requirements') || !f.privacyPolicy.includes('## 5. Retention and physical erasure')
    || policyInputs?.formatAndAdmission !== '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy.enforcementPoints[point=upload-and-import-admission]'
    || policyInputs?.currentAccessRightsAndConsent !== '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy.enforcementPoints[point=artifact-fetch-and-cache-reuse]') errors.push('T02 issuer and policy inputs must resolve to existing PDP-0/policy source records');
  if (verification?.evidenceGuards?.outcomeRules?.AVAILABLE !== 'all-applicable-records-current-positive-and-bound-to-the-same-exact-subject'
    || verification?.evidenceGuards?.outcomeRules?.VERIFYING !== 'required-check-running-or-awaiting-authoritative-result'
    || verification?.evidenceGuards?.outcomeRules?.QUARANTINED !== 'missing-stale-unsupported-ambiguous-or-unverifiable-evidence; deny-use-pending-reconciliation'
    || verification?.evidenceGuards?.outcomeRules?.REJECTED !== 'authoritative-format-security-rights-consent-or-policy-denial'
    || Object.hasOwn(verification?.evidenceGuards?.outcomeRules ?? {}, 'EXPIRED')
    || !verification?.evidenceGuards?.expiryBoundary?.startsWith('EXPIRED-is-outside-this-transition-and-requires-the-separate-authoritative-retention-lifecycle-disposition')) errors.push('T02 must not invent an EXPIRED edge; expiry belongs to the separate governed lifecycle disposition');
  if (verificationGate?.digestFormat !== 'sha256-lowercase-64-hex-digits; compared-as-full-digest-not-prefix-or-sampled-content'
    || !f.runtime.includes('MessageDigest.getInstance("SHA-256")')) errors.push('verification digest format must match the observed full SHA-256 implementation');
  const uploadSession = f.domainObjects?.find(item => item.id === 'media.domain.upload-session');
  const artifact = f.domainObjects?.find(item => item.id === 'media.domain.artifact');
  const artifactVersion = f.domainObjects?.find(item => item.id === 'media.domain.artifact-version');
  if (!uploadSession?.identity?.includes('(tenantId,uploadId)') || !uploadSession?.identity?.includes('(tenantId,principalId,idempotencyKey)')
    || !artifact?.identity?.includes('(tenantId,artifactId)')
    || !artifactVersion?.identity?.includes('(tenantId,artifactId,versionId)')
    || !artifactVersion?.identity?.includes('versionId-is-a-stable-opaque-immutable-version-identity-separate-from-content-digest')
    || !artifactVersion?.scopeStatus?.includes('runtime-NOT_ADMITTED')) errors.push('upload, artifact and version identities must be explicit, distinct, and not mistaken for observed runtime records');
  return errors;
}

test('three existing upload operations bind source identities to bounded version-1 owner definitions', () => {
  assert.deepEqual(validate(fixture()), []);
});

test('upload operation contracts reject false replay, finality, authority, and acceptance claims', () => {
  const mutations = [
    f => { f.operations.find(r => r.id.endsWith('.begin-upload')).ownerSemantics.replay.keyScope = ['tenantId', 'idempotencyKey']; },
    f => { f.operations.find(r => r.id.endsWith('.begin-upload')).ownerSemantics.replay.requestBinding = 'partial-upload-request-v1'; },
    f => { f.operations.find(r => r.id.endsWith('.append-upload-chunk')).ownerSemantics.unknownOutcome.automaticReplay = 'safe'; },
    f => { f.operations.find(r => r.id.endsWith('.complete-upload')).ownerSemantics.completionReplay.completedUpload = 'new-artifact-per-call'; },
    f => { f.operations.find(r => r.id.endsWith('.complete-upload')).ownerSemantics.completionReplay.payloadHashIdempotency = 'accepted'; },
    f => { f.operations.find(r => r.id.endsWith('.complete-upload')).ownerSemantics.reviewStatus = 'accepted'; },
    f => { f.operations.find(r => r.id.endsWith('.append-upload-chunk')).ownerSemantics.authority.rightsAndConsent = 'upload-grants-rights'; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.ok(validate(f).length > 0);
  }
});

test('source identity drift or invented completion key is not silently accepted as parity', () => {
  const f = fixture();
  f.openapi['/api/v1/artifacts/uploads/{uploadId}/complete'].post.operationId = 'completeByRequestKey';
  assert.ok(validate(f).some(error => error.includes('complete-upload OpenAPI identity')));
  const keyed = fixture();
  keyed.openapi['/api/v1/artifacts/uploads/{uploadId}/complete'].post.parameters.push({ name: 'Idempotency-Key' });
  assert.ok(validate(keyed).some(error => error.includes('bodyless completion')));
});

test('upload state, action and object bindings reject availability, rights and action-equivalence expansion', () => {
  const mutations = [
    f => { f.operations.find(r => r.id.endsWith('.complete-upload')).stateBinding.productLifecycle = 'COMPLETED-means-AVAILABLE'; },
    f => { f.operations.find(r => r.id.endsWith('.append-upload-chunk')).stateBinding.productLifecycle = 'chunk-ack-means-AVAILABLE'; },
    f => { f.transition.operationEdgeBounds.acceptedEdge = 'RECEIVING-to-AVAILABLE'; },
    f => { f.actionBindings['media.operation-slice.inspect-upload'].disposition = 'resume-upload-command'; },
    f => { f.stateAdjudication.machineDimensions.find(item => item.machineId === 'media-upload-and-artifact').uploadSessionProjection.explicitNonMappings = []; },
    f => { f.stateAdjudication.machineDimensions.find(item => item.machineId === 'media-upload-and-artifact').acceptedBoundedMeanings.AVAILABLE = 'upload-completed'; },
    f => { f.verificationTransition.evidenceGuards.outcomeRules.AVAILABLE = 'upload-completed'; },
    f => { f.verificationTransition.evidenceGuards.outcomeRules.EXPIRED = 'check-expired'; },
    f => { f.verificationTransition.evidenceGuards.subjectBinding = 'artifact-id-only'; },
    f => { f.verificationTransition.evidenceGuards.requiredCheckRecords.pop(); },
    f => { f.verificationTransition.evidenceGuards.requiredCheckRecords[2].authority = 'media-self-attestation'; },
    f => { f.verificationTransition.operationRefs.push('media.operation.verify-artifact'); },
    f => { f.domainObjects.find(item => item.id === 'media.domain.artifact').identity = 'artifactId-only'; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.ok(validate(f).length > 0);
  }
});
