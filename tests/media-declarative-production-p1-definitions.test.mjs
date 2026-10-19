import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'yaml';

const requireTools = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ghatana-tools/package.json'));
const Ajv2020 = requireTools('ajv/dist/2020').default;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readYaml = file => parse(fs.readFileSync(path.join(root, file), 'utf8'));
const resolvePath = (sourceRef, document) => {
  const marker = sourceRef.indexOf('#');
  assert.ok(marker > 0, `invalid source reference: ${sourceRef}`);
  let value = document;
  for (const segment of sourceRef.slice(marker + 1).split('/')) {
    if (segment.startsWith('@id=')) {
      const id = segment.slice(4);
      const records = Array.isArray(value) ? value : value.records;
      value = records?.find(record => record.id === id);
      assert.ok(value, `unresolved source identity ${id}: ${sourceRef}`);
    } else {
      assert.ok(value && Object.hasOwn(value, segment), `unresolved source selector ${segment}: ${sourceRef}`);
      value = value[segment];
    }
  }
  return value;
};

test('PDP-1 declarative production bindings resolve the full 61-case source denominator to exact current operation contracts', () => {
  const p0 = readYaml('.product-experience/pdp-0-product-truth/requirements.yaml');
  const p1 = readYaml('.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml');
  const operations = readYaml('.product-experience/pdp-1-domain-data/operations.yaml');
  assert.equal(p1.status, 'SOURCE_AUTHORED_DEFINITION_ONLY', 'phase completion is recorded by the source-bound PDP-1 status, not self-declared by a contract');
  const clauses = p0.declarativeProductionProfile.acceptanceClauses;
  const rows = p1.caseOperationBindings;
  assert.equal(rows.length, 61);
  assert.equal(new Set(rows.map(row => row.caseId)).size, 61);
  assert.equal(clauses.length, 61);
  assert.deepEqual([...rows.map(row => row.caseId)].sort(), [...clauses.map(clause => clause.id)].sort());

  const assertClosed = (schema, sourceRef) => {
    const objects = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') objects.push(node);
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === 'object') visit(child);
      }
    };
    visit(schema);
    assert.ok(objects.length > 0, `${sourceRef}: expected typed object schema`);
    for (const object of objects) {
      const boundedJsonValue = object.additionalProperties && typeof object.additionalProperties === 'object'
        && object.additionalProperties.$ref === '#/$defs/jsonValue';
      assert.ok(object.additionalProperties === false || boundedJsonValue,
        `${sourceRef}: object schemas must be closed or use the declared bounded JSON value`);
    }
  };

  for (const row of rows) {
    const operation = resolvePath(row.p1OperationSource, operations);
    assert.equal(operation.id, row.canonicalOperationRef, `${row.caseId}: operation identity`);
    assertClosed(resolvePath(row.p1RequestSchemaSource, operations), row.p1RequestSchemaSource);
    assertClosed(resolvePath(row.p1ResultSchemaSource, operations), row.p1ResultSchemaSource);
    assert.equal(resolvePath(row.p1OperationVersionSource, operations),
      operation.operationVersion ?? operation.contractVersion, `${row.caseId}: operation version`);
    assert.match(JSON.stringify(resolvePath(row.p1ResultOutcomeSource, operations)), /REJECTED/u,
      `${row.caseId}: definitive rejection outcome`);
    assert.match(JSON.stringify(resolvePath(row.p1ResultOutcomeSource, operations)), /UNKNOWN_OUTCOME/u,
      `${row.caseId}: uncertain finality outcome`);
    assert.ok(resolvePath(row.p1ErrorOutcomesSource, operations), `${row.caseId}: typed error outcomes`);
    assert.ok(resolvePath(row.p1FinalitySource, operations), `${row.caseId}: finality semantics`);
    assert.deepEqual(row.resultEvidenceRequired,
      ['exact-model-or-media-result', 'source-version', 'effect-finality', 'denial', 'safe-recovery']);
    assert.equal(row.runtimeAdmission, 'NOT_ADMITTED', `${row.caseId}: source definition cannot admit runtime`);
  }

  const provenance = rows.find(row => row.caseId === 'MEDIA-DECL-P0-AC-049');
  assert.equal(provenance.canonicalOperationRef, 'media.operation-slice.inspect-provenance');
  assert.match(provenance.p1RequestSchemaSource, /ownerWireSchema\/requestSchema$/u);
  assert.match(provenance.p1ResultSchemaSource, /ownerWireSchema\/resultSchema$/u);

  const submit = rows.find(row => row.caseId === 'MEDIA-DECL-P0-AC-058');
  assert.equal(submit.canonicalOperationRef, 'media.operation.job.submit.v1');
  assert.match(submit.p1RequestSchemaSource, /ownerWireSchema\/requestSchema$/u);
  assert.match(submit.p1ResultSchemaSource, /ownerWireSchema\/resultSchema$/u);
  assert.match(JSON.stringify(resolvePath(submit.p1ResultObservationSemanticsSource, operations)), /UNKNOWN/u);
});

