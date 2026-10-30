import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const capDir = join(repo, 'adapters/agent-tools-media/src/main/resources/capabilities');
const census = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-agent-tools-census.v1.json'), 'utf8'));
const factory = readFileSync(join(repo,
  'adapters/agent-tools-media/src/main/java/com/ghatana/audio/video/tools/AudioVideoToolHandlerFactory.java'), 'utf8');

const declared = new Set();
for (const f of readdirSync(capDir).filter((f) => f.endsWith('.yaml'))) {
  for (const m of readFileSync(join(capDir, f), 'utf8').matchAll(/toolId:\s*"([^"]+)"/g)) {
    declared.add(m[1]);
  }
}

test('AT-01: every declared toolId has an exact implementation or descriptor status', () => {
  for (const id of declared) {
    assert.ok(census.declared[id], `${id} missing from census`);
    const entry = census.declared[id];
    if (entry.status === 'SUPPORTED') {
      assert.ok(entry.handler && factory.includes(entry.handler),
        `${id} claims SUPPORTED but ${entry.handler} is not registered in the factory`);
    } else {
      assert.equal(entry.handler, null,
        `${id} is ${entry.status} — must not claim an executable handler`);
    }
  }
  assert.ok(declared.size >= 5, 'expected all five declared capability IDs');
});

test('AT-01: factory dispatch is the single registry and fails closed on unknown IDs', () => {
  const registered = [...factory.matchAll(/case TOOL_ID_\w+\s*->\s*new (\w+)\(\)/g)]
    .map((m) => m[1]);
  assert.equal(registered.length, 4, 'exactly four executable av.* handlers');
  for (const id of declared) {
    const entry = census.declared[id];
    if (entry.status === 'SUPPORTED') {
      assert.ok(registered.includes(entry.handler), `${entry.handler} not in factory switch`);
    }
  }
  assert.match(factory, /Unknown Audio-Video tool ID/,
    'factory must throw on unregistered IDs');
});
