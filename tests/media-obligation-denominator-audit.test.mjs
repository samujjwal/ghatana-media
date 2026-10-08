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

test('audits exact 319 obligation denominator, four phase counts, memberships, and resolvable source records', () => {
  const report = auditMediaObligationDenominator(input());
  assert.equal(report.total, 319);
  assert.equal(report.uniqueIds, 319);
  assert.deepEqual(report.phaseCounts, { 'PDP-0': 38, 'PDP-1': 130, 'PDP-2': 74, 'PDP-3': 77 });
  assert.equal(report.dispositionRecords, 319);
  assert.deepEqual(report.sourceReferences, { total: 319, resolved: 319, unresolved: 0 });
  assert.ok(Object.keys(report.sourceFingerprints.files).length > 0);
  assert.deepEqual(report.sourceFingerprints.comparison, { present: 319, matching: 319, stale: 0, absent: 0 });
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
  const previousDelta = reconciliation?.subsequentSourceDelta;
  const finalDelta = reconciliation?.ownerDispositionSourceDelta;
  assert.ok(finalDelta, 'the current operations source has a semantic impact record beyond the RPC reconciliation');
  assert.ok(previousDelta, 'the SDK census and submission/execution source change remains separately reconciled');
  assert.equal(finalDelta.previousSha256, previousDelta.currentSha256);
  assert.equal(finalDelta.currentSha256, reconciliation.currentSha256);

  const sourced = obligations.filter(({ extensions }) => extensions?.['media-source']?.sourceRef?.startsWith('.product-experience/pdp-1-domain-data/operations.yaml#'));
  assert.equal(sourced.length, 9);
  const digests = new Set(sourced.map(({ extensions }) => extensions['media-source'].sourceDigest));
  assert.deepEqual([...digests], [`sha256:${finalDelta.currentSha256}`]);
  const recordById = new Map(operations.operations.map((record) => [record.id, record]));
  const expectedRecordHashes = previousDelta.unchangedObligationSourceRecords;
  assert.equal(Object.keys(expectedRecordHashes).length, 9);
  for (const obligation of sourced) {
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
  assert.deepEqual(item.caseIds, []);
  assert.deepEqual(item.observerIds, []);
  assert.deepEqual(item.oracleIds, []);
  assert.equal(item.extensions['media-source'].recordId, 'media.component.progress-indicator');
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
  assert.deepEqual(report.sourceFingerprints.comparison, { present: 318, matching: 318, stale: 0, absent: 1 });
  assert.ok(report.issues.some((issue) => issue.code === 'MISSING_SOURCE_FINGERPRINT'));
});
