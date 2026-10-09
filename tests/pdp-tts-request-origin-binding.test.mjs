import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeOwnerRequestSchemaDigest, computeTtsRequestDigests, computeTtsTargetSchemaDigest, validateTtsRequestOriginBinding } from '../scripts/lib/pdp-tts-request-origin-binding.mjs';
import { validateOwnerClosedJsonSchema, resolveEffectiveCapabilityWireSchemas } from '../scripts/lib/pdp-owner-leaf-wire-validation.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(resolve(process.cwd(), '../ghatana-tools/package.json'));
const yaml = require('yaml');
const operations = yaml.parse(readFileSync('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'));
const canonicalTtsOperation = operations.capabilityOperationContracts.records.find(
  (record) => record.id === 'media.operation.capability.media-speech-synthesis-text-to-speech',
);

const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const ref = (id) => `media://${id}/v1`;
const now = '2026-10-09T10:00:00.000Z';

function fixture({ speaker = false } = {}) {
  const request = {
    requestId: 'req-1',
    input1: { artifactType: 'text-or-speech-intent', payload: { kind: 'text', text: 'hello', locale: 'en-US' } },
    ...(speaker ? { input2: { artifactType: 'optional-authorized-speaker-reference', payload: {
      disposition: 'USER_CONFIRMED_REFERENCE', speakerRef: 'artifact://voice-1/v2',
      consentRef: 'consent://voice/v1', rightsEvidenceRefs: ['evidence://rights/2/v1'],
    } } } : {}),
    parameters: { outputProfileRef: 'profile://speech/default@v3', outputLanguage: 'en-US' },
  };
  const expected = {
    tenantId: 'tenant-1', principalId: 'principal-1', jobId: 'job-1', requestId: request.requestId,
    acceptedRequestSnapshotRef: 'snapshot://job-1/req-1/v1',
    readAuthorityRef: 'authority://job-read/v1', readVersion: 'job-read-v7',
    sourceReadAuthorityRef: 'authority://artifact-read/v2', sourceReadVersion: 'artifact-read-v9',
    sourceReadQueryId: 'speaker-resolver-query-1',
    outputReadAuthorityRef: 'authority://job-output-read/v1', outputReadVersion: 'output-read-v4',
    registrationReadAuthorityRef: 'authority://artifact-registration-read/v1', registrationReadVersion: 'registration-read-v2',
    maxObservationAgeMs: 30_000,
    regionRef: 'region://global', retentionPolicyRef: 'retention://voice-standard/v1',
    purposeRef: 'purpose://speech-synthesis', profileRef: request.parameters.outputProfileRef,
    profileVersion: '3', profileVersionRef: 'profile://speech/default/v3',
    targetSchemaDigest: computeTtsTargetSchemaDigest(), now,
  };
  const digests = computeTtsRequestDigests(request, expected);
  const source = speaker
    ? [{ slotId: 'input2', artifactId: 'voice-1', versionId: 'v2', sourceRef: 'artifact://voice-1/v2' }]
    : [];
  const dependencyVersionRefs = speaker ? [] : ['voice-model://default/model-v3'];
  const snapshot = {
    operationRef: 'media.operation.request-snapshot.inspect.v1', outcome: 'OBSERVED',
    acceptedRequestSnapshotRef: expected.acceptedRequestSnapshotRef, ...digests,
    targetOperationRef: 'media.operation.capability.media-speech-synthesis-text-to-speech',
    targetOperationVersion: 1, targetSchemaDigest: expected.targetSchemaDigest,
    capabilityRef: 'media.speech.synthesis.text-to-speech',
    profileRef: expected.profileRef, profileVersion: expected.profileVersion, profileVersionRef: expected.profileVersionRef,
    purposeRef: expected.purposeRef, tenantId: expected.tenantId, principalId: expected.principalId,
    jobId: expected.jobId, requestId: expected.requestId,
    readAuthorityRef: expected.readAuthorityRef, readVersion: expected.readVersion,
    sourceInputs: source, sourceVersionRefs: source.map((entry) => entry.sourceRef), dependencyVersionRefs,
    currentness: 'CURRENT', observedAt: now,
  };
  const authorizationPairs = ['VOICE_AUTHORIZATION', 'CONSENT'].map((decisionKind, index) => {
    const subjectArtifactVersionRef = source[0]?.sourceRef ?? dependencyVersionRefs[0];
    const row = {
      queryId: `rights-query-${index + 1}`, decisionKind, subjectArtifactVersionRef,
      purposeRef: expected.purposeRef, useRef: 'media.speech.synthesis.text-to-speech',
      regionRef: expected.regionRef, retentionPolicyRef: expected.retentionPolicyRef,
      readAuthorityRef: `authority://rights-read/${index + 1}`, readVersion: `rights-read-${index + 1}`,
      decisionAuthorityRef: `authority://decision/${index + 1}`,
      decisionAuthorityVersionRef: `authority://decision/${index + 1}/v1`,
      consentRef: decisionKind === 'CONSENT' ? 'consent://voice/v1' : undefined,
    };
    const queryFingerprintBody = {
      tenantId: expected.tenantId, principalId: expected.principalId, queryId: row.queryId,
      decisionKind, subjectArtifactVersionRef, purposeRef: row.purposeRef,
      useRef: row.useRef, regionRef: row.regionRef, retentionPolicyRef: row.retentionPolicyRef,
    };
    const requestFingerprint = sha(JSON.stringify(Object.fromEntries(Object.entries(queryFingerprintBody).sort(([a], [b]) => a.localeCompare(b)))));
    const observation = {
      operationRef: 'media.operation.action.inspect-consent-and-permitted-use', outcome: 'OBSERVED',
      queryId: row.queryId, decisionKind, subjectArtifactVersionRef, purposeRef: row.purposeRef,
      useRef: row.useRef, regionRef: row.regionRef, retentionPolicyRef: row.retentionPolicyRef,
      requestFingerprint,
      tenantId: expected.tenantId, principalId: expected.principalId, observationStatus: 'ALLOWED_FOR_DECLARED_SCOPE',
      readAuthorityRef: row.readAuthorityRef, readVersion: row.readVersion, currentness: 'CURRENT', observedAt: now,
      decision: {
        authorityRef: row.decisionAuthorityRef, authorityVersionRef: row.decisionAuthorityVersionRef,
        decisionKind, subjectArtifactVersionRef, purposeRef: row.purposeRef, useRef: row.useRef,
        regionRef: row.regionRef, retentionPolicyRef: row.retentionPolicyRef,
        effectDisposition: 'PERMITTED', validFrom: '2026-10-09T09:00:00.000Z', validUntil: '2026-10-09T11:00:00.000Z',
        evidenceRefs: [`evidence://rights/${index + 1}/v1`],
        ...(row.consentRef ? { consentRef: row.consentRef } : {}),
      },
    };
    return { observation, expected: row };
  });
  const authorizationObservations = authorizationPairs.map(({ observation }) => observation);
  expected.trustedAuthorizationObservations = authorizationPairs.map(({ expected: row }) => row);
  const sourceReadRequest = speaker
    ? { queryId: expected.sourceReadQueryId, speakerRef: request.input2.payload.speakerRef }
    : { queryId: expected.sourceReadQueryId, profileRef: expected.profileRef, profileVersionRef: expected.profileVersionRef };
  const sourceVersionReads = [{
    operationRef: speaker ? 'media.operation.speaker-reference.resolve-version.v1' : 'media.operation.voice-profile.resolve-source-version.v1', outcome: 'OBSERVED', observedAt: now,
    queryId: expected.sourceReadQueryId,
    tenantId: expected.tenantId, principalId: expected.principalId,
    readAuthorityRef: expected.sourceReadAuthorityRef, readVersion: expected.sourceReadVersion, currentness: 'CURRENT',
    request: sourceReadRequest,
    requestFingerprint: sha(JSON.stringify(Object.fromEntries(Object.entries({
      tenantId: expected.tenantId, principalId: expected.principalId, queryId: expected.sourceReadQueryId,
      ...(speaker ? { speakerRef: request.input2.payload.speakerRef } : { profileRef: expected.profileRef, profileVersionRef: expected.profileVersionRef }),
    }).sort(([a], [b]) => a.localeCompare(b))))),
    outputs: [{ artifactType: speaker ? 'authorized-artifact-version-summary' : 'governed-profile-voice-version', payload: speaker
      ? { speakerRef: 'artifact://voice-1/v2', sourceKind: 'GOVERNED_MEDIA_ARTIFACT_VERSION', artifactId: source[0].artifactId, versionId: source[0].versionId, sourceRef: source[0].sourceRef }
      : { profileRef: expected.profileRef, profileVersionRef: expected.profileVersionRef, sourceKind: 'VERSIONED_MODEL_DEPENDENCY', modelDependencyRef: 'voice-model://default', modelDependencyVersionRef: dependencyVersionRefs[0] },
    }],
  }];
  const binding = {
    originKind: speaker ? 'HYBRID' : 'GENERATED_FROM_REQUEST',
    acceptedRequestSnapshotRef: snapshot.acceptedRequestSnapshotRef,
    requestFingerprint: snapshot.requestFingerprint,
    targetOperationRef: snapshot.targetOperationRef, targetOperationVersion: 1,
    targetSchemaDigest: snapshot.targetSchemaDigest, capabilityRef: snapshot.capabilityRef,
    tenantId: expected.tenantId, principalId: expected.principalId, purposeRef: expected.purposeRef,
    profileRef: expected.profileRef, profileVersion: expected.profileVersion, profileVersionRef: expected.profileVersionRef,
    outputCandidateRef: 'candidate://job-1/attempt-1/output-1', outputDigest: sha('output-bytes'),
    originBindingRef: 'origin-binding://job-1/req-1/v1', sourceInputs: source, dependencyVersionRefs,
  };
  const { sourceInputs: _sourceInputs, ...outputBindingFields } = binding;
  expected.trustedProducedOutput = {
    currentness: 'CURRENT', jobId: expected.jobId, requestId: expected.requestId,
    tenantId: expected.tenantId, principalId: expected.principalId,
    requestFingerprint: snapshot.requestFingerprint, acceptedRequestSnapshotRef: snapshot.acceptedRequestSnapshotRef,
    targetOperationRef: snapshot.targetOperationRef, targetOperationVersion: 1, targetSchemaDigest: snapshot.targetSchemaDigest,
    profileRef: expected.profileRef, profileVersionRef: expected.profileVersionRef,
    outputCandidateRef: binding.outputCandidateRef, outputDigest: binding.outputDigest,
    observedAt: now, readAuthorityRef: expected.outputReadAuthorityRef, readVersion: expected.outputReadVersion,
  };
  const executionResult = {
    outcome: 'SUCCEEDED', observedAt: now, implementationState: 'UNKNOWN',
    qualificationState: 'NOT_EVALUATED', runtimeAvailability: 'UNKNOWN',
    outputs: [{ artifactType: 'speech-artifact-with-voice-rights-and-execution-provenance', payload: {
      ...outputBindingFields, jobId: expected.jobId, requestId: expected.requestId,
      sourceVersionRefs: binding.sourceInputs.map((entry) => entry.sourceRef),
      rightsEvidenceRefs: authorizationObservations.flatMap((entry) => entry.decision.evidenceRefs),
      consentRef: authorizationObservations.find((entry) => entry.decisionKind === 'CONSENT').decision.consentRef,
      retentionPolicyRef: expected.retentionPolicyRef,
    } }],
    provenance: {
      operationRef: 'media.operation.capability.media-speech-synthesis-text-to-speech', observedAt: now,
      sourceRefs: [snapshot.acceptedRequestSnapshotRef, ...binding.sourceInputs.map((entry) => entry.sourceRef), ...binding.dependencyVersionRefs],
      outputDigest: binding.outputDigest, originBindingRef: binding.originBindingRef,
      jobId: expected.jobId, requestId: expected.requestId, tenantId: expected.tenantId, principalId: expected.principalId,
      readAuthorityRef: expected.outputReadAuthorityRef, readVersion: expected.outputReadVersion, currentness: 'CURRENT',
    },
  };
  const registrationRequest = {
    operationRef: 'media.operation.artifact.output.register.v1', operationVersion: 1,
    requestId: request.requestId, candidateRef: binding.outputCandidateRef, expectedSha256: binding.outputDigest,
    mediaType: 'audio/mpeg', byteLength: 1024,
    sourceVersionRefs: binding.sourceInputs.map((entry) => entry.sourceRef), originBinding: binding,
    target: { workspaceRef: 'workspace://tenant-1/main/v1' },
    governance: {
      purposeRef: expected.purposeRef,
      rightsEvidenceRefs: authorizationObservations.flatMap((entry) => entry.decision.evidenceRefs),
      consentRef: authorizationObservations.find((entry) => entry.decisionKind === 'CONSENT').decision.consentRef,
      retentionPolicyRef: expected.retentionPolicyRef,
      policyDecisionRef: 'policy-decision://speech/v1',
    },
  };
  const registrationReceipt = {
    outcome: 'REGISTERED', requestId: request.requestId, candidateRef: binding.outputCandidateRef,
    expectedSha256: binding.outputDigest, artifactId: 'speech-1', versionId: 'v1',
    registrationReceiptRef: 'registration://speech-1/v1', originBindingRef: binding.originBindingRef,
    contentDigest: binding.outputDigest,
  };
  expected.trustedRegistrationReceipt = {
    currentness: 'CURRENT', readAuthorityRef: expected.registrationReadAuthorityRef,
    readVersion: expected.registrationReadVersion, observedAt: now,
    tenantId: expected.tenantId, principalId: expected.principalId, requestId: request.requestId,
    candidateRef: binding.outputCandidateRef, expectedSha256: binding.outputDigest,
    receipt: structuredClone(registrationReceipt),
  };
  return { request, expected, snapshot, sourceVersionReads, authorizationObservations, executionResult, originBinding: binding, registrationRequest, registrationReceipt };
}

