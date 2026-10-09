import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditMediaObligationDenominator, enumerateExpectedMediaObligations } from '../scripts/lib/media-obligation-denominator-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const { parse } = requireTools('yaml');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const input = () => ({
  root,
  obligations: readJson('config/closure/media-product-definition/obligations.json'),
  program: readJson('config/closure/media-product-definition/phase-program.json'),
  binding: readJson('config/closure/media-product-definition/phase-binding.json'),
  surface: readJson('config/closure/media-product-definition/surface.json'),
  traceability: parse(fs.readFileSync(path.join(root, '.product-experience/traceability.yaml'), 'utf8')),
  parseYaml: parse,
});

test('audits the exact current source denominator, phase counts, memberships, and resolvable source records', () => {
  const enumeration = enumerateExpectedMediaObligations({root, parseYaml:parse});
  assert.deepEqual(enumeration.issues, []);
  const total = enumeration.records.length;
  const phaseCounts = Object.fromEntries([0,1,2,3].map(p=>[`PDP-${p}`,enumeration.records.filter(r=>r.phase===`PDP-${p}`).length]));
  const report = auditMediaObligationDenominator(input());
  assert.equal(report.total, total);
  assert.equal(report.uniqueIds, report.total);
  assert.deepEqual(report.phaseCounts, phaseCounts);
  assert.equal(report.dispositionRecords, report.total);
  assert.deepEqual(report.sourceReferences, { total, resolved: total, unresolved: 0 });
  assert.ok(Object.keys(report.sourceFingerprints.files).length > 0);
  assert.deepEqual(report.sourceFingerprints.comparison, { present: total, matching: total, stale: 0, absent: 0 });
  assert.equal(report.authoritativeObserverAssignments, 0);
  assert.equal(report.authoritativeOracleAssignments, 0);
  assert.equal(report.status, 'DENOMINATOR_AND_MEMBERSHIP_CHECKED_SOURCE_SEMANTIC_ACCEPTANCE_PENDING');
  assert.deepEqual(report.issues, []);
});

