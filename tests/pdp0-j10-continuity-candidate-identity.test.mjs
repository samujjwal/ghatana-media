import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const { parse } = createRequire(resolve(process.cwd(), '../ghatana-tools/package.json'))('yaml');
const p0 = parse(readFileSync('.product-experience/pdp-0-product-truth/journey-catalog.yaml', 'utf8'));
const j10 = p0.journeys.find(({ id }) => id === 'J-10');

test('J-10 continuity observations stay bound to the exact generated candidate identity and version', () => {
  assert.ok(j10);
  assert.match(j10.completion, /Each continuity observation is bound to the exact generated candidate artifact\/version it reviews/u);
  assert.match(j10.completion, /UNKNOWN when candidate identity\/version is missing, stale, ambiguous, or mismatched/u);
  assert.match(j10.completion, /Never transfer a continuity result to another candidate/u);
  assert.match(j10.contextAndReturn, /each candidate's exact artifact\/version identity/u);
  assert.match(j10.contextAndReturn, /candidate-to-continuity-result join/u);
});