test('TTS request origin binds canonical accepted request, producer result, registration and exact optional voice version', () => {
  for (const options of [{}, { speaker: true }]) {
    const args = fixture(options);
    const sourceQueryId = options.speaker
      ? 'media.operation.speaker-reference.resolve-version.v1'
      : 'media.operation.voice-profile.resolve-source-version.v1';
    const sourceQuery = operations.ownerDefinedOperationContracts.records.find((record) => record.id === sourceQueryId);
    assert.ok(sourceQuery, `${sourceQueryId} is a canonical owner query`);
    const sourceRequest = validateOwnerClosedJsonSchema(sourceQuery.requestSchema, args.sourceVersionReads[0].request, sourceQuery.requestSchema);
    assert.equal(sourceRequest.valid, true, JSON.stringify(sourceRequest));
    const { request: _request, ...sourceResultEnvelope } = args.sourceVersionReads[0];
    const sourceResult = validateOwnerClosedJsonSchema(sourceQuery.resultSchema, sourceResultEnvelope, sourceQuery.resultSchema);
    assert.equal(sourceResult.valid, true, JSON.stringify(sourceResult.errors));
    const schemaCheck = validateOwnerClosedJsonSchema(canonicalTtsOperation.resultSchema, args.executionResult, canonicalTtsOperation.resultSchema);
    assert.equal(schemaCheck.valid, true, JSON.stringify(schemaCheck.errors));
    const registrationOwner = operations.ownerDefinedOperationContracts.records.find((record) => record.id === 'media.operation.artifact.output.register.v1').ownerWireSchema;
    const registrationCheck = validateOwnerClosedJsonSchema(registrationOwner.requestSchema, args.registrationRequest, registrationOwner.requestSchema);
    assert.equal(registrationCheck.valid, true, JSON.stringify(registrationCheck.errors));
    const result = validateTtsRequestOriginBinding(args);
    assert.equal(result.status, 'VALID_DEFINITIONAL_BINDING', JSON.stringify(result));
  }
});

