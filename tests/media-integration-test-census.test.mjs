import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(repo, 'integration-tests/src/test/java/com/ghatana/audio/video/integration');
const census = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-integration-test-census.v1.json'), 'utf8'));

const files = readdirSync(dir).filter((f) => f.endsWith('.java'));
const classified = new Set();
for (const list of Object.values(census.classification)) {
  for (const entry of list.files ?? []) classified.add(entry.split(/[ (]/)[0]);
}

test('IT-01: every integration-tests file is classified', () => {
  for (const file of files) {
    assert.ok(classified.has(file), `${file} is not in media-integration-test-census.v1.json`);
  }
});

test('IT-01: scaffold files carry an explicit disabled reason, never a silent pass', () => {
  for (const file of census.classification.STUB_SCAFFOLD_DISABLED.files) {
    const src = readFileSync(join(dir, file.split(' ')[0]), 'utf8');
    assert.match(src, /@Disabled\("IT-01 scaffold/, `${file} must stay @Disabled until wired`);
  }
});

test('IT-01: no integration-named test body is a pure literal/simulated tautology', () => {
  for (const file of files) {
    if (file.endsWith('Base.java') || file.endsWith('Condition.java')) continue;
    const src = readFileSync(join(dir, file), 'utf8');
    const disabled = /@Disabled\(/.test(src);
    const name = file.replace('.java', '');
    if (/Integration|E2E|Load|Performance|Workflow|Journey/.test(name) && !disabled) {
      // A live integration-named suite must touch a real surface.
      assert.match(src,
        /Container|ManagedChannel|Grpc|Socket|Http|Testcontainers|AudioVideoContainerBase|ProcessBuilder|WireMock|localhost|127\.0\.0\.1/,
        `${file} names an integration surface but touches no real transport/container and is not disabled`);
    }
  }
});
