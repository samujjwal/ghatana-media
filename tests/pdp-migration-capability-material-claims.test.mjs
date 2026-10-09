import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const fragment = JSON.parse(await readFile('docs/implementation/verification/pdp-38/migration-capability-reviewed.json', 'utf8'));
const sourceFiles = [
  '.product-experience/pdp-0-product-truth/glossary.yaml',
  '.product-experience/pdp-0-product-truth/quality-policy.yaml',
  '.product-experience/pdp-0-product-truth/domain-model.yaml',
  '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  '.product-experience/pdp-0-product-truth/constitution.yaml',
  '.product-experience/pdp-0-product-truth/reuse-decisions.yaml',
  '.product-experience/pdp-0-product-truth/policy-authority-model.yaml',
  '.product-experience/pdp-0-product-truth/domain-model.yaml',
  '.product-experience/pdp-1-domain-data/privacy.yaml',
  '.product-experience/pdp-1-domain-data/states.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
];
const documents = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [path, parse(await readFile(path, 'utf8'))])));
const resolvePointer = (root, pointer) => pointer.split('/').filter(Boolean).reduce((value, token) => {
  const match = token.match(/^@id=(.+)$/u);
  if (match) return (Array.isArray(value) ? value : Object.values(value ?? {})).find((entry) => entry?.id === match[1]);
  return value?.[token.replace(/~1/gu, '/').replace(/~0/gu, '~')];
}, root);
const sourceRef = (target) => {
  const [file, pointer] = target.split('#');
  return resolvePointer(documents[file], pointer);
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('13 previously mismatched capability claims now target exact owner semantics with pinned source values', () => {
  const expected = {
    'MPSEM-0199-C003': '.product-experience/pdp-0-product-truth/glossary.yaml#/unitsAndConventions/rules/@id=media.unit.measurement-uncertainty/estimatePresentationRule',
    'MPSEM-0204-C001': '.product-experience/pdp-0-product-truth/quality-policy.yaml#/optimizationPolicy/defaultEnhancerApplicationRule',
    'MPSEM-0260-C003': '.product-experience/pdp-0-product-truth/domain-model.yaml#/imageVideoOutputConstraints/resolutionRule',
    'MPSEM-0291-C002': '.product-experience/pdp-0-product-truth/quality-policy.yaml#/protectedSemanticProperties/@id=PROTECTED-DELIVERY-CONSTRAINTS/rule',
    'MPSEM-0300-C003': '.product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/resultSemantics/acknowledged',
    'MPSEM-0334-C002': '.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/pathHandling',
    'MPSEM-0336-C006': '.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/interruptHandling/ctrlC',
    'MPSEM-0352-C001': '.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/flagApplicability/rule',
    'MPSEM-0352-C002': '.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/flagApplicability/readOnlyCommands/idempotencyKey',
    'MPSEM-0355-C003': '.product-experience/pdp-0-product-truth/constitution.yaml#/invariants/records/@id=MEDIA-INV-002/statement',
    'MPSEM-0459-C003': '.product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/externalStackSelectionRule/multiplicity',
    'MPSEM-0459-C004': '.product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/externalStackSelectionRule/multiplicity',
    'MPSEM-0461-C003': '.product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/dependencyUpdatePolicy/pinning/rule',
  };
  for (const [claimId, target] of Object.entries(expected)) {
    const record = fragment.records.find((entry) => entry.claimId === claimId);
    assert.ok(record, `review record ${claimId} exists`);
    assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
    assert.equal(record.proposedTargetRef, target);
    assert.equal(record.targetValueSha256, digest(sourceRef(target)), `${claimId} exact target value is pinned`);
    assert.equal(record.acceptanceEffect, 'none');
    assert.ok(record.testSources.includes('tests/pdp-migration-capability-material-claims.test.mjs'));
  }
  assert.match(sourceRef(expected['MPSEM-0199-C003']), /do not represent it as measured ground truth/u);
  assert.equal(sourceRef(expected['MPSEM-0204-C001']).execution, 'Applying a candidate remains a separate explicit operation subject to the existing policy, rights, resource, fidelity, and confirmation gates.');
  assert.match(sourceRef(expected['MPSEM-0260-C003']), /odd output height.*4:2:0.*pixel alignment/iu);
  assert.match(sourceRef(expected['MPSEM-0291-C002']), /Fallback may alter these only when explicitly permitted/u);
  assert.match(sourceRef(expected['MPSEM-0300-C003']), /does not prove provider crossing, execution start, or completion/u);
  assert.match(sourceRef(expected['MPSEM-0334-C002']).rule, /Never reinterpret it as an HTTP route/u);
  assert.equal(sourceRef(expected['MPSEM-0336-C006']).serverCancellation, false);
  assert.match(sourceRef(expected['MPSEM-0352-C001']), /fail before dispatch/u);
  assert.match(sourceRef(expected['MPSEM-0352-C002']), /FORBIDDEN_OR_NOT_APPLICABLE/u);
  assert.match(sourceRef(expected['MPSEM-0355-C003']), /not verified consent or license/u);
  assert.match(sourceRef(expected['MPSEM-0459-C003']), /silently fall back/u);
  assert.match(sourceRef(expected['MPSEM-0461-C003']), /immutable version and integrity digest/u);
});

test('privacy and erasure capability claims target exact policy/state sources and preserve open implementation limits', () => {
  const expected = {
    'MPSEM-0036-C001': '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#/dataHandling/purposeBoundDataAccess',
    'MPSEM-0037-C002': '.product-experience/pdp-1-domain-data/privacy.yaml#/retentionAndErasure',
    'MPSEM-0037-C003': '.product-experience/pdp-1-domain-data/privacy.yaml#/retentionAndErasure',
    'MPSEM-0365-C001': '.product-experience/pdp-1-domain-data/privacy.yaml#/retentionAndErasure',
    'MPSEM-0366-C001': '.product-experience/pdp-1-domain-data/states.yaml#/stateMachines/2/stateDefinitions',
  };
  const records = new Map(fragment.records.map((record) => [record.claimId, record]));
  for (const [claimId, target] of Object.entries(expected)) {
    const record = records.get(claimId);
    assert.ok(record, `review record ${claimId} exists`);
    assert.equal(record.proposedTargetRef, target);
    assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
    assert.equal(record.targetValueSha256, digest(sourceRef(target)));
    assert.equal(record.acceptanceEffect, 'none');
    assert.ok(record.negativeCases.length >= 2);
    assert.ok(record.testSources.includes('tests/pdp-migration-capability-material-claims.test.mjs'));
  }
  const privacy = sourceRef(expected['MPSEM-0037-C003']);
  assert.equal(privacy.status, 'proposal-only; policy-and-storage-owner-approval-pending');
  assert.ok(privacy.proposalRules.includes('represent-partial-or-unconfirmed-deletion-as-pending-or-blocked-not-erasure-confirmed'));
  assert.ok(privacy.notEstablished.includes('complete-inventory-of-primary-replica-backup-cache-export-and-provider-held-copies'));
  assert.ok(privacy.notEstablished.includes('restore-time-tombstone-replay-or-independently-verifiable-erasure-receipt'));
  const states = sourceRef(expected['MPSEM-0366-C001']);
  const stateIds = new Set(states.map(({ id }) => id));
  for (const id of ['ERASURE_REQUESTED', 'ACCESS_REVOKED', 'PHYSICAL_ERASURE_PENDING', 'ERASURE_CONFIRMED', 'BLOCKED_BY_HOLD', 'EXTERNAL_ERASURE_UNCONFIRMED']) {
    assert.ok(stateIds.has(id), `lifecycle state ${id} is source-defined`);
  }
  assert.match(sourceRef(expected['MPSEM-0036-C001']).defaultPolicy.externalEgress, /deny/u);
  assert.match(sourceRef(expected['MPSEM-0036-C001']).defaultPolicy.secondaryTraining, /deny/u);
});

test('best-effort diagnostics do not decide business outcome or replace required audit intent', () => {
  const target = '.product-experience/pdp-0-product-truth/constitution.yaml#/invariants/records/@id=MEDIA-INV-005/diagnosticFailureRule';
  const record = fragment.records.find(({ claimId }) => claimId === 'MPSEM-0038-C003');
  assert.ok(record);
  assert.equal(record.proposedTargetRef, target);
  assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
  assert.equal(record.targetValueSha256, digest(sourceRef(target)));
  assert.match(sourceRef(target), /without changing the business outcome/u);
  assert.match(sourceRef(target), /cannot replace, satisfy, or weaken required durable audit intent/u);
  assert.equal(record.acceptanceEffect, 'none');
});

test('model, worker, recipe, and isolation claims target exact owner boundaries without admission promotion', async () => {
  const expected = {
    'MPSEM-0030-C001': '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#/modelAcquisitionAndFallback',
    'MPSEM-0387-C002': '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#/modelAcquisitionAndFallback/hardwareFootprintDoesNotWaiveAdmission',
    'MPSEM-0387-C003': '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/platformMechanics/documentIntelligence',
    'MPSEM-0095-C004': '.product-experience/pdp-0-product-truth/domain-model.yaml#/proposedRecordCatalog/@id=MediaRecipe/agentRuntimeBoundary',
    'MPSEM-0039-C001': '.product-experience/pdp-0-product-truth/domain-model.yaml#/architecturePrinciples/isolationRule',
    'MPSEM-0039-C003': '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/inputAndExecutionThreats',
  };
  for (const [claimId, target] of Object.entries(expected)) {
    const record = fragment.records.find((entry) => entry.claimId === claimId);
    assert.ok(record, `review record ${claimId} exists`);
    assert.equal(record.proposedTargetRef, target);
    assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
    if (claimId === 'MPSEM-0039-C003') {
      const impact = JSON.parse(await readFile('docs/implementation/verification/pdp-38/migration-frozen-source-deltas.json', 'utf8'));
      const observed = impact.records.find(({ targetRef }) => targetRef === target);
      assert.ok(observed, 'exact reviewed browser-boundary additive observation exists');
      const current = sourceRef(target);
      const previousProjection = structuredClone(current);
      delete previousProjection.browserToLocalWorkerBoundary;
      assert.equal(record.targetValueSha256, observed.historicalTargetValueSha256, 'immutable fragment target hash remains exact');
      assert.equal(digest(previousProjection), record.targetValueSha256, 'every earlier parsed target field is preserved');
      assert.equal(digest(current), observed.currentTargetValueSha256, 'current whole target hash is exact');
      assert.equal(current.browserToLocalWorkerBoundary.id, 'media.policy.browser-to-local-worker-boundary.v1');
      assert.equal(observed.semanticPromotion, false);
    } else {
      assert.equal(record.targetValueSha256, digest(sourceRef(target)));
    }
    assert.equal(record.acceptanceEffect, 'none');
    assert.ok(record.negativeCases.length >= 2);
    assert.ok(record.testSources.includes('tests/pdp-migration-capability-material-claims.test.mjs'));
  }
  const model = sourceRef(expected['MPSEM-0030-C001']);
  assert.equal(model.fallback.default, 'DENY_SILENT_FALLBACK');
  assert.match(sourceRef(expected['MPSEM-0387-C002']).localExecutionDisposition, /resource fact, not an admission/u);
  assert.match(sourceRef(expected['MPSEM-0387-C003']).mediaRole, /public-document-intelligence-api/u);
  const recipe = sourceRef(expected['MPSEM-0095-C004']);
  assert.match(recipe.rule, /not an agent-runtime graph/u);
  assert.equal(recipe.state, 'NOT_ADMITTED');
  assert.match(sourceRef(expected['MPSEM-0039-C001']), /not automatically a sandbox/u);
  assert.ok(sourceRef(expected['MPSEM-0039-C003']).requiredControls.includes('decode-in-isolated-worker-before-promoting-to-usable-content'));
});
