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
  assert.equal(binding.id, 'media.production.execution-admission.v2');
  assert.equal(binding.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(binding.operationSchemaRelation.operationRef, 'media.recipe.specification.compile');
  assert.equal(binding.operationSchemaRelation.relation, 'COMPILES_PLAN_ADMISSION_CONTEXT');
  assert.equal(binding.operationSchemaRelation.fieldMapping, 'NOT_APPLICABLE_SEPARATE_VERSIONED_ENVELOPE');
  assert.equal(binding.operationSchemaRelation.status, 'OWNER_AUTHORED_SOURCE_MAPPING_REVIEW_REQUIRED');
  assert.equal(binding.operationSchemaRelation.planBindingRules.enginesByStepKeys,
    'EXACT_EQUAL_TO_COMPILED_PLAN_NODE_STEP_IDS');
  assert.equal(binding.operationSchemaRelation.planBindingRules.compiledPlanSchemaVersion, 'media.production-plan.v1');
  assert.deepEqual(binding.operationSchemaRelation.planBindingRules.compiledPlanSteps.map(step =>
    step.stepId ?? step.stepIdTemplate), [
    'validate-spec', 'rights-review', 'capture-source-{zeroBasedSceneIndex}', 'compose-timeline',
    'render-profile-{zeroBasedOutputProfileIndex}', 'publish-review',
  ]);
  assert.equal(binding.operationSchemaRelation.planBindingRules.stepOperationMapping,
    'NOT_DEFINED_BY_LOCAL_COMPILE_CANDIDATE');
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input2ProductionSpecSchema,
    /EXACT_VERSIONED_REFERENCE_AND_DECLARED_SCHEMA_ID_MUST_MATCH_PRODUCTION_SPEC_SCHEMA_VERSION/);
  assert.match(binding.operationSchemaRelation.operationInputCoverage.input3CompilerContract,
    /EXACT_VERSIONED_REFERENCE_REQUIRED_AND_BOUND_IN_FINGERPRINT/);
  assert.deepEqual(binding.operationSchemaRelation.operationInputCoverage.notImplementedInputs,
    ['input1-content-digest-attestation', 'input2-schema-content-resolution-and-validation',
      'input3-compiler-content-resolution-and-step-kind-semantics',
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
    'tenantId', 'principalId', 'purposeRef', 'rightsRef', 'sourceVersionRef', 'sourceSha256',
    'ownerDecisionRef', 'decisionExpiresAt', 'revocationEpoch',
  ]);
  assert.deepEqual(schema.project.required, ['projectId', 'expectedRevision', 'compareAndSet']);
  assert.deepEqual(schema.editLocksByStep.additionalProperties.required,
    ['scopeKind', 'targetRef', 'ownerPrincipalId', 'leaseId', 'epoch', 'expiresAt']);
  assert.deepEqual(schema.clocks.required,
    ['storyClockRef', 'mediaClockRef', 'simulationClockRef', 'wallClockRef', 'conversions']);
  const mapping = binding.operationSchemaRelation.admissionContextBindingRules;
  assert.equal(mapping.reservation.reservedCostComputeAndTime,
    'MUST_EACH_COVER_WORST_CASE_IN_THE_SAME_UNIT');
  assert.equal(mapping.currentAuthority.decision,
    'RE_RESOLVE_CURRENT_OWNER_DECISION_AND_REVOCATION_EPOCH_BEFORE_EACH_EFFECT');
  assert.equal(mapping.projectRevision,
    'EXACT_EQUAL_TO_PRODUCTION_SPEC_REVISION_ID_AND_COMPARE_AND_SET_REQUIRED');
  assert.equal(mapping.editLock.multiTargetCoverage,
    'ONE_EXACT_TARGET_PER_LOCK; NO_IMPLICIT_SHARING');
  assert.equal(mapping.clocks.missingOrAmbiguousMapping, 'NOT_ADMITTED');
  assert.match(binding.executionRule, /reserved cost, compute, and time\s+must each cover their corresponding worst-case bound/iu);
  assert.match(binding.executionRule, /one sourceVersionRef cannot authorize a\s+multi-source plan/u);
});
