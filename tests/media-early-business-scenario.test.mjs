import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMediaEarlyBusinessScenario, validateMediaEarlyBusinessScenario } from '../scripts/lib/media-early-business-scenario.mjs';
import { MEDIA_EARLY_SCENARIO_PATH } from '../scripts/lib/media-early-business-scenario.mjs';

const current = buildMediaEarlyBusinessScenario();

test('builds a source-pinned declarative first-outcome recipe', () => {
  assert.deepEqual(current.orderedJourneyIds, ['J-01', 'J-02', 'J-20', 'J-03']);
  assert.equal(current.execution.executable, false);
  assert.equal(current.channelSelection.selectedChannelRef, null);
  assert.equal(validateMediaEarlyBusinessScenario(current, current).length, 0);
  assert.ok(current.blockers.some(x => x.startsWith('NO_REAL_CHANNEL_ADMITTED')));
});

test('rejects a missing source-defined P1 result binding', () => {
  const mutated = structuredClone(current);
  mutated.journeys.find(x => x.journeyId === 'J-03').p1OperationResultBindings = [];
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('missing or mismatched P1 result')));
});

test('rejects a mismatched PDP-3 edge', () => {
  const mutated = structuredClone(current);
  mutated.journeys.find(x => x.journeyId === 'J-03').p3ChannelEdges[0].id = 'invented-edge';
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('mismatched PDP-3 edge')));
});

test('rejects selecting a channel without actual admission', () => {
  const mutated = structuredClone(current);
  mutated.channelSelection.selectedChannelRef = 'media.channel.web';
  mutated.channelSelection.candidates.find(x => x.channelRef === 'media.channel.web').runtimeAdmission = 'ADMITTED';
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('unadmitted channel selected')));
});

test('rejects duplicate scene identity and stale material pins', () => {
  const duplicated = structuredClone(current);
  duplicated.story.narrative[1].id = duplicated.story.narrative[0].id;
  assert.ok(validateMediaEarlyBusinessScenario(duplicated, current).some(x => x.includes('duplicate story identity')));
  const stale = structuredClone(current);
  stale.materialSourcePins[Object.keys(stale.materialSourcePins)[0]] = '0'.repeat(64);
  assert.ok(validateMediaEarlyBusinessScenario(stale, current).some(x => x.includes('stale material source hash')));
  const duplicateJourney = structuredClone(current);
  duplicateJourney.journeys[1].journeyId = duplicateJourney.journeys[0].journeyId;
  assert.ok(validateMediaEarlyBusinessScenario(duplicateJourney, current).some(x => x.includes('duplicate story journey identity')));
});

test('generator check mode passes current output and reports stale output without writing', () => {
  const generator = path.resolve('scripts/generate-media-early-business-scenario.mjs');
  const currentCheck = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  assert.equal(currentCheck.status, 0, currentCheck.stderr);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-check-'));
  const stalePath = path.join(tempDir, 'stale.json');
  const staleContent = '{"stale":true}\n';
  fs.writeFileSync(stalePath, staleContent);
  const staleCheck = spawnSync(process.execPath, [generator, '--check', '--output', stalePath], { encoding: 'utf8' });
  assert.equal(staleCheck.status, 1);
  assert.match(staleCheck.stderr, /Stale generated projection/);
  assert.equal(fs.readFileSync(stalePath, 'utf8'), staleContent);
  assert.ok(fs.existsSync(MEDIA_EARLY_SCENARIO_PATH));
  fs.rmSync(tempDir, { recursive: true, force: true });
});