test('request digest is key-order independent and rejects sparse or non-JSON inputs', () => {
  const base = fixture();
  const reordered = { ...base.request, input1: { payload: { locale: 'en-US', text: 'hello', kind: 'text' }, artifactType: 'text-or-speech-intent' } };
  assert.deepEqual(computeTtsRequestDigests(base.request, base.expected), computeTtsRequestDigests(reordered, base.expected));
  const sparse = { ...base.request, parameters: { values: Array(2) } };
  assert.throws(() => computeTtsRequestDigests(sparse, base.expected), /Sparse arrays/);
  const nonJson = { ...base.request, parameters: { value: undefined } };
  assert.throws(() => computeTtsRequestDigests(nonJson, base.expected), /JSON request values/);
});

test('TTS helper accepts only requests admitted by the actual canonical operation schema', () => {
  assert.ok(canonicalTtsOperation, 'canonical TTS operation record exists');
  const effective = resolveEffectiveCapabilityWireSchemas(operations, 'media.speech.synthesis.text-to-speech');
  assert.equal(effective.valid, true);
  for (const args of [fixture(), fixture({ speaker: true })]) {
    const checked = validateOwnerClosedJsonSchema(effective.requestSchema, args.request, effective.requestSchema);
    assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  }
  const narrowed = fixture();
  narrowed.request.input2 = { artifactType: 'optional-authorized-speaker-reference', payload: { disposition: 'NOT_SELECTED', reasonRef: 'reason://ignored/v1' } };
  assert.equal(validateOwnerClosedJsonSchema(effective.requestSchema, narrowed.request, effective.requestSchema).valid, false,
    'the operation-specific NOT_SELECTED prohibition survives typed-registry composition');
  assert.notEqual(validateTtsRequestOriginBinding(narrowed).status, 'VALID_DEFINITIONAL_BINDING');
  const missingConsent = fixture({ speaker: true });
  delete missingConsent.request.input2.payload.consentRef;
  assert.equal(validateOwnerClosedJsonSchema(canonicalTtsOperation.requestSchema, missingConsent.request, canonicalTtsOperation.requestSchema).valid, false);
  const unknownField = fixture();
  unknownField.request.extra = true;
  assert.equal(validateOwnerClosedJsonSchema(canonicalTtsOperation.requestSchema, unknownField.request, canonicalTtsOperation.requestSchema).valid, false);
});

