import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/check-media-contract-parity.mjs');
const run = args => spawnSync(process.execPath, [script, ...args], {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
const PINNED_GAP = 'stale SDK route disposition has no matching current divergence: libs/audio-video-client/src/operations.ts POST /api/v1/media/multimodal-analyses';

test('definition-only contract parity CLI defers runtime admission while strict default retains the pinned route gap', () => {
  // The multimodal SDK method fails before dispatch, so its pinned route
  // observation remains an explicit unresolved source gap pending the
  // MPSEM-0023-C002 owner material review; both modes report NON-GREEN.
  const definitionOnly = run(['--definition-only']);
  assert.equal(definitionOnly.status, 1, definitionOnly.stderr || definitionOnly.stdout);
  assert.match(definitionOnly.stdout, /Media contract parity \(definition-only\): NON-GREEN/u);
  assert.match(definitionOnly.stdout, /source findings audited: 46 \(44 dispositioned; 1 unresolved\)/u);
  assert.match(definitionOnly.stdout, /deferred for development completion: 1/u);
  assert.match(definitionOnly.stdout, /agent-tool-runtime-and-shared-admission: DEFERRED_NOT_REQUIRED_FOR_DEVELOPMENT_COMPLETION/u);
  assert.match(definitionOnly.stderr, new RegExp(PINNED_GAP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));

  const strict = run([]);
  assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  const strictOutput = `${strict.stdout}\n${strict.stderr}`;
  assert.match(strictOutput, /Media contract parity: NON-GREEN/u);
  assert.match(strictOutput, /source findings audited: 46 \(45 dispositioned; 1 unresolved\)/u);
  assert.match(strictOutput, /source-dispositioned findings: 45/u);
  assert.match(strictOutput, /historical source findings: 50 \(50 dispositioned; 0 unresolved; 5 retired routes\)/u);
  assert.match(strictOutput, /explicit gaps \(1\)/u);
  assert.match(strictOutput, new RegExp(PINNED_GAP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.doesNotMatch(strictOutput, /Agent Tool structural inventory found 4 tools/u);
  assert.doesNotMatch(strictOutput, /deferred for development completion/u);
});
