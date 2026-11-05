import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/check-media-contract-parity.mjs');
const run = args => spawnSync(process.execPath, [script, ...args], {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});

test('definition-only contract parity CLI defers runtime admission while strict mode is green with the retired multimodal route', () => {
  // The multimodal SDK method fails before dispatch; its route observation is
  // retired-non-dispatching while MPSEM-0023-C002 owner material review stays
  // pending. Definition-only still defers the Agent Tool runtime admission.
  const definitionOnly = run(['--definition-only']);
  assert.equal(definitionOnly.status, 0, definitionOnly.stderr || definitionOnly.stdout);
  assert.match(definitionOnly.stdout, /Media contract parity \(definition-only\): PASS/u);
  assert.match(definitionOnly.stdout, /source findings audited: 45 \(44 dispositioned; 0 unresolved\)/u);
  assert.match(definitionOnly.stdout, /deferred for development completion: 1/u);
  assert.match(definitionOnly.stdout, /agent-tool-runtime-and-shared-admission: DEFERRED_NOT_REQUIRED_FOR_DEVELOPMENT_COMPLETION/u);

  const strict = run([]);
  assert.equal(strict.status, 0, strict.stderr || strict.stdout);
  const strictOutput = `${strict.stdout}\n${strict.stderr}`;
  assert.match(strictOutput, /Media contract parity: PASS/u);
  assert.match(strictOutput, /source findings audited: 45 \(45 dispositioned; 0 unresolved\)/u);
  assert.match(strictOutput, /source-dispositioned findings: 45/u);
  assert.match(strictOutput, /historical source findings: 51 \(51 dispositioned; 0 unresolved; 6 retired routes\)/u);
  assert.doesNotMatch(strictOutput, /explicit gaps/u);
  assert.doesNotMatch(strictOutput, /Agent Tool structural inventory found 4 tools/u);
  assert.doesNotMatch(strictOutput, /deferred for development completion/u);
});
