import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateOwnerClosedJsonSchema, resolveEffectiveCapabilityWireSchemas } from './pdp-owner-leaf-wire-validation.mjs';

const require = createRequire(resolve(process.cwd(), '../ghatana-tools/package.json'));
const yaml = require('yaml');
const operationSource = yaml.parse(readFileSync(resolve(process.cwd(), '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8'));
const ttsOperationSchema = operationSource.capabilityOperationContracts.records.find((record) => record.id === 'media.operation.capability.media-speech-synthesis-text-to-speech');
const outputRegistrationSchema = operationSource.ownerDefinedOperationContracts.records.find((record) => record.id === 'media.operation.artifact.output.register.v1')?.ownerWireSchema;
const ttsOriginSchema = operationSource.ownerDefinedTtsRequestOriginContract?.outputOriginSchema;

const TTS_OPERATION_REF = 'media.operation.capability.media-speech-synthesis-text-to-speech';
const TTS_CAPABILITY_REF = 'media.speech.synthesis.text-to-speech';
const SNAPSHOT_OPERATION_REF = 'media.operation.request-snapshot.inspect.v1';
const TTS_REQUEST_SCHEMA_REF = '.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=media.operation.capability.media-speech-synthesis-text-to-speech/requestSchema';
const SHA256 = /^sha256:[a-f0-9]{64}$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const same = (left, right) => {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
};
const canonicalInstant = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;

function currentObservation(observation, expected, { authorityRef, readVersion, observedAt } = {}) {
  const maxAgeMs = expected?.maxObservationAgeMs;
  return observation?.currentness === 'CURRENT'
    && nonblank(authorityRef) && observation.readAuthorityRef === authorityRef
    && nonblank(readVersion) && observation.readVersion === readVersion
    && canonicalInstant(observedAt) && canonicalInstant(expected.now)
    && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 300_000
    && Date.parse(observedAt) <= Date.parse(expected.now)
    && Date.parse(expected.now) - Date.parse(observedAt) <= maxAgeMs;
}

const sha256 = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite values are not JSON request values.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const values = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError('Sparse arrays are not accepted in canonical request values.');
      values.push(canonicalJson(value[index]));
    }
    return `[${values.join(',')}]`;
  }
  if (!isRecord(value)) throw new TypeError('Only JSON request values are accepted.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Only plain JSON objects are accepted.');
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function pointerValue(root, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('#/')) throw new TypeError(`Unsupported owner schema ref: ${pointer}`);
  return pointer.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((value, part) => value?.[part], root);
}

