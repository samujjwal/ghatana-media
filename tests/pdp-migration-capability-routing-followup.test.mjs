import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const yaml = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
const [fragment, baseline, reuse, time, qualification, glossary, navigation] = await Promise.all([
  readFile('docs/implementation/verification/pdp-38/migration-capability-followup-review.json', 'utf8').then(JSON.parse),
  readFile('docs/implementation/verification/pdp-38/migration-capability-reviewed.json', 'utf8').then(JSON.parse),
  readFile('.product-experience/pdp-0-product-truth/reuse-decisions.yaml', 'utf8').then(yaml.parse),
  readFile('.product-experience/pdp-0-product-truth/time-units-fidelity.yaml', 'utf8').then(yaml.parse),
  readFile('.product-experience/pdp-0-product-truth/qualification-policy.yaml', 'utf8').then(yaml.parse),
  readFile('.product-experience/pdp-0-product-truth/glossary.yaml', 'utf8').then(yaml.parse),
  readFile('.product-experience/pdp-3-product-experience/navigation-contracts.yaml', 'utf8').then(yaml.parse),
]);
const policyPath = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml";
const frozenDeltas = JSON.parse(await readFile("docs/implementation/verification/pdp-38/migration-frozen-source-deltas.json", "utf8"));
const currentSourceObservations = JSON.parse(await readFile("docs/implementation/verification/pdp-38/migration-capability-followup-current-source-observations.json", "utf8"));
const policyInputThreatsObservation = JSON.parse(await readFile("docs/implementation/verification/pdp-38/policy-input-threats-current-source-observation.json", "utf8"));
const policyAuthority = await readFile(policyPath, "utf8").then(yaml.parse);
const qualificationSourceSha256 = createHash('sha256').update(await readFile('.product-experience/pdp-0-product-truth/qualification-policy.yaml')).digest('hex');
const historicalPolicyText = await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["show", `${frozenDeltas.priorSourceCommit}:${policyPath}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
const historicalPolicy = yaml.parse(historicalPolicyText);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('Tools development workflow migration claim routes to exact Media execution boundary', () => {
  const record = fragment.records.find(({ claimId }) => claimId === 'MPSEM-0029-C005');
  const original = baseline.records.find(({ claimId }) => claimId === record.claimId);
  const target = reuse.mediaArchitectureRules.genericMechanicsBoundary.tools;
  assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
  assert.equal(record.exactSourceText, original.exactSourceText);
  assert.equal(record.sourceTextSha256, original.sourceTextSha256);
  assert.equal(record.proposedTargetRef, '.product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules.genericMechanicsBoundary.tools');
  assert.equal(record.targetValueSha256, hash(target));
  assert.match(target.rule, /do not constitute production Media execution/u);
  assert.match(target.admission, /exact admitted Media operation/u);
  assert.equal(record.acceptanceEffect, 'none');
  assert.ok(record.negativeCases.length >= 2);
});

test('clock and conversion migration claims route to distinct exact time policies', () => {
  assert.equal(fragment.sourceBaselineSha256, baseline.sourceBaselineSha256);
  const expected = new Map([
    ['MPSEM-0033-C002', ['.product-experience/pdp-0-product-truth/time-units-fidelity.yaml#separateClocks', time.separateClocks]],
    ['MPSEM-0033-C004', ['.product-experience/pdp-0-product-truth/time-units-fidelity.yaml#conversionRequirements', time.conversionRequirements]],
  ]);
  for (const [claimId, [ref, value]] of expected) {
    const record = fragment.records.find((entry) => entry.claimId === claimId);
    const original = baseline.records.find((entry) => entry.claimId === claimId);
    assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
    assert.equal(record.exactSourceText, original.exactSourceText);
    assert.equal(record.sourceTextSha256, original.sourceTextSha256);
    assert.equal(record.proposedTargetRef, ref);
    assert.equal(record.targetValueSha256, hash(value));
    assert.equal(record.acceptanceEffect, 'none');
    assert.match(record.negativeCases.join(' '), /No conversion implementation/u);
  }
  assert.ok(time.separateClocks.some(({ id }) => id === 'audio_sample_time'));
  assert.ok(time.separateClocks.some(({ id }) => id === 't_sim'));
  assert.ok(time.separateClocks.some(({ id }) => id === 't_story'));
  assert.ok(time.conversionRequirements.some((rule) => /source clock\/time base, destination clock\/rate/u.test(rule)));
});

test('per-metric qualification claim routes to exact leaf and profile scope policy', () => {
  const record = fragment.records.find((entry) => entry.claimId === 'MPSEM-0035-C003');
  const original = baseline.records.find((entry) => entry.claimId === record.claimId);
  const value = record.reviewedPredicates.find(({ evidence }) => evidence.targetValue !== undefined).evidence.targetValue;
  assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
  assert.equal(record.exactSourceText, original.exactSourceText);
  assert.equal(record.sourceTextSha256, original.sourceTextSha256);
  assert.equal(record.proposedTargetRef, '.product-experience/pdp-0-product-truth/qualification-policy.yaml#decisionRules/4');
  assert.equal(record.targetValueSha256, hash(value), 'the historical followup review retains its original target bytes');
  assert.match(value, /declared leaf and scope/u);
  assert.match(value, /quality dataset/u);
  assert.equal(record.acceptanceEffect, 'none');
  assert.match(record.negativeCases.join(' '), /No model, provider, metric/u);
  const observation = currentSourceObservations.records.find(({ claimId }) => claimId === record.claimId);
  assert.equal(observation.targetRef, record.proposedTargetRef);
  assert.equal(observation.historicalTargetValueSha256, record.targetValueSha256);
  assert.equal(observation.currentTargetValueSha256, hash(qualification.decisionRules[4]));
  assert.equal(observation.currentSourceFileSha256, qualificationSourceSha256);
  assert.equal(observation.currentReviewStatus, 'PENDING_COORDINATOR_MATERIAL_REVIEW');
  assert.equal(observation.semanticEquivalence, 'NOT_ASSERTED');
  assert.equal(observation.semanticPromotion, false);
  assert.equal(observation.acceptanceEffect, 'none');
  assert.match(qualification.decisionRules[4], /unknown applicability or a NOT_EVALUATED bound/u);
  assert.equal(qualification.decisionRules[5], value, 'the reviewed clause shifted but is not approved at a new locator');
});

test('whole-array availability claim records the inserted rule as pending current-source change', () => {
  const record = fragment.records.find(({ claimId }) => claimId === 'MPSEM-0043-C002');
  const original = baseline.records.find(({ claimId }) => claimId === record.claimId);
  const evidence = record.reviewedPredicates.find(({ evidence }) => evidence.targetValue !== undefined).evidence;
  const observation = currentSourceObservations.records.find(({ claimId }) => claimId === record.claimId);
  assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
  assert.equal(record.exactSourceText, original.exactSourceText);
  assert.equal(record.sourceTextSha256, original.sourceTextSha256);
  assert.equal(record.proposedTargetRef, '.product-experience/pdp-0-product-truth/qualification-policy.yaml#decisionRules');
  assert.equal(hash(evidence.targetValue), record.targetValueSha256);
  assert.equal(evidence.targetValue.length, 9);
  assert.equal(qualification.decisionRules.length, 10);
  assert.deepEqual(qualification.decisionRules.slice(0, 4), evidence.targetValue.slice(0, 4));
  assert.deepEqual(qualification.decisionRules.slice(5), evidence.targetValue.slice(4));
  assert.equal(observation.historicalTargetValueSha256, record.targetValueSha256);
  assert.equal(observation.currentTargetValueSha256, hash(qualification.decisionRules));
  assert.equal(observation.currentSourceFileSha256, qualificationSourceSha256);
  assert.equal(observation.currentReviewStatus, 'PENDING_COORDINATOR_MATERIAL_REVIEW');
  assert.equal(observation.semanticEquivalence, 'NOT_ASSERTED');
  assert.equal(observation.semanticPromotion, false);
  assert.equal(observation.acceptanceEffect, 'none');
});

test('untrusted decoder and executable isolation claim routes to the exact security baseline', () => {
  const record = fragment.records.find((entry) => entry.claimId === 'MPSEM-0039-C003');
  const original = baseline.records.find((entry) => entry.claimId === record.claimId);
  const qualificationPolicy = qualification.securityAndRightsBaseline[1];
  assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
  assert.equal(record.exactSourceText, original.exactSourceText);
  assert.equal(record.sourceTextSha256, original.sourceTextSha256);
  assert.equal(record.proposedTargetRef, '.product-experience/pdp-0-product-truth/qualification-policy.yaml#securityAndRightsBaseline/1');
  assert.equal(record.targetValueSha256, hash(qualificationPolicy));
  assert.match(qualificationPolicy, /Decode and execute engines in isolated workers/u);
  assert.match(qualificationPolicy, /restricted network egress/u);
  assert.match(record.negativeCases.join(' '), /does not establish.*admitted or qualified/u);
  assert.equal(record.acceptanceEffect, 'none');
});

test("PXD-100 browser/local-worker rule is a single additive current source delta", async () => {
  const impact = frozenDeltas.records.find(({ claimId }) => claimId === "MPSEM-0388-C005");
  const current = policyAuthority.productPolicy.inputAndExecutionThreats;
  const historical = historicalPolicy.productPolicy.inputAndExecutionThreats;
  const currentWithoutAdditions = structuredClone(current);
  delete currentWithoutAdditions.browserToLocalWorkerBoundary;
  delete currentWithoutAdditions.archiveExtractionDestinationRule;
  const currentReview = JSON.parse(await readFile("docs/implementation/verification/pdp-38/migration-coordinator-p2-review-97.json", "utf8"));
  const reviewed = currentReview.records.find(({ claimId }) => claimId === "MPSEM-0388-C005");
  const boundary = current.browserToLocalWorkerBoundary;
  const latestObservation = policyInputThreatsObservation.records.find(({ claimId }) => claimId === "MPSEM-0039-C003");

  assert.ok(impact, "the browser boundary has an exact additive impact record");
  assert.equal(impact.semanticPromotion, false);
  assert.equal(impact.historicalTargetValueSha256, hash(historical));
  assert.match(impact.currentTargetValueSha256, /^[a-f0-9]{64}$/u, "historical intermediate source snapshot stays pinned");
  assert.deepEqual(currentWithoutAdditions, historical, "the two later fields leave the historical input-threat rules intact");
  assert.equal(latestObservation.currentTargetValueSha256, hash(current));
  assert.equal(latestObservation.sourceFileSha256, createHash('sha256').update(await readFile(policyPath)).digest('hex'));
  assert.deepEqual(latestObservation.addedPaths, [
    "#/productPolicy/inputAndExecutionThreats/archiveExtractionDestinationRule",
    "#/productPolicy/inputAndExecutionThreats/browserToLocalWorkerBoundary",
  ]);
  assert.equal(latestObservation.historicalProjectionSha256, hash(historical));
  assert.equal(latestObservation.semanticPromotion, false);
  assert.equal(latestObservation.acceptanceEffect, "none");
  assert.deepEqual(reviewed?.currentTargetRef, `${policyPath}#productPolicy/inputAndExecutionThreats/browserToLocalWorkerBoundary`);
  assert.equal(hash(boundary), reviewed.currentTargetValueSha256, "PXD-100 pins the current exact target");
  assert.match(boundary.rule, /loopback is not authentication or authorization/u);
  assert.ok(boundary.requiredChecks.includes("authenticated-pairing-proof-is-current-and-bound-to-tenant-principal-origin-worker-and-grant"));
  assert.ok(boundary.rejectionCases.includes("missing-null-opaque-or-unallowlisted-browser-origin"));
  assert.equal(boundary.failure, "reject-before-local-file-read-or-effect");
  assert.equal(boundary.runtimeStatus, "DEFINITION_ONLY_NOT_RUNTIME_EVIDENCE");
});

