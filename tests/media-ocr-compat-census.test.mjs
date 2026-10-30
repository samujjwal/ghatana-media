import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = readFileSync(join(repo,
  'adapters/ocr-compat/src/main/java/com/ghatana/audio/video/vision/ocr/KernelOcrProviderAdapter.java'), 'utf8');
const census = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-ocr-compat-census.v1.json'), 'utf8'));

test('OC-01: extract() never dispatches to a model, executor or endpoint', () => {
  const extractBody = adapter.match(/CompletionStage<[^>]+> extract\([\s\S]*?\n    }/)[0];
  assert.ok(!/service\.|executor\.|invoke|execute|submit|model\./i.test(extractBody),
    'extract() must not invoke service/model/executor');
  assert.match(extractBody, /NOT_ADMITTED/);
});

test('OC-01: fail-closed terminal codes only — no OCR text path', () => {
  const extractBody = adapter.match(/CompletionStage<[^>]+> extract\([\s\S]*?\n    }/)[0];
  for (const code of ['PROVIDER_CLOSED', 'PROVIDER_NOT_STARTED', 'NOT_ADMITTED']) {
    assert.ok(extractBody.includes(`"${code}"`), `extract() must return ${code}`);
  }
  assert.ok(!extractBody.includes('OcrResult.success') && !extractBody.includes('text('),
    'extract() must never construct a text result');
});

test('OC-01/OC-04: census reflects the fail-closed compat verdict', () => {
  assert.equal(census.verdict.status, 'COMPAT_SHIM_NOT_ADMITTED');
  assert.match(census.verdict.externalOwner, /#252/);
});