test('TTS target schema digest binds the exact schema, transitive definitions, and declared scalar formats', () => {
  const operationRef = canonicalTtsOperation.id;
  const sourceDigest = computeOwnerRequestSchemaDigest(operations, operationRef);
  assert.equal(sourceDigest, computeTtsTargetSchemaDigest());
  const changedDefinition = structuredClone(operations);
  const row = changedDefinition.capabilityOperationContracts.records.find((record) => record.id === operationRef);
  row.requestSchema.$defs = { requestId: { type: 'string', minLength: 1, maxLength: 128 } };
  row.requestSchema.properties.requestId = { $ref: '#/$defs/requestId' };
  const definitionDigest = computeOwnerRequestSchemaDigest(changedDefinition, operationRef);
  const secondDefinition = structuredClone(changedDefinition);
  secondDefinition.capabilityOperationContracts.records.find((record) => record.id === operationRef).requestSchema.$defs.requestId.maxLength = 127;
  assert.notEqual(definitionDigest, computeOwnerRequestSchemaDigest(secondDefinition, operationRef),
    'same request-schema $ref with changed referenced definition changes the digest');
  const changedScalarRecordOnly = structuredClone(operations);
  changedScalarRecordOnly.capabilityOperationContracts.scalarTypeRecords.find((record) => record.key === 'BCP-47-language-tag').validator.maxLength = 62;
  assert.throws(() => computeOwnerRequestSchemaDigest(changedScalarRecordOnly, operationRef), /map and record projection disagree/u,
    'a changed scalar record cannot be used while the validator map still has the old constraint');
  const changedScalarMapOnly = structuredClone(operations);
  changedScalarMapOnly.capabilityOperationContracts.scalarTypes['BCP-47-language-tag'].validator.maxLength = 62;
  assert.throws(() => computeOwnerRequestSchemaDigest(changedScalarMapOnly, operationRef), /map and record projection disagree/u,
    'the actual schema validator map cannot drift from the enumerated scalar record');
  const changedScalarBoth = structuredClone(operations);
  changedScalarBoth.capabilityOperationContracts.scalarTypes['BCP-47-language-tag'].validator.maxLength = 62;
  changedScalarBoth.capabilityOperationContracts.scalarTypeRecords.find((record) => record.key === 'BCP-47-language-tag').validator.maxLength = 62;
  assert.notEqual(sourceDigest, computeOwnerRequestSchemaDigest(changedScalarBoth, operationRef),
    'the exact scalar validator map and its record projection are both included in the schema digest');
  const changedInputRegistry = structuredClone(operations);
  const speakerSchema = changedInputRegistry.capabilityOperationContracts.inputPayloadSchemas.find((record) => record.id === 'media.typed-input.optional-authorized-speaker-reference');
  speakerSchema.schema.properties.payload.properties.reasonRef.maxLength = 200;
  assert.notEqual(sourceDigest, computeOwnerRequestSchemaDigest(changedInputRegistry, operationRef),
    'the selected effective request digest includes referenced typed input registry constraints');
  assert.throws(() => computeOwnerRequestSchemaDigest(operations, 'foreign.media.tts'), /exact owner request schema is unresolved/u);
});