test('PDP-1 model execution and checkpoint descriptors share versioned replay randomness semantics', () => {
  const contracts = readYaml('.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml');
  const valueObjects = readYaml('.product-experience/pdp-1-domain-data/value-objects.yaml');
  const sourceRef = '.product-experience/pdp-1-domain-data/value-objects.yaml#ownerDescriptorDefinitions/records/@id=media.value.replay-provenance-definition/schema/properties/randomnessSemantics';
  assert.equal(contracts.canonicalReplaySemanticsAuthority, sourceRef);

  const descriptors = new Map(contracts.typedProductionValueDescriptors.map(item => [item.id, item]));
  for (const id of ['media.declarative.value.model-execution-spec.v1', 'media.declarative.value.simulation-state.v1']) {
    const descriptor = descriptors.get(id);
    assert.ok(descriptor, `${id}: model/checkpoint descriptor`);
    assert.ok(descriptor.requiredFields.includes('randomnessSemantics'), `${id}: required randomness disposition`);
    assert.equal(descriptor.randomnessSemanticsRef, sourceRef, `${id}: exact PDP-1 schema authority`);
    assert.match(descriptor.randomnessRule, /versioned non-stochastic declaration/u, `${id}: source-bound non-applicability`);
    assert.match(descriptor.randomnessRule, /UNKNOWN/u, `${id}: unknown semantics boundary`);
  }

  const replay = valueObjects.ownerDescriptorDefinitions.records
    .find(item => item.id === 'media.value.replay-provenance-definition');
  assert.ok(replay.schema.required.includes('randomnessSemantics'));
  const randomness = replay.schema.properties.randomnessSemantics.oneOf;
  const specified = randomness.find(branch => branch.properties.disposition.const === 'SPECIFIED');
  const notApplicable = randomness.find(branch => branch.properties.disposition.const === 'NOT_APPLICABLE');
  const unknown = randomness.find(branch => branch.properties.disposition.const === 'UNKNOWN');
  for (const field of [
    'prngAlgorithmVersionRef', 'prngImplementationVersionRef', 'randomStreamVersionRef',
    'seedPolicyVersionRef', 'seedMaterialVersionRef', 'checkpointStateFormatVersionRef',
    'checkpointStateVersionRefs',
  ]) assert.ok(specified.required.includes(field), `SPECIFIED requires ${field}`);
  assert.ok(notApplicable.required.includes('nonStochasticDeclarationVersionRef'));
  assert.ok(notApplicable.required.includes('reason'));
  assert.ok(unknown.required.includes('reason'));

  const replayClaimGuard = replay.schema.allOf.find(rule =>
    rule.if?.properties?.replayClass?.enum?.includes('EXACT_ENVIRONMENT')
    && rule.then?.properties?.randomnessSemantics);
  assert.ok(replayClaimGuard, 'replay class guard exists');
  const allowedClaims = replayClaimGuard.then.properties.randomnessSemantics.oneOf
    .map(branch => branch.properties.disposition.const).sort();
  assert.deepEqual(allowedClaims, ['NOT_APPLICABLE', 'SPECIFIED']);
});

