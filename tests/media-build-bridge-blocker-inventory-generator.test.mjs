import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatorPath = path.join(repositoryRoot, 'scripts/generate-media-build-bridge-blocker-inventory.mjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceBridgeFixture() {
  return `${JSON.stringify({
    schemaVersion: 'media.build-contract-bridge.v1',
    status: 'SOURCE_RELATIONS_CURRENT',
    census: { identityCount: 3, edgeCount: 2 },
    identities: [
      { id: 'PDP-0:capability:upload', unresolvedSourceBlockers: [] },
      { id: 'PDP-1:operations:op.upload', unresolvedSourceBlockers: [] },
      { id: 'PDP-3:journey:upload', unresolvedSourceBlockers: [] },
    ],
  }, null, 2)}\n`;
}

function runGenerator(cwd, ...args) {
  return execFileSync(process.execPath, [generatorPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function assertGeneratorFailsClosed(cwd) {
  assert.throws(() => runGenerator(cwd), (error) => error.status === 1);
}

test('unavailable or malformed bridge source fails closed and exact fixture recovery restores the prior readback', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'media-f00-t02-bridge-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const implementationDirectory = path.join(cwd, 'docs/implementation');
  fs.mkdirSync(implementationDirectory, { recursive: true });
  const sourcePath = path.join(implementationDirectory, 'MEDIA-BUILD-CONTRACT-BRIDGE.v1.json');
  const outputPath = path.join(implementationDirectory, 'MEDIA-BUILD-BRIDGE-BLOCKER-INVENTORY.v1.json');
  const originalSource = sourceBridgeFixture();
  fs.writeFileSync(sourcePath, originalSource);

  runGenerator(cwd);
  const originalOutput = fs.readFileSync(outputPath);
  const originalOutputDigest = sha256(originalOutput);
  const originalInventory = JSON.parse(originalOutput.toString('utf8'));
  assert.equal(originalInventory.census.traceIdentityCount, 3);
  assert.equal(originalInventory.census.sourceBridgeEdgeCount, 2);
  assert.equal(originalInventory.census.unresolvedSourceIdentityCount, 0);
  assert.equal(originalInventory.census.unresolvedSourceBlockerCount, 0);
  assert.equal(originalInventory.status, 'SOURCE_RELATIONS_CURRENT');

  fs.unlinkSync(sourcePath);
  assertGeneratorFailsClosed(cwd);
  assert.equal(sha256(fs.readFileSync(outputPath)), originalOutputDigest);

  fs.writeFileSync(sourcePath, '{ invalid JSON');
  assertGeneratorFailsClosed(cwd);
  assert.equal(sha256(fs.readFileSync(outputPath)), originalOutputDigest);

  fs.writeFileSync(sourcePath, originalSource);
  runGenerator(cwd, '--check');
  assert.equal(sha256(fs.readFileSync(sourcePath)), sha256(originalSource));
  assert.equal(sha256(fs.readFileSync(outputPath)), originalOutputDigest);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')).census, originalInventory.census);
});

test('unknown bridge status and contradictory currentness fail closed without changing the prior readback', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'media-f00-t02-unknown-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const implementationDirectory = path.join(cwd, 'docs/implementation');
  fs.mkdirSync(implementationDirectory, { recursive: true });
  const sourcePath = path.join(implementationDirectory, 'MEDIA-BUILD-CONTRACT-BRIDGE.v1.json');
  const outputPath = path.join(implementationDirectory, 'MEDIA-BUILD-BRIDGE-BLOCKER-INVENTORY.v1.json');
  fs.writeFileSync(sourcePath, sourceBridgeFixture());
  runGenerator(cwd);
  const priorOutputDigest = sha256(fs.readFileSync(outputPath));

  const cases = [
    {
      name: 'unknown status',
      mutate: (bridge) => { bridge.status = 'UNKNOWN'; },
      error: 'SOURCE_BRIDGE_STATUS_INVALID',
    },
    {
      name: 'current bridge with unresolved blocker',
      mutate: (bridge) => { bridge.identities[0].unresolvedSourceBlockers = ['UNCLASSIFIED_SOURCE_BLOCKER']; },
      error: 'SOURCE_BRIDGE_CURRENT_WITH_UNRESOLVED_BLOCKERS',
    },
    {
      name: 'incomplete bridge without unresolved blocker',
      mutate: (bridge) => { bridge.status = 'INCOMPLETE_SOURCE_RELATIONS'; },
      error: 'SOURCE_BRIDGE_INCOMPLETE_WITHOUT_BLOCKERS',
    },
  ];

  for (const scenario of cases) {
    const bridge = JSON.parse(sourceBridgeFixture());
    scenario.mutate(bridge);
    fs.writeFileSync(sourcePath, `${JSON.stringify(bridge, null, 2)}\n`);
    assert.throws(
      () => runGenerator(cwd),
      (error) => error.status === 1 && String(error.stderr).includes(scenario.error),
      scenario.name,
    );
    assert.equal(sha256(fs.readFileSync(outputPath)), priorOutputDigest, `${scenario.name} must preserve prior output`);
  }
});

test('unknown blocker reason remains explicitly unclassified and check-only readback does not write', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'media-f00-t02-unclassified-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const implementationDirectory = path.join(cwd, 'docs/implementation');
  fs.mkdirSync(implementationDirectory, { recursive: true });
  const sourcePath = path.join(implementationDirectory, 'MEDIA-BUILD-CONTRACT-BRIDGE.v1.json');
  const outputPath = path.join(implementationDirectory, 'MEDIA-BUILD-BRIDGE-BLOCKER-INVENTORY.v1.json');
  const bridge = JSON.parse(sourceBridgeFixture());
  bridge.status = 'INCOMPLETE_SOURCE_RELATIONS';
  bridge.identities[0].unresolvedSourceBlockers = ['UNCLASSIFIED_SOURCE_BLOCKER'];
  fs.writeFileSync(sourcePath, `${JSON.stringify(bridge, null, 2)}\n`);

  runGenerator(cwd);
  const sourceDigest = sha256(fs.readFileSync(sourcePath));
  const outputDigest = sha256(fs.readFileSync(outputPath));
  const inventory = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(inventory.status, 'TECHNICAL_WORK_REMAINING');
  assert.equal(inventory.census.otherReasonCount, 1);
  assert.deepEqual(inventory.otherUnclassified.map(({ reason }) => reason), ['UNCLASSIFIED_SOURCE_BLOCKER']);

  runGenerator(cwd, '--check');
  assert.equal(sha256(fs.readFileSync(sourcePath)), sourceDigest);
  assert.equal(sha256(fs.readFileSync(outputPath)), outputDigest);
});
