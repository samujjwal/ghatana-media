import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const [capabilities, quality, policy, reuse, channels, domainModel] = await Promise.all([
  readFile('.product-experience/pdp-0-product-truth/capabilities.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/quality-policy.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/policy-authority-model.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/reuse-decisions.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/applications-channels.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-0-product-truth/domain-model.yaml', 'utf8').then(parse),
]);
const byId = (records, id) => records.find((record) => record.id === id);

test('migration correction: estimated depth remains distinct from measured ground truth', () => {
  const capability = byId(capabilities.capabilities, 'media.generate.image.condition.depth');
  assert.match(capability.constraints[2], /report reconstruction or estimation distinctly from measured\/ground-truth output/u);
  assert.doesNotMatch(capability.constraints[2], /predicted depth is ground truth/u);
});

test('migration correction: enhancer pipeline proposes only eligible operations and does not auto-apply', () => {
  const rule = quality.optimizationPolicy.defaultEnhancerApplicationRule;
  assert.equal(rule.disposition, 'never-apply-every-enhancer-by-default');
  assert.match(rule.candidateSelection, /individually applicable, authorized/u);
  assert.match(rule.planning, /before any application/u);
  assert.match(rule.execution, /separate explicit operation/u);
  assert.ok(rule.negativeCases.some((entry) => /not selected merely because it exists/u.test(entry)));
});

test('migration correction: operation acceptance is not completion', () => {
  const submit = byId(capabilities.capabilities, 'media.job.submit');
  assert.ok(submit.constraints.some((entry) => /Acceptance is not completion/u.test(entry)));
  assert.match(submit.outcome, /return the Media job reference/u);
});

test('migration correction: user rights attestation cannot establish verified consent or license', () => {
  assert.ok(policy.productPolicy.invariants.includes('user-attestation-is-not-verified-consent-or-license'));
});

test('migration correction: Media CLI paths and interrupts remain client-local and do not cancel remote work', () => {
  const cli = channels.channels.find((channel) => channel.id === 'media.channel.cli').ownerCliDefinitionContract;
  assert.equal(cli.definitionOnly, true);
  assert.match(cli.pathHandling.rule, /Never reinterpret it as an HTTP route, URL, server filesystem path/u);
  assert.equal(cli.interruptHandling.ctrlC.exitCode, 130);
  assert.equal(cli.interruptHandling.ctrlC.serverCancellation, false);
  assert.equal(cli.interruptHandling.ctrlC.jobStateChange, false);
  assert.match(cli.flagApplicability.readOnlyCommands.idempotencyKey, /FORBIDDEN_OR_NOT_APPLICABLE/u);
  assert.match(cli.flagApplicability.consequentialCommands.idempotencyKey, /EXACT_CANONICAL_COMMAND_SCHEMA/iu);
  assert.match(cli.scopeStatus, /not established/u);
});

test('migration correction: source data is minimized per exact operation purpose', () => {
  const minimization = policy.dataHandling.minimization;
  assert.equal(minimization.id, 'media.policy.data-minimization');
  assert.match(minimization.rule, /only the minimum fields and media ranges necessary/u);
  assert.ok(minimization.decisionProcedure.some((entry) => /bind each input and output field or media range to one declared purpose and exact operation/u.test(entry)));
  assert.ok(minimization.decisionProcedure.some((entry) => /when necessity or purpose is unknown, do not disclose or dispatch/u.test(entry)));
});

test('migration correction: license evidence applies independently to wrapped code, model weights, codecs, and assets', () => {
  const boundary = reuse.mediaArchitectureRules.componentLicenseBoundary;
  assert.match(boundary.rule, /independent from every bundled, downloaded or transitively used model weight/u);
  assert.ok(boundary.requiredEvidence.includes('separate license and use-term disposition for code and each model/asset weight'));
  assert.match(boundary.unknownDisposition, /DENY_SELECTION_OR_ACQUISITION/u);
});

test('migration correction: odd 4:2:0 dimensions require exact encoder-profile alignment', () => {
  const rule = domainModel.imageVideoOutputConstraints.resolutionRule;
  assert.match(rule, /Do not assume an odd output height is accepted by a selected 4:2:0 encoder/u);
  assert.match(rule, /require that exact model\/encoder profile to declare and satisfy its pixel alignment/u);
  assert.match(domainModel.imageVideoOutputConstraints.boundary, /does not claim any model, encoder, or GPU profile has been qualified/u);
});

test('migration correction: delivery compatibility and fallback are profile-bound, evidence-based, and explicit', () => {
  const rule = quality.deliveryCompatibilityPolicy;
  assert.equal(rule.id, 'media.quality.delivery-compatibility');
  for (const field of ['codec', 'container', 'playerOrConsumerContract', 'deliveryMode', 'declaredConstraints']) {
    assert.ok(rule.targetBinding.required.includes(field));
  }
  assert.match(rule.targetBinding.unknownTarget, /abstain/u);
  assert.equal(rule.evaluation.noSilentDowngrade, true);
  assert.ok(rule.fallback.require.includes('minimum-quality-floor'));
  assert.ok(rule.fallback.require.includes('explicit-confirmation-when-required'));
  assert.ok(rule.fallback.prohibit.includes('unlisted-codec-or-container-substitution'));
  assert.match(rule.fallback.unknownDisposition, /do-not-select-fallback/u);
  assert.ok(rule.negativeCases.includes('profile-name-matches-codec-but-container-or-player-contract-is-unknown'));
  assert.equal(rule.qualificationStatus, 'NOT_EVALUATED');
  assert.equal(rule.runtimeAdmission, 'NOT_ADMITTED');
});

test('migration correction: dependency pins and promotion checks are definition-only gates', () => {
  const policy = reuse.mediaArchitectureRules.dependencyUpdatePolicy;
  assert.match(policy.pinning.rule, /immutable version and integrity digest/u);
  assert.ok(policy.validationBeforePromotion.required.includes('API and ABI compatibility checks against the exact supported Media profile'));
  assert.match(policy.validationBeforePromotion.promotion, /does not admit or qualify a dependency or runtime/u);
});
