import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const require = createRequire(resolve(root, '../ghatana-tools/package.json'));
const { parse } = require('yaml');
const migrationPath = '.product-experience/pdp-0-product-truth/migration-semantics-review.yaml';
const glossaryPath = '.product-experience/pdp-0-product-truth/glossary.yaml';
const domainModelPath = '.product-experience/pdp-0-product-truth/domain-model.yaml';
const timePolicyPath = '.product-experience/pdp-0-product-truth/time-units-fidelity.yaml';
const qualityPolicyPath = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
const policyAuthorityPath = '.product-experience/pdp-0-product-truth/policy-authority-model.yaml';
const reuseDecisionsPath = '.product-experience/pdp-0-product-truth/reuse-decisions.yaml';
const qualificationPolicyPath = '.product-experience/pdp-0-product-truth/qualification-policy.yaml';
const dependencyContractsPath = '.product-experience/pdp-0-product-truth/dependency-contracts.yaml';
const cliLanguagePath = '.product-experience/pdp-2-design-interface-system/cli-language.yaml';
const interfaceGrammarPath = '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml';
const semanticStateGrammarPath = '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml';
const valueObjectsPath = '.product-experience/pdp-1-domain-data/value-objects.yaml';
const handoffContractsPath = '.product-experience/pdp-0-product-truth/handoff-contracts.yaml';
const migration = parse(readFileSync(migrationPath, 'utf8'));
const glossary = parse(readFileSync(glossaryPath, 'utf8'));
const domainModel = parse(readFileSync(domainModelPath, 'utf8'));
const timePolicy = parse(readFileSync(timePolicyPath, 'utf8'));
const qualityPolicy = parse(readFileSync(qualityPolicyPath, 'utf8'));
const policyAuthority = parse(readFileSync(policyAuthorityPath, 'utf8'));
const reuseDecisions = parse(readFileSync(reuseDecisionsPath, 'utf8'));
const qualificationPolicy = parse(readFileSync(qualificationPolicyPath, 'utf8'));
const dependencyContracts = parse(readFileSync(dependencyContractsPath, 'utf8'));
const cliLanguage = parse(readFileSync(cliLanguagePath, 'utf8'));
const interfaceGrammar = parse(readFileSync(interfaceGrammarPath, 'utf8'));
const semanticStateGrammar = parse(readFileSync(semanticStateGrammarPath, 'utf8'));
const valueObjects = parse(readFileSync(valueObjectsPath, 'utf8'));
const handoffContracts = parse(readFileSync(handoffContractsPath, 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Pin claim-specific owner-source bindings. Exact resolved values prevent a
// neighboring valid record or broad summary from silently substituting.
const reviewData = JSON.parse(readFileSync('docs/implementation/verification/pdp-38/migration-domain-review.json', 'utf8'));
const rules = reviewData.records;
const pendingRules = reviewData.pendingRecords ?? [];

const requiredOwnerPhrases = new Map([
  ['MPSEM-0036-C003', ['simple human-readable summary', 'access/sharing', 'classification', 'processing location', 'consent/rights', 'retention', 'preserving each applicable axis independently']],
  ['MPSEM-0217-C001', ['immutable revision reference', 'access policy']],
  ['MPSEM-0218-C002', ['Access', 'lifecycle', 'retention', 'deletion/purge', 'separate from immutable content identity']],
  ['MPSEM-0219-C002', ['References bytes', 'does not duplicate or redefine them']],
  ['MPSEM-0255-C002', ['Half-open intervals [start, end).']],
  ['MPSEM-0272-C001', ['Visual quality is not scientific/domain fidelity.']],
]);

const owners = new Map([
  [glossaryPath, glossary],
  [domainModelPath, domainModel],
  [timePolicyPath, timePolicy],
  [qualityPolicyPath, qualityPolicy],
  [policyAuthorityPath, policyAuthority],
  [reuseDecisionsPath, reuseDecisions],
  [qualificationPolicyPath, qualificationPolicy],
  [dependencyContractsPath, dependencyContracts],
  [cliLanguagePath, cliLanguage],
  [interfaceGrammarPath, interfaceGrammar],
  [semanticStateGrammarPath, semanticStateGrammar],
  [valueObjectsPath, valueObjects],
  [handoffContractsPath, handoffContracts],
]);

function resolveRef(ref) {
  const [source, pointer] = ref.split('#', 2);
  let value = owners.get(source);
  assert.ok(value, `owner source must be a PDP-0 glossary/domain model: ${source}`);
  for (const raw of pointer.split('/').filter(Boolean)) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (segment.startsWith('@id=')) {
      assert.ok(Array.isArray(value), `@id selector must address a record list in ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `owner target must resolve: ${ref}`);
  }
  return value;
}

function claims() {
  return migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? []);
}

test('48 glossary/domain-model claims retain exact claim text and exact owner-source semantics', () => {
  assert.equal(reviewData.schemaVersion, 'media.pdp38-migration-domain-review.v1');
  assert.equal(reviewData.reviewStatus, 'PENDING_COORDINATOR_REVIEW');
  assert.equal(reviewData.acceptanceEffect, 'none');
  assert.match(reviewData.authority, /not a merged migration disposition/u);
  assert.equal(pendingRules.length, 82);
  assert.equal(new Set(pendingRules.map((rule) => rule.claimId)).size, 82, 'current pending review membership has no duplicate claim IDs');
  assert.deepEqual(reviewData.historicalDuplicateReviewEntries.map((rule) => rule.claimId).sort(), ['MPSEM-0099-C003', 'MPSEM-0177-C005']);
  assert.equal(rules.length, 48);
  assert.equal(new Set(rules.map((rule) => rule.claimId)).size, rules.length);
  const rows = new Map(claims().map((claim) => [claim.claimId, claim]));

  for (const rule of rules) {
    const claim = rows.get(rule.claimId);
    assert.ok(claim, `claim exists: ${rule.claimId}`);
    assert.equal(claim.exactSourceText, rule.exactSourceText, `${rule.claimId} exact source text`);
    assert.equal(digest(claim.exactSourceText), rule.sourceTextSha256, `${rule.claimId} source text digest`);
    assert.equal(claim.acceptanceEffect, 'none', `${rule.claimId} does not imply acceptance`);
    assert.ok(rule.materialPredicates.length > 0 && rule.negativeCases.length > 0, `${rule.claimId} has claim-specific review predicates and negative boundaries`);

    const target = resolveRef(rule.targetRef);
    assert.ok(typeof target === 'string' || (target !== null && typeof target === 'object'), `${rule.claimId} points to an exact owner definition`);
    assert.deepEqual(target, rule.expectedOwnerValue, `${rule.claimId} preserves the reviewed material owner meaning`);
    assert.equal(digest(JSON.stringify(target)), rule.targetValueSha256, `${rule.claimId} owner value digest`);
    const semanticValue = typeof target === 'string' ? target : JSON.stringify(target);
    for (const phrase of requiredOwnerPhrases.get(rule.claimId) ?? []) {
      assert.ok(semanticValue.includes(phrase), `${rule.claimId} preserves material predicate: ${phrase}`);
    }
  }
});

test('resolution claim preserves model, encoder, and display constraints and rejects false universals', () => {
  const rule = pendingRules.find((item) => item.claimId === 'MPSEM-0260-C002');
  assert.ok(rule, 'the 720×405 claim is explicitly represented in the pending owner review');
  assert.equal(rule.semanticReviewStatus, 'OWNER_SOURCE_AUTHORED_PENDING_COORDINATOR_REVIEW');
  assert.equal(rule.acceptanceEffect, 'none');
  const target = resolveRef(rule.targetRef);
  assert.equal(target, rule.expectedOwnerValue);
  assert.equal(digest(JSON.stringify(target)), rule.targetValueSha256);
  for (const phrase of [
    '720×405 is not a universal safe default',
    'model-native grid or latent constraints',
    'encoder pixel-format alignment',
    'requested display aspect',
    'crop/pad/scale',
  ]) assert.ok(target.includes(phrase), `resolution contract preserves: ${phrase}`);

  const preservesResolutionMeaning = (value) => [
    'not a universal safe default',
    'model-native grid or latent constraints',
    'encoder pixel-format alignment',
    'separate profile-bound values',
  ].every((phrase) => value.includes(phrase));
  for (const falseContract of [
    '720×405 is a universal safe default.',
    'Ignore model-native grid or latent constraints.',
    'Ignore encoder pixel-format alignment.',
    'Requested display aspect and model generation dimensions are the same.',
  ]) assert.equal(preservesResolutionMeaning(falseContract), false, falseContract);
});

test('authored owner semantics for source-authored high-risk claims preserve exact material predicates', () => {
  const rows = new Map(claims().map((claim) => [claim.claimId, claim]));
  assert.equal(pendingRules.filter((rule) => rule.semanticReviewStatus === 'OWNER_SOURCE_AUTHORED_PENDING_COORDINATOR_REVIEW').length, 81);
  for (const rule of pendingRules.filter((item) => item.semanticReviewStatus === 'OWNER_SOURCE_AUTHORED_PENDING_COORDINATOR_REVIEW')) {
    const claim = rows.get(rule.claimId);
    assert.ok(claim, `migration claim exists: ${rule.claimId}`);
    assert.equal(claim.exactSourceText, rule.exactSourceText);
    assert.equal(digest(rule.exactSourceText), rule.sourceTextSha256);
    assert.equal(claim.targetRef, rule.targetRef, `${rule.claimId} migration overlay uses the reviewed exact owner target`);
    assert.equal(claim.semanticReviewStatus, 'CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED', `${rule.claimId} has a tested semantic mapping`);
    const target = resolveRef(rule.targetRef);
    if (rule.currentOwnerDelta) {
      const reviewedSnapshot = structuredClone(target);
      delete reviewedSnapshot.hardwareFootprintDoesNotWaiveAdmission;
      assert.deepEqual(reviewedSnapshot, rule.expectedOwnerValue, `${rule.claimId} preserves the previously reviewed owner snapshot`);
      assert.equal(digest(JSON.stringify(reviewedSnapshot)), rule.targetValueSha256);
      const delta = resolveRef(rule.currentOwnerDelta.targetRef);
      assert.deepEqual(delta, rule.currentOwnerDelta.expectedOwnerValue, `${rule.claimId} current owner delta is exact`);
      assert.equal(digest(JSON.stringify(delta)), rule.currentOwnerDelta.targetValueSha256);
      for (const predicate of rule.currentOwnerDelta.materialPredicates) {
        assert.ok(JSON.stringify(delta).toLowerCase().includes(predicate.toLowerCase()), `${rule.claimId} delta predicate: ${predicate}`);
      }
    } else {
      assert.deepEqual(target, rule.expectedOwnerValue, `${rule.claimId} owner value retains reviewed semantics`);
      assert.equal(digest(JSON.stringify(target)), rule.targetValueSha256);
    }
    assert.equal(claim.targetTextSha256, digest(typeof target === 'string' ? target : JSON.stringify(target)), `${rule.claimId} current overlay target value digest`);
    assert.equal(rule.acceptanceEffect, 'none');
    const semanticValue = typeof target === 'string' ? target : JSON.stringify(target);
    for (const predicate of rule.materialPredicates) {
      assert.ok(semanticValue.toLowerCase().includes(predicate.toLowerCase()), `${rule.claimId} material predicate: ${predicate}`);
      const mutated = semanticValue.toLowerCase().replaceAll(predicate.toLowerCase(), '__removed_material_predicate__');
      assert.equal(rule.materialPredicates.every((required) => mutated.includes(required.toLowerCase())), false,
        `${rule.claimId} rejects a target mutation that removes ${predicate}`);
    }
  }
});

test('scene geometry keeps owner-declared unit conversion as an explicit bounded exception', () => {
  const rule = pendingRules.find((item) => item.claimId === 'MPSEM-0261-C002');
  assert.ok(rule);
  const target = resolveRef(rule.targetRef);
  assert.equal(target, rule.expectedOwnerValue);
  assert.equal(digest(JSON.stringify(target)), rule.targetValueSha256);
  for (const predicate of ['default only', 'domain owner may declare converted units', 'source and destination unit systems', 'precision/rounding', 'reject implicit or lossy conversion']) {
    assert.ok(target.includes(predicate), `scene unit override preserves: ${predicate}`);
  }
  const preservesUnitOverride = (value) => ['domain owner may declare converted units', 'reject implicit or lossy conversion']
    .every((phrase) => value.includes(phrase));
  for (const falseContract of [
    'The initial SI unit convention is mandatory for every domain.',
    'Units may be converted without preserving their source unit or rounding.',
    'Any unit choice is allowed without a domain owner declaration.',
  ]) assert.equal(preservesUnitOverride(falseContract), false, falseContract);
});

test('external authoring and Kernel handoff claims require exact published owner contracts', () => {
  const byId = new Map(pendingRules.map((rule) => [rule.claimId, rule]));
  const overlayClaims = new Map(claims().map((claim) => [claim.claimId, claim]));
  const yappc = byId.get('MPSEM-0102-C002');
  const kernel = byId.get('MPSEM-0093-C003');
  assert.ok(yappc && kernel, 'both handoff decisions have exact source-authored definitions');

  const yappcRule = resolveRef(yappc.targetRef);
  const kernelRule = resolveRef(kernel.targetRef);
  assert.equal(overlayClaims.get(yappc.claimId).targetRef.endsWith('@id=yappc-product-authoring/adoptionRule'), true);
  assert.equal(overlayClaims.get(kernel.claimId).targetRef.endsWith('@id=kernel-product-lifecycle/kernelAdoptionRule'), true);
  assert.ok(yappcRule.includes('published public authoring capability is needed by Media'));
  assert.ok(yappcRule.includes('Otherwise Media retains its own authoring behavior'));
  assert.ok(yappcRule.includes('private YAPPC packages or implementation details are not an integration surface'));
  assert.ok(kernelRule.includes('owner identity, version, and public surface have been reviewed'));
  assert.ok(kernelRule.includes('must not recreate Kernel-owned schemas'));
  assert.ok(kernelRule.includes('A dependency alone is not adoption evidence'));

  for (const falseClaim of [
    'A YAPPC registry entry alone is a callable app-authoring contract.',
    'Media may integrate a private YAPPC package without a reviewed public contract.',
    'A Kernel dependency coordinate proves Kernel-native materialization.',
    'Media should recreate Kernel schemas when consuming a host reference.',
  ]) {
    assert.equal(
      [yappcRule, kernelRule].some((rule) => rule.includes(falseClaim)),
      false,
      falseClaim,
    );
  }
});

test('handoff envelope binds every admitted call to required fields and service-call authority boundary', () => {
  const byId = new Map(claims().map((claim) => [claim.claimId, claim]));
  const envelopeClaim = byId.get('MPSEM-0474-C001');
  const authorityClaim = byId.get('MPSEM-0474-C002');
  assert.ok(envelopeClaim && authorityClaim);
  assert.equal(envelopeClaim.targetRef.endsWith('/handoffEnvelope/requiredForEveryAdmittedCall'), true);
  assert.equal(authorityClaim.targetRef.endsWith('/handoffEnvelope/invariants/0'), true);

  const required = resolveRef(envelopeClaim.targetRef);
  assert.equal(required.length, 11);
  for (const requiredField of [
    'source owner and destination owner',
    'operation and version',
    'authentication/delegation and the authority source',
    'data classification and purpose',
    'minimum expected context',
    'deadline/timeout and supported cancellation behavior',
    'finality and uncertainty representation',
    'idempotency/retry/reconciliation behavior',
    'safe error mapping',
    'return/continuation path',
    'accepted artifact/result references',
  ]) assert.ok(required.includes(requiredField), `handoff envelope requires ${requiredField}`);

  const authority = resolveRef(authorityClaim.targetRef);
  assert.equal(authority, "A service call does not authorize another owner's database mutation.");
  assert.notEqual(authority, 'source owner and destination owner');
  assert.notEqual(required.filter((field) => field !== 'source owner and destination owner').length, 0);
});

test('reuse priority requires Ghatana-first evidence and justifies any later implementation choice', () => {
  const rule = pendingRules.find((item) => item.claimId === 'MPSEM-0021-C003');
  assert.ok(rule);
  assert.equal(rule.targetRef, '.product-experience/pdp-0-product-truth/reuse-decisions.yaml#selectionSequenceRule');
  const sequence = resolveRef(rule.targetRef);
  assert.equal(sequence.id, 'media.reuse.selection-sequence');
  assert.equal(sequence.orderedChoices.length, 4);
  assert.match(sequence.orderedChoices[0], /Ghatana-public/u);
  assert.match(sequence.orderedChoices[1], /owner-extension-or-extract/u);
  assert.match(sequence.orderedChoices[2], /external-OSS/u);
  assert.match(sequence.orderedChoices[3], /new-Media-mechanics-only-when/u);
  assert.ok(sequence.requiredRecord.includes('reason-the-next-priority-choice-is-required'));
  assert.ok(sequence.constraints.includes('A candidate list or package name is not an integration mandate or admission.'));
  assert.match(sequence.scopeStatus, /no owner extension, extraction, external package, or new runtime is admitted/u);
  assert.equal(sequence.orderedChoices.indexOf('consider-external-OSS-only-after-exact-reuse-license-security-isolation-and-profile-benchmark-review') < sequence.orderedChoices.indexOf('implement-new-Media-mechanics-only-when-no-fitting-admitted-owner-contract-extension-or-extraction-is-available-and-the-remaining-gap-is-justified'), true);
});

test('Data Cloud compatibility continuity is explicit while Media mutations stay owner-bound', () => {
  const rule = pendingRules.find((item) => item.claimId === 'MPSEM-0024-C002');
  assert.ok(rule);
  const reconciliation = resolveRef(rule.targetRef);
  assert.equal(rule.targetRef.endsWith('@id=datacloud-media-compatibility/retryReconciliation'), true);
  assert.match(reconciliation, /Preserve Data Cloud navigation and compatibility until consumer migration/u);
  assert.match(reconciliation, /admitted Media request identity/u);
  assert.match(reconciliation, /reconcile uncertain jobs/u);
  assert.doesNotMatch(reconciliation, /Data Cloud becomes canonical Media artifact or job state/u);
});

test('external owner binding requires immutable public identity and fails closed when fingerprint evidence is absent', () => {
  const rule = pendingRules.find((item) => item.claimId === 'MPSEM-0167-C003');
  assert.ok(rule);
  const binding = resolveRef(rule.targetRef);
  assert.equal(rule.targetRef.endsWith('#publicOwnerContractFingerprintRule'), true);
  for (const phrase of [
    'Media authors and governs Media product meaning in the current owning PDP records',
    'an external owner controls its own public capability semantics',
    'canonical external owner identity and accountable contract owner',
    'immutable published artifact or package version and content fingerprint',
    'exact public operation, request/result schema and compatibility revision',
    'source/publication location and owner-resolution evidence',
    'without copying or redefining external-owner meaning',
  ]) assert.ok(JSON.stringify(binding).includes(phrase), phrase);
  assert.match(binding.unresolvedBehavior, /keep that binding pending/u);
  assert.match(binding.scopeStatus, /does not assert that a current external contract is published/u);
  const bindingIsComplete = (evidence) => [
    'ownerId',
    'version',
    'artifactFingerprint',
    'operation',
    'schemaFingerprint',
    'publicationSource',
    'ownerResolution',
    'mediaSemanticBinding',
  ].every((key) => typeof evidence[key] === 'string' && evidence[key].trim().length > 0);
  const complete = Object.fromEntries(['ownerId', 'version', 'artifactFingerprint', 'operation', 'schemaFingerprint', 'publicationSource', 'ownerResolution', 'mediaSemanticBinding'].map((key) => [key, 'verified-source-value']));
  assert.equal(bindingIsComplete(complete), true);
  assert.equal(bindingIsComplete({ ...complete, artifactFingerprint: '' }), false);
  assert.equal(bindingIsComplete({ ...complete, ownerResolution: undefined }), false);
  assert.equal(bindingIsComplete({ ...complete, mediaSemanticBinding: '' }), false);
});

test('Media meaning remains Media-owned while external capability meaning stays owner-controlled', () => {
  const rule = pendingRules.find((item) => item.claimId === 'MPSEM-0092-C003');
  assert.ok(rule);
  const binding = resolveRef(rule.targetRef);
  assert.equal(rule.targetRef.endsWith('#publicOwnerContractFingerprintRule'), true);
  assert.match(binding.mediaSemanticAuthority, /Media authors and governs Media product meaning/u);
  assert.match(binding.mediaSemanticAuthority, /external owner controls its own public capability semantics/u);
  assert.match(binding.mediaSemanticAuthority, /exact published contract without copying/u);
  assert.match(binding.scopeStatus, /does not assert that a current external contract is published/u);
});

test('Data Cloud consumer visibility uses its own scoped continuation rather than DI cancellation state', () => {
  const claim = claims().find((item) => item.claimId === 'MPSEM-0471-C004');
  const review = pendingRules.find((item) => item.claimId === 'MPSEM-0471-C004');
  assert.ok(claim && review);
  assert.equal(claim.targetRef, review.targetRef);
  assert.equal(review.targetRef.endsWith('@id=datacloud-media-compatibility/returnContinuation'), true);
  const continuation = resolveRef(review.targetRef);
  assert.match(continuation, /same scoped context and route identity/u);
  assert.match(continuation, /revalidate current authorization and policy scope/u);
  assert.match(continuation, /access is absent, expired, revoked, or indeterminate/u);
  assert.match(continuation, /withholding protected data/u);
  assert.match(continuation, /never grants or widens access/u);
  const preservesAccessBoundary = (value) => /revalidate current authorization and policy scope/u.test(value)
    && /withholding protected data/u.test(value)
    && /never grants or widens access/u.test(value);
  for (const falseContinuation of [
    'Return to the same route and context; retain existing access.',
    'Keep the consumer view visible and allow access when the authorization status is unknown.',
    'Return to Data Cloud using the same route without checking current policy scope.',
  ]) assert.equal(preservesAccessBoundary(falseContinuation), false, falseContinuation);
  assert.doesNotMatch(review.targetRef, /document-intelligence|generation-token/u);
});

test('wrong owner locators and semantic mutations fail the reviewed bindings', () => {
  for (const rule of rules) {
    const target = resolveRef(rule.targetRef);
    assert.notEqual(target, rule.exactSourceText, `${rule.claimId} does not simply echo migration prose as authority`);
    const [source, pointer] = rule.targetRef.split('#', 2);
    const segments = pointer.split('/');
    segments[segments.length - 1] = 'missing-reviewed-owner-field';
    assert.throws(() => resolveRef(`${source}#${segments.join('/')}`), undefined, `${rule.claimId} rejects a substituted locator`);
    assert.notEqual(digest(JSON.stringify(`${target} semantic mutation`)), rule.targetValueSha256, `${rule.claimId} rejects changed owner semantics`);
  }
});
