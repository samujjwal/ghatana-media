import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeCreateOnlyPlanArtifact} from '../scripts/plan-media-pdp0-source-amendment-cas.mjs';

test('plan artifact writer creates once and refuses to overwrite existing frozen bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cas-plan-create-only-'));
  const outputPath = path.join(root, 'plan.json');
  const original = Buffer.from('{"frozen":true}\n');
  try {
    writeCreateOnlyPlanArtifact(outputPath, original);
    assert.deepEqual(fs.readFileSync(outputPath), original);
    assert.throws(() => writeCreateOnlyPlanArtifact(outputPath, Buffer.from('{"frozen":false}\n')), /refusing to overwrite frozen bytes/u);
    assert.deepEqual(fs.readFileSync(outputPath), original);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
