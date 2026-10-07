#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMediaClosureInputState } from './lib/media-closure-preflight.mjs';

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

const input = validateMediaClosureInputState({
  consumer, program, surface, binding, obligations, pending,
});
for (const source of ['surfaces', 'phasePrograms', 'phaseBindings', 'obligations']) {
  for (const ref of consumer.sources[source]) {
    assert.equal(ref.schemaVersion, 'closure-source-ref');
    assert.equal(ref.kind, 'file');
    assert.ok(fs.existsSync(path.join(root, ref.ref)),
      `consumer source does not exist: ${ref.ref}`);
  }
}

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

console.log(`Lifecycle public consumer admission passed (${admission.resolvedFiles} source files, zero errors) for PDP-0 through PDP-3; Media inputs=${input.inputStatus}, obligations=${input.obligationCount}, recorded blockers=${pending.blockers.length}; Lifecycle acceptance remains external.`);
