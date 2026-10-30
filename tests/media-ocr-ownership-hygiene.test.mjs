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
  const adapter = read('adapters/ocr-compat/src/main/java/com/ghatana/audio/video/vision/ocr/KernelOcrProviderAdapter.java');
  const adapterBuild = read('adapters/ocr-compat/build.gradle.kts');
  for (const source of [service, adapter]) {
    assert.match(source, /Document Intelligence/u);
    assert.doesNotMatch(source, /OCR accuracy &gt;95%|model identity, confidence policy, and image decoding remain Media-owned/u);
  }
  assert.doesNotMatch(adapterBuild, /Media owns the OCR model/u);
  assert.match(adapterBuild, /optional Kernel bridge/u);
});

test('legacy OCR is not an automatically selected provider', () => {
  const manifest = JSON.parse(read('config/provider-manifest.json'));
  assert.equal(manifest.conformance.automaticSelectionEligible, false);
  const meaning = read('.product-experience/pdp-0-product-truth/ocr-ownership.yaml');
  assert.match(meaning, /classification: LEGACY_COMPATIBILITY/u);
  assert.match(meaning, /status: EXTERNAL_BLOCKER/u);
});

test('MDI-001 is the sole OCR execution owner and Media has no generic recognizer path', () => {
  const owner = read('docs/migration/decisions/MDI-001-document-intelligence-ownership.md');
  const pdp = read('.product-experience/pdp-0-product-truth/ocr-ownership.yaml');
  const source = read('libs/audio-video-client/src/authorized-scene-text.ts');
  const contract = read('libs/audio-video-client/src/scene-text-adapter.ts');
  const architecture = read('docs/architecture/MEDIA-OCR-DATACLOUD-DEPENDENCY-DECISION-2026-10-30.md');
  assert.match(owner, /All OCR\s+execution anywhere in Ghatana is exposed \*\*exclusively through Document/u);
  assert.match(pdp, /PDP0-003-D4/u);
  assert.match(source, /diClient: DocumentIntelligenceV1Client/u);
  assert.match(source, /new DocumentIntelligenceSceneTextAdapter\(diClient, diPolicy\)/u);
  assert.doesNotMatch(source, /interface MediaSceneTextRecognizer/u);
  assert.doesNotMatch(source, /qualified Vision OCR provider|Media-owned OCR model/u);
  assert.match(contract, /DOCUMENT_INTELLIGENCE_PROTOCOL_V1/u);
  assert.match(architecture, /prior idea of adding an independent Media Vision OCR provider is/u);
  assert.doesNotMatch(architecture, /OR qualified Media model/u);
});

test('development consumer migration accounts for every DI-only adoption and retirement stage', () => {
  const matrix = read('docs/migration/document-intelligence-media-crosswalk.md');
  const ids = [...matrix.matchAll(/^\| \*\*(OCR-[A-Z]\d\d) — /gmu)]
    .map(match => match[1]);
  assert.deepEqual(ids, [
    'OCR-C01', 'OCR-D01', 'OCR-D02', 'OCR-M01', 'OCR-M02',
    'OCR-K01', 'OCR-M03', 'OCR-X01',
  ]);
  assert.match(matrix, /source-free DI-backed capability conformance/u);
  assert.match(matrix, /After OCR-M01\/M02\/K01 prove their replacement/u);
  assert.match(matrix, /No callable Media generic OCR implementation remains/u);
  assert.match(matrix, /swap the adapter\/model \*\*inside Document Intelligence\*\*/u);
  assert.match(matrix, /Ghatana #252/u);
  assert.match(matrix, /VIS-09\/OC-04/u);
});