test('TTS request helper preserves canonical locale, reference, and evidence collection bounds', () => {
  const invalidCases = [
    [() => { const value = fixture(); value.request.input1.payload.locale = `en-${'a'.repeat(61)}`; return value; }, 'input locale over 63 chars'],
    [() => { const value = fixture(); value.request.parameters.outputLanguage = `en-${'a'.repeat(61)}`; return value; }, 'output language over 63 chars'],
    [() => { const value = fixture({ speaker: true }); value.request.input2.payload.speakerRef = `artifact://${'a'.repeat(500)}/v1`; return value; }, 'speaker ref over 384 chars'],
    [() => { const value = fixture({ speaker: true }); value.request.input2.payload.consentRef = `consent://${'a'.repeat(500)}/v1`; return value; }, 'consent ref over 384 chars'],
    [() => { const value = fixture({ speaker: true }); value.request.input2.payload.rightsEvidenceRefs[0] = `evidence://${'a'.repeat(250)}`; return value; }, 'evidence ref over 256 chars'],
    [() => { const value = fixture({ speaker: true }); value.request.input2.payload.rightsEvidenceRefs.push(value.request.input2.payload.rightsEvidenceRefs[0]); return value; }, 'duplicate rights evidence refs'],
  ];
  for (const [make, label] of invalidCases) {
    const value = make();
    assert.equal(validateOwnerClosedJsonSchema(canonicalTtsOperation.requestSchema, value.request, canonicalTtsOperation.requestSchema).valid, false, label);
    assert.notEqual(validateTtsRequestOriginBinding(value).status, 'VALID_DEFINITIONAL_BINDING', label);
  }
  const keyOrder = fixture();
  keyOrder.expected.trustedProducedOutput = Object.fromEntries(Object.entries(keyOrder.expected.trustedProducedOutput).reverse());
  assert.equal(validateTtsRequestOriginBinding(keyOrder).status, 'VALID_DEFINITIONAL_BINDING', 'object field ordering does not alter tuple identity');
});

