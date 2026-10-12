import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/check-media-contract-parity.mjs');
const run = args => spawnSync(process.execPath, [script, ...args], {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});

test('definition-only contract parity CLI passes while strict default retains its admission findings', () => {
  const definitionOnly = run(['--definition-only']);
  assert.equal(definitionOnly.status, 0, definitionOnly.stderr || definitionOnly.stdout);
  assert.match(definitionOnly.stdout, /Media contract parity \(definition-only\): PASS/u);

  const strict = run([]);
  assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  const strictOutput = `${strict.stdout}\n${strict.stderr}`;
  assert.match(strictOutput, /Media contract parity: NON-GREEN/u);
  assert.match(strictOutput, /source findings audited: 47 \(46 dispositioned; 1 unresolved\)/u);
  assert.match(strictOutput, /explicit gaps \(1\):/u);
  assert.match(strictOutput, /PDP-1 operations remain proposal-only/u);
  assert.doesNotMatch(strictOutput, /Agent Tool structural inventory found 4 tools/u);
  assert.doesNotMatch(strictOutput, /deferred for development completion/u);
});
