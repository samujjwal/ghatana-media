import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseExternalObservations} from '../scripts/record-media-discovery-pdp0-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('external source currentness derives the live manifest denominator and rejects duplicate entries', () => {
  const source = fs.readFileSync(path.join(root, '.product-experience/source-manifest.yaml'), 'utf8');
  const repositories = parseExternalObservations(source);
  const paths = repositories.flatMap(repository => repository.files.map(file => `${repository.repositoryId}/${file.path}`));
  assert.equal(repositories.length, 6);
  assert.equal(paths.length, 25);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(repositories.every(repository => Array.isArray(repository.files)));

  const duplicateSource = source.replace(
    /(      - path: [^\n]+\n(?:        [^\n]+\n)*)/u,
    '$1$1',
  );
  assert.throws(() => parseExternalObservations(duplicateSource), /Unexpected external contract denominator/u);
});
