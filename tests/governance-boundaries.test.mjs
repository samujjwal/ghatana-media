import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Media Product Definition has one declared semantic source across implementation repositories', () => {
  const authority = read('.product-experience/authority-map.yaml');
  for (const declaration of [
    'semanticAuthorityRepository: ghatana-media',
    'semanticAuthorityPath: .product-experience/',
    'codeRepository: ghatana/services/media',
    'codeRepositoryRole: implementation-and-runtime-contract-source-only',
    'competingProductDefinitionAuthority: prohibited',
  ]) assert.ok(authority.includes(declaration), `missing authority declaration: ${declaration}`);
  assert.match(read('.product-experience/README.md'), /Moving implementation code does not move semantic authority/u);
});

test('Lifecycle admission uses its public package export and the full consumer contract arguments', () => {
  const source = read('scripts/check-media-lifecycle-closure-inputs.mjs');
  assert.match(source, /import\('@ghatana\/evidence-contracts\/consumer-schema-admission'\)/u);
  assert.match(source, /admitClosureConsumer\(root, 'config\/closure\/consumer\.json', \{ contractRoot: lifecycleRoot, toolsRoot: lifecycleRoot \}\)/u);
  assert.doesNotMatch(source, /ghatana-lifecycle\/scripts\/closure\/consumer-schema-admission|pathToFileURL/u);

  const lifecyclePackage = JSON.parse(fs.readFileSync(path.join(root, '../ghatana-lifecycle/libs/evidence-contracts/package.json'), 'utf8'));
  assert.equal(lifecyclePackage.exports['./consumer-schema-admission'].import, './runtime/consumer-schema-admission.mjs');
  assert.equal(lifecyclePackage.version, '0.1.0-rc.1');
});

test('technology register distinguishes selection from license and artifact qualification', () => {
  const source = read('.product-experience/pdp-0-product-truth/reuse-decisions.yaml');
  const register = source.slice(source.indexOf('selectionRegister:'));
  for (const fragment of [
    'schemaVersion: media.technology-selection.v1',
    'licenseSPDX:',
    'authoritativeRepository:',
    'version:',
    'sourceDigest:',
    'publicContract:',
    'transitiveLicenseDecision:',
    'securityPosture:',
    'qualificationStatus:',
    'decision: REJECTED',
    'TECH-FFMPEG',
    'MPL-2.0',
    'BLOCKED_PENDING_TRANSITIVE_LICENSE_REVIEW',
  ]) assert.ok(register.includes(fragment), `technology register missing ${fragment}`);
  assert.match(register, /status: architecture-selected; artifact-admission-pending/u);
  assert.match(register, /sourceDigest: not-observed/u);
});