function collectSchemaClosure(schema) {
  const definitions = new Map();
  const visited = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (!visited.has(ref)) {
        visited.add(ref);
        const target = pointerValue(schema, ref);
        if (!target || typeof target !== 'object') throw new TypeError(`Unresolved owner schema ref: ${ref}`);
        definitions.set(ref, target);
        visit(target);
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);
  return Object.fromEntries([...definitions.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function schemaFormats(schema) {
  const formats = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.format === 'string') formats.add(node.format);
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);
  return [...formats].sort();
}

function scalarDefinitionClosure(source, schema) {
  const scalarTypes = source?.capabilityOperationContracts?.scalarTypes;
  const scalarRows = source?.capabilityOperationContracts?.scalarTypeRecords;
  if (!isRecord(scalarTypes) || !Array.isArray(scalarRows)) {
    throw new TypeError('The canonical scalar validator map and record projection are required.');
  }
  const keys = new Set();
  for (const format of schemaFormats(schema)) {
    const matches = Object.entries(scalarTypes).filter(([, definition]) => definition?.validator?.format === format);
    if (matches.length === 0) throw new TypeError(`Owner request format ${format} does not resolve to the validator map.`);
    for (const [key] of matches) keys.add(key);
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (Object.hasOwn(node, 'scalarTypeRef')) {
      const ref = node.scalarTypeRef;
      const match = typeof ref === 'string'
        && /^\.product-experience\/pdp-1-domain-data\/operations\.yaml#capabilityOperationContracts\/scalarTypes\/([^/]+)$/u.exec(ref);
      if (!match) throw new TypeError(`Unsupported canonical scalarTypeRef: ${String(ref)}`);
      keys.add(match[1]);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);

  return [...keys].sort().map((key) => {
    const mapped = scalarTypes[key];
    const rows = scalarRows.filter((row) => row?.key === key);
    // `scalarTypes` is the map consumed by the owner-leaf AJV validator, while
    // `scalarTypeRecords` is the normative/readable projection. They must agree
    // on the executable validator. Some map entries intentionally omit the
    // record-only executionRule metadata, so absence there is not a mismatch;
    // both complete objects are still included in the closure digest below.
    if (!isRecord(mapped) || rows.length !== 1 || !same(mapped.validator, rows[0].validator)
      || (mapped.executionRule !== undefined && rows[0].executionRule !== undefined
        && mapped.executionRule !== rows[0].executionRule)) {
      throw new TypeError(`Canonical scalar validator map and record projection disagree for ${key}.`);
    }
    return { key, validatorMapDefinition: mapped, scalarTypeRecord: rows[0] };
  });
}

export function computeOwnerRequestSchemaDigest(source, operationRef, selectedCapabilityRef = undefined) {
  const records = source?.capabilityOperationContracts?.records ?? [];
  const matches = records.filter((row) => row.id === operationRef);
  if (matches.length !== 1 || !matches[0].requestSchema) throw new TypeError('The exact owner request schema is unresolved.');
  const row = matches[0];
  if (!nonblank(row.capabilityRef) || (selectedCapabilityRef !== undefined && selectedCapabilityRef !== row.capabilityRef)) {
    throw new TypeError('The exact capability request binding is unresolved.');
  }
  const effective = resolveEffectiveCapabilityWireSchemas(source, selectedCapabilityRef ?? row.capabilityRef);
  if (!effective.valid || effective.operation !== row || !effective.requestSchema) {
    throw new TypeError('The exact effective owner request schema is unresolved.');
  }
  return computeSelectedOwnerRequestSchemaDigest(source, {
    operationRef: row.id,
    capabilityRef: row.capabilityRef,
    operationVersion: row.operationVersion ?? 1,
    requestSchema: effective.requestSchema,
    requestSchemaRef: `${TTS_REQUEST_SCHEMA_REF.split('#')[0]}#capabilityOperationContracts/records/@id=${operationRef}/effectiveRequestSchema`,
    inputSlots: row.inputSlots ?? [],
  });
}

/** Compute the cross-phase targetSchemaDigest for one already-resolved exact owner request schema. */
export function computeSelectedOwnerRequestSchemaDigest(source, {
  operationRef, capabilityRef, operationVersion, requestSchema, requestSchemaRef, inputSlots = [],
} = {}) {
  if (!nonblank(operationRef) || !nonblank(capabilityRef) || !Number.isSafeInteger(operationVersion)
    || operationVersion < 1 || !isRecord(requestSchema) || !nonblank(requestSchemaRef) || !Array.isArray(inputSlots)) {
    throw new TypeError('The selected owner request-schema closure tuple is incomplete.');
  }
  const schema = requestSchema;
  const scalarTypes = scalarDefinitionClosure(source, schema);
  return sha256(canonicalJson({
    sourceRef: requestSchemaRef,
    operationRef,
    capabilityRef,
    operationVersion,
    requestSchema: schema,
    inputSlots,
    referencedDefinitions: collectSchemaClosure(schema),
    scalarTypes,
  }));
}

/** Digest an exact owner-defined schema closure, including scalar format contracts. */
export function computeOwnerSchemaClosureDigest(source, operationRef, schema, selector) {
  if (!isRecord(schema) || typeof selector !== "string" || !selector) throw new TypeError("The exact owner schema closure is unresolved.");
  const scalarTypes = scalarDefinitionClosure(source, schema);
  const matches = (source?.capabilityOperationContracts?.records ?? []).filter((row) => row.id === operationRef);
  if (matches.length !== 1) throw new TypeError("The exact owner operation is unresolved.");
  const row = matches[0];
  return sha256(canonicalJson({
    sourceRef: TTS_REQUEST_SCHEMA_REF.split("#")[0] + "#capabilityOperationContracts/records/@id=" + operationRef + "/" + selector,
    operationRef: row.id,
    operationVersion: row.operationVersion ?? 1,
    schema,
    referencedDefinitions: collectSchemaClosure(schema),
    scalarTypes,
  }));
}

export function computeTtsTargetSchemaDigest() {
  return computeOwnerRequestSchemaDigest(operationSource, TTS_OPERATION_REF);
}

function expectedRequestDigests(request, expected, profile) {
  const typedInputDigest = sha256(canonicalJson({ input1: request.input1, ...(request.input2 === undefined ? {} : { input2: request.input2 }) }));
  const parameterDigest = sha256(canonicalJson(request.parameters));
  const requestFingerprint = sha256(canonicalJson({
    tenantId: expected.tenantId,
    principalId: expected.principalId,
    jobId: expected.jobId,
    requestId: request.requestId,
    purposeRef: expected.purposeRef,
    capabilityRef: TTS_CAPABILITY_REF,
    targetOperationRef: TTS_OPERATION_REF,
    targetOperationVersion: 1,
    targetSchemaDigest: computeTtsTargetSchemaDigest(),
    profileRef: profile.profileRef,
    profileVersion: profile.profileVersion,
    profileVersionRef: profile.profileVersionRef,
    typedInputDigest,
    parameterDigest,
  }));
  return { typedInputDigest, parameterDigest, requestFingerprint };
}

export function computeTtsRequestDigests(request, expected) {
  const profile = {
    profileRef: request?.parameters?.outputProfileRef,
    profileVersion: expected?.profileVersion,
    profileVersionRef: expected?.profileVersionRef,
  };
  return expectedRequestDigests(request, expected, profile);
}

function unknown(reason) {
  return { status: 'UNKNOWN', reason };
}

function rejected(reason) {
  return { status: 'REJECTED', reason };
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validTtsRequest(request) {
  const effective = resolveEffectiveCapabilityWireSchemas(operationSource, TTS_CAPABILITY_REF);
  if (!ttsOperationSchema?.requestSchema || !effective.valid
    || !validateOwnerClosedJsonSchema(effective.requestSchema, request, effective.requestSchema).valid) return false;
  if (!hasOnlyKeys(request, ['requestId', 'input1', 'input2', 'parameters'])
    || !nonblank(request.requestId) || request.requestId.length > 128
    || !hasOnlyKeys(request.input1, ['artifactType', 'payload'])
    || request.input1.artifactType !== 'text-or-speech-intent'
    || !hasOnlyKeys(request.input1.payload, ['kind', 'text', 'locale', 'constraints'])
    || !['text', 'speech-intent'].includes(request.input1.payload.kind)
    || !nonblank(request.input1.payload.text) || request.input1.payload.text.length > 4096
    || (request.input1.payload.locale !== undefined && (typeof request.input1.payload.locale !== 'string' || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(request.input1.payload.locale)))
    || (request.input1.payload.constraints !== undefined && (!Array.isArray(request.input1.payload.constraints)
      || request.input1.payload.constraints.length > 32
      || request.input1.payload.constraints.some((value) => typeof value !== 'string' || value.length > 512)))
    || !hasOnlyKeys(request.parameters, ['outputProfileRef', 'outputLanguage'])
    || !nonblank(request.parameters.outputProfileRef) || request.parameters.outputProfileRef.length > 384
    || (request.parameters.outputLanguage !== undefined && (typeof request.parameters.outputLanguage !== 'string' || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(request.parameters.outputLanguage)))) return false;
  if (request.input2 !== undefined) {
    const payload = request.input2?.payload;
    if (!hasOnlyKeys(request.input2, ['artifactType', 'payload'])
      || request.input2.artifactType !== 'optional-authorized-speaker-reference'
      || !hasOnlyKeys(payload, ['disposition', 'speakerRef', 'consentRef', 'rightsEvidenceRefs', 'reasonRef'])) return false;
    if (payload.disposition === 'NOT_SELECTED') {
      if (['speakerRef', 'consentRef', 'rightsEvidenceRefs', 'reasonRef'].some((key) => Object.hasOwn(payload, key))) return false;
    } else if (payload.disposition === 'NOT_APPLICABLE') {
      if (!nonblank(payload.reasonRef) || ['speakerRef', 'consentRef', 'rightsEvidenceRefs'].some((key) => Object.hasOwn(payload, key))) return false;
    } else if (payload.disposition === 'USER_CONFIRMED_REFERENCE') {
      if (!nonblank(payload.speakerRef) || !nonblank(payload.consentRef)
        || !Array.isArray(payload.rightsEvidenceRefs) || payload.rightsEvidenceRefs.length < 1
        || payload.rightsEvidenceRefs.length > 32 || payload.rightsEvidenceRefs.some((ref) => !nonblank(ref))) return false;
    } else return false;
  }
  return true;
}

function exactSnapshotTuple(snapshot, expected, request, profile) {
  const mustMatch = {
    acceptedRequestSnapshotRef: expected.acceptedRequestSnapshotRef,
    requestFingerprint: expected.requestFingerprint,
    targetOperationRef: TTS_OPERATION_REF,
    targetOperationVersion: 1,
    targetSchemaDigest: expected.targetSchemaDigest,
    capabilityRef: TTS_CAPABILITY_REF,
    profileRef: profile.profileRef,
    profileVersion: profile.profileVersion,
    profileVersionRef: profile.profileVersionRef,
    purposeRef: expected.purposeRef,
    tenantId: expected.tenantId,
    principalId: expected.principalId,
    jobId: expected.jobId,
    requestId: request.requestId,
    typedInputDigest: expected.typedInputDigest,
    parameterDigest: expected.parameterDigest,
    readAuthorityRef: expected.readAuthorityRef,
    readVersion: expected.readVersion,
  };
  return Object.entries(mustMatch).filter(([key, value]) => snapshot[key] !== value).map(([key]) => key);
}

function validateSnapshot(snapshot, expected, request, profile) {
  if (!isRecord(snapshot) || snapshot.operationRef !== SNAPSHOT_OPERATION_REF) {
    return unknown('The exact request-snapshot query result is unavailable.');
  }
  if (snapshot.outcome !== 'OBSERVED') return unknown('The accepted request snapshot is not authoritatively observed.');
  if (!nonblank(expected?.tenantId) || !nonblank(expected?.principalId) || !nonblank(expected?.jobId)
    || !nonblank(expected?.requestId) || !nonblank(expected?.readAuthorityRef)
    || !nonblank(expected?.readVersion)) {
    return unknown('The trusted expected request-snapshot tuple is incomplete.');
  }
  if (!SHA256.test(snapshot.requestFingerprint ?? '') || !SHA256.test(snapshot.targetSchemaDigest ?? '')
    || !SHA256.test(snapshot.typedInputDigest ?? '') || !SHA256.test(snapshot.parameterDigest ?? '')) {
    return unknown('The current request snapshot omits a canonical digest.');
  }
  if (!nonblank(snapshot.acceptedRequestSnapshotRef) || !nonblank(snapshot.profileVersionRef)
    || !nonblank(snapshot.purposeRef) || !nonblank(snapshot.readAuthorityRef)
    || !nonblank(snapshot.readVersion)
    || snapshot.currentness !== 'CURRENT' || !canonicalInstant(snapshot.observedAt)
    || !currentObservation(snapshot, expected, {
      authorityRef: expected.readAuthorityRef,
      readVersion: expected.readVersion,
      observedAt: snapshot.observedAt,
    })) {
    return unknown('The request-snapshot observation is incomplete or malformed.');
  }
  const mismatches = exactSnapshotTuple(snapshot, expected, request, profile);
  if (mismatches.length) {
    return rejected(`The request snapshot differs from the trusted tuple at: ${mismatches.join(', ')}.`);
  }
  return null;
}

function validateSourceReads(request, snapshot, expected, reads) {
  const input = request.input2?.payload;
  const snapshotSources = snapshot.sourceInputs;
  const selectedSpeaker = input?.disposition === 'USER_CONFIRMED_REFERENCE';
  const expectedOperation = selectedSpeaker
    ? 'media.operation.speaker-reference.resolve-version.v1'
    : 'media.operation.voice-profile.resolve-source-version.v1';
  const expectedReference = selectedSpeaker ? input.speakerRef : expected.profileVersionRef;
  if (!nonblank(expectedReference)) return rejected('The selected speaker/profile version is not exact.');
  if (!Array.isArray(reads) || reads.length !== 1) return unknown('The speaker source lacks exactly one trusted version observation.');
  const read = reads[0];
  const trusted = read;
  const queryContract = operationSource.ownerDefinedOperationContracts.records.find((record) => record.id === expectedOperation);
  if (!isRecord(read) || !queryContract || !isRecord(read.request)) return rejected('The source-version query contract or closed request is unavailable.');
  const requestSchemaResult = validateOwnerClosedJsonSchema(queryContract.requestSchema, read.request, queryContract.requestSchema);
  const { request: _request, ...resultEnvelope } = read;
  const resultSchemaResult = validateOwnerClosedJsonSchema(queryContract.resultSchema, resultEnvelope, queryContract.resultSchema);
  if (!requestSchemaResult.valid || !resultSchemaResult.valid) return rejected('The source-version query does not match its canonical closed request/result schema.');
  if (read.operationRef !== expectedOperation
    || read.outcome !== 'OBSERVED' || !Array.isArray(read.outputs) || read.outputs.length !== 1) {
    return unknown('The exact speaker/profile source query did not return one observed result.');
  }
  if (!isRecord(trusted) || trusted.tenantId !== expected.tenantId || trusted.principalId !== expected.principalId
    || trusted.readAuthorityRef !== expected.sourceReadAuthorityRef
    || trusted.readVersion !== expected.sourceReadVersion
    || !nonblank(expected.sourceReadVersion) || !nonblank(expected.sourceReadAuthorityRef)
    || !currentObservation(trusted, expected, {
      authorityRef: expected.sourceReadAuthorityRef,
      readVersion: expected.sourceReadVersion,
      observedAt: trusted.observedAt,
    })) {
    return rejected('The speaker version observation is foreign or does not match the trusted read tuple.');
  }
  const queryId = expected.sourceReadQueryId;
  const requestMatches = selectedSpeaker
    ? read.request?.speakerRef === expectedReference
    : read.request?.profileRef === expected.profileRef && read.request?.profileVersionRef === expectedReference;
  const fingerprintRequest = selectedSpeaker
    ? { tenantId: expected.tenantId, principalId: expected.principalId, queryId, speakerRef: expectedReference }
    : { tenantId: expected.tenantId, principalId: expected.principalId, queryId, profileRef: expected.profileRef, profileVersionRef: expectedReference };
  if (!nonblank(queryId) || read.queryId !== queryId || read.request?.queryId !== queryId
    || read.tenantId !== expected.tenantId || read.principalId !== expected.principalId
    || read.readAuthorityRef !== expected.sourceReadAuthorityRef || read.readVersion !== expected.sourceReadVersion
    || read.currentness !== 'CURRENT' || read.observedAt !== trusted.observedAt
    || !currentObservation(read, expected, {
      authorityRef: expected.sourceReadAuthorityRef,
      readVersion: expected.sourceReadVersion,
      observedAt: read.observedAt,
    })
    || !requestMatches
    || read.requestFingerprint !== sha256(canonicalJson(fingerprintRequest))) {
    return rejected('The speaker/profile resolver query does not correlate to the exact trusted query ID and source tuple.');
  }
  const output = read.outputs[0];
  const observed = output?.payload;
  const expectedArtifactType = selectedSpeaker ? 'authorized-artifact-version-summary' : 'governed-profile-voice-version';
  if (output?.artifactType !== expectedArtifactType || !isRecord(observed)
    || (selectedSpeaker ? observed.speakerRef !== expectedReference
      : observed.profileRef !== expected.profileRef || observed.profileVersionRef !== expected.profileVersionRef)
    || !nonblank(read.observedAt)
    || !Number.isFinite(Date.parse(read.observedAt))) {
    return rejected('The speaker version observation does not identify the exact requested immutable version.');
  }
  let sourceInputs;
  let sourceVersionRefs;
  let dependencyVersionRefs;
  let voiceAuthorizationSubjectRef;
  let originKind;
  if (selectedSpeaker || observed.sourceKind === 'GOVERNED_MEDIA_ARTIFACT_VERSION') {
    if (!nonblank(observed.artifactId) || !nonblank(observed.versionId) || !nonblank(observed.sourceRef)
      || (selectedSpeaker && observed.sourceRef !== input.speakerRef)) {
      return rejected('The governed voice source does not resolve to the exact immutable artifact/version tuple.');
    }
    const source = { slotId: selectedSpeaker ? 'input2' : 'profile-default-voice', artifactId: observed.artifactId, versionId: observed.versionId, sourceRef: observed.sourceRef };
    sourceInputs = [source];
    sourceVersionRefs = [observed.sourceRef];
    dependencyVersionRefs = [];
    voiceAuthorizationSubjectRef = observed.sourceRef;
    originKind = 'HYBRID';
  } else if (!selectedSpeaker && observed.sourceKind === 'VERSIONED_MODEL_DEPENDENCY'
    && nonblank(observed.modelDependencyRef) && nonblank(observed.modelDependencyVersionRef)) {
    sourceInputs = [];
    sourceVersionRefs = [];
    dependencyVersionRefs = [observed.modelDependencyVersionRef];
    voiceAuthorizationSubjectRef = observed.modelDependencyVersionRef;
    originKind = 'GENERATED_FROM_REQUEST';
  } else return rejected('The profile voice source does not have an exact supported typed source branch.');
  const snapshotDependencies = snapshot.dependencyVersionRefs ?? [];
  if (!Array.isArray(snapshotSources) || !same(snapshotSources, sourceInputs)
    || !Array.isArray(snapshot.sourceVersionRefs) || !same(snapshot.sourceVersionRefs, sourceVersionRefs)
    || !Array.isArray(snapshotDependencies) || !same(snapshotDependencies, dependencyVersionRefs)) {
    return rejected('The accepted snapshot lineage differs from the trusted resolved voice source tuple.');
  }
  return { sourceInputs, sourceVersionRefs, dependencyVersionRefs, voiceAuthorizationSubjectRef, originKind };
}

function validateAuthorizationObservations(request, expected, observations, profile, lineage) {
  const trusted = expected?.trustedAuthorizationObservations;
  if (!Array.isArray(trusted) || trusted.length < 2 || !Array.isArray(observations)
    || observations.length !== trusted.length) {
    return unknown('Current rights and consent observations are required before output registration.');
  }
  const expectedKinds = new Set(['VOICE_AUTHORIZATION', 'CONSENT']);
  const evidenceRefs = [];
  const consentRefs = [];
  for (let index = 0; index < trusted.length; index += 1) {
    const expectedRow = trusted[index];
    const observed = observations[index];
    const decision = observed?.decision;
    const expectedTextFields = ['queryId', 'decisionKind', 'subjectArtifactVersionRef', 'purposeRef', 'useRef', 'regionRef', 'retentionPolicyRef', 'readAuthorityRef', 'readVersion', 'decisionAuthorityRef', 'decisionAuthorityVersionRef'];
    const observedTextFields = ['queryId', 'decisionKind', 'subjectArtifactVersionRef', 'purposeRef', 'useRef', 'regionRef', 'retentionPolicyRef', 'requestFingerprint', 'tenantId', 'principalId', 'readAuthorityRef', 'readVersion'];
    if (!isRecord(expectedRow) || expectedTextFields.some((field) => !nonblank(expectedRow[field]))
      || !isRecord(observed) || observedTextFields.some((field) => !nonblank(observed[field]))) {
      return unknown('The trusted or observed authorization query tuple is incomplete.');
    }
    if (!isRecord(expectedRow) || !isRecord(observed) || observed.operationRef !== 'media.operation.action.inspect-consent-and-permitted-use'
      || observed.outcome !== 'OBSERVED' || !isRecord(decision)) {
      return unknown('A rights/consent decision lacks an exact owner query observation.');
    }
    const requiredKind = expectedRow.decisionKind;
    const expectedSubject = lineage.voiceAuthorizationSubjectRef;
    if (!expectedKinds.has(requiredKind) || observed.outcome !== 'OBSERVED'
      || expectedRow.queryId !== observed.queryId || expectedRow.decisionKind !== observed.decisionKind
      || expectedRow.subjectArtifactVersionRef !== expectedSubject
      || expectedRow.purposeRef !== expected.purposeRef
      || expectedRow.useRef !== 'media.speech.synthesis.text-to-speech'
      || expectedRow.regionRef !== expected.regionRef
      || expectedRow.retentionPolicyRef !== expected.retentionPolicyRef
      || observed.subjectArtifactVersionRef !== expectedRow.subjectArtifactVersionRef
      || observed.purposeRef !== expectedRow.purposeRef || observed.useRef !== expectedRow.useRef
      || observed.regionRef !== expectedRow.regionRef || observed.retentionPolicyRef !== expectedRow.retentionPolicyRef
      || !SHA256.test(observed.requestFingerprint ?? '')
      || observed.requestFingerprint !== sha256(canonicalJson({
        tenantId: expected.tenantId, principalId: expected.principalId,
        queryId: expectedRow.queryId, decisionKind: requiredKind,
        subjectArtifactVersionRef: expectedSubject, purposeRef: expected.purposeRef,
        useRef: expectedRow.useRef, regionRef: expectedRow.regionRef,
        retentionPolicyRef: expectedRow.retentionPolicyRef,
      }))
      || observed.decisionKind !== expectedRow.decisionKind
      || observed.tenantId !== expected.tenantId || observed.principalId !== expected.principalId
      || observed.readAuthorityRef !== expectedRow.readAuthorityRef
      || observed.readVersion !== expectedRow.readVersion
      || decision.authorityRef !== expectedRow.decisionAuthorityRef
      || decision.authorityVersionRef !== expectedRow.decisionAuthorityVersionRef
      || decision.subjectArtifactVersionRef !== expectedSubject
      || decision.purposeRef !== expected.purposeRef || decision.useRef !== expectedRow.useRef
      || decision.regionRef !== expectedRow.regionRef || decision.retentionPolicyRef !== expectedRow.retentionPolicyRef
      || decision.decisionKind !== requiredKind
      || decision.effectDisposition !== 'PERMITTED'
      || observed.observationStatus !== 'ALLOWED_FOR_DECLARED_SCOPE'
      || !currentObservation(observed, expected, {
        authorityRef: expectedRow.readAuthorityRef,
        readVersion: expectedRow.readVersion,
        observedAt: observed.observedAt,
      })
      || !canonicalInstant(decision.validFrom) || !canonicalInstant(decision.validUntil)
      || Date.parse(decision.validFrom) > Date.parse(expected.now)
      || Date.parse(expected.now) >= Date.parse(decision.validUntil)
      || !Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.length === 0
      || decision.evidenceRefs.some((ref) => !nonblank(ref))) {
      return rejected('A rights/consent observation is stale, foreign, outside the exact voice-use scope, or not permitted.');
    }
    evidenceRefs.push(...decision.evidenceRefs);
    if (requiredKind === 'CONSENT') {
      if (!nonblank(decision.consentRef) || decision.consentRef !== expectedRow.consentRef) {
        return rejected('The consent decision does not identify the exact trusted consent record.');
      }
      consentRefs.push(decision.consentRef);
    }
  }
  if (!trusted.some((row) => row?.decisionKind === 'VOICE_AUTHORIZATION')
    || !trusted.some((row) => row?.decisionKind === 'CONSENT')) {
    return rejected('Both voice authorization and consent decisions are required.');
  }
  const consentDecision = observations.find((row) => row.decisionKind === 'CONSENT');
  if (request.input2?.payload?.disposition === 'USER_CONFIRMED_REFERENCE'
    && (request.input2.payload.consentRef !== consentDecision?.decision?.consentRef
      || !same([...request.input2.payload.rightsEvidenceRefs].sort(), [...consentDecision.decision.evidenceRefs].sort()))) {
    return rejected('The confirmed speaker input consent/evidence tuple does not match the current owner decision.');
  }
  return { evidenceRefs: [...new Set(evidenceRefs)].sort(), consentRefs: [...new Set(consentRefs)].sort() };
}

/**
 * Definition-only validation for the TTS request-origin registration contract.
 * It validates host-supplied observations; it performs no query, registration, or dispatch.
 */
function validateTtsRequestOriginBindingInternal({ request, expected, snapshot, sourceVersionReads = [], authorizationObservations = [], executionResult, originBinding, registrationRequest, registrationReceipt } = {}) {
  if (!isRecord(request) || !isRecord(expected)) return unknown('The request or trusted expected tuple is absent.');
  if (!validTtsRequest(request)) return rejected('The TTS request is malformed, open, or outside its exact owner schema.');
  if (request.requestId !== expected.requestId || !nonblank(request.requestId)) {
    return rejected('The request identifier does not match the trusted job/request tuple.');
  }
  let canonicalTargetSchemaDigest;
  try { canonicalTargetSchemaDigest = computeTtsTargetSchemaDigest(); }
  catch (error) { return unknown(`The exact TTS request-schema closure is unresolved: ${error.message}`); }
  if (expected.targetSchemaDigest !== canonicalTargetSchemaDigest) {
    return rejected('The trusted target schema digest does not match the exact canonical TTS request schema and scalar-format closure.');
  }
  const profile = {
    profileRef: request.parameters?.outputProfileRef,
    profileVersion: expected.profileVersion,
    profileVersionRef: expected.profileVersionRef,
  };
  if (!nonblank(profile.profileRef) || !nonblank(profile.profileVersion) || !nonblank(profile.profileVersionRef)
    || profile.profileRef !== expected.profileRef || profile.profileVersion !== expected.profileVersion
    || profile.profileVersionRef !== expected.profileVersionRef) {
    return rejected('The request output profile does not match its trusted immutable profile tuple.');
  }
  let digests;
  try {
    digests = expectedRequestDigests(request, expected, profile);
  } catch (error) {
    return rejected(`The request is not a canonical JSON value: ${error.message}`);
  }
  const snapshotExpected = { ...expected, ...digests };
  const snapshotError = validateSnapshot(snapshot, snapshotExpected, request, profile);
  if (snapshotError) return snapshotError;
  const lineage = validateSourceReads(request, snapshot, expected, sourceVersionReads);
  if (lineage.status) return lineage;
  const authorization = validateAuthorizationObservations(request, expected, authorizationObservations, profile, lineage);
  if (authorization.status) return authorization;
  const produced = expected.trustedProducedOutput;
  if (!isRecord(produced) || !isRecord(executionResult) || executionResult.outcome !== 'SUCCEEDED'
    || !Array.isArray(executionResult.outputs) || executionResult.outputs.length !== 1
    || executionResult.outputs[0]?.artifactType !== 'speech-artifact-with-voice-rights-and-execution-provenance'
    || executionResult.provenance?.operationRef !== TTS_OPERATION_REF) {
    return unknown('A trusted successful TTS output observation is required before registration.');
  }
  if (!ttsOperationSchema?.resultSchema
    || !validateOwnerClosedJsonSchema(ttsOperationSchema.resultSchema, executionResult, ttsOperationSchema.resultSchema).valid) {
    return rejected('The TTS result does not match its closed canonical owner result schema.');
  }
  if (produced.currentness !== 'CURRENT' || produced.jobId !== expected.jobId
    || produced.requestId !== request.requestId || produced.tenantId !== expected.tenantId
    || produced.principalId !== expected.principalId || produced.requestFingerprint !== snapshot.requestFingerprint
    || produced.acceptedRequestSnapshotRef !== snapshot.acceptedRequestSnapshotRef
    || produced.targetOperationRef !== TTS_OPERATION_REF || produced.targetOperationVersion !== 1
    || produced.targetSchemaDigest !== snapshot.targetSchemaDigest
    || produced.profileRef !== profile.profileRef || produced.profileVersionRef !== profile.profileVersionRef
    || !currentObservation(produced, expected, {
      authorityRef: expected.outputReadAuthorityRef,
      readVersion: expected.outputReadVersion,
      observedAt: produced.observedAt,
    })
    || !nonblank(expected.outputReadAuthorityRef) || !nonblank(expected.outputReadVersion)
    || !nonblank(produced.outputCandidateRef) || !SHA256.test(produced.outputDigest ?? '')) {
    return rejected('The trusted produced-output tuple is stale, foreign, or mismatched to the accepted request.');
  }
  const producerReceipt = executionResult.provenance;
  if (producerReceipt.jobId !== expected.jobId || producerReceipt.requestId !== request.requestId
    || producerReceipt.tenantId !== expected.tenantId || producerReceipt.principalId !== expected.principalId
    || !currentObservation(producerReceipt, expected, {
      authorityRef: expected.outputReadAuthorityRef,
      readVersion: expected.outputReadVersion,
      observedAt: producerReceipt.observedAt,
    })) {
    return rejected('The producer result lacks the exact current trusted request/output observation tuple.');
  }
  const outputPayload = executionResult.outputs[0]?.payload;
  if (!isRecord(outputPayload)
    || outputPayload.originKind !== lineage.originKind
    || outputPayload.acceptedRequestSnapshotRef !== snapshot.acceptedRequestSnapshotRef
    || outputPayload.requestFingerprint !== snapshot.requestFingerprint
    || outputPayload.targetOperationRef !== TTS_OPERATION_REF
    || outputPayload.targetOperationVersion !== 1
    || outputPayload.targetSchemaDigest !== snapshot.targetSchemaDigest
    || outputPayload.capabilityRef !== TTS_CAPABILITY_REF
    || outputPayload.tenantId !== expected.tenantId || outputPayload.principalId !== expected.principalId
    || outputPayload.purposeRef !== expected.purposeRef || outputPayload.profileRef !== profile.profileRef
    || outputPayload.profileVersionRef !== profile.profileVersionRef
    || outputPayload.outputCandidateRef !== produced.outputCandidateRef
    || outputPayload.outputDigest !== produced.outputDigest
    || !same(outputPayload.sourceVersionRefs, lineage.sourceVersionRefs)
    || !same(outputPayload.dependencyVersionRefs, lineage.dependencyVersionRefs)
    || !Array.isArray(outputPayload.rightsEvidenceRefs)
    || !same([...outputPayload.rightsEvidenceRefs].sort(), authorization.evidenceRefs)
    || !same(outputPayload.consentRef, authorization.consentRefs[0])
    || outputPayload.retentionPolicyRef !== expected.retentionPolicyRef
    || !nonblank(outputPayload.originBindingRef)
    || executionResult.provenance.outputDigest !== produced.outputDigest
    || executionResult.provenance.originBindingRef !== outputPayload.originBindingRef
    || !currentObservation(executionResult.provenance, expected, {
      authorityRef: expected.outputReadAuthorityRef,
      readVersion: expected.outputReadVersion,
      observedAt: executionResult.provenance.observedAt,
    })
    || executionResult.provenance.observedAt !== produced.observedAt) {
    return rejected('The TTS result does not match the exact trusted produced-output observation.');
  }
  if (!isRecord(originBinding)) return unknown('The output-origin binding is missing.');
  if (!ttsOriginSchema || !validateOwnerClosedJsonSchema(ttsOriginSchema, originBinding, ttsOriginSchema).valid) {
    return rejected('The output-origin binding does not match its closed canonical owner schema.');
  }
  const expectedBinding = {
    originKind: lineage.originKind,
    acceptedRequestSnapshotRef: snapshot.acceptedRequestSnapshotRef,
    requestFingerprint: snapshot.requestFingerprint,
    targetOperationRef: TTS_OPERATION_REF,
    targetOperationVersion: 1,
    targetSchemaDigest: snapshot.targetSchemaDigest,
    capabilityRef: TTS_CAPABILITY_REF,
    tenantId: expected.tenantId,
    principalId: expected.principalId,
    purposeRef: expected.purposeRef,
    profileRef: profile.profileRef,
    profileVersion: profile.profileVersion,
    profileVersionRef: profile.profileVersionRef,
    dependencyVersionRefs: lineage.dependencyVersionRefs,
    outputCandidateRef: produced.outputCandidateRef,
    outputDigest: produced.outputDigest,
    originBindingRef: outputPayload.originBindingRef,
    sourceInputs: lineage.sourceInputs,
  };
  for (const [key, value] of Object.entries(expectedBinding)) {
    if (!same(originBinding[key], value)) return rejected(`Output-origin binding field ${key} does not match the accepted request.`);
  }
  if (!nonblank(originBinding.outputCandidateRef) || !SHA256.test(originBinding.outputDigest ?? '')) {
    return rejected('The output candidate identity or digest is malformed.');
  }
  if (!isRecord(registrationRequest) || !isRecord(registrationRequest.originBinding)) {
    return unknown('The output-registration request is absent.');
  }
  if (!outputRegistrationSchema?.requestSchema
    || !validateOwnerClosedJsonSchema(outputRegistrationSchema.requestSchema, registrationRequest, outputRegistrationSchema.requestSchema).valid) {
    return rejected('The output-registration request does not match its closed canonical owner schema.');
  }
  if (!same(registrationRequest.originBinding, originBinding)
    || registrationRequest.requestId !== request.requestId
    || registrationRequest.candidateRef !== originBinding.outputCandidateRef
    || registrationRequest.expectedSha256 !== originBinding.outputDigest
    || !same(registrationRequest.sourceVersionRefs, lineage.sourceVersionRefs)) {
    return rejected('The output-registration request does not exactly bind the validated origin and candidate.');
  }
  const trustedRegistration = expected.trustedRegistrationReceipt;
  if (!isRecord(trustedRegistration) || !isRecord(registrationReceipt) || registrationReceipt.outcome !== 'REGISTERED') {
    return unknown('An authoritative output-registration receipt is unavailable.');
  }
  if (!currentObservation(trustedRegistration, expected, {
    authorityRef: expected.registrationReadAuthorityRef,
    readVersion: expected.registrationReadVersion,
    observedAt: trustedRegistration.observedAt,
  }) || trustedRegistration.tenantId !== expected.tenantId
    || trustedRegistration.principalId !== expected.principalId
    || trustedRegistration.requestId !== request.requestId
    || trustedRegistration.candidateRef !== originBinding.outputCandidateRef
    || trustedRegistration.expectedSha256 !== originBinding.outputDigest
    || !isRecord(trustedRegistration.receipt)
    || !same(registrationReceipt, trustedRegistration.receipt)
    || trustedRegistration.receipt.outcome !== 'REGISTERED'
    || registrationReceipt.requestId !== request.requestId
    || registrationReceipt.candidateRef !== originBinding.outputCandidateRef
    || registrationReceipt.expectedSha256 !== originBinding.outputDigest
    || !nonblank(registrationReceipt.artifactId) || !nonblank(registrationReceipt.versionId)
    || !nonblank(registrationReceipt.registrationReceiptRef)
    || !nonblank(registrationReceipt.originBindingRef)
    || registrationReceipt.originBindingRef !== originBinding.originBindingRef
    || registrationReceipt.contentDigest !== originBinding.outputDigest
    || !nonblank(registrationReceipt.artifactId) || !nonblank(registrationReceipt.versionId)
    || !nonblank(registrationReceipt.registrationReceiptRef)) {
    return rejected('The registration receipt is not bound to the exact candidate, digest, and origin binding.');
  }
  return {
    status: 'VALID_DEFINITIONAL_BINDING',
    originKind: lineage.originKind,
    outputArtifactVersion: { artifactId: registrationReceipt.artifactId, versionId: registrationReceipt.versionId },
    runtimeAdmission: 'NOT_ADMITTED',
  };
}

export function validateTtsRequestOriginBinding(input = {}) {
  try {
    return validateTtsRequestOriginBindingInternal(input);
  } catch (error) {
    return rejected(`Malformed owner observation rejected safely: ${error instanceof Error ? error.message : 'invalid input'}`);
  }
}