test('refreshes the nine operation-source fingerprints only after their semantic impact is reconciled', () => {
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  const operations = parse(fs.readFileSync(path.join(root, '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8'));
  const reviewedCommit = 'd99baf7b5df806ed8c528ce1ad4bd90f8640434c';
  const historicalOperationText = execFileSync('git', ['show', `${reviewedCommit}:.product-experience/pdp-1-domain-data/operations.yaml`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const historicalOperations = parse(historicalOperationText);
  const historicalReviewText = execFileSync('git', ['show', `${reviewedCommit}:.product-experience/pdp-0-product-truth/capability-leaf-review.yaml`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const review = parse(historicalReviewText);
  const reconciliation = review.sourcePinReconciliations.find(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-1-domain-data/operations.yaml');
  const reviewedSourcePin = review.sourceInventory.find(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-1-domain-data/operations.yaml');
  const previousDelta = reconciliation?.subsequentSourceDelta;
  const finalDelta = reconciliation?.ownerDispositionSourceDelta;
  assert.ok(finalDelta, 'the current operations source has a semantic impact record beyond the RPC reconciliation');
  assert.ok(previousDelta, 'the SDK census and submission/execution source change remains separately reconciled');
  assert.equal(finalDelta.previousSha256, previousDelta.currentSha256);
  assert.equal(finalDelta.currentSha256, reconciliation.currentSha256);

  const sourced = obligations.filter(({ extensions }) => extensions?.['media-source']?.sourceRef?.startsWith('.product-experience/pdp-1-domain-data/operations.yaml#'));
  const expectedSources = enumerateExpectedMediaObligations({ root, parseYaml: parse }).records.filter(record => record.sourceRef.startsWith('.product-experience/pdp-1-domain-data/operations.yaml#'));
  assert.equal(sourced.length, expectedSources.length);
  const digests = new Set(sourced.map(({ extensions }) => extensions['media-source'].sourceDigest));
  const currentSourceDigest = createHash('sha256')
    .update(fs.readFileSync(path.join(root, '.product-experience/pdp-1-domain-data/operations.yaml'))).digest('hex');
  const currentReview = review.ownerDefinitionSourceReconciliation.records.find(record => record.path === '.product-experience/pdp-1-domain-data/operations.yaml');
  const reviewedOperationCut = readJson('docs/implementation/verification/pdp-38/owner-query-current-cut-review.json');
  const reviewedOperationDigest = reviewedOperationCut.sourceFingerprints['.product-experience/pdp-1-domain-data/operations.yaml'];
  assert.equal(reviewedOperationCut.decisionRef, '.product-experience/decision-log.md#PXD-094');
  assert.equal(reviewedOperationDigest, '16cb028dcb28ec7d91b8698412a2f1a41c05f5779d7164f42cd13facd7389e54');
  assert.deepEqual([...digests], [`sha256:${currentSourceDigest}`]);
  assert.equal(createHash('sha256').update(historicalOperationText).digest('hex'), reviewedOperationDigest,
    'PXD-094 remains tied to its exact historical operation bytes');
  const directCriteria = readJson('docs/implementation/verification/pdp-38/direct-definition-criteria-review.json');
  const currentP001 = directCriteria.records.find(({ taskId }) => taskId === 'P0-01')?.currentCorrectiveReview;
  assert.equal(currentP001?.status, 'APPROVED_CURRENT_CORRECTION');
  assert.equal(currentP001?.decisionRef, '.product-experience/decision-log.md#PXD-106');
  assert.equal(currentP001?.sourceFingerprints['.product-experience/pdp-1-domain-data/operations.yaml'], currentSourceDigest,
    'the current operations source is checked against PXD-106 separately from historical PXD-094');
  assert.equal(currentReview.currentSha256, 'f279538b72a1bdd73a6cf88556eebdaf91c9799a033f460233b796bf8df8f89d',
    'the older additive source overlay remains immutable history rather than being rewritten to the newer review');
  assert.equal(reviewedSourcePin.sha256, review.transcriptionSubmissionDefinitionSourceReconciliations.find(record => record.path === '.product-experience/pdp-1-domain-data/operations.yaml').currentSha256, 'the historical SDK source pin remains immutable');
  assert.notEqual(currentSourceDigest, finalDelta.currentSha256,
    'new SDK adapter denominator metadata postdates the bounded capability operation review');
  assert.match(operations.individualOperationContracts.status, /pending/u);
  const recordById = new Map(historicalOperations.operations.map((record) => [record.id, record]));
  const expectedRecordHashes = previousDelta.unchangedObligationSourceRecords;
  assert.equal(Object.keys(expectedRecordHashes).length, 9);
  const previouslyReviewedIds = new Set(Object.keys(expectedRecordHashes));
  const previouslyReviewed = sourced.filter(({ extensions }) => previouslyReviewedIds.has(extensions['media-source'].recordId));
  assert.equal(previouslyReviewed.length, 9);
  const newlyEnumerated = sourced.filter(({ extensions }) => !previouslyReviewedIds.has(extensions['media-source'].recordId));
  assert.equal(newlyEnumerated.length, expectedSources.length - 9);
  const deltas = new Map(currentReview.currentFamilyRecordDeltas.records.map(record => [record.id, record]));
  assert.equal(deltas.size, 9);
  for (const obligation of previouslyReviewed) {
    const source = obligation.extensions['media-source'];
    const recordId = source.recordId;
    const record = recordById.get(recordId);
    assert.ok(record, `${obligation.id} still resolves to ${recordId}`);
    assert.equal(source.sourceRef, `.product-experience/pdp-1-domain-data/operations.yaml#/operations/${recordId}`);
    const semanticHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    const delta = deltas.get(recordId);
    assert.ok(delta);
    assert.equal(delta.previousJsonSha256, expectedRecordHashes[recordId]);
    assert.equal(semanticHash, delta.currentJsonSha256);
    assert.deepEqual(delta.changedFields, ['operationKind']);
    const original = structuredClone(record); delete original.operationKind;
    assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), expectedRecordHashes[recordId], `${recordId} preserves every historical semantic field beyond the explicitly reviewed additive kind`);
  }
  assert.match(finalDelta.reviewedCapabilityEvidence.impact, /no capability-leaf operation binding/u);
});

test('thirteen individual source slices add obligations but no case, observer, oracle, or admission claims', () => {
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  const operations = parse(fs.readFileSync(path.join(root, '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8'));
  const records = operations.individualOperationContracts.records;
  const ids = records.map(({ id }) => id);
  assert.equal(records.length, 13);
  assert.equal(new Set(ids).size, 13);
  for (const record of records) {
    assert.ok(record.sourceRef, `${record.id} cites a source route`);
    assert.ok(record.sourceBounds, `${record.id} scopes its source claims`);
    assert.ok(record.finality, `${record.id} distinguishes operation finality`);
    assert.ok(record.negativeCases?.length >= 3, `${record.id} preserves negative/fail-closed cases`);
    const ref = `.product-experience/pdp-1-domain-data/operations.yaml#/individualOperationContracts/records/${record.id}`;
    const obligation = obligations.find(({ extensions }) => extensions?.['media-source']?.sourceRef === ref);
    assert.ok(obligation, `${record.id} has its exact source-derived obligation`);
    assert.deepEqual(obligation.caseIds, []);
    assert.deepEqual(obligation.observerIds, []);
    assert.deepEqual(obligation.oracleIds, []);
    assert.equal(obligation.extensions['media-source'].recordId, record.id);
  }
  for (const id of [
    'media.operation-slice.create-project',
    'media.operation-slice.list-projects',
    'media.operation-slice.inspect-project',
  ]) {
    const record = records.find((item) => item.id === id);
    assert.ok(record.sourceBounds, `${id} separates journey requirements from owner-defined details and runtime claims`);
    assert.match(record.sourceBounds, /J-01/u);
    assert.match(record.sourceBounds, /no deployed|does not establish|do not establish|do not prescribe/u);
  }
});

test('PDP-2 obligation fingerprints change only after exact source-record impact is recorded', () => {
  const ledger = readJson('.product-experience/pdp-0-product-truth/implementation-status-2026-10-07.json');
  const impacts = new Map(ledger.source_pin_impact_reconciliations.map((item) => [item.path, item]));
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  for (const sourcePath of [
    '.product-experience/pdp-2-design-interface-system/component-contracts.yaml',
    '.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml',
  ]) {
    const impact = impacts.get(sourcePath);
    assert.ok(impact, `${sourcePath} has a bounded impact review`);
    const sourceText = fs.readFileSync(path.resolve(root, sourcePath), 'utf8');
    const digest = `sha256:${createHash('sha256').update(sourceText).digest('hex')}`;
    if (sourcePath.endsWith('/component-contracts.yaml')) {
      const currentReview = readJson('docs/implementation/verification/pdp-38/component-source-review.json');
      assert.equal(currentReview.decisionRef, '.product-experience/decision-log.md#PXD-083');
      const supplemental = readJson('docs/implementation/verification/pdp-38/component-current-source-impact.json');
      assert.equal(supplemental.priorSourceSha256,currentReview.sourceFingerprints[sourcePath]);
      assert.equal(`sha256:${supplemental.currentSourceSha256}`,digest);
      const currentTree=parse(sourceText);
      const {ownerDefinedComponentRules,normativeRuleRecords,...unchanged}=currentTree;
      assert.equal(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex'),supplemental.unchangedPriorParsedTreeSha256);
      assert.deepEqual(ownerDefinedComponentRules.map(r=>({id:r.id,recordSha256:createHash('sha256').update(JSON.stringify(r)).digest('hex'),negativeCases:r.negativeCases})),supplemental.addedRuleRecords);
      assert.equal(normativeRuleRecords.length,12);
      assert.equal(supplemental.wholeTaskCriterionEstablished,false);assert.equal(supplemental.nativeLifecycleReceipt,null);
      assert.equal(currentReview.wholeTaskCriterionEstablished, false);
      assert.equal(currentReview.nativeLifecycleReceipt, null);
    } else {
      const currentImpact = readJson('docs/implementation/verification/pdp-38/media-token-aliases-current-impact.json');
      assert.equal(currentImpact.historicalSourcePin, impact.currentSha256);
      assert.equal(`sha256:${currentImpact.currentSourceSha256}`, digest);
      assert.equal(currentImpact.unchangedSemanticRecords.aliasCount, 9);
      assert.equal(currentImpact.unchangedSemanticRecords.semanticAliasValuesChanged, false);
      assert.equal(currentImpact.coordinatorReview.wholeTaskCriterionEstablished, false);
      assert.equal(currentImpact.coordinatorReview.nativeLifecycleReceipt, null);
    }
    const refs = obligations.filter(({ extensions }) => extensions?.['media-source']?.sourceRef?.startsWith(`${sourcePath}#`));
    const expected = enumerateExpectedMediaObligations({root, parseYaml:parse}).records.filter(record => record.sourceRef.startsWith(`${sourcePath}#`));
    assert.equal(refs.length, expected.length);
    assert.ok(refs.every(({ extensions }) => extensions['media-source'].sourceDigest === digest));
    assert.equal(impact.acceptanceEffect.startsWith('none;'), true);
  }
  const components = impacts.get('.product-experience/pdp-2-design-interface-system/component-contracts.yaml');
  assert.equal(components.obligationCount, 31);
  assert.equal(components.newObligationCount, 1);
  assert.equal(components.unchangedObligationRecordCount, 28);
  assert.deepEqual(components.changedObligationRecords.map(({ recordId }) => recordId).sort(), [
    'media.component.task-flow',
    'media.component.voice-production-workflow',
  ]);
  const tokens = impacts.get('.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml');
  assert.equal(tokens.obligationCount, 9);
  assert.equal(tokens.unchangedObligationRecordCount, 9);
  assert.equal(tokens.changedObligationRecords.length, 0);
});

test('PXD-032 adds only the required source-proposal obligation for the progress-indicator contract', () => {
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  const item = obligations.find(({ id }) => id === 'media.pdp-2.requirement.media.component.progress-indicator');
  assert.ok(item);
  assert.equal(item.disposition, 'REQUIRED');
  assert.deepEqual(item.phaseSemantics, { applicableIn: ['PDP-2'], blockingIn: ['PDP-2'], affects: ['PDP-2'] });
  assert.deepEqual(item.caseIds, ['media.definition-case.component-binding.progress-indicator']);
  assert.deepEqual(item.observerIds, []);
  assert.deepEqual(item.oracleIds, []);
  assert.equal(item.extensions['media-source'].recordId, 'media.component.progress-indicator');
  const caseLinks = readJson('config/closure/media-product-definition/l02-source-case-links.json');
  const link = caseLinks.candidateLinks.find(({ obligationId }) => obligationId === item.id);
  assert.equal(link.caseId, 'media.definition-case.component-binding.progress-indicator');
  assert.equal(link.method, 'PARAMETERIZED_SOURCE_DEFINITION_ASSERTIONS');
  assert.equal(link.scope, 'PARTIAL_SOURCE_DEFINITION_ASSERTIONS_ONLY');
  assert.equal(link.admission, 'NOT_LIFECYCLE_ADMITTED');
  assert.equal(item.extensions['media-source'].sourceRef, '.product-experience/pdp-2-design-interface-system/component-contracts.yaml#/components/media.component.progress-indicator');
  const acceptance = parse(fs.readFileSync(path.join(root, '.product-experience/acceptance.yaml'), 'utf8'));
  const decision = acceptance.recordedHumanDecisionInputs.find(({ id }) => id === 'ACCEPT-INPUT-MEDIA-OWNER-PDP2-PROGRESS-OBLIGATION-20261008');
  assert.ok(decision);
  assert.equal(decision.decisionInput, 'accepted');
  assert.ok(decision.exclusions.some((entry) => /Lifecycle currentness\/receipts/u.test(entry)));
});

test('flags duplicate IDs, phase contradictions, and duplicate or missing selected membership', () => {
  const data = input();
  data.obligations[0].phaseSemantics.applicableIn = ['PDP-1'];
  data.obligations[1].id = data.obligations[0].id;
  data.program.phases[0].obligationIds.pop();
  data.program.phases[0].obligationIds.push(data.obligations[0].id, data.obligations[0].id);
  const report = auditMediaObligationDenominator(data);
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has('DUPLICATE_ID'));
  assert.ok(codes.has('CONTRADICTORY_PHASE'));
  assert.ok(codes.has('DUPLICATE_SELECTION'));
  assert.ok(codes.has('MISSING_SELECTION'));
});

test('flags unresolved source references and stale expected fingerprints', () => {
  const data = input();
  data.obligations[0].extensions['media-source'].sourceRef = '.product-experience/missing.yaml#/requirements/missing';
  data.obligations[1].extensions['media-source'].sourceDigest = `sha256:${'0'.repeat(64)}`;
  const report = auditMediaObligationDenominator(data);
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has('UNRESOLVED_SOURCE'));
  assert.ok(codes.has('STALE_SOURCE_FINGERPRINT'));
});

test('flags a missing persisted source digest', () => {
  const data = input();
  delete data.obligations[0].extensions['media-source'].sourceDigest;
  const report = auditMediaObligationDenominator(data);
  assert.equal(report.sourceFingerprints.comparison.absent, 1);
  assert.equal(report.sourceFingerprints.comparison.present, data.obligations.length - 1);
  assert.equal(report.sourceFingerprints.comparison.matching + report.sourceFingerprints.comparison.stale, data.obligations.length - 1);
  assert.ok(report.issues.some((issue) => issue.code === 'MISSING_SOURCE_FINGERPRINT'));
});

test('same-process source audits cannot reuse a removed or changed normative record', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-source-audit-freshness-'));
  const relative = '.product-experience/pdp-3-product-experience/view-observation-predicates.yaml';
  const file = path.join(temporaryRoot, relative);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  try {
    fs.writeFileSync(file, 'predicates:\n  - id: media.predicate.original\n');
    const first = enumerateExpectedMediaObligations({root:temporaryRoot, parseYaml:parse});
    assert.ok(first.records.some(record => record.recordId === 'media.predicate.original'));
    fs.writeFileSync(file, 'predicates:\n  - id: media.predicate.replacement\n');
    const second = enumerateExpectedMediaObligations({root:temporaryRoot, parseYaml:parse});
    assert.ok(second.records.some(record => record.recordId === 'media.predicate.replacement'));
    assert.ok(!second.records.some(record => record.recordId === 'media.predicate.original'));
    assert.notEqual(first.sourceDigests[relative], second.sourceDigests[relative]);
    fs.unlinkSync(file);
    const third = enumerateExpectedMediaObligations({root:temporaryRoot, parseYaml:parse});
    assert.ok(!third.records.some(record => record.recordId === 'media.predicate.replacement'));
    assert.ok(third.issues.some(issue => issue.code === 'SOURCE_ENUMERATION_MISSING' && issue.detail.includes(relative)));
  } finally { fs.rmSync(temporaryRoot, {recursive:true, force:true}); }
});
