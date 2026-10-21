import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const Ajv2020 = toolsRequire('ajv/dist/2020.js').default;
const readYaml = file => parse(fs.readFileSync(path.join(root, file), 'utf8'));

const assertUniqueSemanticCommands = records => {
  const commandIds = records.map(record => record.semanticCommandId);
  assert.ok(commandIds.every(Boolean), 'every proposal has a semantic command identity');
  assert.equal(new Set(commandIds).size, commandIds.length, 'one proposal per semantic command');
};

test('PDP-1 Recorder Studio definitions preserve canonical owner reuse and all 52 typed manual edit kinds', () => {
  const recorder = readYaml('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const domain = readYaml('.product-experience/pdp-1-domain-data/domain-objects.yaml');
  const operations = readYaml('.product-experience/pdp-1-domain-data/operations.yaml');
  assert.equal(recorder.sourcePhase, 'PDP-1');
  assert.equal(recorder.status, 'SOURCE_AUTHORED_DEFINITION_ONLY');
  assert.equal(recorder.editKindParameterContracts.status, 'SOURCE_AUTHORED_DEFINITION_ONLY');

  const domainIds = new Set(domain.objects.map(object => object.id));
  const reusedDomainIds = Object.values(recorder.canonicalOwnerReuse)
    .filter(value => typeof value === 'string' && value.startsWith('media.domain.'));
  assert.equal(reusedDomainIds.length, 12);
  for (const id of reusedDomainIds) assert.ok(domainIds.has(id), `canonical Media owner is missing: ${id}`);
  assert.ok(recorder.canonicalOwnerReuse.reuseRule.toLowerCase()
    .includes('no object in this extension may create a second canonical repository'));

  const objectIds = recorder.objects.map(object => object.id);
  assert.equal(new Set(objectIds).size, objectIds.length);
  const project = recorder.objects.find(object => object.id === 'media.recorder.production-project');
  const run = recorder.objects.find(object => object.id === 'media.recorder.production-run');
  assert.equal(project.extends, 'media.domain.project-revision');
  assert.equal(run.extends, 'media.domain.media-run');

  const edit = recorder.objects.find(object => object.id === 'media.recorder.edit-operation');
  const contracts = recorder.editKindParameterContracts;
  assert.deepEqual(contracts.originalEditKindAuthority,
    '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml#objects/@id=media.recorder.edit-operation/operationKinds');
  assert.deepEqual(contracts.globalEnvelopeRequired,
    ['tenantId', 'projectId', 'expectedRevisionId', 'editOperationId', 'actorRef', 'sourceVersionRefs', 'stableTargetAnchor', 'purposePolicyRef', 'idempotencyKey']);
  const envelope = contracts.globalEnvelopeSchema;
  const envelopeFields = Object.keys(envelope.properties);
  assert.equal(envelope.type, 'object');
  assert.equal(envelope.additionalProperties, false);
  assert.deepEqual([...envelope.required].sort(), [...contracts.globalEnvelopeRequired].sort());
  assert.deepEqual([...envelopeFields].sort(), [...contracts.globalEnvelopeRequired].sort());
  for (const [field, definition] of Object.entries(envelope.properties)) {
    assert.ok(definition['x-ghatana-typeRuleRef'], `${field}: exact source-bound field/type rule`);
    assert.ok(definition['x-ghatana-semanticInvariant'], `${field}: semantic scope rule`);
    const [sourcePath, selector] = definition['x-ghatana-typeRuleRef'].split('#');
    assert.ok(sourcePath && selector, `${field}: source-bound type selector`);
    if (sourcePath.endsWith('/operations.yaml')) {
      const scalarTypeId = selector.match(/capabilityOperationContracts\/scalarTypes\/([^/]+)$/)?.[1];
      assert.ok(scalarTypeId, `${field}: exact scalar type selector`);
      assert.ok(operations.capabilityOperationContracts.scalarTypes[scalarTypeId], `${field}: canonical scalar type exists`);
    } else {
      const parameterType = selector.match(/editKindParameterContracts\/paramTypeRules\/([^/]+)$/)?.[1];
      assert.ok(parameterType, `${field}: exact local parameter type selector`);
      assert.ok(contracts.paramTypeRules[parameterType], `${field}: parameter type rule exists`);
    }
  }
  assert.equal(envelope.properties.tenantId['x-ghatana-origin'], 'TRUSTED_HOST_CONTEXT');
  assert.match(envelope.properties.expectedRevisionId['x-ghatana-semanticInvariant'], /same-tenant-and-project-current-revision/);
  assert.match(envelope.properties.sourceVersionRefs['x-ghatana-semanticInvariant'], /immutable-source-version-in-the-same-tenant-and-project-scope/);
  assert.match(envelope.properties.stableTargetAnchor['x-ghatana-semanticInvariant'], /specified-project-revision-and-source-version/);
  assert.match(envelope.properties.purposePolicyRef['x-ghatana-semanticInvariant'], /current-tenant-and-purpose-scoped/);
  assert.match(envelope.properties.sourceVersionRefs.items['x-ghatana-typeRuleRef'], /paramTypeRules\/SourceAssetVersionRef$/);
  assert.match(envelope.properties.stableTargetAnchor['x-ghatana-typeRuleRef'], /paramTypeRules\/StableAnchorRef$/);
  assert.match(envelope.properties.purposePolicyRef['x-ghatana-typeRuleRef'], /paramTypeRules\/PolicyRef$/);
  assert.match(envelope.properties.idempotencyKey.pattern, /\[A-Za-z0-9/);
  assert.ok(envelope.crossFieldInvariants.length >= 5);
  for (const negativeCase of [
    'caller-supplied-tenant-disagrees-with-trusted-tenant-deny-before-reference-resolution',
    'expectedRevisionId-from-another-project-or-tenant-deny-without-CAS-or-write',
    'sourceVersionRefs-empty-duplicate-stale-or-cross-tenant-deny-before-CAS',
    'stableTargetAnchor-from-another-revision-or-source-clock-deny-without-rebase-guess',
    'purposePolicyRef-revoked-wrong-tenant-or-wrong-purpose-deny-before-any-derived-effect',
  ]) assert.ok(envelope.negativeCases.includes(negativeCase), `missing envelope negative case: ${negativeCase}`);
  const identityContracts = domain.ownerTypedIdentityContracts.records;
  for (const ref of [
    envelope.properties.tenantId['x-ghatana-ownerIdentityRef'],
    envelope.properties.projectId['x-ghatana-ownerIdentityRef'],
    envelope.properties.expectedRevisionId['x-ghatana-ownerIdentityRef'],
  ]) {
    const match = ref.match(/#ownerTypedIdentityContracts\/records\/@id=([^/]+)\/identityComponents\/@field=([^/]+)$/);
    assert.ok(match, `identity selector has exact record and component: ${ref}`);
    const record = identityContracts.find(item => item.id === match[1]);
    assert.ok(record, `identity contract exists: ${match[1]}`);
    assert.ok(record.identityComponents.some(item => item.field === match[2]), `identity component exists: ${match[2]}`);
  }
  const validateEnvelope = new Ajv2020({ allErrors: true, strict: false }).compile(envelope);
  const validEnvelope = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    expectedRevisionId: 'revision-1',
    editOperationId: 'edit-1',
    actorRef: 'actor-1',
    sourceVersionRefs: [{
      tenantId: 'tenant-1',
      assetId: 'asset-1',
      immutableAssetVersionId: 'version-1',
      digest: `sha256:${'a'.repeat(64)}`,
      rightsScopeId: 'rights-1',
      provenanceRef: 'provenance:1',
    }],
    stableTargetAnchor: 'anchor:revision-1:source-1',
    purposePolicyRef: 'policy:tenant-1:demo',
    idempotencyKey: 'request-1',
  };
  assert.equal(validateEnvelope(validEnvelope), true, 'closed schema accepts a well-typed envelope');
  for (const invalidEnvelope of [
    { ...validEnvelope, unexpected: true },
    { ...validEnvelope, tenantId: 17 },
    { ...validEnvelope, idempotencyKey: 'bad/key' },
    { ...validEnvelope, sourceVersionRefs: [] },
    { ...validEnvelope, sourceVersionRefs: [{ ...validEnvelope.sourceVersionRefs[0], digest: 'not-a-digest' }] },
    { ...validEnvelope, sourceVersionRefs: [{ tenantId: 'tenant-1', assetId: 'asset-1' }] },
  ]) assert.equal(validateEnvelope(invalidEnvelope), false, 'closed schema rejects malformed envelope fields');

  assert.equal(envelope.structuralOracleChecks.status, 'DEFINITION_TEST_ORACLE_ONLY_NO_RUNTIME_PROOF');
  assert.deepEqual(envelope.structuralOracleChecks.checks,
    ['envelope-tenant-equals-each-inline-sourceVersionRefs-tenantId']);
  const structurallyConsistent = value => value.sourceVersionRefs.every(ref => ref.tenantId === value.tenantId);
  assert.equal(structurallyConsistent(validEnvelope), true);
  assert.equal(structurallyConsistent({
    ...validEnvelope,
    sourceVersionRefs: [{ ...validEnvelope.sourceVersionRefs[0], tenantId: 'tenant-2' }],
  }), false, 'structural cross-field oracle rejects source tenant mismatch');
  const resolverOracle = contracts.globalEnvelopeSchema.resolverOracleContract;
  assert.equal(resolverOracle.status, 'DEFINITION_TEST_ORACLE_ONLY_NO_RUNTIME_PROOF');
  assert.equal(resolverOracle.decision, 'DENY');
  assert.deepEqual(resolverOracle.before, ['reference-resolution', 'project-revision-CAS', 'derived-or-external-effect']);
  assert.equal(resolverOracle.sideEffects, 'NONE');
  assert.deepEqual(resolverOracle.cases.map(item => item.id), [
    'MEDIA-REC-P1-EDIT-ENV-ORACLE-001',
    'MEDIA-REC-P1-EDIT-ENV-ORACLE-002',
    'MEDIA-REC-P1-EDIT-ENV-ORACLE-003',
    'MEDIA-REC-P1-EDIT-ENV-ORACLE-004',
    'MEDIA-REC-P1-EDIT-ENV-ORACLE-005',
  ]);
  for (const oracleCase of resolverOracle.cases) {
    assert.equal(oracleCase.requiredDecision, 'DENY');
    assert.equal(oracleCase.requiredSideEffects, 'NONE');
    assert.ok(oracleCase.requiredBefore.length > 0, `${oracleCase.id}: denial ordering oracle`);
  }
  assert.equal(Object.keys(contracts.paramTypeRules).length, 57);
  assert.equal(contracts.kinds.length, 52);
  assert.equal(edit.operationKinds.length, 52);
  assert.deepEqual([...contracts.kinds.map(item => item.kind)].sort(), [...edit.operationKinds].sort());
  assert.equal(new Set(contracts.kinds.map(item => item.kind)).size, 52);
  for (const kind of contracts.kinds) {
    assert.equal(kind.commitOwner, 'media.recorder.operation.edit.commit.v1', `${kind.kind}: canonical edit owner`);
    assert.deepEqual([...Object.keys(kind.parameters)].sort(), [...kind.requiredFields].sort(), `${kind.kind}: typed required parameters`);
    for (const type of Object.values(kind.parameters)) {
      assert.ok(contracts.paramTypeRules[type], `${kind.kind}: unresolved parameter type ${type}`);
    }
    assert.equal(kind.fieldValidation, 'typed-and-unit-bounded-current-source-revision', `${kind.kind}: validation rule`);
    assert.ok(kind.acceptanceCaseRefs.length > 0, `${kind.kind}: acceptance trace`);
    assert.ok(kind.negative, `${kind.kind}: negative case`);
    assert.ok(kind.positiveEffect, `${kind.kind}: positive result`);
    assert.ok(kind.unavailableBehavior, `${kind.kind}: unavailable result`);
  }

  assert.equal(recorder.canonicalOperationProposals.status,
    'PDP1_DEFINITION_ONLY_NO_NEW_PUBLIC_ROUTE_OR_RUNTIME_ADMISSION');
  assert.equal(recorder.canonicalOperationProposals.identityListAuthority,
    'SOLE_AUTHORITATIVE_PROPOSAL_IDENTITY_LIST');
  assert.equal(recorder.operations, undefined, 'no parallel top-level operation proposal list');
  const proposed = recorder.canonicalOperationProposals.records;
  const canonicalOperations = new Set(operations.ownerDefinedOperationContracts.records.map(operation => operation.id));
  assert.equal(proposed.length, 15);
  assert.equal(new Set(proposed.map(operation => operation.id)).size, proposed.length);
  assertUniqueSemanticCommands(proposed);
  const duplicateSemanticCommand = proposed.map(operation => ({ ...operation }));
  duplicateSemanticCommand[1].semanticCommandId = duplicateSemanticCommand[0].semanticCommandId;
  assert.throws(() => assertUniqueSemanticCommands(duplicateSemanticCommand), /one proposal per semantic command/);
  const canonicalIds = new Set(proposed.map(operation => operation.id));
  const crosswalkCases = recorder.pdp0CaseOperationCrosswalk.groups.flatMap(group => {
    for (const operationId of group.proposedPdp1OperationRefs) {
      assert.ok(canonicalIds.has(operationId), `${group.groupId}: exact canonical proposal exists for ${operationId}`);
    }
    return group.acceptanceCaseIds;
  });
  assert.equal(crosswalkCases.length, 84);
  assert.equal(new Set(crosswalkCases).size, 84, 'each P0 case is mapped exactly once');
  const crosswalkOperationIds = new Set(recorder.pdp0CaseOperationCrosswalk.groups
    .flatMap(group => group.proposedPdp1OperationRefs));
  assert.deepEqual([...crosswalkOperationIds].sort(), [...canonicalIds].sort(),
    'every proposed command is reachable from the complete P0 crosswalk');
  for (const operation of proposed) {
    assert.equal(operation.runtimeStatus, 'NOT_ADMITTED', `${operation.id}: no runtime admission`);
    assert.equal(canonicalOperations.has(operation.id), false, `${operation.id}: proposal is not a second canonical operation`);
    assert.ok(operation.requestFields?.length, `${operation.id}: typed request`);
    assert.ok(operation.resultVariants?.length, `${operation.id}: typed result`);
    assert.ok(operation.negativeCases?.length, `${operation.id}: negative outcomes`);
    assert.ok(operation.invariant, `${operation.id}: explicit invariant`);
  }
});

test('PDP-1 edit commit binds typed CAS, replay, conflict, and unknown-outcome semantics to versioning authority', () => {
  const recorder = readYaml('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const versioning = readYaml('.product-experience/pdp-1-domain-data/versioning.yaml');
  const operation = recorder.canonicalOperationProposals.records
    .find(({ id }) => id === 'media.recorder.operation.edit.commit.v1');
  const contract = operation.resultContract;
  const schema = contract.resultSchema;
  const revisionRules = versioning.ownerDefinedRevisionSemantics.projectRevision;
  const idempotencyRules = versioning.ownerDefinedRevisionSemantics.idempotency;

  assert.equal(operation.revisionSemanticsRef,
    '.product-experience/pdp-1-domain-data/versioning.yaml#ownerDefinedRevisionSemantics/projectRevision');
  assert.equal(revisionRules.success,
    'A successful mutation creates exactly one successor revision and returns its exact revision ID.');
  assert.match(revisionRules.stale, /CONFLICT.*no mutation, automatic merge or overwrite/u);
  assert.match(idempotencyRules.duplicate, /original receipt without a second effect/u);
  assert.match(idempotencyRules.conflict, /different digest is rejected/u);
  assert.match(idempotencyRules.unknown, /reconciled before retry/u);
  assert.equal(contract.status, 'SOURCE_AUTHORED_DEFINITION_ONLY');

  const variants = schema.oneOf;
  assert.deepEqual(variants.map(({ properties }) => properties.outcome.const),
    ['APPLIED', 'CONFLICT', 'DENIED', 'OUTCOME_UNKNOWN']);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const revision = (revisionId) => ({
    objectType: 'media.domain.project-revision',
    identity: { tenantId: 'tenant-1', projectId: 'project-1', revisionId },
  });
  const request = {
    tenantId: 'tenant-1', projectId: 'project-1', expectedRevisionId: 'revision-1',
    editOperationIds: ['edit-1'], editorActorRef: 'actor-1', idempotencyKey: 'key-1',
    payload: { kind: 'trim', clipId: 'clip-1', boundary: '00:00:03' },
  };
  const fingerprint = 'sha256:request-fingerprint-1';
  const applied = {
    outcome: 'APPLIED', tenantId: request.tenantId, projectId: request.projectId,
    expectedRevisionId: request.expectedRevisionId, successorRevisionRef: revision('revision-2'),
    editOperationIds: request.editOperationIds, idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint, receiptRef: 'receipt-1',
  };
  assert.equal(validate(applied), true, JSON.stringify(validate.errors));
  const appliedSemantics = (submitted, result) => result.outcome === 'APPLIED'
    && result.tenantId === submitted.tenantId
    && result.projectId === submitted.projectId
    && result.expectedRevisionId === submitted.expectedRevisionId
    && result.successorRevisionRef.identity.tenantId === submitted.tenantId
    && result.successorRevisionRef.identity.projectId === submitted.projectId
    && result.successorRevisionRef.identity.revisionId !== submitted.expectedRevisionId
    && result.editOperationIds.length === submitted.editOperationIds.length
    && result.editOperationIds.every((id, index) => id === submitted.editOperationIds[index]);
  assert.equal(appliedSemantics(request, applied), true, 'APPLIED returns one exact successor for the submitted project revision');

  const conflict = {
    outcome: 'CONFLICT', tenantId: request.tenantId, projectId: request.projectId,
    expectedRevisionId: request.expectedRevisionId, disclosure: 'AUTHORIZED',
    currentHeadRevisionRef: revision('revision-3'), idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint,
  };
  assert.equal(validate(conflict), true, JSON.stringify(validate.errors));
  const withheldConflict = { ...conflict, disclosure: 'WITHHELD' };
  delete withheldConflict.currentHeadRevisionRef;
  assert.equal(validate(withheldConflict), true, 'unauthorized disclosure omits the current-head reference');
  assert.equal(validate({ ...conflict, disclosure: 'WITHHELD' }), false,
    'current head cannot be disclosed when authorization is withheld');
  assert.equal(validate({ ...conflict, disclosure: 'AUTHORIZED', currentHeadRevisionRef: undefined }), false,
    'authorized conflict must return the exact current head');
  assert.equal(contract.conflictRule,
    'atomically-compare-expectedRevisionId-to-current-head; no-project-write-no-automatic-merge-no-overwrite; current-head-reference-only-when-disclosure-is-authorized');
  const conflictSemantics = (result) => result.outcome === 'CONFLICT'
    && result.expectedRevisionId === request.expectedRevisionId
    && (result.disclosure === 'WITHHELD'
      ? !Object.hasOwn(result, 'currentHeadRevisionRef')
      : result.disclosure === 'AUTHORIZED'
        && result.currentHeadRevisionRef?.identity.tenantId === result.tenantId
        && result.currentHeadRevisionRef?.identity.projectId === result.projectId
        && result.currentHeadRevisionRef?.identity.revisionId !== result.expectedRevisionId)
    && contract.conflictRule.includes('no-project-write-no-automatic-merge-no-overwrite');
  assert.equal(conflictSemantics(conflict), true, 'stale CAS reports current head without merge or mutation');
  assert.equal(conflictSemantics(withheldConflict), true, 'WITHHELD conflict contains no current-head reference');
  assert.equal(conflictSemantics({
    ...conflict,
    currentHeadRevisionRef: {
      ...revision('revision-3'),
      identity: { ...revision('revision-3').identity, tenantId: 'tenant-2' },
    },
  }), false, 'authorized conflict cannot disclose a head from another tenant');
  assert.equal(conflictSemantics({
    ...conflict,
    currentHeadRevisionRef: {
      ...revision('revision-3'),
      identity: { ...revision('revision-3').identity, projectId: 'project-2' },
    },
  }), false, 'authorized conflict cannot disclose a head from another project');
  assert.equal(conflictSemantics({
    ...conflict,
    currentHeadRevisionRef: revision(request.expectedRevisionId),
  }), false, 'a conflict head must differ from the expected revision');
  assert.equal(conflictSemantics({
    ...withheldConflict,
    currentHeadRevisionRef: revision('revision-3'),
  }), false, 'WITHHELD cannot carry a current-head reference');
  assert.match(contract.conflictHeadInvariant, /tenantId-and-projectId-equal-result-scope.*revisionId-differs-from-expectedRevisionId/u);
  assert.match(contract.disclosureRule, /server-governing-policy-authorizes-current-head-disclosure.*caller-authorization-alone-is-insufficient/u);

  const ledger = new Map();
  const submitOracle = (key, payloadFingerprint, receipt) => {
    const prior = ledger.get(key);
    if (!prior) {
      ledger.set(key, { fingerprint: payloadFingerprint, receipt });
      return { disposition: 'APPLIED', receipt };
    }
    if (prior.fingerprint !== payloadFingerprint) return { disposition: 'IDEMPOTENCY_CONFLICT' };
    return { disposition: 'REPLAY', receipt: prior.receipt };
  };
  const first = submitOracle(request.idempotencyKey, fingerprint, 'receipt-1');
  assert.deepEqual(first, { disposition: 'APPLIED', receipt: 'receipt-1' });
  assert.deepEqual(submitOracle(request.idempotencyKey, fingerprint, 'receipt-2'),
    { disposition: 'REPLAY', receipt: 'receipt-1' }, 'same key and fingerprint reuses original receipt without a second effect');
  assert.deepEqual(submitOracle(request.idempotencyKey, 'sha256:different-payload', 'receipt-3'),
    { disposition: 'IDEMPOTENCY_CONFLICT' }, 'same key with a different payload is rejected');
  assert.match(contract.idempotencyRule, /same-key-same-fingerprint-returns-original-receipt.*same-key-different-fingerprint-is-rejected/u);

  const unknown = {
    outcome: 'OUTCOME_UNKNOWN', tenantId: request.tenantId, projectId: request.projectId,
    expectedRevisionId: request.expectedRevisionId, idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint, reconciliationRef: 'reconciliation-1',
  };
  assert.equal(validate(unknown), true, JSON.stringify(validate.errors));
  let reconciled = false;
  const mayRetry = (submitted, reconciliation) => reconciled
    && reconciliation.tenantId === submitted.tenantId
    && reconciliation.projectId === submitted.projectId
    && reconciliation.idempotencyKey === submitted.idempotencyKey
    && reconciliation.requestFingerprint === fingerprint;
  const exactReconciliation = {
    tenantId: request.tenantId, projectId: request.projectId,
    idempotencyKey: request.idempotencyKey, requestFingerprint: fingerprint,
  };
  assert.equal(mayRetry(request, exactReconciliation), false, 'UNKNOWN blocks resubmission before exact readback');
  reconciled = true;
  assert.equal(mayRetry(request, exactReconciliation), true, 'only exact same-request reconciliation permits recovery');
  assert.equal(mayRetry(request, { ...exactReconciliation, idempotencyKey: 'new-key' }), false,
    'recovery cannot allocate a new semantic request identity');
  assert.match(contract.unknownRule, /before-retry.*no-new-key-or-resubmission/u);
});
