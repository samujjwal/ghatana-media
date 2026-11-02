import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { verifyDeclarativeProductionDefinitions } from '../scripts/check-media-declarative-production-definitions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const files = {
  p0: '.product-experience/pdp-0-product-truth/requirements.yaml',
  p1: '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
  p1Operations: '.product-experience/pdp-1-domain-data/operations.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml',
  p3: '.product-experience/pdp-3-product-experience/declarative-production-experience.yaml',
};

test('all PDP-0, PDP-1, and PDP-2 declarative production source contracts reconcile without synthetic runtime claims', () => {
  const result = verifyDeclarativeProductionDefinitions();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.equal(result.stats.recorderCases, 84);
  assert.equal(result.stats.declarativeCases, 61);
  assert.equal(result.stats.p1Bindings, 61);
  assert.equal(result.stats.p2Bindings, 61);
  assert.equal(result.stats.p3Bindings, 61);
  assert.equal(result.stats.valueTypes, 11);
  assert.equal(result.stats.recorderManualEdits, 52);
  assert.equal(result.stats.originClasses, 5);
});

test('reject removed or duplicated canonical PDP-0 case even when parent family unchanged', () => {
  const source = read(files.p0);
  const broken = source.replace('    - id: MEDIA-DECL-P0-AC-061', '    - id: MEDIA-DECL-P0-AC-060');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p0: broken } });
  assert.ok(result.errors.some(e => /PDP-0: exact 61 canonical/.test(e)), result.errors.join('\n'));
});

test('reject missing PDP-1 canonical operation while preserving source case counts', () => {
  const source = read(files.p1);
  const broken = source.replace(
    'canonicalOperationRef: media.operation.capability.media-animation-vector',
    'canonicalOperationRef: media.operation.capability.media-does-not-exist'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(e => /missing or mismatched canonical PDP-1 operation/.test(e)), result.errors.join('\n'));
});

test('reject a PDP-2 drift from exact operation/capability source binding', () => {
  const source = read(files.p2);
  const broken = source.replace(
    'operationRef: media.operation.capability.media-animation-vector',
    'operationRef: media.operation.capability.media-animation-3d'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p2: broken } });
  assert.ok(result.errors.some(e => /missing or mismatched canonical PDP-1 operation/.test(e)), result.errors.join('\n'));
});

test('reject a P2 duplicate YAML mapping even if all 61 source bindings remain', () => {
  const source = read(files.p2);
  const broken = source.replace('  caseCount: 61', '  caseCount: 61\n  caseCount: 61');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p2: broken } });
  assert.ok(result.errors.some(e => /duplicate-key/.test(e)), result.errors.join('\n'));
});

test('reject invalid Newton law reference oracle rather than making the animation plausible', () => {
  const source = read(files.p1);
  const broken = source.replace('testInputs: {massKg: 2', 'testInputs: {massKg: 0');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(e => /analytical force-and-motion oracle inconsistent/.test(e)), result.errors.join('\n'));
});

test('generated H-02 production-spec schema context matches exact PDP-1 descriptor and root definitions', () => {
  const p1 = YAML.parse(read(files.p1));
  const descriptor = p1.typedProductionValueDescriptors.find(value =>
    value.id === 'media.declarative.value.production-spec.v1');
  const generated = JSON.parse(read('runtime-contracts/src/main/resources/contracts/media-production-spec-v1.schema.json'));
  assert.deepEqual(generated.$defs, p1.$defs);
  assert.deepEqual({
    type: generated.type,
    additionalProperties: generated.additionalProperties,
    required: generated.required,
    properties: generated.properties,
  }, descriptor.schema);
  assert.equal(generated.$schema, p1.typedProductionValueSchemaContext.dialect);
});

test('declarative-production checker rejects stale H-02 schema context source or artifact', () => {
  const source = read(files.p1);
  const changedSource = source.replace(
    "versionRef: {type: string, format: opaque-versioned-reference, minLength: 1, maxLength: 384, pattern: '\\S'}",
    "versionRef: {type: string, format: opaque-versioned-reference, minLength: 1, maxLength: 383, pattern: '\\S'}",
  );
  assert.notEqual(source, changedSource);
  const sourceDrift = verifyDeclarativeProductionDefinitions({ overrides: { p1: changedSource } });
  assert.ok(sourceDrift.errors.some(error => /generated production-spec schema context differs/.test(error)),
    sourceDrift.errors.join('\n'));

  const artifact = read('runtime-contracts/src/main/resources/contracts/media-production-spec-v1.schema.json');
  const artifactDrift = verifyDeclarativeProductionDefinitions({
    overrides: { productionSpecSchemaContext: artifact.replace('media.declarative.value.production-spec.v1', 'tampered') },
  });
  assert.ok(artifactDrift.errors.some(error => /generated production-spec schema context differs/.test(error)),
    artifactDrift.errors.join('\n'));

  const changedSourcePath = source.replace(
    '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml#/$defs',
    '.product-experience/pdp-1-domain-data/operations.yaml#/$defs',
  );
  assert.notEqual(source, changedSourcePath);
  const wrongSource = verifyDeclarativeProductionDefinitions({ overrides: { p1: changedSourcePath } });
  assert.ok(wrongSource.errors.some(error => /cannot derive or verify generated production-spec schema context/.test(error)),
    wrongSource.errors.join('\n'));
});

