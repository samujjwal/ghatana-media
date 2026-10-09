import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const [capabilities, policy, quality, operations, authority, privacy, versioning, channels, reuse] = await Promise.all([
  readFile('.product-experience/pdp-0-product-truth/capabilities.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/policy-authority-model.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/quality-policy.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-1-domain-data/authority.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-1-domain-data/privacy.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-1-domain-data/versioning.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/applications-channels.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/reuse-decisions.yaml', 'utf8').then(parse),
]);
const cap = (id) => capabilities.capabilities.find((entry) => entry.id === id);
const axis = (id) => policy.productPolicy.independentGovernanceAxes.find((entry) => entry.axis === id);
const operation = (id) => operations.operations.find((entry) => entry.id === id);
const operationCapability = (id) => operations.capabilityOperationContracts.records.find((entry) => entry.capabilityRef === id);
const ownerOperation = (id) => operations.ownerDefinedOperationContracts.records.find((entry) => entry.id === id)
  ?? operations.individualOperationContracts.records.find((entry) => entry.id === id);

test('MPSEM-0187-C001: identity and gaze analysis remain scoped uncertain inferences', () => {
  const gaze = cap('media.vision.analyze.gaze');
  assert.match(gaze.constraints[3], /purpose-specific authority, rights\/consent, applicability, limits, and qualified handling/u);
  assert.match(gaze.constraints[3], /inference is not fact/u);
  assert.equal(axis('likeness-voice-and-biometric-rights').default, 'explicit-separate-authority-required-for-biometric-operation');
});

test('MPSEM-0212-C005 and MPSEM-0291-C006: compatibility and fallback require exact profiles and declared confirmation', () => {
  const compatibility = quality.deliveryCompatibilityPolicy;
  assert.ok(compatibility.targetBinding.required.includes('playerOrConsumerContract'));
  assert.ok(compatibility.fallback.require.includes('explicit-confirmation-when-required'));
  const delivery = quality.protectedSemanticProperties.find((entry) => entry.id === 'PROTECTED-DELIVERY-CONSTRAINTS');
  assert.match(delivery.rule, /explicitly permitted with a declared floor, confirmation, and compatible binding/u);
});

test('MPSEM-0287-C001: processing location remains a distinct explicit policy axis', () => {
  const locality = axis('processing-locality');
  assert.deepEqual(locality.values, ['local', 'remote', 'hybrid', 'unknown']);
  assert.equal(locality.default, 'no-location-claim-without-binding-and-observation');
});

test('MPSEM-0298-C001 and MPSEM-0298-C002: generic job request is closed, typed, bounded, and host-scoped', () => {
  const contract = operation('media.operation.transcription-submission');
  assert.equal(contract.inputSemantics.branchFieldRule, 'exactly-the-allowedFields-for-selected-requestMode; reject-unknown-branch-mixed-caller-identity-or-ignored-fields-before-any-effect');
  assert.ok(contract.inputSemantics.submitRequiredFields.includes('profileConfigurationDigest'));
  assert.equal(contract.context.callerCannotSupplyOrOverrideTrustedIdentity, true);
  assert.ok(contract.context.trustedIdentityFields.includes('tenantId'));
  assert.ok(contract.context.trustedIdentityFields.includes('principalId'));
  const submit = ownerOperation('media.operation.job.submit.v1');
  const request = submit.ownerWireSchema.requestSchema;
  assert.equal(request.additionalProperties, false);
  assert.ok(request.required.includes('operationRef'));
  assert.ok(request.required.includes('operationVersion'));
  assert.ok(request.required.includes('targetOperationRef'));
  assert.ok(request.required.includes('parameters'));
  assert.ok(request.required.includes('typedInputs'));
  assert.ok(request.required.includes('requestId'));
  assert.ok(request.required.includes('profile'));
  assert.ok(request.required.includes('fallbackPolicy'));
  assert.ok(request.required.includes('deadline'));
  assert.ok(request.required.includes('resourceBudget'));
  assert.ok(!Object.hasOwn(request.properties, 'tenantId'));
  assert.ok(!Object.hasOwn(request.properties, 'principalId'));
  assert.match(submit.parameterBindingRule.validation, /closed JSON Schema semantics/u);
  assert.match(submit.parameterBindingRule.fingerprint, /canonical parameter values/u);
  assert.equal(submit.parameterBindingRule.definitionValidator.export, 'validateJobSubmitParameterContract');
  assert.match(submit.ownerWireSchema.ownerDefinition, /host identity and authority are never request fields/u);
});

