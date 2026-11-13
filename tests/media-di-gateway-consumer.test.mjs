import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => readFileSync(resolve(root, p), 'utf8');

test('MED-04: Media scene-text code reaches OCR only through the DI public client surface', () => {
  const adapter = read('libs/audio-video-client/src/scene-text-adapter.ts');
  const authorized = read('libs/audio-video-client/src/authorized-scene-text.ts');
  for (const [name, source] of [['scene-text-adapter.ts', adapter], ['authorized-scene-text.ts', authorized]]) {
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:child_process|node:http|node:https/u, `${name} must not open its own transport`);
    assert.doesNotMatch(source, /tesseract|paddle|easyocr|onnxruntime|tfjs|opencv|wasm/iu, `${name} must not import or name an OCR engine`);
    assert.doesNotMatch(source, /services\/document-intelligence|document_intelligence/u, `${name} must not import DI service internals`);
  }
  // The only DI egress methods the adapter may call on the injected client.
  const calls = [...adapter.matchAll(/this\.client\.(\w+)\(/gu)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'adapter must call the injected DI client');
  assert.deepEqual([...new Set(calls)].sort(), ['parse', 'providers']);
  const authorizedCalls = [...authorized.matchAll(/diClient\.(\w+)\(/gu)].map((m) => m[1]);
  assert.deepEqual([...new Set(authorizedCalls)].sort(), ['parse', 'providers']);
  // The structural DI client contract is exactly the frozen v1 read/parse surface; no status GET is invented.
  const iface = adapter.match(/export interface DocumentIntelligenceV1Client \{[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.match(iface, /providers\(/u);
  assert.match(iface, /parse\(/u);
  assert.doesNotMatch(iface, /status\(|getOperation\(|poll/u);
});

test('MED-04: the DI module is outside Media core build graphs (DI offline cannot break non-OCR Media)', () => {
  const settings = read('settings.gradle.kts');
  assert.doesNotMatch(settings, /services\/document-intelligence|document-intelligence-java-client|:services:document-intelligence/u,
    'the DI client/worker must not be part of the Media Gradle composite');
  const tracked = ['package.json', 'libs/audio-video-client/package.json', 'libs/audio-video-types/package.json'];
  for (const file of tracked) {
    if (!existsSync(resolve(root, file))) continue;
    assert.doesNotMatch(read(file), /document-intelligence-client/u, `${file} must not hard-depend on the DI client package`);
  }
  const ws = read('pnpm-workspace.yaml');
  assert.match(ws, /services\/document-intelligence\/clients\/\*/u);
});

test('MED-02: DI module is a parity-manifested copy that is explicitly not the active deployment writer', () => {
  const manifest = JSON.parse(read('services/document-intelligence/MIGRATION-MANIFEST.json'));
  assert.equal(manifest.source.commit, '7d81f267bc7fe1149557d827e029a0dfd09bc6ab');
  assert.equal(manifest.deploymentWriter.media, 'INACTIVE_PENDING_CUTOVER');
  assert.equal(manifest.deploymentWriter.active, 'ghatana/services/document-intelligence');
  assert.equal(manifest.protocol, 'document-intelligence.v1');
  assert.equal(manifest.decision.state, 'PROPOSED');
  assert.equal(manifest.decision.architecturalReview, 'NOT_PERFORMED');
  const root0 = resolve(root, 'services/document-intelligence');
  const files = new Map(manifest.files.map((f) => [f.path, f]));
  const onDisk = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', 'dist', 'build', '.gradle', '__pycache__', '.venv'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full); else onDisk.push(relative(root0, full));
    }
  };
  walk(root0);
  const selfPath = 'MIGRATION-MANIFEST.json';
  for (const path of onDisk) if (path !== selfPath) assert.ok(files.has(path), `${path} must be in the migration manifest`);
  assert.equal(files.size, onDisk.filter((p) => p !== selfPath).length, 'manifest lists exactly the on-disk files');
  assert.ok(manifest.referencedNotCopied.length > 0);
});

test('MDI-002 is a PROPOSED additive supersession and MDI-001 keeps the single-gateway rules', () => {
  const mdi2 = read('docs/migration/decisions/MDI-002-document-intelligence-media-packaging.md');
  assert.match(mdi2, /\*\*Status:\*\* PROPOSED/u);
  assert.match(mdi2, /no independent architectural review has been performed or claimed/iu);
  assert.match(mdi2, /existing Ghatana deployment remains the active writer until cutover is proven/iu);
  assert.match(mdi2, /One DI public gateway/u);
  const boundary = read('BOUNDARY.md');
  assert.match(boundary, /MDI-002 \(PROPOSED\)/u);
  const yaml = read('.product-experience/pdp-0-product-truth/ocr-ownership.yaml');
  assert.match(yaml, /PDP0-003-D4/u);
  assert.match(yaml, /id: PDP0-003-D5[\s\S]*?state: proposed/u);
  assert.match(yaml, /mediaCopy: INACTIVE_PENDING_CUTOVER/u);
});
