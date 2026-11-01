import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { validateMediaBuildPlanTaskClosure } from '../scripts/lib/media-build-plan-task-closure-validation.mjs';

const root = process.cwd();
const base = JSON.parse(fs.readFileSync('docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json', 'utf8'));
const clone = () => structuredClone(base);
const sourceDigest = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const validFixture = () => ({
  sourcePins: { 'package.json': sourceDigest('package.json') }, census: { packageCount: 1, traceIdentityCount: 1, surfaces: { total: 1 } },
  packages: [{ id: 'P1', dependencies: [], taskIds: ['P1.T1'] }],
  tasks: [{ id: 'P1.T1', packageId: 'P1', title: 't', status: 'ASSIGNED_UNVERIFIED', priority: 'NORMAL', packageDependencyScope: 'FULL_PACKAGE', outcome: 'outcome', joinedSourceIdentities: [{ phase: 'PDP-0', kind: 'capability', id: 'C1', joins: { requirement: 'R1' }, unresolvedSourceSlots: [], unresolvedSourceBlockers: [] }], ownership: { role: 'engineering' }, fingerprints: { sourcePins: [] }, predecessorTaskIds: [], actions: ['edit'], tests: { positiveTestIds: ['t.pos'], adversarialTestIds: ['t.neg'] }, expectedResult: 'result', finality: 'finality', environmentPrerequisites: ['none'], actionableBlocker: 'none', rollbackFencingCleanup: 'rollback', constraints: ['constraints'], evidence: ['evidence'], reviewerRole: 'reviewer', approverRole: 'approver' }],
  surfaces: [{ id: 'S1', type: 'physical' }], trace: [{ phase: 'PDP-0', kind: 'capability', identity: 'C1', primaryPackageId: 'P1' }],
  materialSourceReceipt: { status: 'CURRENT', staleCount: 0, count: 0, records: [] },
  wipPolicy: { source: { section: '11B' }, limits: { maxSimultaneouslyEditedPackagesPerLane: 2, maxActiveChangeWritersPerSharedFileOrSchemaOwner: 1 } }
});

test('accepts a complete source-bound structural fixture without asserting approval', () => {
  const r = validateMediaBuildPlanTaskClosure(validFixture(), { root });
  assert.equal(r.structuralStatus, 'PASS');
  assert.equal(r.taskClosure, 'PENDING');
  assert.equal(r.planReady, 'PENDING');
});

test('checked-in projection retains stale source and owner-currentness blockers without approval', () => {
  const report = validateMediaBuildPlanTaskClosure(base, { root });
  assert.equal(report.structuralStatus, 'FAIL');
  assert(report.errors.some(error => error.includes('task source pin disagrees with projection')));
  assert(report.sourceBlockers.some(blocker => blocker.includes('stale or inconsistent material source receipt')));
  assert(report.sourceBlockers.includes('material source receipt is missing, stale, or has a count mismatch'));
  assert.deepEqual(report.unresolvedBlockerTaskIds, ['M-BLD-F00.T01']);
  assert.equal(report.taskClosure, 'PENDING');
  assert.equal(report.planReady, 'PENDING');
  assert.equal(report.approvalEvidenceStatus, 'MISSING');
});

test('fragment and section selectors are validated against exact isolated fixture receipt records', () => {
  const x = validFixture();
  const selector = 'package.json#name';
  const sha256 = x.sourcePins['package.json'];
  const row = x.tasks[0].joinedSourceIdentities[0];
  Object.assign(row, { selector, expectedSha256: sha256, currentSha256: sha256, status: 'CURRENT' });
  const record = { phase: row.phase, selector, expectedSha256: sha256, currentSha256: sha256, status: 'CURRENT' };
  x.materialSourceReceipt = { status: 'CURRENT', staleCount: 0, count: 1, records: [record] };
  const report = validateMediaBuildPlanTaskClosure(x, { root });
  assert.equal(report.structuralStatus, 'PASS');
  assert.deepEqual(report.sourceBlockers, []);
});

test('reports stale and missing exact material receipt records as source blockers', () => {
  const stale = clone();
  const row = stale.tasks.find(t => t.id === 'M-BLD-F00.T01').joinedSourceIdentities.find(r => r.selector?.includes('#'));
  stale.materialSourceReceipt.records.find(r => r.phase === row.phase && r.selector === row.selector).currentSha256 = '0'.repeat(64);
  assert.ok(validateMediaBuildPlanTaskClosure(stale, { root }).sourceBlockers.some(x => x.includes('stale or inconsistent')));
  const missing = clone();
  const missingRow = missing.tasks.find(t => t.id === 'M-BLD-F00.T01').joinedSourceIdentities.find(r => r.selector);
  missing.materialSourceReceipt.records = missing.materialSourceReceipt.records.filter(r => !(r.phase === missingRow.phase && r.selector === missingRow.selector));
  assert.ok(validateMediaBuildPlanTaskClosure(missing, { root }).sourceBlockers.some(x => x.includes('missing material source receipt')));
});

test('detects duplicate task identity and orphan/missing ownership', () => {
  const x = clone(); x.tasks.push(structuredClone(x.tasks[0]));
  x.packages[0].taskIds = [];
  const r = validateMediaBuildPlanTaskClosure(x, { root });
  assert.ok(r.errors.some(e => e.includes('duplicate task IDs')));
  assert.ok(r.errors.some(e => e.includes('orphan task')));
  assert.ok(r.errors.some(e => e.includes('package has no task IDs')));
});

test('detects dangling dependencies, cycles, missing required fields, and invalid WIP limits', () => {
  const x = clone(); x.wipPolicy.limits.maxSimultaneouslyEditedPackagesPerLane = 3;
  x.tasks[0].predecessorTaskIds = [x.tasks[0].id, 'MISSING.T01'];
  delete x.tasks[0].outcome;
  const r = validateMediaBuildPlanTaskClosure(x, { root });
  assert.ok(r.errors.some(e => e.includes('WIP bound outside')));
  assert.ok(r.errors.some(e => e.includes('dangling task dependency')));
  assert.ok(r.errors.some(e => e.includes('task dependency cycle')));
  assert.ok(r.errors.some(e => e.includes('missing required task field outcome')));
});

test('caller-supplied approval shaped data cannot promote closure or Plan Ready', () => {
  const x = validFixture();
  const r = validateMediaBuildPlanTaskClosure(x, { root, approvalEvidence: { kind: 'implementation-plan-approval', planTaskValidator: true, fingerprint: 'x', engineeringLead: 'role', productQualityOwner: 'role' } });
  assert.equal(r.taskClosure, 'PENDING');
  assert.equal(r.planReady, 'PENDING');
});