test('reject conversion of educational model time into editorial story time', () => {
  const source = read(files.p2);
  const broken = source.replace(
    'Pausing or seeking tStory never mutates tSim',
    'Pausing or seeking story-time advances physics'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p2: broken } });
  assert.ok(result.errors.some(e => /simulation time and model\/visual authority/.test(e)), result.errors.join('\n'));
});

test('refuse premature phase DEV_COMPLETE status from an unexecuted source proposal', () => {
  const source = read(files.p1);
  const broken = source.replace('status: SOURCE_AUTHORED_DEFINITION_ONLY', 'status: DEV_COMPLETE');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(e => /cannot self-declare current-source DEV_COMPLETE/.test(e)), result.errors.join('\n'));
});

test('reject a PDP-3 journey/operation drift even with all 61 successor cases present', () => {
  const source = read(files.p3);
  const broken = source.replace(
    'pdp1OperationRef: media.operation.capability.media-animation-vector',
    'pdp1OperationRef: media.operation.capability.media-animation-3d'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p3: broken } });
  assert.ok(result.errors.some(e => /PDP-3 successor lacks exact P0\/1\/2/.test(e)), result.errors.join('\n'));
});

test('H-02 execution admission remains separate, NOT_ADMITTED, and node-binds explicit NO_ENGINE identities', () => {
  const source = YAML.parse(read(files.p1));
  const binding = source.executionAdmissionBinding;
  assert.equal(binding.id, 'media.production.execution-admission.v3');
  assert.equal(binding.runtimeAdmission, 'NOT_ADMITTED');
  assert.ok(binding.requiredFields.includes('perSceneImmutableSourceVersionDigestRightsOwnerDecisionExpiryAndRevocation'));
  assert.equal(binding.operationSchemaRelation.operationRef, 'media.recipe.specification.compile');
  assert.equal(binding.operationSchemaRelation.relation, 'COMPILES_PLAN_ADMISSION_CONTEXT');
  assert.equal(binding.operationSchemaRelation.fieldMapping, 'NOT_APPLICABLE_SEPARATE_VERSIONED_ENVELOPE');
  assert.equal(binding.operationSchemaRelation.status, 'OWNER_AUTHORED_SOURCE_MAPPING_REVIEW_REQUIRED');
  assert.equal(binding.operationSchemaRelation.planBindingRules.appliesTo, 'LEGACY_COMPILATION_PATH_ONLY');
  assert.equal(binding.operationSchemaRelation.planBindingRules.enginesByStepKeys,
    'EXACT_EQUAL_TO_COMPILED_PLAN_NODE_STEP_IDS');
  assert.equal(binding.operationSchemaRelation.planBindingRules.compiledPlanSchemaVersion, 'media.production-plan.v1');
  assert.deepEqual(binding.operationSchemaRelation.planBindingRules.compiledPlanSteps.map(step =>
    step.stepId ?? step.stepIdTemplate), [
    'validate-spec', 'rights-review', 'capture-source-{zeroBasedSceneIndex}', 'compose-timeline',
    'render-profile-{zeroBasedOutputProfileIndex}', 'publish-review',
  ]);
  assert.equal(binding.operationSchemaRelation.planBindingRules.stepOperationMapping,
    'EXACT_IDENTICAL_STEP_ID_JOIN_ONLY; OPERATION_COMPATIBILITY_UNPROVEN');
  assert.deepEqual(binding.operationSchemaRelation.semanticCandidateBindingRules, {
    appliesTo: 'DIGEST_BOUND_PER_INSTANCE_SEMANTIC_SOURCE_CANDIDATE_ONLY',
    input3GraphStepIds: 'EXACT_EXPLICIT_SEMANTIC_SOURCE_NODES_STEP_IDS',
    enginesByStepKeys: 'EXACT_EQUAL_TO_INPUT3_GRAPH_STEP_IDS',
    legacyFixedDagPlanIds: 'MAY_DIFFER; LEGACY_PLAN_BINDING_RULES_DO_NOT_APPLY',
    operationToEngineCompatibility: 'UNPROVEN',
    resolverAuthorityAndSourceCurrentness: 'UNPROVEN',
    resultKind: 'EFFECT_FREE_SEMANTIC_SOURCE_V3_CANDIDATE',
    doesNotProduce: ['COMPILED_PLAN', 'EXECUTABLE_PLAN', 'DISPATCH', 'JOB', 'ADMISSION'],
    runtimeAdmission: 'NOT_ADMITTED',
  });
  assert.equal(binding.operationSchemaRelation.status, 'OWNER_AUTHORED_SOURCE_MAPPING_REVIEW_REQUIRED');
  assert.equal(source.semanticSource.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(source.semanticSource.resultSemantics.UNKNOWN.includes('STEP_ID_SET_MISMATCH'), false);
  assert.equal(source.semanticSource.resultSemantics.NOT_ADMITTED.includes('EXECUTION_CONTEXT_MISMATCH'), true);
  assert.equal(source.semanticSource.executionAdmissionMapping.stepOperationMapping,
    'OWNER_AUTHORED_EXACT_STEP_ID_JOIN_CANDIDATE_REVIEW_REQUIRED');
  assert.match(source.semanticSource.executionAdmissionMapping.rule,
    /exact stepId keys are identical/);
  assert.match(source.semanticSource.executionAdmissionMapping.rule,
    /does not prove resolver authority/);
  assert.match(source.semanticSource.executionAdmissionMapping.rule,
    /engine-operation compatibility/);
  assert.deepEqual(source.semanticSource.executionAdmissionMapping.candidateFingerprint, {
    algorithm: 'SHA256_OVER_LENGTH_PREFIXED_UTF8_FIELDS',
    orderedFields: [
      'media.production.semantic-source-v3-candidate.v1', 'semanticSourceRef', 'semanticSourceSha256',
      'normalizedGraphFingerprint', 'executionAdmissionBindingFingerprint',
    ],
    outputField: 'SemanticCandidateBindResult.candidateFingerprint',
    status: 'DETERMINISTIC_EFFECT_FREE_CANDIDATE_IDENTITY_ONLY',
  });
  assert.match(source.semanticSource.executionAdmissionMapping.rule,
    /Candidate preparation produces no dispatch, job, project mutation, provider call, or admission decision/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input2ProductionSpecSchema,
    /EXACT_VERSIONED_REFERENCE_AND_SUPPLIED_PRODUCTION_SPEC_SCHEMA_VERSION_MUST_MATCH_SPEC_SCHEMA_VERSION/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input1Content,
    /CHECKS_EXACT_REFERENCE_ECHO_AND_SHA256_OF_RETURNED_BYTES/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.typedProductionSpecInput,
    /DECODED_INPUT1_VALUE_TO_STRUCTURALLY_EQUAL_THE_TYPED_MIRROR/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input2ProductionSpecSchema,
    /RESOLVER_OVERLOAD_REQUIRES_INPUT2_STRICTLY_PARSED_JSON_TO_BE_STRUCTURALLY_EQUAL_TO_THE_CANONICAL_PRODUCTION_SPEC_SCHEMA_WITH_THE_EXACT_SHARED_PDP1_\$DEFS_MATERIALIZED/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input2ProductionSpecSchema,
    /SHA256_BINDS_THE_ACTUAL_RESOLVED_INPUT2_BYTES/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input2ProductionSpecSchema,
    /RESOLVED_SCHEMA_DOCUMENT_\$ID_IS_NOT_MATCHED_TO_THE_SUPPLIED_VERSION/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input3CompilerContract,
    /RESOLVER_OVERLOAD_CHECKS_REFERENCE_ECHO_AND_SHA256_OF_RETURNED_BYTES/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input3CompilerContract,
    /CLOSED_MEDIA_PRODUCTION_COMPILER_CONTRACT_V1_INSTANCE_BOUND_TO_THE_EXACT_INPUT1_AND_INPUT2_REFS_AND_DIGESTS/);
  const compilerContract = binding.operationSchemaRelation.operationInputCoverage.input3CompilerContractSchema;
  assert.equal(compilerContract.id, 'media.production.compiler-contract.v1');
  assert.equal(compilerContract.schema.type, 'object');
  assert.equal(compilerContract.schema.additionalProperties, false);
  assert.deepEqual(compilerContract.schema.required, [
    'schemaVersion', 'targetProductionSpecRef', 'targetProductionSpecSha256',
    'targetProductionSpecSchemaRef', 'targetProductionSpecSchemaSha256', 'steps',
  ]);
  assert.equal(compilerContract.schema.properties.schemaVersion.const, 'media.production.compiler-contract.v1');
  assert.equal(compilerContract.schema.properties.steps.items.$ref,
    '#/semanticSource/schema/properties/nodes/items');
  assert.deepEqual(compilerContract.candidateFingerprint, {
    algorithm: 'SHA256_OVER_LENGTH_PREFIXED_UTF8_FIELDS',
    orderedFields: [
      'media.production.semantic-graph-resolved-input-candidate.v1',
      'productionSpecRef', 'productionSpecSha256', 'productionSpecByteLength',
      'productionSpecSchemaRef', 'productionSpecSchemaSha256', 'productionSpecSchemaByteLength',
      'compilerContractRef', 'compilerContractSha256', 'compilerContractByteLength',
      'normalizedGraphFingerprint',
    ],
    outputField: 'MediaProductionSemanticSource.CompilationResult.fingerprint',
    status: 'DETERMINISTIC_EFFECT_FREE_CANDIDATE_IDENTITY_ONLY',
  });
  assert.match(compilerContract.bindingRule,
    /must equal the exact resolver-confirmed input1\/input2 references and byte digests/);
  assert.match(compilerContract.bindingRule,
    /no template, label, stepId, implementation, kind, or engine identity is used to infer/);
  assert.match(compilerContract.ownerAuthoredAssumption,
    /input3 must provide the complete explicit step graph/);
  assert.equal(compilerContract.nodeKindRule,
    'DETERMINISTIC_OR_GENERATIVE_REQUIRED; UNKNOWN_OR_UNSUPPORTED_KIND_RETURNS_UNKNOWN');
  assert.equal(compilerContract.operationResolution,
    'EXACT_OPERATION_REF_WITH_ONE_CALLER_SUPPLIED_RESOLUTION; AUTHORITY_AND_CURRENTNESS_UNPROVEN');
  assert.equal(compilerContract.effect, 'NO_DISPATCH_NO_JOB_NO_PROJECT_MUTATION_NO_PROVIDER_CALL');
  assert.deepEqual(binding.operationSchemaRelation.operationInputCoverage.notImplementedInputs,
    ['input1-immutable-version-and-authorization-proof', 'input3-resolver-authority-and-source-currentness',
      'input5-target-schema', 'input6-migration-transformation']);
  assert.equal(binding.operationSchemaRelation.operationInputCoverage.schemaMigrationCandidate,
    'NOT_IMPLEMENTED; UNKNOWN_UNSUPPORTED_WITHOUT_A_SOURCE_DECLARED_SUPPORTED_TRANSFORMATION');
  assert.equal(binding.operationSchemaRelation.sourceAndLockCoverage.oneLockAuthorizesOtherScenesOrOutputsInPlan, false);
  assert.equal(binding.operationSchemaRelation.effectBoundary.beforeProviderDispatchRetryOrRestart.implementationStatus,
    'NOT_WIRED_TO_H02_EXECUTION_PATH');
  assert.equal(binding.operationSchemaRelation.planBindingRules.optionalProjectRevisionRef,
    'EXACT_EQUAL_TO_PRODUCTION_SPEC_REVISION_ID_OR_REJECT_STALE');
  assert.equal(binding.operationSchemaRelation.effectBoundary.runtimeAdmission,
    'NOT_ADMITTED_PENDING_INDEPENDENT_SOURCE_REVIEW_AND_AUTHORITY_BACKED_ADAPTER');
  const operations = YAML.parse(read(files.p1Operations));
  const compileOperation = operations.capabilityOperationContracts.definitionExtensionOperationMappings.find(operation =>
    operation.id === 'media.definition-extension-operation.media-recipe-specification-compile');
  assert.ok(compileOperation, 'H-02 keeps the existing compile operation identity');
  assert.deepEqual(compileOperation.inputSlots.map(slot => slot.slotId),
    ['input1', 'input2', 'input3', 'input4', 'input5', 'input6']);
  assert.deepEqual(binding.schema.properties.requestIdentity.required, ['requestId', 'requestFingerprint']);
  assert.ok(binding.schema.required.includes('sourceBindingsByScene'));
  const sourcesByScene = binding.schema.properties.sourceBindingsByScene;
  assert.equal(sourcesByScene.type, 'object');
  assert.equal(sourcesByScene.additionalProperties.additionalProperties, false);
  assert.deepEqual(sourcesByScene.additionalProperties.required,
    ['sourceVersionRef', 'sourceSha256', 'rightsRef', 'ownerDecisionRef', 'decisionExpiresAt', 'revocationEpoch']);
  assert.equal(binding.schema.properties.enginesByStep.minProperties, 1);
  const enginesByStep = binding.schema.properties.enginesByStep;
  const engine = enginesByStep.additionalProperties;
  assert.deepEqual(engine.properties.identityKind.enum, ['ENGINE', 'MODEL', 'SOLVER', 'NO_ENGINE']);
  assert.equal(engine.allOf[0].if.properties.identityKind.const, 'NO_ENGINE');
  assert.equal(engine.allOf[0].then.properties.identity.const, 'NO_ENGINE');
  assert.equal(engine.allOf[0].then.properties.immutableBuildSha256.const, 'NO_ENGINE');
  assert.equal(engine.allOf[1].then.properties.identity.not.const, 'NO_ENGINE');
  assert.equal(engine.allOf[1].then.properties.immutableBuildSha256.$ref, '#/$defs/immutableSha256');
  const schema = binding.schema.properties;
  assert.deepEqual(schema.reservation.required, [
    'quoteRef', 'quoteVersion', 'reservationId', 'worstCaseCost', 'reservedCost',
    'worstCaseCompute', 'reservedCompute', 'worstCaseTime', 'reservedTime',
  ]);
  for (const field of ['worstCaseCost', 'reservedCost', 'worstCaseCompute', 'reservedCompute', 'worstCaseTime', 'reservedTime']) {
    assert.equal(schema.reservation.properties[field].$ref, '#/$defs/boundedQuantity', `${field} is bounded and unit typed`);
  }
  assert.deepEqual(schema.authority.required, [
    'identityContextRef', 'identityContextSha256', 'identityEpoch',
    'tenantId', 'principalId', 'delegationRef', 'workspaceRef', 'purposeRef', 'rightsRef', 'sourceVersionRef', 'sourceSha256',
    'ownerDecisionRef', 'decisionExpiresAt', 'revocationEpoch',
  ]);
  assert.equal(schema.authority.properties.identityContextRef.$ref, '#/$defs/versionRef');
  assert.equal(schema.authority.properties.identityContextSha256.$ref, '#/$defs/immutableSha256');
  assert.equal(schema.authority.properties.identityEpoch.$ref, '#/$defs/nonnegativeInt64');
  assert.equal(schema.authority.properties.delegationRef.$ref, '#/$defs/versionRef');
  assert.equal(schema.authority.properties.workspaceRef.$ref, '#/$defs/versionRef');
  assert.deepEqual(schema.project.required, ['projectId', 'expectedRevision', 'compareAndSet']);
  assert.deepEqual(schema.editLocksByStep.additionalProperties.required,
    ['scopeKind', 'targetRef', 'ownerPrincipalId', 'leaseId', 'epoch', 'expiresAt']);
  assert.deepEqual(schema.clocks.required,
    ['storyClockRef', 'mediaClockRef', 'simulationClockRef', 'wallClockRef', 'conversions']);
  const mapping = binding.operationSchemaRelation.admissionContextBindingRules;
  assert.equal(mapping.authenticatedIdentity.source,
    '.product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope');
  assert.deepEqual(Object.keys(mapping.authenticatedIdentity.tuple), [
    'tenantId', 'principalId', 'delegationRef', 'workspaceRef', 'identityEpoch',
  ]);
  assert.match(mapping.authenticatedIdentity.tuple.tenantId, /HOST_ATTESTED.*CALLER_BODY_COMPARE_ONLY/);
  assert.match(mapping.authenticatedIdentity.tuple.principalId, /HOST_ATTESTED.*CALLER_BODY_COMPARE_ONLY/);
  assert.match(mapping.authenticatedIdentity.tuple.delegationRef, /CURRENT_HOST_ATTESTED.*CALLER_BODY_COMPARE_ONLY/);
  assert.match(mapping.authenticatedIdentity.tuple.workspaceRef, /HOST_AUTHORIZED.*CALLER_SELECTOR_CANNOT_WIDEN/);
  assert.equal(mapping.authenticatedIdentity.tuple.identityEpoch, 'MUST_MATCH_CURRENT_TRUSTED_IDENTITY_EPOCH');
  assert.equal(mapping.authenticatedIdentity.missingStaleOrMismatched, 'NOT_ADMITTED_BEFORE_LOOKUP_OR_EFFECT');
  assert.equal(mapping.reservation.reservedCostComputeAndTime,
    'MUST_EACH_COVER_WORST_CASE_IN_THE_SAME_UNIT');
  assert.equal(mapping.currentAuthority.decision,
    'RE_RESOLVE_CURRENT_OWNER_DECISION_AND_REVOCATION_EPOCH_BEFORE_EACH_EFFECT');
  assert.match(mapping.currentAuthority.sourceBindingsByScene.keys,
    /EXACT_EQUAL_TO_PRODUCTION_SPEC_SCENE_REFS/);
  assert.match(mapping.currentAuthority.sourceBindingsByScene.captureStepIndex,
    /capture-source-\{i\}_MUST_MATCH_PRODUCTION_SPEC_SCENE_REFS\[i\]/);
  assert.match(binding.operationSchemaRelation.planBindingRules.captureGuard,
    /EXACT_COMPILED_CAPTURE_NODE_ID_AND_SINGLETON_SCENE_REF/);
  assert.match(mapping.currentAuthority.sourceBindingsByScene.recheck,
    /BEFORE_EACH_SCENE_DISPATCH_RETRY_AND_RESTART/);
  assert.equal(mapping.projectRevision,
    'EXACT_EQUAL_TO_PRODUCTION_SPEC_REVISION_ID_AND_COMPARE_AND_SET_REQUIRED');
  assert.equal(mapping.editLock.multiTargetCoverage,
    'ONE_EXACT_TARGET_PER_LOCK; NO_IMPLICIT_SHARING');
  assert.equal(mapping.clocks.missingOrAmbiguousMapping, 'NOT_ADMITTED');
  assert.match(binding.executionRule, /reserved cost, compute, and time\s+must each cover their corresponding worst-case bound/iu);
  assert.match(binding.executionRule, /sourceBindingsByScene keys must exactly equal ProductionSpec\.sceneRefs/u);
});

test('H-02 keeps the legacy fixed-DAG prototype separate from the digest-bound per-instance candidate', () => {
  const source = YAML.parse(read(files.p1));
  const assertBoundaries = document => {
    const legacy = document.executionAdmissionBinding.operationSchemaRelation.legacyCompilationPath;
    const semantic = document.semanticSource;
    const mapping = document.executionAdmissionBinding.operationSchemaRelation;
    const legacyRules = mapping.planBindingRules;
    const semanticRules = mapping.semanticCandidateBindingRules;
    const effect = mapping.effectBoundary;
    const lock = mapping.admissionContextBindingRules.editLock;

    assert.equal(legacy.api, 'media.recipe.specification.compile');
    assert.equal(legacy.helper, 'MediaProductionSpecCompiler.compile(spec)');
    assert.equal(legacy.output, 'media.production-plan.v1');
    assert.deepEqual(legacy.stepIds, [
      'validate-spec', 'rights-review', 'capture-source-{zeroBasedSceneIndex}', 'compose-timeline',
      'render-profile-{zeroBasedOutputProfileIndex}', 'publish-review',
    ]);
    assert.equal(legacy.stepIdDisposition,
      'LEGACY_FIXED_DAG_PROTOTYPE_ONLY; NOT_SEMANTIC_SOURCE_STEP_ID_AUTHORITY');
    assert.equal(legacy.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(legacyRules.appliesTo, 'LEGACY_COMPILATION_PATH_ONLY');
    assert.deepEqual(legacyRules.compiledPlanSteps.map(step => step.stepId ?? step.stepIdTemplate), legacy.stepIds);

    assert.equal(semanticRules.appliesTo, 'DIGEST_BOUND_PER_INSTANCE_SEMANTIC_SOURCE_CANDIDATE_ONLY');
    assert.equal(semanticRules.input3GraphStepIds, 'EXACT_EXPLICIT_SEMANTIC_SOURCE_NODES_STEP_IDS');
    assert.equal(semanticRules.enginesByStepKeys, 'EXACT_EQUAL_TO_INPUT3_GRAPH_STEP_IDS');
    assert.match(semanticRules.legacyFixedDagPlanIds, /MAY_DIFFER/);
    assert.match(semanticRules.legacyFixedDagPlanIds, /RULES_DO_NOT_APPLY/);
    assert.equal(semanticRules.operationToEngineCompatibility, 'UNPROVEN');
    assert.equal(semanticRules.resolverAuthorityAndSourceCurrentness, 'UNPROVEN');
    assert.equal(semanticRules.resultKind, 'EFFECT_FREE_SEMANTIC_SOURCE_V3_CANDIDATE');
    assert.deepEqual(semanticRules.doesNotProduce, ['COMPILED_PLAN', 'EXECUTABLE_PLAN', 'DISPATCH', 'JOB', 'ADMISSION']);
    assert.equal(semanticRules.runtimeAdmission, 'NOT_ADMITTED');

    assert.equal(semantic.compilationPath.kind, 'DIGEST_BOUND_PER_INSTANCE_SEMANTIC_SOURCE_CANDIDATE');
    assert.equal(semantic.compilationPath.graphStepIdAuthority, 'EXACT_EXPLICIT_INPUT3_NODES_STEP_ID_VALUES');
    assert.equal(semantic.compilationPath.engineKeyJoin, 'EXACT_EQUAL_TO_THOSE_GRAPH_STEP_IDS');
    assert.match(semantic.compilationPath.legacyFixedDagStepIds, /MAY_DIFFER/);
    assert.match(semantic.compilationPath.legacyFixedDagStepIds, /NOT_A_CONSTRAINT/);
    assert.equal(semantic.compilationPath.operationToEngineCompatibility, 'UNPROVEN');
    assert.equal(semantic.compilationPath.resolverAuthorityAndSourceCurrentness, 'UNPROVEN');
    assert.equal(semantic.compilationPath.runtimeAdmission, 'NOT_ADMITTED');
    assert.match(semantic.executionAdmissionMapping.pathSeparation.legacyFixedDagPlanIds, /MAY_DIFFER/);
    assert.equal(semantic.executionAdmissionMapping.pathSeparation.operationToEngineCompatibility, 'UNPROVEN');
    assert.equal(semantic.executionAdmissionMapping.pathSeparation.resolverAuthorityAndCurrentness, 'UNPROVEN');
    assert.equal(semantic.executionAdmissionMapping.pathSeparation.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(mapping.status, 'OWNER_AUTHORED_SOURCE_MAPPING_REVIEW_REQUIRED');
    assert.equal(effect.beforeProviderDispatchRetryOrRestart.implementationStatus, 'NOT_WIRED_TO_H02_EXECUTION_PATH');
    assert.equal(effect.runtimeAdmission, 'NOT_ADMITTED_PENDING_INDEPENDENT_SOURCE_REVIEW_AND_AUTHORITY_BACKED_ADAPTER');

    assert.equal(lock.ownerPrecondition,
      'CONSERVATIVE_JAVA_CANDIDATE_CHECK_REQUIRES_LOCK_OWNER_EQUAL_AUTHENTICATED_AUTHORITY_PRINCIPAL');
    assert.equal(lock.beforeEffectReadback,
      'AUTHORITATIVE_CURRENT_FENCED_LOCK_READBACK_MUST_MATCH_TARGET_SCOPE_OWNER_LEASE_ID_EPOCH_AND_EXPIRY');
    assert.equal(lock.candidateOnly,
      'OWNER_EQUALITY_IS_A_STRUCTURAL_PRECONDITION_NOT_TRUSTED_LOCK_AUTHORITY_OR_ADMISSION');
  };

  assertBoundaries(source);

  const conflated = structuredClone(source);
  conflated.semanticSource.compilationPath.legacyFixedDagStepIds = 'EXACT_EQUAL_TO_LEGACY_FIXED_DAG_STEP_IDS';
  assert.throws(() => assertBoundaries(conflated), /MAY_DIFFER/);

  const broadenedLegacyRules = structuredClone(source);
  broadenedLegacyRules.executionAdmissionBinding.operationSchemaRelation.planBindingRules.appliesTo =
    'LEGACY_AND_SEMANTIC_SOURCE_CANDIDATES';
  assert.throws(() => assertBoundaries(broadenedLegacyRules), /LEGACY_COMPILATION_PATH_ONLY/);

  const compatibilityInvented = structuredClone(source);
  compatibilityInvented.semanticSource.compilationPath.operationToEngineCompatibility = 'PROVEN';
  assert.throws(() => assertBoundaries(compatibilityInvented), /UNPROVEN/);

  const admissionOpened = structuredClone(source);
  admissionOpened.semanticSource.compilationPath.runtimeAdmission = 'ADMITTED';
  assert.throws(() => assertBoundaries(admissionOpened), /NOT_ADMITTED/);

  const lockTrustInvented = structuredClone(source);
  lockTrustInvented.executionAdmissionBinding.operationSchemaRelation.admissionContextBindingRules.editLock.beforeEffectReadback =
    'CANDIDATE_BINDING_IS_CURRENT_LOCK_AUTHORITY';
  assert.throws(() => assertBoundaries(lockTrustInvented), /AUTHORITATIVE_CURRENT_FENCED_LOCK_READBACK/);
});

test('H-02 source checker rejects a capture index rule that permits a different scene', () => {
  const source = read(files.p1);
  const broken = source.replace(
    'capture-source-{i}_MUST_MATCH_PRODUCTION_SPEC_SCENE_REFS[i]',
    'capture-source-{i}_MAY_MATCH_ANOTHER_SCENE'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(error => /capture guard must bind the exact indexed plan scene/.test(error)),
    result.errors.join('\n'));
});

test('H-02 source checker rejects an unbound or caller-supplied identity context', () => {
  const source = read(files.p1);
  const broken = source.replace(
    'required: [identityContextRef, identityContextSha256, identityEpoch, tenantId, principalId, delegationRef, workspaceRef, purposeRef, rightsRef, sourceVersionRef, sourceSha256, ownerDecisionRef, decisionExpiresAt, revocationEpoch]',
    'required: [tenantId, principalId, purposeRef, rightsRef, sourceVersionRef, sourceSha256, ownerDecisionRef, decisionExpiresAt, revocationEpoch]',
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(error => /complete host-attested identity tuple and current identity epoch/.test(error)),
    result.errors.join('\n'));

  const wrongSource = source.replace(
    '.product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope',
    '.product-experience/pdp-1-domain-data/authority.yaml#identityScope',
  );
  assert.notEqual(source, wrongSource);
  const wrongSourceResult = verifyDeclarativeProductionDefinitions({ overrides: { p1: wrongSource } });
  assert.ok(wrongSourceResult.errors.some(error => /complete host-attested identity tuple and current identity epoch/.test(error)),
    wrongSourceResult.errors.join('\n'));
});

test('H-02 source checker rejects omitted delegation/workspace tuple members and unresolved authority anchors', () => {
  const source = read(files.p1);
  const requiredTuple = 'identityContextRef, identityContextSha256, identityEpoch, tenantId, principalId, delegationRef, workspaceRef, purposeRef';
  for (const field of ['delegationRef', 'workspaceRef']) {
    const omitted = source.replace(requiredTuple, requiredTuple.replace(`, ${field}`, ''));
    assert.notEqual(source, omitted, `expected ${field} removal fixture to alter PDP-1`);
    const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: omitted } });
    assert.ok(result.errors.some(error => /complete host-attested identity tuple and current identity epoch/.test(error)),
      result.errors.join('\n'));
  }

  const wrongAnchor = source.replace(
    '.product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope',
    '.product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/movedIdentityScope',
  );
  assert.notEqual(source, wrongAnchor);
  const wrongAnchorResult = verifyDeclarativeProductionDefinitions({ overrides: { p1: wrongAnchor } });
  assert.ok(wrongAnchorResult.errors.some(error => /complete host-attested identity tuple and current identity epoch/.test(error)),
    wrongAnchorResult.errors.join('\n'));

  const missingAuthorityPath = '.product-experience/pdp-1-domain-data/missing-authority.yaml';
  const missingAuthority = source.replace(
    '.product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope',
    `${missingAuthorityPath}#ownerDefinedPdp10AuthorityScopes/identityScope`,
  );
  assert.notEqual(source, missingAuthority);
  const missingAuthorityResult = verifyDeclarativeProductionDefinitions({ overrides: { p1: missingAuthority } });
  assert.ok(missingAuthorityResult.errors.some(error => /complete host-attested identity tuple and current identity epoch/.test(error)),
    missingAuthorityResult.errors.join('\n'));

  const authority = read('.product-experience/pdp-1-domain-data/authority.yaml');
  const authorityMutations = [
    ['ownerDefinedPdp10AuthorityScopes:', 'ownerDefinedPdp10AuthorityScopesMoved:'],
    ['  identityScope:', '  identityScopeMoved:'],
    ['    delegationRef: host-attested, current delegation; caller role labels are not grants',
      '    delegationIdentity: host-attested, current delegation; caller role labels are not grants'],
    ['    requiredObservation: Current trusted identity owner observation bound to the request, identity epoch and exact tenant, principal, delegation and workspace tuple.',
      '    identityObservation: Current trusted identity owner observation bound to the request, identity epoch and exact tenant, principal, delegation and workspace tuple.'],
    ['workspaceRef: host-authorized workspace context; caller selector cannot widen scope',
      'workspaceSelector: caller selector may widen scope'],
  ];
  for (const [before, after] of authorityMutations) {
    const mutatedAuthority = authority.replace(before, after);
    assert.notEqual(authority, mutatedAuthority, `expected authority mutation for ${before} to alter source`);
    const result = verifyDeclarativeProductionDefinitions({ overrides: { authority: mutatedAuthority } });
    assert.ok(result.errors.some(error => /complete host-attested identity tuple and current identity epoch/.test(error)),
      result.errors.join('\n'));
  }
});