test('stale, future, foreign, malformed and caller-forged origin evidence fails closed', () => {
  const stale = fixture(); stale.snapshot.currentness = 'STALE';
  assert.equal(validateTtsRequestOriginBinding(stale).status, 'UNKNOWN');
  const future = fixture(); future.snapshot.observedAt = '2026-10-09T10:00:01.000Z';
  assert.equal(validateTtsRequestOriginBinding(future).status, 'UNKNOWN');
  const invalidDate = fixture(); invalidDate.snapshot.observedAt = '2026-02-30T10:00:00.000Z';
  assert.equal(validateTtsRequestOriginBinding(invalidDate).status, 'UNKNOWN');
  const foreign = fixture({ speaker: true }); foreign.sourceVersionReads[0].tenantId = 'tenant-foreign';
  assert.equal(validateTtsRequestOriginBinding(foreign).status, 'REJECTED');
  const badSource = fixture({ speaker: true }); badSource.sourceVersionReads[0].outputs[0].payload.versionId = 'v-other';
  assert.equal(validateTtsRequestOriginBinding(badSource).status, 'REJECTED');
  const forgedSourceRef = fixture({ speaker: true }); forgedSourceRef.request.input2.payload.sourceRef = 'artifact://foreign/v99';
  assert.equal(validateTtsRequestOriginBinding(forgedSourceRef).status, 'REJECTED');
  const openRequest = fixture(); openRequest.request.tenantId = 'caller-selected-tenant';
  assert.equal(validateTtsRequestOriginBinding(openRequest).status, 'REJECTED');
  const foreignSchema = fixture(); foreignSchema.expected.targetSchemaDigest = sha('foreign-schema');
  assert.equal(validateTtsRequestOriginBinding(foreignSchema).status, 'REJECTED', 'caller-supplied digest cannot replace the canonical target schema closure');
  const spoofedOutput = fixture(); spoofedOutput.expected.trustedProducedOutput.outputDigest = sha('other');
  assert.equal(validateTtsRequestOriginBinding(spoofedOutput).status, 'REJECTED');
  const noProducedOutput = fixture(); delete noProducedOutput.expected.trustedProducedOutput;
  const noOutputResult = validateTtsRequestOriginBinding(noProducedOutput);
  assert.equal(noOutputResult.status, 'UNKNOWN', JSON.stringify(noOutputResult));
  const wrongReceipt = fixture(); wrongReceipt.registrationReceipt.contentDigest = sha('different');
  assert.equal(validateTtsRequestOriginBinding(wrongReceipt).status, 'REJECTED');
});

