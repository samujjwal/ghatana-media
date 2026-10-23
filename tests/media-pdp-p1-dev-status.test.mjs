import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {buildPdp1DevStatus, buildPdp1SourceCensus, buildP103TestArgs, p103VerificationSuites, p1Criteria, p1SourceRoots} from '../scripts/report-media-pdp-readiness.mjs';
const parseYaml = createRequire(path.resolve(process.cwd(), '../ghatana-tools/package.json'))('yaml').parse;

test('current PDP-1 semantic review pins the exact full denominator and delegated decision authority', () => {
  const reviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const census = buildPdp1SourceCensus(process.cwd());
  const reviewedIds = review.reviewedIdentityIds ?? [];
  const sourceFingerprints = review.sourceFingerprints ?? {};

  assert.equal(review.status, 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW');
  assert.equal(review.phase, 'PDP-1');
  assert.equal(review.sourceCutStable, true);
  assert.deepEqual([...reviewedIds].sort(), [...census.identityIds].sort());
  assert.equal(new Set(reviewedIds).size, census.identityIds.length);
  assert.deepEqual(Object.keys(review.reviewedPopulationIds).sort(), Object.keys(census.reviewDenominators).sort());
  for (const [population, count] of Object.entries(census.reviewDenominators)) {
    assert.equal(review.reviewedPopulationIds[population].length, count, `${population} covers its exact current denominator`);
  }
  assert.equal(census.sourceRecordCount.p0CapabilityCount, 469);
  assert.equal(census.sourceRecordCount.capabilityOperationRecordCount, 462);
  assert.equal(census.sourceRecordCount.definitionExtensionOperationMappingCount, 7);
  assert.equal(census.reviewDenominators.capabilityOperations, 462,
    'the 462 owner-adjudicated capability operation contracts keep their own denominator');
  assert.equal(census.reviewDenominators.definitionExtensionOperationMappings, 7,
    'the seven PXD-207 mappings are a separate source population');
  assert.equal(census.identityIds.length, 2040);
  const expectedExtensions = [
    'media.generate.video.preset.manage', 'media.generate.video.shot-condition',
    'media.job.schedule.manage', 'media.master.audio.creative-effect.apply',
    'media.project.scene.patch-merge', 'media.quality.audio.content-similarity.assess',
    'media.recipe.specification.compile',
  ].map(id => `definitionExtensionOperationMappings:media.definition-extension-operation.${id.replaceAll('.', '-')}`);
  assert.deepEqual(review.reviewedPopulationIds.definitionExtensionOperationMappings, expectedExtensions.sort());
  assert.equal(review.reviewDenominators.definitionExtensionOperationMappings, 7);
  assert.equal(review.currentCutReview.sourceIdentityCount, 2040);
  assert.equal(review.currentCutReview.reviewedPopulationCount, 25);
  assert.equal(review.sourceIdentityCount, 2040);
  assert.equal(review.reviewedPopulationCount, 25);
  assert.deepEqual(review.outstandingMeaningIds, []);
  assert.ok(Object.hasOwn(sourceFingerprints, '.product-experience/decision-log.md'),
    'the accepted route-owner contract and related P1 decisions are included in the review source cut');
  assert.ok(Object.values(sourceFingerprints).every(hash => /^[a-f0-9]{64}$/u.test(hash)));
  assert.ok(review.decisionReconciliations.some(item => item.id === 'PXD-152'));
  assert.ok(review.decisionReconciliations.some(item => item.id === 'PXD-155'));
  assert.equal(review.currentCutReview?.sourceIdentityCount, census.identityIds.length);
  assert.equal(review.currentCutReview?.currentOperationsSourceReinspection?.status, 'REINSPECTED_CURRENT_SOURCE_CUT');
  assert.equal(review.currentCutReview?.currentOperationsSourceReinspection?.currentSourceSha256,
    crypto.createHash('sha256').update(fs.readFileSync('.product-experience/pdp-1-domain-data/operations.yaml')).digest('hex'),
    'the current reinspection binds the exact current operations source');
  assert.equal(review.currentCutReview?.currentOperationsSourceReinspection?.currentSourceReviewArtifactSha256,
    crypto.createHash('sha256').update(fs.readFileSync('.product-experience/pdp-1-domain-data/operations-current-source-review.json')).digest('hex'),
    'the current reinspection binds its exact source-review artifact');
  const j05Visual = review.supplementaryReviews.find(item => item.id === 'PDP1-J05-VISUAL-SOURCE-SCOPED-OBSERVATIONS-2026-10-19');
  assert.ok(j05Visual, 'the current review includes its bounded J05 visual source reinspection');
  assert.equal(j05Visual.operationId, 'media.operation.vision-analysis');
  assert.equal(j05Visual.sourceSha256, sourceFingerprints['.product-experience/pdp-1-domain-data/operations.yaml']);
  assert.ok(j05Visual.sourceSelectors.includes('.product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.vision-analysis/context'));
  assert.ok(j05Visual.sourceSelectors.includes('.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas/@id=media.typed-output.typed-visual-analysis-result-with-applicability-and-uncertainty'));
  assert.equal(j05Visual.p0VisionCapabilityIds.length, 20);
  assert.equal(j05Visual.verification.command, 'node --test tests/pdp1-vision-source-scoped-observation-contract.test.mjs');
  assert.equal(j05Visual.verification.status, 'PASS');
  assert.equal(j05Visual.verification.passed, 8);
  assert.equal(j05Visual.verification.total, 8);
  assert.equal(j05Visual.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(j05Visual.transportMapping, 'NOT_ESTABLISHED');
  assert.equal(j05Visual.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(j05Visual.independentSpecialistAcceptance, 'NOT_CLAIMED');
  assert.match(j05Visual.meaning, /legacy opaque timeRange is never converted/u);
  assert.match(j05Visual.boundary, /multimodal-analysis operation and legacy RPC mappings remain unresolved/u);
  const pxd164Impact = JSON.parse(fs.readFileSync('docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json', 'utf8'));
  const historicalReview = review.sourceCutHistory?.find(item => item.id === 'PDP1_SOURCE_REVIEW_CUT_PRE_2026_10_18');
  assert.ok(historicalReview, 'the predecessor source review remains preserved as history');
  assert.equal(historicalReview.currentCutReview?.currentOperationsSourceReinspection?.currentSourceSha256,
    pxd164Impact.sourcePredecessor.sourceDigests['.product-experience/pdp-1-domain-data/operations.yaml'].replace(/^sha256:/u, ''),
    'the earlier reinspection remains bound to the exact pre-PXD164 operations source');
  assert.equal(historicalReview.currentCutReview?.currentOperationsSourceReinspection?.previousSourceBytesAvailableInGit, false);
  assert.deepEqual(review.currentCutReview?.outstandingMeaningIds, []);
});

const green = () => Object.fromEntries(p1Criteria.map(id => {
  const check = {status:'PASS',command:`node --test ${id}`,testCount:2,passedTestCount:2,skippedTestCount:0,
    outputSha256:'output-hash',testSourceFingerprints:{'tests/example.test.mjs':'test-hash'}};
  if (id === 'P1-03') check.suites = {
    'bounded-owner-contracts': {status:'PASS',testCount:2,passedTestCount:2,skippedTestCount:0,outputSha256:'a'.repeat(64),testSourceFingerprints:Object.fromEntries(
      p103VerificationSuites['bounded-owner-contracts'].files.map((file, index) => [file, String(index).padStart(1, '0').repeat(64)]))},
    'capability-intent-mapping': {status:'PASS',testCount:12,passedTestCount:12,skippedTestCount:0,outputSha256:'b'.repeat(64),testSourceFingerprints:Object.fromEntries(
      p103VerificationSuites['capability-intent-mapping'].files.map(file => [file, 'b'.repeat(64)]))},
    'owner-action-wire-contracts': {status:'PASS',testCount:4,passedTestCount:4,skippedTestCount:0,outputSha256:'c'.repeat(64),testSourceFingerprints:{'tests/pdp1-owner-action-wire-contracts.test.mjs':'c'.repeat(64)}},
  };
  return [id,check];
}));

test('PDP-1 development status requires current full-denominator review and reports exact source identities', () => {
  const census = {sourceRecordCount: {objects: 2, guards: 1}, identityIds: ['guards:g-1', 'objects:o-1', 'objects:o-2'],
    integrityIssues: [], exportedHandoffIds: ['media.pdp1-pdp2.canonical-domain-handoff.v1'],
    deferredDownstreamFindings: [{id: 'consumer-mismatch', candidates: ['J-05', 'J-06', 'J-08']} ]};
  const sourceShaSet = {'owner.yaml': 'owner-hash'};
  const base = {mainSha: 'fixture-sha', sourceShaSet, verification: green(), sourceCensus: census, sourceCutStable: true};
  const pending = buildPdp1DevStatus(base);
  assert.equal(pending.phase, 'PDP-1');
  assert.equal(pending.status, 'IN_PROGRESS');
  assert.deepEqual(pending.sourceRecordCount, {objects: 2, guards: 1});
  assert.deepEqual(pending.semanticallyResolvedCount, {objects: 0, guards: 0});
  assert.deepEqual(pending.outstandingMeaningIds, ['P1-11:current-full-denominator-semantic-review-not-recorded', 'P1-11:frozen-pdp1-to-pdp2-handoff-not-recorded']);

  const review = {status: 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW', phase: 'PDP-1', sourceCutStable: true,
    sourceFingerprints: {'owner.yaml': 'owner-hash'}, reviewedIdentityIds: census.identityIds, outstandingMeaningIds: []};
  const handoff = ['media.pdp1-pdp2.canonical-domain-handoff.v1'];
  const complete = buildPdp1DevStatus({...base, semanticReview: review, exportedHandoffIds: handoff});
  assert.equal(complete.status, 'DEV_COMPLETE');
  assert.deepEqual(complete.semanticallyResolvedCount, census.sourceRecordCount);
  assert.deepEqual(complete.exportedHandoffIds, handoff);
  assert.equal(complete.directDevelopmentCriteria['P1-11'].sourceSemanticReview, 'COVERED_BY_CURRENT_FULL_DENOMINATOR_REVIEW');
  assert.equal(complete.testsActuallyRun['P1-11'].testCount, 2);
  assert.deepEqual(complete.deferredDownstreamFindings[0].candidates, ['J-05', 'J-06', 'J-08']);
  assert.equal(complete.outstandingMeaningIds.length, 0, 'PDP-3 consumer repair is exported but does not block PDP-1');
  for (const key of ['Lifecycle', 'receipt', 'independentReview', 'certification', 'release', 'production', 'convergence']) {
    assert.equal(Object.keys(complete).some(field => field.toLowerCase().includes(key.toLowerCase())), false, `${key} is not a development-exit input`);
  }
  assert.equal(Object.hasOwn(complete, 'taskCount'), false, 'the historical 38-task ledger is not rewritten');
});

test('J-05/J-06/J-08 are classified as a PDP-3 consumer mismatch against current P0/P1 source facts', () => {
  const p0 = parseYaml(fs.readFileSync('.product-experience/pdp-0-product-truth/capabilities.yaml', 'utf8'));
  const operations = parseYaml(fs.readFileSync('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'));
  assert.ok(p0.capabilities.length > 0);
  assert.ok(p0.capabilities.every(leaf => !Object.hasOwn(leaf.ownerDefinition ?? {}, 'operationRefs')),
    'PDP-0 capability leaves do not own PDP-1 operation references');
  const operation = operations.ownerDefinedOperationContracts.records.find(record => record.id === 'media.operation-slice.attach-source-asset');
  assert.equal(operation.capabilityRef, 'media.project.source-asset.attach');
  assert.ok(operation.sourceRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#media.project.source-asset.attach'));
});

test('PDP-1 development status rejects stale, incomplete, or changed-cut review and any skipped suite', () => {
  const census = {sourceRecordCount: {objects: 2}, identityIds: ['objects:o-1', 'objects:o-2'], integrityIssues: [],
    exportedHandoffIds: ['media.pdp1-pdp2.canonical-domain-handoff.v1']};
  const verification = green();
  const base = {mainSha: 'fixture', sourceShaSet: {'owner.yaml': 'current'}, verification, sourceCensus: census, sourceCutStable: true,
    exportedHandoffIds: ['media.pdp1-pdp2.canonical-domain-handoff.v1'],
    semanticReview: {status: 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW', phase: 'PDP-1', sourceCutStable: true,
      sourceFingerprints: {'owner.yaml': 'current'}, reviewedIdentityIds: census.identityIds, outstandingMeaningIds: []}};
  for (const mutate of [
    review => {review.sourceFingerprints['owner.yaml'] = 'stale';},
    review => {review.reviewedIdentityIds.pop();},
    review => {review.reviewedIdentityIds.push('objects:unknown');},
    review => {review.outstandingMeaningIds.push('P1-01:meaning-open');},
  ]) {
    const semanticReview = structuredClone(base.semanticReview);
    mutate(semanticReview);
    assert.equal(buildPdp1DevStatus({...base, semanticReview}).status, 'IN_PROGRESS');
  }
  assert.equal(buildPdp1DevStatus({...base, sourceCutStable: false}).status, 'IN_PROGRESS');
  assert.equal(buildPdp1DevStatus({...base, exportedHandoffIds: ['media.pdp1-pdp2.other-handoff.v1']}).status, 'IN_PROGRESS');
  assert.equal(buildPdp1DevStatus({...base, exportedHandoffIds: ['media.pdp1-pdp2.canonical-domain-handoff.v1', 'media.pdp1-pdp2.canonical-domain-handoff.v1']}).status, 'IN_PROGRESS');
  const noSourceHandoff = structuredClone(base.sourceCensus);
  delete noSourceHandoff.exportedHandoffIds;
  assert.equal(buildPdp1DevStatus({...base, sourceCensus: noSourceHandoff}).status, 'IN_PROGRESS');
  const skipped = structuredClone(verification);
  skipped['P1-04'].skippedTestCount = 1;
  assert.equal(buildPdp1DevStatus({...base, verification: skipped}).status, 'IN_PROGRESS');
  const missing = structuredClone(verification);
  delete missing['P1-02'];
  assert.equal(buildPdp1DevStatus({...base, verification: missing}).status, 'IN_PROGRESS');
});

test('P1-03 cannot pass unless all three complete focused suites ran with output and source fingerprints', () => {
  const census = {sourceRecordCount:{objects:1},identityIds:['objects:o-1'],integrityIssues:[],exportedHandoffIds:['media.pdp1-pdp2.canonical-domain-handoff.v1']};
  const verification = green();
  const base = {mainSha:'fixture',sourceShaSet:{'owner.yaml':'current'},verification,sourceCensus:census,sourceCutStable:true,
    exportedHandoffIds:['media.pdp1-pdp2.canonical-domain-handoff.v1'],
    semanticReview:{status:'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW',phase:'PDP-1',sourceCutStable:true,
      sourceFingerprints:{'owner.yaml':'current'},reviewedIdentityIds:census.identityIds,outstandingMeaningIds:[]}};
  assert.equal(buildPdp1DevStatus(base).status,'DEV_COMPLETE');
  for (const mutate of [
    suites => { delete suites['capability-intent-mapping']; },
    suites => { suites['capability-intent-mapping'].status='FAIL'; },
    suites => { suites['capability-intent-mapping'].skippedTestCount=1; },
    suites => { suites['capability-intent-mapping'].passedTestCount=2; },
    suites => { suites['capability-intent-mapping'].outputSha256='missing'; },
    suites => { suites['capability-intent-mapping'].testSourceFingerprints={}; },
    suites => { suites['owner-action-wire-contracts'].status='FAIL'; },
    suites => { suites['owner-action-wire-contracts'].skippedTestCount=1; },
    suites => { suites['owner-action-wire-contracts'].testSourceFingerprints={}; },
    suites => { suites.extra={status:'PASS',testCount:1,passedTestCount:1,skippedTestCount:0,outputSha256:'c'.repeat(64),testSourceFingerprints:{'tests/x.test.mjs':'x'} }; },
  ]) {
    const changed=structuredClone(verification);
    mutate(changed['P1-03'].suites);
    assert.equal(buildPdp1DevStatus({...base,verification:changed}).status,'IN_PROGRESS');
  }
});

test('P1-03 preserves all test cases in all three groups', () => {
  const boundedArgs = buildP103TestArgs('bounded-owner-contracts');
  const mappingArgs = buildP103TestArgs('capability-intent-mapping');
  const wireArgs = buildP103TestArgs('owner-action-wire-contracts');
  for (const args of [boundedArgs, mappingArgs, wireArgs]) assert.ok(args.includes('--test-reporter=tap'));
  assert.ok(boundedArgs.includes(path.resolve('tests/pdp-truth-domain.test.mjs')));
  assert.ok(boundedArgs.includes(path.resolve('tests/pdp-job-submit-parameter-contract.test.mjs')));
  for (const file of [
    'tests/pdp1-opaque-id-operation-field-bounds.test.mjs',
    'tests/media-declarative-production-p1-definitions.test.mjs',
    'tests/media-recorder-studio-p1-definitions.test.mjs',
  ]) assert.ok(boundedArgs.includes(path.resolve(file)), `${file} is enforced by the P1-03 gate`);
  assert.ok(mappingArgs.includes(path.resolve('tests/pdp1-capability-intent-operation-mapping.test.mjs')));
  for (const file of [
    'tests/pdp1-vision-source-scoped-observation-contract.test.mjs',
    'tests/pdp1-artifact-upload-result-schema.test.mjs',
    'tests/pdp1-artifact-wire-byte-ceilings.test.mjs',
    'tests/pdp1-job-submit-typed-input-mapping.test.mjs',
    'tests/pdp1-output-producer-contract-mappings.test.mjs',
    'tests/pdp1-provenance-execution-reference.test.mjs',
    'tests/pdp1-provenance-reference-key-bounds.test.mjs',
    'tests/pdp1-provenance-typed-input-mapping.test.mjs',
    'tests/pdp1-requiredness-regression.test.mjs',
    'tests/pdp1-transcription-exact-contract.test.mjs',
    'tests/pdp1-transcription-optional-profile-mapping.test.mjs',
  ]) assert.ok(mappingArgs.includes(path.resolve(file)), `${file} is enforced by the P1-03 gate`);
  assert.ok(wireArgs.includes(path.resolve('tests/pdp1-owner-action-wire-contracts.test.mjs')));
  assert.equal(boundedArgs.some(arg => arg.startsWith('--test-name-pattern=')), false);
  assert.equal(mappingArgs.some(arg => arg.startsWith('--test-name-pattern=')), false);
  assert.equal(wireArgs.some(arg => arg.startsWith('--test-name-pattern=')), false);
});

test('P1-01 includes the lane-A current-source identity review', () => {
  const statusScript = fs.readFileSync('scripts/report-media-pdp-readiness.mjs', 'utf8');
  assert.match(statusScript, /'P1-01':[^\n]*pdp1-lane-a-current-source-review\.test\.mjs/u);
  assert.match(statusScript, /const testArgs=\['--test-reporter=tap',\s*'--test'/u);
});

test('PDP-1 current identity census matches the normative owner registry denominator', () => {
  const census = buildPdp1SourceCensus();
  assert.deepEqual(census.integrityIssues, []);
  assert.equal(census.sourceRecordCount.objectDefinitions, 39);
  assert.equal(census.sourceRecordCount.registeredObjectIdentities, 38);
  assert.equal(census.sourceRecordCount.canonicalProductObjectIdentities, 37);
  assert.equal(census.sourceRecordCount.values, 13);
  assert.equal(census.sourceRecordCount.relationships, 13);
  assert.equal(census.sourceRecordCount.stateMachines, 11);
  assert.equal(census.sourceRecordCount.guardContracts, 55);
  assert.equal(census.sourceRecordCount.guardFacts, 166);
  assert.equal(census.sourceRecordCount.actionWireContracts, 79);
  assert.equal(census.sourceRecordCount.capabilityOperations, 462);
  assert.equal(census.sourceRecordCount.capabilityBounds, 462);
  assert.equal(census.sourceRecordCount.capabilityInputPayloadSchemas, 131);
  assert.equal(census.sourceRecordCount.capabilityOutputPayloadSchemas, 102);
  assert.equal(census.sourceRecordCount.capabilityOperationRecordCount, 462);
  assert.equal(census.sourceRecordCount.canonicalOperationSchemaCount, 448);
  assert.equal(census.sourceRecordCount.existingOperationBindingCount, 14);
  assert.ok(census.sourceRecordCount.httpOperations > 0);
  assert.equal(census.sourceRecordCount.grpcOperations, 43);
  assert.equal(census.sourceRecordCount.sdkRegistryRows, 33);
  assert.equal(census.sourceRecordCount.sdkLogicalPublicMethods, 30);
  assert.equal(census.sourceRecordCount.sdkParserTokens, 3);
  assert.equal(census.sourceRecordCount.grpcDispositionCounts.unresolved, 0);
  assert.equal(census.sourceRecordCount.uiActions, 148);
  assert.equal(census.sourceRecordCount.cliCommands, 11);
  assert.equal(census.sourceRecordCount.agentToolHandlers, 4);
  assert.equal(census.sourceRecordCount.agentToolContracts, 4);
  assert.equal(census.sourceRecordCount.transitions, 55);
  assert.equal(census.sourceRecordCount.guardFactGroups, 43);
  assert.equal(census.sourceRecordCount.capabilityOperationRecordCount, 462);
  assert.equal(census.sourceRecordCount.canonicalOperationSchemaCount, 448);
  assert.equal(census.sourceRecordCount.existingOperationBindingCount, 14);
  assert.deepEqual(census.exportedHandoffIds, ['media.pdp1-pdp2.canonical-domain-handoff.v1']);
  assert.equal(new Set(census.identityIds).size, census.identityIds.length);
  assert.ok(census.identityIds.some(id => id === 'actionWireContracts:media.owner-action-wire.inspect-job-retry-policy.v1'));
  assert.ok(census.identityIds.some(id => id === 'httpOperations:GET /health'));
});

test('PDP-1 source cut fingerprints the P0 time-unit conversion vocabulary it consumes', () => {
  const dependency = '.product-experience/pdp-0-product-truth/time-units-fidelity.yaml';
  assert.ok(p1SourceRoots.includes(dependency));
  const verificationLog = 'docs/implementation/verification/pdp-38/P1-01.log';
  const logBefore = crypto.createHash('sha256').update(fs.readFileSync(verificationLog)).digest('hex');
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['scripts/report-media-pdp-readiness.mjs', '--verify', '--phase-dev-status=PDP-1', '--verify-tasks=P1-01', '--no-write-verification-logs'], {
    cwd: process.cwd(), encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(status.phase, 'PDP-1');
  assert.equal(status.sourceShaSet[dependency], crypto.createHash('sha256').update(fs.readFileSync(dependency)).digest('hex'));
  assert.equal(status.testsActuallyRun['P1-01'].status, 'PASS');
  assert.equal(status.testsActuallyRun['P1-01'].testCount, 23);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(verificationLog)).digest('hex'), logBefore,
    'a subset verification must not replace the full phase verification log');
});
