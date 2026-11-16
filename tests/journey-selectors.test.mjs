import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, testArgs, JOURNEY_IDS, REPO_ROOT } from '../scripts/check-journey-selectors.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '../scripts/check-journey-selectors.mjs');
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'integration-tests/journey-selectors.v1.json'), 'utf8'));
const remaining = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/development/remaining-work.json'), 'utf8'));

const clone = (x) => JSON.parse(JSON.stringify(x));
const check = (m, root = REPO_ROOT) => validateManifest(m, { remaining, repoRoot: root });

test('committed manifest validates against remaining-work.json and the test tree', () => {
  const { errors, journeys } = check(manifest);
  assert.deepEqual(errors, []);
  assert.equal(journeys.size, 30);
});

test('all 30 journey ids J-01..J-30 are present', () => {
  assert.equal(JOURNEY_IDS.length, 30);
  assert.equal(JOURNEY_IDS[0], 'J-01');
  assert.equal(JOURNEY_IDS[29], 'J-30');
  for (const id of JOURNEY_IDS) assert.ok(manifest.journeys.some((j) => j.id === id), id);
});

test('a missing journey is reported', () => {
  const m = clone(manifest);
  m.journeys = m.journeys.filter((j) => j.id !== 'J-05');
  assert.ok(check(m).errors.some((e) => e.includes('missing journey J-05')));
});

test('a class listed for a journey whose evidence does not mention it is rejected', () => {
  const m = clone(manifest);
  const j = m.journeys.find((x) => x.id === 'J-03');
  j.classes = ['com.ghatana.media.integration.MediaDevSimulationIT'];
  j.selectorCount = 1;
  j.runnable = true;
  j.cpuOnly = true;
  j.needsLocalModel = false;
  j.needsChromium = false;
  j.needsNode = false;
  j.needsFfmpeg = true;
  const { errors } = check(m);
  assert.ok(errors.some((e) => e.startsWith('J-03: MediaDevSimulationIT is listed but')), errors.join('\n'));
});

test('a class whose file does not exist is rejected', () => {
  const m = clone(manifest);
  const fqcn = 'com.ghatana.media.integration.MediaDevDoesNotExistIT';
  m.classes[fqcn] = { ...m.classes['com.ghatana.media.integration.MediaDevMasterIT'], file: 'integration-tests/src/test/java/com/ghatana/media/integration/MediaDevDoesNotExistIT.java' };
  const j = m.journeys.find((x) => x.id === 'J-17');
  j.classes = [...j.classes, fqcn];
  j.selectorCount = j.classes.length;
  const { errors } = check(m);
  assert.ok(errors.some((e) => e.includes('class file missing') && e.includes('MediaDevDoesNotExistIT')), errors.join('\n'));
});

test('an untagged or @Disabled class is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-sel-'));
  try {
    const pkgDir = join(root, 'integration-tests/src/test/java/com/ghatana/media/integration');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'MediaDevFixtureIT.java'), 'package com.ghatana.media.integration;\nclass MediaDevFixtureIT {}\n');
    const m = clone(manifest);
    const fqcn = 'com.ghatana.media.integration.MediaDevFixtureIT';
    m.classes = { [fqcn]: { file: 'integration-tests/src/test/java/com/ghatana/media/integration/MediaDevFixtureIT.java', tagIntegration: false, disabled: false, hasTestMethod: false, needsLocalModel: false, needsChromium: false, needsNode: false, needsFfmpeg: false } };
    const j = m.journeys.find((x) => x.id === 'J-01');
    m.journeys.forEach((x) => { if (x.id !== 'J-01') { x.classes = []; x.runnable = false; x.cpuOnly = false; x.selectorCount = 0; } });
    j.classes = [fqcn];
    j.selectorCount = 1;
    j.runnable = true;
    j.cpuOnly = true;
    const { errors } = check(m, root);
    assert.ok(errors.some((e) => e.includes('not @Tag("integration")')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journey flags must match the flags of their classes', () => {
  const m = clone(manifest);
  const j = m.journeys.find((x) => x.id === 'J-24');
  j.needsChromium = true;
  assert.ok(check(m).errors.some((e) => e.startsWith('J-24: needsChromium')));
});

test('cpu-only selection contains no class that needs a local model', () => {
  const { selectors, journeys } = check(manifest);
  const cpu = selectors.get('cpu-only');
  assert.ok(cpu.length > 0);
  for (const c of cpu) assert.equal(manifest.classes[c].needsLocalModel, false, c);
  for (const j of journeys.values()) if (j.cpuOnly) assert.equal(j.needsLocalModel, false, j.id);
});

test('cli prints Gradle --tests arguments for J-24', () => {
  const out = execFileSync(process.execPath, [script, '--print', 'J-24'], { encoding: 'utf8' }).trim();
  assert.equal(out, '--tests com.ghatana.media.integration.MediaDevStructuredCliBatchIT');
  assert.deepEqual(testArgs(['a.B', 'c.D']), ['--tests', 'a.B', '--tests', 'c.D']);
});

test('cli prints the full Gradle command with the required -P flags', () => {
  const out = execFileSync(process.execPath, [script, '--print', 'J-24', '--command'], { encoding: 'utf8' }).trim();
  for (const flag of [
    '-Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE',
    '-Pghatana.media.compositeScope=FULL',
    '-Pghatana.kernel.path=',
    '-Pghatana.tools.path=',
    '-Pghatana.lifecycle.path=',
  ]) assert.ok(out.includes(flag), flag);
  assert.ok(out.includes(':services:media:integration-tests:test --tests com.ghatana.media.integration.MediaDevStructuredCliBatchIT'));
});

test('cli prints the selectors for a journey whose evidence names its integration classes', () => {
  const out = execFileSync(process.execPath, [script, '--print', 'J-03'], { encoding: 'utf8', stdio: 'pipe' });
  assert.ok(out.includes('--tests com.ghatana.media.integration.MediaDevCaptionJourneyIT'), out);
  assert.ok(out.includes('--tests com.ghatana.media.integration.MediaDevExplorerCaptionCorrectionLiveIT'), out);
});