test('capability availability, invocation, recipe, and document-intelligence claims route to exact owner records', () => {
  const recipe = glossary.terms.find(({ id }) => id === 'media.term.recipe');
  const targets = new Map([
    ['MPSEM-0043-C002', ['.product-experience/pdp-0-product-truth/qualification-policy.yaml#decisionRules', qualification.decisionRules]],
    ['MPSEM-0080-C002', ['.product-experience/pdp-0-product-truth/qualification-policy.yaml#decisionRules/3', qualification.decisionRules[3]]],
    ['MPSEM-0095-C004', ['.product-experience/pdp-0-product-truth/glossary.yaml#terms/@id=media.term.recipe', recipe]],
    ['MPSEM-0101-C002', ['.product-experience/pdp-0-product-truth/qualification-policy.yaml#documentIntelligence', qualification.documentIntelligence]],
  ]);
  for (const [claimId, [ref, value]] of targets) {
    const record = fragment.records.find((entry) => entry.claimId === claimId);
    const original = baseline.records.find((entry) => entry.claimId === claimId);
    assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
    assert.equal(record.exactSourceText, original.exactSourceText);
    assert.equal(record.sourceTextSha256, original.sourceTextSha256);
    assert.equal(record.proposedTargetRef, ref);
    if (claimId !== 'MPSEM-0043-C002') assert.equal(record.targetValueSha256, hash(value));
    assert.equal(record.acceptanceEffect, 'none');
    assert.ok(record.negativeCases.length >= 2);
  }
  assert.match(qualification.decisionRules[3], /exact implementation binding is admitted/u);
  assert.match(recipe.distinctions.join(' '), /does not route generic model providers/u);
  assert.match(qualification.documentIntelligence.activationState, /not-activated-by-migration/u);
});

test('ordinary product navigation does not expose a technical provider catalog by default', () => {
  const record = fragment.records.find((entry) => entry.claimId === 'MPSEM-0041-C004');
  const original = baseline.records.find((entry) => entry.claimId === record.claimId);
  const boundary = navigation.informationArchitecture.ordinaryPathProviderSelection;
  assert.equal(record.semanticReviewStatus, 'SEMANTIC_PARITY_VERIFIED');
  assert.equal(record.exactSourceText, original.exactSourceText);
  assert.equal(record.sourceTextSha256, original.sourceTextSha256);
  assert.equal(record.proposedTargetRef, '.product-experience/pdp-3-product-experience/navigation-contracts.yaml#informationArchitecture.ordinaryPathProviderSelection');
  assert.equal(record.targetValueSha256, hash(boundary));
  assert.match(boundary.rule, /does not expose a technical vendor, model, or provider catalog/u);
  assert.ok(boundary.nonClaims.some((item) => /no provider or model is selected, qualified, or admitted/u.test(item)));
  assert.equal(record.acceptanceEffect, 'none');
});
