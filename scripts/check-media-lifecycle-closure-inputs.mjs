#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lifecycleRoot = path.resolve(process.env.MEDIA_LIFECYCLE_CONTRACT_ROOT ?? path.resolve(root, '../ghatana-lifecycle'));
const base = 'config/closure/media-product-definition';
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const consumer = readJson('config/closure/consumer.json');
const program = readJson(`${base}/phase-program.json`);
const surface = readJson(`${base}/surface.json`);
const binding = readJson(`${base}/phase-binding.json`);
const obligations = readJson(`${base}/obligations.json`);
const pending = readJson(`${base}/pending-decisions.json`);

const phaseIds = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
const expectedDependencies = {
  'PDP-0': [],
  'PDP-1': ['PDP-0'],
  'PDP-2': ['PDP-0', 'PDP-1'],
  'PDP-3': ['PDP-0', 'PDP-1', 'PDP-2'],
};
assert.deepEqual(program.phases.map((phase) => phase.id), phaseIds, 'four canonical PDP phases must be declared exactly once and in display order');
assert.equal(surface.phaseProgramRef, program.programId);
assert.equal(surface.phaseBindingRef, binding.bindingId);
assert.equal(binding.closureSurfaceId, surface.id);
assert.equal(binding.programId, program.programId);

const obligationById = new Map(obligations.map((obligation) => [obligation.id, obligation]));
assert.equal(obligationById.size, phaseIds.length, 'each phase must have one distinct declared obligation');
for (const phaseId of phaseIds) {
  const phase = program.phases.find((candidate) => candidate.id === phaseId);
  assert.deepEqual(phase.dependsOn ?? [], expectedDependencies[phaseId], `${phaseId} dependency graph changed`);
  const overlay = binding.phases[phaseId];
  assert.equal(overlay?.applicability, 'APPLICABLE', `${phaseId} must be explicitly applicable`);
  assert.equal(overlay?.obligationIds?.length, 1, `${phaseId} must select its own obligation`);
  assert.deepEqual(overlay.obligationIds, phase.obligationIds, `${phaseId} definition and binding must agree`);
  const obligation = obligationById.get(overlay.obligationIds[0]);
  assert.ok(obligation, `${phaseId} selected obligation must resolve`);
  assert.equal(obligation.disposition, 'REQUIRED');
  assert.deepEqual(obligation.phaseSemantics.applicableIn, [phaseId]);
  assert.deepEqual(obligation.phaseSemantics.blockingIn, [phaseId]);
  assert.deepEqual(obligation.phaseSemantics.affects, [phaseId]);
}
assert.deepEqual(surface.obligationIds, obligations.map((obligation) => obligation.id));

assert.equal(consumer.schemaVersion, 'ghatana.closure.consumer');
assert.deepEqual(consumer.contractSet, { id: 'ghatana.closure', version: '1' });
assert.deepEqual(consumer.providerBindings, [], 'unadmitted providers must not be represented as bindings');
for (const source of ['surfaces', 'phasePrograms', 'phaseBindings', 'obligations']) {
  assert.ok(consumer.sources[source]?.length, `consumer must bind ${source}`);
  for (const ref of consumer.sources[source]) {
    assert.equal(ref.schemaVersion, 'closure-source-ref');
    assert.equal(ref.kind, 'file');
    assert.ok(fs.existsSync(path.join(root, ref.ref)), `consumer source does not exist: ${ref.ref}`);
  }
}
assert.equal(pending.status, 'PENDING');
assert.equal(pending.closureStatus, 'BLOCKED');
assert.ok(pending.blockers.length > 0);
assert.equal(pending.receipts.length, 0, 'Media must not author Lifecycle receipts');
assert.equal(pending.currentness, 'UNKNOWN', 'Media must not author Lifecycle currentness');
assert.ok(pending.blockers.some((item) => item.id === 'MEDIA-PDP-OWNER-ADJUDICATION'));
assert.ok(pending.blockers.some((item) => item.id === 'MEDIA-PDP-PROOF-PRODUCERS'));

const { admitClosureConsumer } = await import('@ghatana/evidence-contracts/consumer-schema-admission');
if (process.env.MEDIA_EXPECTED_EVIDENCE_CONTRACTS_ROOT) {
  const resolvedPackageExport = path.resolve(fileURLToPath(import.meta.resolve('@ghatana/evidence-contracts/consumer-schema-admission')));
  const expectedPackageRoot = fs.realpathSync(path.resolve(process.env.MEDIA_EXPECTED_EVIDENCE_CONTRACTS_ROOT));
  assert.ok(resolvedPackageExport.startsWith(`${expectedPackageRoot}${path.sep}`),
    `Lifecycle admission must resolve from the isolated installed artifact: ${resolvedPackageExport}`);
}
// Lifecycle's post-split package owns the provider registry consumed by this
// RC1 admission contract; keep both resolver roots on that installed owner.
const admission = admitClosureConsumer(root, 'config/closure/consumer.json', { contractRoot: lifecycleRoot, toolsRoot: lifecycleRoot });
assert.equal(admission.passed, true, `Lifecycle public consumer admission failed: ${JSON.stringify(admission.errors)}`);
assert.equal(admission.admissionStatus, 'CANONICAL');
assert.equal(admission.resolvedFiles, 5, 'consumer, surface, phase program, phase binding, and obligations must resolve');
assert.deepEqual(admission.errors, []);

console.log(`Lifecycle public consumer admission passed (${admission.resolvedFiles} source files, zero errors) for ${phaseIds.join(', ')}; closure remains BLOCKED by ${pending.blockers.length} pending owner/provider decisions.`);