test('PDP-1 simulation family evidence and active-speaker proposal schemas stay version and evidence bound', () => {
  const contracts = readYaml('.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml');
  const rows = contracts.caseOperationBindings;
  const model = contracts.typedProductionValueDescriptors.find(item => item.id === 'media.declarative.value.model-execution-spec.v1');
  const applicability = contracts.$defs.familyApplicability;
  assert.ok(model, 'model execution specification exists');
  for (const field of ['modelFamilyRef', 'familyApplicability', 'familyQualificationRef']) {
    assert.ok(model.requiredFields.includes(field), `${field}: required by model execution spec`);
    assert.ok(Object.hasOwn(model.schema.properties, field), `${field}: typed model execution property`);
  }
  assert.equal(applicability.oneOf.length, 3);
  const applicabilityBranches = new Map(applicability.oneOf.map(branch => [branch.properties.applicability.const, branch]));
  assert.deepEqual([...applicabilityBranches.keys()].sort(), ['ADMITTED', 'NOT_ADMITTED', 'UNKNOWN']);
  for (const branch of applicability.oneOf) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(branch.required, ['applicability', 'evidenceRefs']);
    assert.equal(Object.hasOwn(branch.properties, 'modelFamilyRef'), false,
      'family identity is inherited from the enclosing model, never duplicated in applicability');
    assert.equal(Object.hasOwn(branch.properties, 'modelVersionRef'), false,
      'family version is inherited from the enclosing model, never duplicated in applicability');
  }
  assert.equal(applicabilityBranches.get('ADMITTED').properties.evidenceRefs.$ref, '#/$defs/nonEmptyVersionRefList');
  assert.match(applicability.description, /enclosing exact modelFamilyRef and modelVersionRef/u);
  assert.match(model.familyBindingInvariant, /familyQualificationRef.*same enclosing pair/u);
  assert.match(model.familyBindingInvariant, /UNKNOWN.*rejects execution/u);
  assert.match(model.applicabilityAdmissionRule, /at least one versioned source evidence reference/u);
  assert.match(model.applicabilityAdmissionRule, /UNKNOWN.*must be rejected/u);
  assert.ok(model.negativeCases.includes('qualification-transfer-between-families'));
  assert.ok(model.negativeCases.includes('admitted-applicability-with-empty-evidence'));
  assert.ok(model.negativeCases.includes('unknown-family-applicability-execution'));
  const p0Capabilities = readYaml('.product-experience/pdp-0-product-truth/capabilities.yaml').capabilities;
  const supportedSimulationLeaves = p0Capabilities.map(item => item.id)
    .filter(id => id.startsWith('media.simulation.')
      && id !== 'media.simulation.output'
      && !id.startsWith('media.simulation.output.')).sort();
  assert.equal(supportedSimulationLeaves.length, 22,
    'the frozen PDP-1 simulation family denominator is exactly 22 P0 leaves');
  const familyValidation = model.familyApplicabilityValidationContract;
  assert.deepEqual([...familyValidation.familyIdentity.supportedFamilyIds].sort(), supportedSimulationLeaves,
    'validator allowlist is the exact current P0 simulation leaf set');
  assert.deepEqual([...contracts.$defs.existingSimulationCapabilityLeafId.enum].sort(), supportedSimulationLeaves,
    'schema excludes the generic category and simulation output identities');
  assert.deepEqual(familyValidation.familyIdentity.forbiddenFamilyIds, ['media.simulation', 'media.simulation.output']);
  assert.equal(familyValidation.familyIdentity.rejectAnyUnlistedOrUnsupportedFamilyId, true);
  assert.equal(familyValidation.familyIdentity.supportedIdsMustResolveAsExactCapabilityLeaves, true);
  assert.equal(familyValidation.applicabilityEvidence.resolveEveryEvidenceRef, true);
  assert.equal(familyValidation.applicabilityEvidence.minimumResolvedEvidenceRecords, 1);
  assert.deepEqual(familyValidation.applicabilityEvidence.resolvedRecordMustMatch, {
    modelFamilyRef: 'EXACT_EQUAL_TO_ENCLOSING_MODEL_FAMILY_REF',
    modelVersionRef: 'EXACT_EQUAL_TO_ENCLOSING_MODEL_VERSION_REF',
    applicabilityDisposition: 'ADMITTED',
  });
  const authorityRequirements = familyValidation.applicabilityEvidence.requiredAuthorizedAuthoritySource.authorityRecordMustDeclare;
  assert.equal(familyValidation.applicabilityEvidence.requiredAuthorizedAuthoritySource.authorityRefMustResolve, true);
  assert.equal(authorityRequirements.authorityRole, 'QUALIFIED_DOMAIN_OWNER');
  assert.equal(authorityRequirements.authorizationDisposition, 'AUTHORIZED_FOR_EXACT_FAMILY_AND_MODEL_VERSION');
  assert.equal(authorityRequirements.modelFamilyRef, 'EXACT_EQUAL_TO_ENCLOSING_MODEL_FAMILY_REF');
  assert.equal(authorityRequirements.modelVersionRef, 'EXACT_EQUAL_TO_ENCLOSING_MODEL_VERSION_REF');
  assert.equal(familyValidation.applicabilityEvidence.applicabilityCanBeAdmittedOnlyWhenAllEvidenceAndAuthorityChecksPass, true);
  assert.equal(familyValidation.applicabilityEvidence.noAdmissionRecordOrOwnerAuthorizationIsAssertedByThisContract, true);
  for (const negative of [
    'unsupported-family-capability-id',
    'evidence-bound-to-another-family-or-model-version',
    'unresolved-applicability-evidence-ref',
    'missing-or-unauthorized-authority-source',
  ]) assert.ok(model.negativeCases.includes(negative), `negative case: ${negative}`);

  const proposal = contracts.typedProductionValueDescriptors.find(item => item.id === 'media.declarative.value.active-speaker-cut-proposal.v1');
  assert.ok(proposal, 'active-speaker cut proposal has a dedicated typed value identity');
  assert.equal(proposal.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(proposal.schema.additionalProperties, false);
  assert.ok(proposal.requiredFields.includes('sourceRevisionRef'));
  assert.ok(proposal.requiredFields.includes('proposedCuts'));
  assert.equal(proposal.schema.properties.schemaVersion.const, proposal.id);
  assert.equal(proposal.schema.properties.proposalDisposition.const, 'REVIEWABLE_LOCAL_CANDIDATE_NO_PROJECT_COMMIT');
  const cut = proposal.schema.properties.proposedCuts.items;
  assert.deepEqual(cut.required, ['cutRef', 'storyTime', 'speakerTurnEvidence', 'cameraSourceEvidence', 'uncertaintyRef']);
  assert.equal(cut.additionalProperties, false);
  assert.equal(cut.properties.storyTime.$ref, '#/$defs/storyTime');
  assert.deepEqual(cut.properties.speakerTurnEvidence.required, ['evidenceClass', 'evidenceRef']);
  assert.equal(cut.properties.speakerTurnEvidence.properties.evidenceClass.const, 'SPEAKER_TURN_OBSERVATION');
  assert.deepEqual(cut.properties.cameraSourceEvidence.required, ['evidenceClass', 'evidenceRef']);
  assert.equal(cut.properties.cameraSourceEvidence.properties.evidenceClass.const, 'CAMERA_SOURCE_OBSERVATION');
  assert.ok(contracts.$defs.storyTime.required.includes('ticks'), 'story-time anchor retains exact ticks');
  assert.ok(contracts.$defs.storyTime.required.includes('timeBase'), 'story-time anchor retains exact time base');
  assert.equal(contracts.$defs.storyTime.properties.clockKind.const, 'story');
  assert.ok(proposal.negativeCases.includes('missing-speaker-turn-evidence'));
  assert.ok(proposal.negativeCases.includes('missing-camera-source-evidence'));
  assert.ok(proposal.negativeCases.includes('wrong-speaker-turn-evidence-class'));
  assert.ok(proposal.negativeCases.includes('wrong-camera-source-evidence-class'));
  assert.ok(proposal.negativeCases.includes('unresolved-evidence-reference'));
  assert.ok(proposal.negativeCases.includes('missing-cut-uncertainty'));
  assert.ok(proposal.negativeCases.includes('inferred-missing-evidence'));
  assert.ok(proposal.negativeCases.includes('implicit-project-commit'));
  assert.match(proposal.evidenceLinkRule, /evidenceClass distinguishes the relationship/u);
  assert.match(proposal.evidenceLinkRule, /reject unresolved references/u);
  assert.match(proposal.evidenceLinkRule, /evidence class does not match its declared role/u);
  assert.match(proposal.evidenceLinkRule, /No separate proposal-level membership list is authoritative/u);
  const modelAcRefs = model.schemaAuthorities.filter(ref => /MEDIA-REQ-CAP-SIMULATION-AC-(01|03)$/u.test(ref));
  assert.deepEqual(modelAcRefs.sort(), [
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SIMULATION/acceptanceCases/@id=MEDIA-REQ-CAP-SIMULATION-AC-01',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SIMULATION/acceptanceCases/@id=MEDIA-REQ-CAP-SIMULATION-AC-03',
  ].sort(), 'core simulation AC-01 and AC-03 map to the model execution schema without inflating the 61-case declarative denominator');
  const simulationCoreRelations = model.operationSchemaRelations.filter(relation =>
    ['MEDIA-REQ-CAP-SIMULATION-AC-01', 'MEDIA-REQ-CAP-SIMULATION-AC-03'].includes(relation.caseId));
  assert.equal(simulationCoreRelations.length, 2);
  for (const relation of simulationCoreRelations) {
    assert.match(relation.p0CaseSource, new RegExp(`${relation.caseId}$`, 'u'));
    assert.match(relation.requestSchemaSource, /media\.operation\.capability\.media-simulation-agent\/requestSchema$/u);
    assert.match(relation.resultSchemaSource, /media\.operation\.capability\.media-simulation-agent\/resultSchema$/u);
  }
  assert.ok(proposal.schemaAuthorities.some(ref => ref.endsWith('/@id=MEDIA-REQ-CAP-COMPOSE/acceptanceCases/@id=MEDIA-REQ-CAP-COMPOSE-AC-03')),
    'core multicamera AC-03 is a source authority for the typed proposal');
  const compositionRelation = proposal.operationSchemaRelations.find(relation => relation.caseId === 'MEDIA-REQ-CAP-COMPOSE-AC-03');
  assert.ok(compositionRelation, 'core multicamera AC-03 maps to the typed proposal');
  assert.match(compositionRelation.p0CaseSource, /MEDIA-REQ-CAP-COMPOSE-AC-03$/u);
  assert.match(compositionRelation.requestSchemaSource, /media\.operation\.capability\.media-compose-multitrack-timeline\/requestSchema$/u);
  assert.match(compositionRelation.resultSchemaSource, /media\.operation\.capability\.media-compose-multitrack-timeline\/resultSchema$/u);
});