test('registration receipt, rights evidence, consent scope, and bounded read freshness are exact joins', () => {
  for (const field of ['artifactId', 'versionId']) {
    const foreignReceipt = fixture();
    foreignReceipt.registrationReceipt[field] = `${foreignReceipt.registrationReceipt[field]}-foreign`;
    assert.equal(validateTtsRequestOriginBinding(foreignReceipt).status, 'REJECTED', field);
  }
  const unboundRights = fixture();
  delete unboundRights.executionResult.outputs[0].payload.rightsEvidenceRefs;
  assert.equal(validateTtsRequestOriginBinding(unboundRights).status, 'REJECTED');
  const foreignConsent = fixture();
  foreignConsent.executionResult.outputs[0].payload.consentRef = 'consent://foreign/v99';
  assert.equal(validateTtsRequestOriginBinding(foreignConsent).status, 'REJECTED');
  const oldButMarkedCurrent = fixture();
  oldButMarkedCurrent.snapshot.observedAt = '2020-01-01T00:00:00.000Z';
  assert.equal(validateTtsRequestOriginBinding(oldButMarkedCurrent).status, 'UNKNOWN');
  const staleRights = fixture();
  staleRights.authorizationObservations[0].observedAt = '2020-01-01T00:00:00.000Z';
  assert.equal(validateTtsRequestOriginBinding(staleRights).status, 'REJECTED');
  const incompleteTrustedQuery = fixture();
  delete incompleteTrustedQuery.expected.trustedAuthorizationObservations[0].queryId;
  delete incompleteTrustedQuery.authorizationObservations[0].queryId;
  const incompleteResult = validateTtsRequestOriginBinding(incompleteTrustedQuery);
  assert.notEqual(incompleteResult.status, 'VALID_DEFINITIONAL_BINDING', 'missing trusted and observed query IDs fail closed without throwing');
});
