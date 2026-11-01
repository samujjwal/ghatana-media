import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => readFileSync(resolve(root, p), 'utf8');

test('retired Media OCR implementations remain absent', () => {
  for (const source of [
    'modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/ocr/OcrService.java',
    'adapters/ocr-compat',
  ]) assert.equal(existsSync(resolve(root, source)), false, `${source} must remain retired`);
});

test('Media OCR source retirement does not claim an admitted Kernel or DI replacement', () => {
  const topology = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));
  const retired = topology.retiredManifestLocations.find(entry => entry.path === 'adapters/ocr-compat/build.gradle.kts');
  assert.match(retired.rationale, /does not establish a replacement Kernel provider/u);
  const retirement = JSON.parse(read('docs/implementation/media-ocr-compat-retirement-decision.v1.json'));
  assert.equal(retirement.decision, 'RETIRED_SOURCE_REPLACEMENT_NOT_ADMITTED');
  assert.equal(retirement.currentState.mediaSource, 'RETIRED');
  assert.equal(retirement.currentState.replacementProvider, 'NOT_ADMITTED');
  assert.match(retirement.currentState.closure, /separately from OCR-K01/u);
  assert.equal(retirement.sourceImpact.candidatePresentOnKernelOriginMain, false);
  assert.equal(retirement.sourceImpact.kernelOriginMain, '209921dea4f13c756deaa0a945580df4587ffbf3');
});

test('legacy OCR is not an automatically selected provider', () => {
  const manifest = JSON.parse(read('config/provider-manifest.json'));
  assert.equal(manifest.conformance.automaticSelectionEligible, false);
  const meaning = read('.product-experience/pdp-0-product-truth/ocr-ownership.yaml');
  assert.match(meaning, /classification: LEGACY_COMPATIBILITY/u);
  assert.match(meaning, /status: EXTERNAL_BLOCKER/u);
  assert.match(meaning, /Kernel replacement and installed\s+consumer compatibility remain unverified/u);
  const request = JSON.parse(read('config/kernel-provider-dependency-requests.source.json')).requests[0];
  assert(request.sourceRefs.every(ref => !ref.path.includes('DiOcrProvider')));
  assert.match(request.note, /local-only candidate.*not an admitted provider/u);
  assert(request.environmentPrerequisites.length > 0);
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
  assert.match(matrix, /source-free DI-backed capability conformance/iu);
  assert.match(matrix, /OCR-M03 source removal is already recorded/u);
  assert.match(matrix, /No callable Media generic OCR implementation remains/u);
  assert.match(matrix, /swap the adapter\/model \*\*inside Document Intelligence\*\*/u);
  assert.match(matrix, /Ghatana #252/u);
  assert.match(matrix, /VIS-09\/OC-04/u);
});