test('all eleven PDP-1 typed production values have closed enforceable schemas and exact operation-schema relations', () => {
  const contracts = readYaml('.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml');
  const operations = readYaml('.product-experience/pdp-1-domain-data/operations.yaml');
  const domainObjects = readYaml('.product-experience/pdp-1-domain-data/domain-objects.yaml');
  const valueObjects = readYaml('.product-experience/pdp-1-domain-data/value-objects.yaml');
  const evidence = readYaml('.product-experience/pdp-1-domain-data/evidence.yaml');
  const p0 = readYaml('.product-experience/pdp-0-product-truth/requirements.yaml');
  const rows = contracts.caseOperationBindings;
  const rowsByCase = new Map(rows.map(row => [row.caseId, row]));
  const documents = new Map([
    ['.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml', contracts],
    ['.product-experience/pdp-1-domain-data/operations.yaml', operations],
    ['.product-experience/pdp-1-domain-data/domain-objects.yaml', domainObjects],
    ['.product-experience/pdp-1-domain-data/value-objects.yaml', valueObjects],
    ['.product-experience/pdp-1-domain-data/evidence.yaml', evidence],
    ['.product-experience/pdp-0-product-truth/requirements.yaml', p0],
  ]);
  const resolveAny = sourceRef => {
    const marker = sourceRef.indexOf('#');
    assert.ok(marker > 0, `invalid source reference: ${sourceRef}`);
    let value = documents.get(sourceRef.slice(0, marker));
    assert.ok(value, `unrecognized source document: ${sourceRef}`);
    for (const segment of sourceRef.slice(marker + 1).replace(/^\//u, '').split('/')) {
      if (segment.startsWith('@id=')) {
        const id = segment.slice(4);
        const records = Array.isArray(value) ? value : value.records;
        value = records?.find(record => record.id === id);
        assert.ok(value, `unresolved source identity ${id}: ${sourceRef}`);
      } else {
        assert.ok(value && Object.hasOwn(value, segment), `unresolved source selector ${segment}: ${sourceRef}`);
        value = value[segment];
      }
    }
    return value;
  };
  assert.equal(contracts.typedProductionValueDescriptors.length, 11);
  assert.equal(contracts.typedProductionValueSchemaContext.dialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(resolveAny(contracts.typedProductionValueSchemaContext.sharedDefinitionsSource), contracts.$defs,
    'descriptor-local $refs resolve against this exact shared definition map');
  assert.match(contracts.typedProductionValueSchemaContext.resolutionRule, /merged at that root/u);

  const closedRecursively = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') assert.equal(node.additionalProperties, false, `${where}: every object must be closed`);
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) child.forEach((entry, index) => closedRecursively(entry, `${where}/${key}/${index}`));
      else if (child && typeof child === 'object') closedRecursively(child, `${where}/${key}`);
    }
  };
  const closedAfterDereference = (schema, rootSchema, where, seen = new WeakSet()) => {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return;
    seen.add(schema);
    if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/$defs/')) {
      const target = schema.$ref.slice('#/$defs/'.length).split('/').reduce((value, key) => value?.[key], rootSchema.$defs);
      assert.ok(target, `${where}: local schema ref resolves: ${schema.$ref}`);
      closedAfterDereference(target, rootSchema, `${where}->${schema.$ref}`, seen);
    }
    if (schema.type === 'object') assert.equal(schema.additionalProperties, false, `${where}: dereferenced object is closed`);
    for (const [key, child] of Object.entries(schema)) {
      if (key === '$ref') continue;
      if (Array.isArray(child)) child.forEach((entry, index) => closedAfterDereference(entry, rootSchema, `${where}/${key}/${index}`, seen));
      else if (child && typeof child === 'object') closedAfterDereference(child, rootSchema, `${where}/${key}`, seen);
    }
  };
  const dereference = (schema, rootSchema) => {
    if (schema.$ref?.startsWith('#/$defs/')) return rootSchema.$defs[schema.$ref.slice('#/$defs/'.length)];
    return schema;
  };
  const example = (schema, rootSchema) => {
    schema = dereference(schema, rootSchema);
    if (Object.hasOwn(schema, 'const')) return schema.const;
    if (schema.enum) return schema.enum[0];
    if (schema.oneOf) return example(schema.oneOf[0], rootSchema);
    if (schema.type === 'object') {
      const value = {};
      for (const key of schema.required ?? []) value[key] = example(schema.properties[key], rootSchema);
      return value;
    }
    if (schema.type === 'array') return schema.minItems ? [example(schema.items, rootSchema)] : [];
    if (schema.type === 'integer' || schema.type === 'number') return 1;
    if (schema.type === 'null') return null;
    if (schema.type === 'string') {
      if (schema.format === 'opaque-id') return 'value-1';
      if (schema.format === 'signed-int64-decimal') return '0';
      if (schema.format === 'positive-int64-decimal') return '1';
      return 'version:v1';
    }
    throw new Error(`no representative value for ${JSON.stringify(schema)}`);
  };
  const makeValidator = schema => {
    const ajv = new Ajv2020({strict: false, validateFormats: true, allErrors: true});
    ajv.addFormat('opaque-id', /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
    ajv.addFormat('opaque-versioned-reference', /^\S+$/u);
    const signedMin = -(2n ** 63n);
    const signedMax = (2n ** 63n) - 1n;
    ajv.addFormat('signed-int64-decimal', {
      type: 'string',
      validate: value => /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/u.test(value)
        && BigInt(value) >= signedMin && BigInt(value) <= signedMax,
    });
    ajv.addFormat('positive-int64-decimal', {
      type: 'string',
      validate: value => /^[1-9][0-9]*$/u.test(value)
        && BigInt(value) >= 1n && BigInt(value) <= signedMax,
    });
    return ajv.compile(schema);
  };

  for (const descriptor of contracts.typedProductionValueDescriptors) {
    assert.equal(new Set(contracts.typedProductionValueDescriptors.map(item => item.id)).size, 11, 'stable descriptor IDs are unique');
    assert.ok(resolveAny(`.product-experience/pdp-1-domain-data/domain-objects.yaml#objects/@id=${descriptor.ownerDomainRef}`), `${descriptor.id}: canonical domain owner`);
    assert.ok(descriptor.schemaAuthorities.length >= 2, `${descriptor.id}: source authorities`);
    for (const ref of descriptor.schemaAuthorities) assert.ok(resolveAny(ref), `${descriptor.id}: schema source ${ref}`);
    assert.ok(descriptor.schema && descriptor.schema.type === 'object', `${descriptor.id}: machine-readable object schema`);
    assert.equal(descriptor.schema.additionalProperties, false, `${descriptor.id}: closed object`);
    assert.deepEqual(descriptor.schema.required, descriptor.requiredFields, `${descriptor.id}: required fields match schema`);
    assert.deepEqual(Object.keys(descriptor.schema.properties).sort(), [...descriptor.requiredFields].sort(), `${descriptor.id}: every declared field has exactly one property type`);
    assert.ok(descriptor.negativeCases.includes('unknown-property'), `${descriptor.id}: unknown-field negative case`);
    assert.ok(descriptor.negativeCases.some(value => /wrong|nonnumeric|unsupported|negative-|zero-|empty-/u.test(value)), `${descriptor.id}: wrong-type/value negative case`);
    assert.ok(descriptor.negativeCases.some(value => /mismatch|incompatible|contradiction|without|with-|null-|inconsistent|unknown-randomness|unsupported-|unadmitted-|wrong-|missing-/u.test(value)), `${descriptor.id}: invalid-combination negative case`);
    closedRecursively(descriptor.schema, descriptor.id);

    const schema = {$schema: contracts.typedProductionValueSchemaContext.dialect, $id: `https://media.invalid/${descriptor.id}`, $defs: resolveAny(contracts.typedProductionValueSchemaContext.sharedDefinitionsSource), ...descriptor.schema};
    closedAfterDereference(descriptor.schema, schema, descriptor.id);
    const validate = makeValidator(schema);
    const validValue = example(descriptor.schema, schema);
    assert.equal(validate(validValue), true, `${descriptor.id}: representative closed value should validate: ${JSON.stringify(validate.errors)}`);

    const withUnknown = structuredClone(validValue);
    withUnknown.unexpectedField = true;
    assert.equal(validate(withUnknown), false, `${descriptor.id}: unknown fields are rejected`);

    const wrongType = structuredClone(validValue);
    const firstField = descriptor.schema.required[0];
    wrongType[firstField] = 17;
    assert.equal(validate(wrongType), false, `${descriptor.id}: wrong field type/value is rejected`);

    if (descriptor.id === 'media.declarative.value.active-speaker-cut-proposal.v1') {
      const wrongEvidenceClass = structuredClone(validValue);
      wrongEvidenceClass.proposedCuts[0].speakerTurnEvidence.evidenceClass = 'CAMERA_SOURCE_OBSERVATION';
      assert.equal(validate(wrongEvidenceClass), false, 'active-speaker proposal rejects evidence class in the wrong typed slot');
      const missingUncertainty = structuredClone(validValue);
      delete missingUncertainty.proposedCuts[0].uncertaintyRef;
      assert.equal(validate(missingUncertainty), false, 'active-speaker proposal rejects a cut without explicit uncertainty');
    }

    assert.ok(descriptor.operationSchemaRelations.length >= 1, `${descriptor.id}: canonical operation relation`);
    for (const relation of descriptor.operationSchemaRelations) {
      const binding = rowsByCase.get(relation.caseId);
      assert.equal(relation.fieldMapping, 'NOT_ASSERTED', `${descriptor.id}/${relation.caseId}: no unsupported field equivalence claim`);
      if (binding) {
        assert.equal(relation.requestSchemaSource, binding.p1RequestSchemaSource, `${descriptor.id}/${relation.caseId}: exact request selector`);
        assert.equal(relation.resultSchemaSource, binding.p1ResultSchemaSource, `${descriptor.id}/${relation.caseId}: exact result selector`);
        assert.equal(resolveAny(relation.requestSchemaSource), resolveAny(binding.p1RequestSchemaSource));
        assert.equal(resolveAny(relation.resultSchemaSource), resolveAny(binding.p1ResultSchemaSource));
        assert.equal(resolveAny(binding.p1OperationSource).id, binding.canonicalOperationRef);
      } else {
        assert.match(relation.caseId, /^MEDIA-REQ-CAP-/u,
          `${descriptor.id}: non-profile relation must identify a core P0 acceptance case`);
        assert.ok(relation.p0CaseSource, `${descriptor.id}/${relation.caseId}: exact core P0 source selector`);
        assert.equal(resolveAny(relation.p0CaseSource).id, relation.caseId,
          `${descriptor.id}/${relation.caseId}: P0 selector resolves exact acceptance identity`);
        assert.ok(resolveAny(relation.requestSchemaSource), `${descriptor.id}/${relation.caseId}: exact request schema selector`);
        assert.ok(resolveAny(relation.resultSchemaSource), `${descriptor.id}/${relation.caseId}: exact result schema selector`);
      }
      assert.ok(relation.basis?.length > 0, `${descriptor.id}/${relation.caseId}: semantic relation basis`);
    }
    assert.equal(descriptor.runtimeAdmission ?? 'NOT_ADMITTED', 'NOT_ADMITTED', `${descriptor.id}: schema cannot admit runtime`);
  }

  const byId = new Map(contracts.typedProductionValueDescriptors.map(item => [item.id, item]));
  const state = byId.get('media.declarative.value.simulation-state.v1');
  const int64Min = '-9223372036854775808';
  const int64Max = '9223372036854775807';
  const stateSchema = {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://media.invalid/simulation-state', $defs: contracts.$defs, ...state.schema};
  const validateState = makeValidator(stateSchema);
  for (const ticks of [int64Min, int64Max]) {
    const boundaryState = example(state.schema, stateSchema);
    boundaryState.tSimTicks = ticks;
    assert.equal(validateState(boundaryState), true, `simulation state accepts exact signed-64 boundary ${ticks}`);
  }
  for (const ticks of ['-9223372036854775809', '9223372036854775808', '-0', '01', '+1', 1]) {
    const invalidState = example(state.schema, stateSchema);
    invalidState.tSimTicks = ticks;
    assert.equal(validateState(invalidState), false, `simulation state rejects invalid exact tick value ${JSON.stringify(ticks)}`);
  }
  const wrongRngCombo = example(state.schema, stateSchema);
  wrongRngCombo.randomnessSemantics = {disposition: 'NOT_APPLICABLE', nonStochasticDeclarationVersionRef: 'declaration:v1', reason: 'deterministic model'};
  wrongRngCombo.rngStateOrNull = 'rng-state:v1';
  assert.equal(validateState(wrongRngCombo), false, 'non-stochastic state cannot carry RNG state');

  const report = byId.get('media.declarative.value.validation-report.v1');
  const reportSchema = {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://media.invalid/validation-report', $defs: contracts.$defs, ...report.schema};
  const validateReport = makeValidator(reportSchema);
  const invalidReport = example(report.schema, reportSchema);
  invalidReport.applicability = 'BLOCKED';
  invalidReport.verdict = 'PASS';
  assert.equal(validateReport(invalidReport), false, 'blocked scientific validation cannot pass');

  const alignment = byId.get('media.declarative.value.clock-alignment.v1');
  const alignmentSchema = {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://media.invalid/clock-alignment', $defs: contracts.$defs, ...alignment.schema};
  const validateAlignment = makeValidator(alignmentSchema);
  const invalidScale = example(alignment.schema, alignmentSchema);
  invalidScale.rationalScale.numerator = '0';
  assert.equal(validateAlignment(invalidScale), false, 'clock alignment scale must be positive');

  const sharedDefs = resolveAny(contracts.typedProductionValueSchemaContext.sharedDefinitionsSource);
  const clockSchema = {
    $schema: contracts.typedProductionValueSchemaContext.dialect,
    $id: 'https://media.invalid/simulation-clock',
    $defs: sharedDefs,
    ...contracts.$defs.simulationClock,
  };
  const validateClock = makeValidator(clockSchema);
  for (const ticks of [int64Min, int64Max]) {
    const boundaryClock = example(contracts.$defs.simulationClock, clockSchema);
    boundaryClock.ticks = ticks;
    assert.equal(validateClock(boundaryClock), true, `signed-64 boundary ${ticks} is valid`);
  }
  for (const ticks of ['-9223372036854775809', '9223372036854775808']) {
    const outsideClock = example(contracts.$defs.simulationClock, clockSchema);
    outsideClock.ticks = ticks;
    assert.equal(validateClock(outsideClock), false, `signed-64 overflow ${ticks} is rejected exactly`);
  }
  const positiveRationalSchema = {
    $schema: contracts.typedProductionValueSchemaContext.dialect,
    $id: 'https://media.invalid/positive-rational',
    $defs: sharedDefs,
    ...contracts.$defs.positiveRational,
  };
  const validatePositiveRational = makeValidator(positiveRationalSchema);
  const invalidDenominator = example(contracts.$defs.positiveRational, positiveRationalSchema);
  invalidDenominator.denominator = '9223372036854775808';
  assert.equal(validatePositiveRational(invalidDenominator), false, 'positive rational denominator above int64 max is rejected exactly');
});
