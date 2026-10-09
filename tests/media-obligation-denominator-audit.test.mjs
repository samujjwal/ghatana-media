import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditMediaObligationDenominator } from '../scripts/lib/media-obligation-denominator-audit.mjs';

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

test('audits exact 347 obligation denominator, four phase counts, memberships, and resolvable source records', () => {
  const report = auditMediaObligationDenominator(input());
  assert.equal(report.total, 347);
  assert.equal(report.uniqueIds, 347);
  assert.deepEqual(report.phaseCounts, { 'PDP-0': 38, 'PDP-1': 149, 'PDP-2': 83, 'PDP-3': 77 });
  assert.equal(report.dispositionRecords, 347);
  assert.deepEqual(report.sourceReferences, { total: 347, resolved: 347, unresolved: 0 });
  assert.ok(Object.keys(report.sourceFingerprints.files).length > 0);
  assert.deepEqual(report.sourceFingerprints.comparison, { present: 347, matching: 347, stale: 0, absent: 0 });
  assert.equal(report.authoritativeObserverAssignments, 0);
  assert.equal(report.authoritativeOracleAssignments, 0);
  assert.equal(report.status, 'DENOMINATOR_AND_MEMBERSHIP_CHECKED_SOURCE_SEMANTIC_ACCEPTANCE_PENDING');
  assert.deepEqual(report.issues, []);
});

test('refreshes the nine operation-source fingerprints only after their semantic impact is reconciled', () => {
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  const operations = parse(fs.readFileSync(path.join(root, '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8'));
  const review = parse(fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'), 'utf8'));
  const reconciliation = review.sourcePinReconciliations.find(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-1-domain-data/operations.yaml');
  const reviewedSourcePin = review.sourceInventory.find(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-1-domain-data/operations.yaml');
  const previousDelta = reconciliation?.subsequentSourceDelta;
  const finalDelta = reconciliation?.ownerDispositionSourceDelta;
  assert.ok(finalDelta, 'the current operations source has a semantic impact record beyond the RPC reconciliation');
  assert.ok(previousDelta, 'the SDK census and submission/execution source change remains separately reconciled');
  assert.equal(finalDelta.previousSha256, previousDelta.currentSha256);
  assert.equal(finalDelta.currentSha256, reconciliation.currentSha256);

  const sourced = obligations.filter(({ extensions }) => extensions?.['media-source']?.sourceRef?.startsWith('.product-experience/pdp-1-domain-data/operations.yaml#'));
  assert.equal(sourced.length, 27);
  const digests = new Set(sourced.map(({ extensions }) => extensions['media-source'].sourceDigest));
  const currentSourceDigest = createHash('sha256')
    .update(fs.readFileSync(path.join(root, '.product-experience/pdp-1-domain-data/operations.yaml'))).digest('hex');
  assert.deepEqual([...digests], [`sha256:${currentSourceDigest}`]);
  assert.equal(currentSourceDigest, reviewedSourcePin.sha256,
    'source pin tracks the current SDK denominator metadata');
  assert.notEqual(currentSourceDigest, finalDelta.currentSha256,
    'new SDK adapter denominator metadata postdates the bounded capability operation review');
  assert.match(operations.individualOperationContracts.status, /pending/u);
  const recordById = new Map(operations.operations.map((record) => [record.id, record]));
  const expectedRecordHashes = previousDelta.unchangedObligationSourceRecords;
  assert.equal(Object.keys(expectedRecordHashes).length, 9);
  const previouslyReviewedIds = new Set(Object.keys(expectedRecordHashes));
  const previouslyReviewed = sourced.filter(({ extensions }) => previouslyReviewedIds.has(extensions['media-source'].recordId));
  assert.equal(previouslyReviewed.length, 9);
  const newlyEnumerated = sourced.filter(({ extensions }) => !previouslyReviewedIds.has(extensions['media-source'].recordId));
  assert.equal(newlyEnumerated.length, 18);
  for (const obligation of previouslyReviewed) {
    const source = obligation.extensions['media-source'];
    const recordId = source.recordId;
    const record = recordById.get(recordId);
    assert.ok(record, `${obligation.id} still resolves to ${recordId}`);
    assert.equal(source.sourceRef, `.product-experience/pdp-1-domain-data/operations.yaml#/operations/${recordId}`);
    const semanticHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    assert.equal(semanticHash, expectedRecordHashes[recordId], `${recordId} matches its reviewed source-record semantics`);
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
    assert.equal(`sha256:${impact.currentSha256}`, digest);
    const refs = obligations.filter(({ extensions }) => extensions?.['media-source']?.sourceRef?.startsWith(`${sourcePath}#`));
    assert.equal(refs.length, impact.obligationCount);
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
  assert.deepEqual(report.sourceFingerprints.comparison, { present: 346, matching: 346, stale: 0, absent: 1 });
  assert.ok(report.issues.some((issue) => issue.code === 'MISSING_SOURCE_FINGERPRINT'));
});