test('MPSEM-0300-C001: accepted generic submission receipt carries canonical status, operation, fingerprint, and observation location', () => {
  const submit = operation('media.operation.transcription-submission');
  assert.ok(submit.outputSemantics.acknowledgedFields.includes('jobId'));
  assert.ok(submit.outputSemantics.acknowledgedFields.includes('requestFingerprint'));
  assert.ok(submit.outputSemantics.acknowledgedFields.includes('replayDisposition'));
  assert.equal(submit.outputSemantics.completedRecognitionIsNotImplied, true);
  const generic = ownerOperation('media.operation.job.submit.v1');
  const accepted = generic.ownerWireSchema.resultSchema.oneOf.find((branch) => branch.properties.outcome.const === 'REQUEST_ACKNOWLEDGED');
  for (const field of ['operationRef', 'operationVersion', 'requestFingerprint', 'jobId', 'canonicalStatus', 'observationLocation', 'replayDisposition']) {
    assert.ok(accepted.required.includes(field), `${field} is required in the accepted receipt`);
  }
  assert.equal(accepted.properties.operationRef.const, 'media.operation.job.submit.v1');
  assert.equal(accepted.properties.operationVersion.const, 1);
  assert.equal(accepted.properties.canonicalStatus.const, 'QUEUED');
  assert.equal(accepted.properties.observationLocation.properties.operationRef.const, 'media.operation-slice.inspect-job');
  assert.equal(generic.resultSemantics.acknowledged.includes('does not prove provider crossing, execution start, or completion'), true);
  assert.equal(generic.finality.includes('does not prove provider dispatch, execution, completion'), true);
  const unknown = generic.ownerWireSchema.resultSchema.oneOf.find((branch) => branch.properties.outcome.const === 'UNKNOWN_OUTCOME');
  assert.ok(unknown.required.includes('requestFingerprint'));
  assert.ok(!unknown.required.includes('jobId'));
});

test('MPSEM-0375-C001, C002 and C004: dispatch intent, effect-started receipt, and provider receipt have distinct durable boundaries', () => {
  const submit = ownerOperation('media.operation.job.submit.v1');
  const protocol = submit.dispatchProtocol;
  assert.equal(protocol.attemptIdentity.requiredBeforeDispatch, true);
  for (const field of ['attemptId', 'fencingToken', 'requestFingerprint', 'sourceRevisionRefs', 'profileConfigurationDigest', 'dispatchIntentId', 'authorityDecisionRefs']) {
    assert.ok(protocol.attemptIdentity.fields.includes(field), `${field} is persisted before dispatch`);
  }
  assert.equal(protocol.effectStartedReceipt.requiredBeforeProviderCrossing, true);
  assert.match(protocol.effectStartedReceipt.meaning, /may have begun; it is not a provider acknowledgment or completion/u);
  for (const field of ['receiptId', 'attemptId', 'fencingToken', 'requestFingerprint', 'recordedAt']) {
    assert.ok(protocol.effectStartedReceipt.fields.includes(field), `${field} binds the durable effect boundary`);
  }
  assert.equal(protocol.providerReceipt.requiredWhenSupportedByExactProviderContract, true);
  assert.match(protocol.providerReceipt.absenceBehavior, /OUTCOME_UNKNOWN/u);
  assert.match(protocol.ordering.join(' '), /only when returned under an authoritative provider contract/u);
  assert.match(protocol.ordering.join(' '), /never blind-replay/u);
});

test('MPSEM-0304-C001: artifact operations are explicit separate leaf contracts', () => {
  const required = [
    'media.artifact.download', 'media.artifact.list', 'media.artifact.search', 'media.artifact.derive',
    'media.artifact.share', 'media.artifact.share.revoke', 'media.artifact.delete',
  ];
  for (const id of required) assert.ok(operationCapability(id), `${id} has an exact operation binding`);
  assert.match(cap('media.artifact.download').outcome, /download/u);
  assert.match(cap('media.artifact.import').explicitUnsupportedCases[0], /SSRF/u);
});

test('MPSEM-0305-C002 and MPSEM-0377-C001: retry requires bounded, classified eligibility and reconciliation first', () => {
  const retry = cap('media.job.retry');
  assert.ok(retry.constraints.some((entry) => /Do not retry an uncertain external effect/u.test(entry)));
  assert.ok(retry.constraints.some((entry) => /Recheck authority and budget immediately before dispatch/u.test(entry)));
  const exact = ownerOperation('media.operation-slice.retry-job');
  assert.ok(exact.ownerDefinition.guards.includes('prior-outcome-is-not-unknown'));
  assert.ok(exact.ownerDefinition.guards.includes('retry-budget-remains'));
  assert.match(exact.ownerDefinition.recovery, /separate-authoritative-reconciliation-contract-first/u);
});

