import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const prefix = 'modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/ocr/';

test('Media OCR compatibility source does not claim generic OCR ownership or unsupported accuracy', () => {
  const service = read(prefix + 'OcrService.java');
  const adapter = read(prefix + 'KernelOcrProviderAdapter.java');
  const build = read('modules/vision/vision-service/build.gradle.kts');
  for (const source of [service, adapter]) {
    assert.match(source, /Document Intelligence/u);
    assert.doesNotMatch(source, /OCR accuracy &gt;95%|model identity, confidence policy, and image decoding remain Media-owned/u);
  }
  assert.doesNotMatch(build, /Media owns the OCR model/u);
  assert.match(build, /Legacy Kernel OCR compatibility only/u);
});

test('legacy OCR is not an automatically selected provider', () => {
  const manifest = JSON.parse(read('config/provider-manifest.json'));
  assert.equal(manifest.conformance.automaticSelectionEligible, false);
  const meaning = read('.product-experience/pdp-0-product-truth/ocr-ownership.yaml');
  assert.match(meaning, /classification: LEGACY_COMPATIBILITY/u);
  assert.match(meaning, /status: EXTERNAL_BLOCKER/u);
});
