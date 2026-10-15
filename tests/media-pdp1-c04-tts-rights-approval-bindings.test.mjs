import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/../ghatana-tools/package.json`);
const yaml = require('yaml');
const source = yaml.parse(fs.readFileSync('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'), { uniqueKeys: false });

const byId = (records, id) => {
  const record = records?.find((item) => item.id === id);
  assert.ok(record, `missing canonical record ${id}`);
  return record;
};
const normalize = (value) => {
  const parts = [];
  const visit = (node) => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(value);
  return parts.join(' ').replace(/\s+/g, ' ');
};
const contains = (value, fragment) => normalize(value).includes(fragment.replace(/\s+/g, ' '));

const tts = byId(source.capabilityOperationContracts.records, 'media.operation.capability.media-speech-synthesis-text-to-speech');
const origin = source.ownerDefinedTtsRequestOriginContract;
const typedRights = byId(source.ownerTypedObservationContracts.records, 'media.observation-contract.rights-decision.v1');
const rightsValidation = byId(source.ownerTypedObservationValidationRules.records, 'media.observation-validation.rights-decision.v1');
const commonCurrentRead = source.ownerTypedObservationValidationRules.commonCurrentReadValidation;

test('C04 TTS origin binds the exact request, profile and resolved voice versions', () => {
  assert.equal(origin.id, 'media.operation.tts-request-origin-binding.v1');
  assert.equal(origin.canonicalOperationRef, '.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=media.operation.capability.media-speech-synthesis-text-to-speech');
  assert.deepEqual(origin.sourceInputVersionRead.exactQueryRefs, [
    'media.operation.speaker-reference.resolve-version.v1',
    'media.operation.voice-profile.resolve-source-version.v1',
  ]);
  assert.deepEqual(origin.sourceInputVersionRead.requiredObservedOutputFields, ['artifactId', 'versionId', 'sourceRef']);
  assert.match(origin.sourceInputVersionRead.bindingRule, /immutable voice-model artifact\/version/);
  assert.match(origin.sourceInputVersionRead.bindingRule, /Missing,\s*ambiguous, mismatched, inaccessible, or stale reads are UNKNOWN/);
  assert.deepEqual(origin.observedSnapshotRequirements.trustedExpectedTuple, [
    'tenantId', 'principalId', 'jobId', 'requestId', 'readAuthorityRef', 'readVersion', 'maxObservationAgeMs',
  ]);
  assert.ok(origin.observedSnapshotRequirements.requiredObservedFields.includes('profileRef'));
  assert.ok(origin.observedSnapshotRequirements.requiredObservedFields.includes('profileVersionRef'));
  assert.match(origin.observedSnapshotRequirements.currentReadRule, /UNKNOWN_OBSERVATION, stale authority\/version, absent expected tuple/);

  assert.equal(tts.operationKind, 'COMMAND');
  assert.equal(tts.requestSchema.properties.input1.properties.artifactType.const, 'text-or-speech-intent');
  assert.ok(tts.requestSchema.required.includes('parameters'));
  assert.ok(tts.requestSchema.properties.parameters.required.includes('outputProfileRef'));
  assert.equal(tts.requestSchema.properties.parameters.properties.outputProfileRef.format, 'versioned-profile-reference');
  assert.ok(tts.resultSchema.required.includes('outputs'));
  assert.match(origin.producedOutputObservation.outputCandidateAndDigestSource, /exact successful owner operation result/);
  assert.match(origin.producedOutputObservation.unknownRule, /stale.*UNKNOWN and forbids registration/);
});

test('voice authorization and consent are exact scoped decisions with fail-closed currentness', () => {
  const request = typedRights.requestSchema;
  for (const field of ['queryId', 'subjectArtifactVersionRef', 'decisionKind', 'purposeRef', 'useRef', 'regionRef', 'retentionPolicyRef']) {
    assert.ok(request.required.includes(field), `typed decision request must require ${field}`);
  }
  assert.deepEqual(origin.effectAuthorizationObservation.requiredDecisionKinds, ['VOICE_AUTHORIZATION', 'CONSENT']);
  assert.deepEqual(origin.effectAuthorizationObservation.exactRequestTuple, [
    'tenantId', 'principalId', 'queryId', 'decisionKind', 'subjectArtifactVersionRef', 'purposeRef', 'useRef', 'regionRef', 'retentionPolicyRef',
  ]);
  assert.equal(origin.effectAuthorizationObservation.requiredUseRef, 'media.speech.synthesis.text-to-speech');
  assert.match(origin.effectAuthorizationObservation.voiceAuthorizationSubject, /exact resolved governed voice artifact version/);
  assert.match(origin.effectAuthorizationObservation.voiceAuthorizationSubject, /profileVersionRef alone is not the voice subject/);
  assert.match(origin.effectAuthorizationObservation.consentSubject, /exact user-selected voice artifact version/);
  assert.match(origin.effectAuthorizationObservation.requiredDecision, /ALLOWED_FOR_DECLARED_SCOPE/);
  assert.match(origin.effectAuthorizationObservation.requiredDecision, /exact issuer authority\/version/);
  assert.match(origin.effectAuthorizationObservation.validity, /validFrom <= trustedNow < validUntil/);
  assert.match(origin.effectAuthorizationObservation.trustedExpectedRows, /never caller assertions/);
  assert.match(origin.effectAuthorizationObservation.resultBinding, /rightsEvidenceRefs equals the unique evidence refs/);
  assert.match(origin.effectAuthorizationObservation.resultBinding, /consentRef equals the exact current consent decision record/);
  assert.match(origin.effectAuthorizationObservation.failure, /absent, UNKNOWN, denied, restricted, expired, revoked, stale/);

  const validationText = rightsValidation.predicates;
  assert.ok(contains(validationText, 'request and decision\n            subjectArtifactVersionRef/purposeRef/useRef/regionRef/retentionPolicyRef\n            exactly equal'));
  assert.ok(contains(commonCurrentRead, 'result requestFingerprint equals server-computed fingerprint'));
  assert.ok(contains(commonCurrentRead, 'cannot satisfy a positive, permission, qualification or completeness predicate'));
  assert.ok(contains(validationText, 'decision absent'));
});

test('C04 request snapshot and voice reads preserve exact selected input, language, profile and purpose', () => {
  const parameters = tts.requestSchema.properties.parameters;
  assert.ok(tts.requestSchema.required.includes('parameters'));
  assert.ok(parameters.required.includes('outputProfileRef'));
  assert.equal(parameters.properties.outputProfileRef.format, 'versioned-profile-reference');
  assert.equal(parameters.properties.outputLanguage.format, 'bcp47-language-tag');
  assert.equal(origin.requestDigestDefinition.typedInputDigest, 'sha256(canonicalJson({input1, optional-input2}))');
  assert.equal(origin.requestDigestDefinition.parameterDigest, 'sha256(canonicalJson(parameters))');
  assert.match(origin.requestDigestDefinition.requestFingerprint, /purposeRef[\s\S]*profileRef[\s\S]*profileVersionRef[\s\S]*typedInputDigest[\s\S]*parameterDigest/u);
  for (const field of ['purposeRef', 'profileRef', 'profileVersion', 'profileVersionRef', 'typedInputDigest', 'parameterDigest']) {
    assert.ok(origin.observedSnapshotRequirements.requiredObservedFields.includes(field), `accepted snapshot binds ${field}`);
  }

  const sourceRead = origin.sourceInputVersionRead;
  assert.deepEqual(sourceRead.exactQueryRefs, [
    'media.operation.speaker-reference.resolve-version.v1',
    'media.operation.voice-profile.resolve-source-version.v1',
  ]);
  assert.deepEqual(sourceRead.requiredObservedOutputFields, ['artifactId', 'versionId', 'sourceRef']);
  const expectedVoiceRevision = { artifactId: 'voice-model-04', versionId: 'voice-revision-7', sourceRef: 'voice-model-04@version-7' };
  for (const field of sourceRead.requiredObservedOutputFields) {
    assert.ok(expectedVoiceRevision[field], `resolved voice read supplies exact ${field}`);
  }
  assert.match(sourceRead.bindingRule, /one trusted immutable voice-model artifact\/version and canonical sourceRef/u);
  assert.match(sourceRead.bindingRule, /caller cannot manufacture sourceRef/u);

  const authorization = origin.effectAuthorizationObservation;
  assert.deepEqual(authorization.exactRequestTuple, [
    'tenantId', 'principalId', 'queryId', 'decisionKind', 'subjectArtifactVersionRef', 'purposeRef', 'useRef', 'regionRef', 'retentionPolicyRef',
  ]);
  assert.equal(authorization.requiredUseRef, 'media.speech.synthesis.text-to-speech');
  assert.match(authorization.resultBinding, /rightsEvidenceRefs equals the unique evidence refs/u);
  assert.match(authorization.resultBinding, /consentRef equals the exact current consent decision record/u);
});

test('C04 stale or unknown rights and consent cannot satisfy the synthesis effect gate', () => {
  const authorization = origin.effectAuthorizationObservation;
  const expected = {
    tenantId: 'tenant-c04', principalId: 'principal-c04', purposeRef: 'purpose-c04',
    subjectArtifactVersionRef: 'voice-model-04@version-7', useRef: authorization.requiredUseRef,
    regionRef: 'region-c04', retentionPolicyRef: 'retention-c04',
  };
  const currentDecision = (decisionKind) => ({
    ...expected, queryId: `query-${decisionKind}`, decisionKind,
    subjectArtifactVersionRef: expected.subjectArtifactVersionRef,
    currentness: 'CURRENT', observationStatus: 'ALLOWED_FOR_DECLARED_SCOPE',
    effectDisposition: 'PERMITTED', issuerAuthorityRef: 'authority-version-c04',
    evidenceRef: `evidence-${decisionKind}`,
  });
  const permitsSynthesis = (rows) => authorization.requiredDecisionKinds.every((kind) => {
    const rowsForKind = rows.filter((row) => row.decisionKind === kind);
    return rowsForKind.length === 1 && authorization.exactRequestTuple.every((field) =>
      expected[field] === undefined ? rowsForKind[0][field] != null : rowsForKind[0][field] === expected[field])
      && rowsForKind[0].currentness === 'CURRENT'
      && rowsForKind[0].observationStatus === 'ALLOWED_FOR_DECLARED_SCOPE'
      && rowsForKind[0].effectDisposition === 'PERMITTED'
      && rowsForKind[0].issuerAuthorityRef != null;
  });
  const currentRows = authorization.requiredDecisionKinds.map(currentDecision);
  assert.equal(permitsSynthesis(currentRows), true, 'only the exact current positive decision pair satisfies the definition gate');

  for (const [kind, field, value] of [
    ['VOICE_AUTHORIZATION', 'currentness', 'STALE'],
    ['VOICE_AUTHORIZATION', 'observationStatus', 'UNKNOWN'],
    ['CONSENT', 'currentness', 'UNKNOWN'],
    ['CONSENT', 'observationStatus', 'UNKNOWN'],
    ['VOICE_AUTHORIZATION', 'subjectArtifactVersionRef', 'voice-model-04@version-8'],
    ['CONSENT', 'purposeRef', 'substituted-purpose'],
    ['CONSENT', 'useRef', 'media.speech.synthesis.other-use'],
    ['CONSENT', 'regionRef', 'substituted-region'],
    ['CONSENT', 'retentionPolicyRef', 'substituted-retention'],
  ]) {
    const rows = structuredClone(currentRows);
    rows.find((row) => row.decisionKind === kind)[field] = value;
    assert.equal(permitsSynthesis(rows), false, `${kind}.${field}=${value} cannot authorize synthesis`);
  }
  assert.match(authorization.failure, /absent, UNKNOWN, denied, restricted, expired, revoked, stale, malformed, or mismatched decision forbids output registration/u);
});

test('human approval is a read-only observation of the exact registered immutable output version', () => {
  const approvalRequest = typedRights.requestSchema.allOf.find((rule) => rule.if?.properties?.decisionKind?.const === 'HUMAN_REVIEW_APPROVAL');
  assert.ok(approvalRequest, 'approval request must have a decision-kind-specific exact version rule');
  assert.equal(approvalRequest.then.properties.subjectArtifactVersionRef.type, 'CanonicalObjectReference');
  assert.deepEqual(approvalRequest.then.properties.subjectArtifactVersionRef.allowedObjectRefs, ['media.domain.artifact-version']);
  assert.match(approvalRequest.then.properties.subjectArtifactVersionRef.versionRule, /exact owner-confirmed registered output ArtifactVersionRef required/);

  assert.match(origin.outputRegistrationReceiptObservation.currentnessRule, /independently read/);
  for (const field of ['requestId', 'candidateRef', 'expectedSha256', 'artifactId', 'versionId', 'registrationReceiptRef', 'originBindingRef', 'contentDigest', 'readAuthorityRef', 'readVersion']) {
    assert.ok(origin.outputRegistrationReceiptObservation.trustedExpectedTuple.includes(field), `receipt tuple must bind ${field}`);
  }
  assert.match(origin.outputRegistrationReceiptObservation.mismatch, /UNKNOWN_NO_SUCCESSFUL_OUTPUT_CLAIM/);

  const approvedRule = typedRights.resultSchema.allOf.find((rule) => rule.if?.properties?.observationStatus?.const === 'APPROVED');
  assert.ok(approvedRule, 'APPROVED must be conditionally constrained');
  const approvedGate = typedRights.resultSchema.allOf.find((rule) => rule.if?.properties?.decisionKind?.const === 'HUMAN_REVIEW_APPROVAL' && rule.if?.properties?.observationStatus?.const === 'APPROVED' && rule.if?.properties?.currentness?.const === 'CURRENT');
  assert.ok(approvedGate);
  assert.equal(approvedGate.then.properties.decision.properties.approvalStatus.const, 'APPROVED');
  assert.equal(approvedGate.then.properties.decision.properties.effectDisposition.const, 'APPROVED');
  assert.ok(contains(rightsValidation.predicates, 'owner-confirmed registered output ArtifactVersionRef'));
  assert.ok(contains(typedRights.resultRules, 'query never creates or changes approval') || contains(typedRights.resultRules, 'query never performs it'));
  assert.ok(contains(typedRights.resultRules, 'STALE or UNKNOWN currentness yields observationStatus UNKNOWN with unknownReasonRef and no decision'));
  assert.ok(contains(typedRights.resultRules, 'stale evidence never supports APPROVED'));
});