test('MPSEM-0310-C001 and MPSEM-0310-C003: observation is bounded and missing progress stays unknown', () => {
  const watch = cap('media.job.watch');
  assert.match(watch.constraints[0], /monotonic continuation identifiers when the event stream is admitted/u);
  assert.match(watch.constraints[2], /Unknown or missing progress remains unknown/u);
  assert.match(watch.supportedParameters, /Exact units, bounds, event IDs, retention, and resume behavior require the owning contract/u);
});

test('MPSEM-0312-C002: operation-specific closed schemas reject undeclared parameters', () => {
  const submit = operation('media.operation.transcription-submission');
  assert.match(submit.inputSemantics.branchFieldRule, /reject-unknown/u);
  assert.match(submit.inputSemantics.branchFieldRule, /before-any-effect/u);
  const request = operations.capabilityOperationContracts.requestEnvelope;
  assert.equal(request.body.additionalProperties, false);
});

test('MPSEM-0313-C001, C002 and C004: byte access, external import and text generation use typed guarded contracts', () => {
  const download = operationCapability('media.artifact.download');
  assert.equal(download.operationKind, 'COMMAND');
  assert.equal(download.requestSchema.additionalProperties, false);
  assert.match(cap('media.artifact.import').explicitUnsupportedCases[0], /allowlists, SSRF controls, locality, and egress policy/u);
  const text = operationCapability('media.generate.image.text-to-image');
  assert.equal(text.requestSchema.properties.input1.properties.artifactType.const, 'text-or-visual-intent');
  assert.equal(text.requestSchema.additionalProperties, false);
});

test('MPSEM-0336-C007 and MPSEM-0346-C002: detaching observation is not remote cancellation or finality', () => {
  const cli = channels.channels.find((entry) => entry.id === 'media.channel.cli').ownerCliDefinitionContract;
  assert.equal(cli.interruptHandling.ctrlC.serverCancellation, false);
  assert.equal(cli.interruptHandling.ctrlC.jobStateChange, false);
  const cancel = cap('media.job.cancel');
  assert.match(cancel.constraints[0], /request is not cancellation confirmation/u);
  assert.match(cancel.acceptanceCases[1].then, /not reported CANCELLED without proof/u);
});

test('MPSEM-0355-C001 and MPSEM-0367-C003: minimized data, privacy defaults and retention evidence stay explicit', () => {
  assert.equal(policy.dataHandling.purposeBoundDataAccess.id, 'media.policy.purpose-bound-data-access');
  assert.match(policy.dataHandling.purposeBoundDataAccess.rule, /exact declared Media operation and purpose/u);
  assert.match(policy.dataHandling.purposeBoundDataAccess.rule, /cross-tenant|private|egress|training/iu);
  assert.ok(policy.dataHandling.minimization.decisionProcedure.some((entry) => /logs, traces, metrics, audit, provenance, exports, provider requests, and recovery receipts/u.test(entry)));
  const retention = privacy.ownerDefinedPdp10Boundary.retentionAndErasure;
  assert.match(retention.confirmRule, /primary, replica, backup, cache, export and provider scopes/u);
  assert.match(retention.partialErasure, /do not collapse partial deletion to confirmed erasure/u);
});

test('MPSEM-0372-C006 and MPSEM-0378-C002: stage/progress is separate from job authority and corrections append', () => {
  const status = cap('media.job.view-status');
  assert.match(status.constraints[1], /stage progress, attempt status, remote-outcome certainty, cancellation outcome/u);
  assert.match(status.constraints[1], /remain distinct/u);
  const outputs = cap('media.job.outputs.inspect');
  assert.match(outputs.constraints[2], /corrections append a revision or reconciliation record/u);
  assert.match(versioning.ownerDefinedRevisionSemantics.artifactVersion.content, /immutable/u);
});

test('MPSEM-0458-C005: an out-of-process boundary does not grant license or effect admission', () => {
  const rule = reuse.mediaArchitectureRules.componentLicenseBoundary;
  assert.match(rule.rule, /independent from every bundled, downloaded or transitively used model weight/u);
  assert.match(rule.unknownDisposition, /DENY_SELECTION_OR_ACQUISITION/u);
});
