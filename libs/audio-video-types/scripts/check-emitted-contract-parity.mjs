import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const formats = [
  ['ESM', await import('../dist/index.js'), await import('../dist/contracts.js')],
  ['CJS', require('../dist-cjs/index.js'), require('../dist-cjs/contracts.js')],
];

const validStt = {
  text: 'hello',
  confidence: 0.9,
  processingTimeMs: Number.MAX_SAFE_INTEGER,
  language: 'en',
  model: 'model-1',
  words: [{ word: 'hello', start: -0.25, end: 0.5, confidence: 0.9 }],
};
const validDetection = {
  objects: [{
    class: 'edge-object',
    confidence: 0.5,
    bbox: { x: -0.5, y: 1.25, width: 0, height: 2.5 },
  }],
  confidence: 0.5,
  processingTimeMs: 1,
  imageSize: { width: 10.5, height: 20.25 },
};
const validMultimodal = {
  result: { summary: 'ok' },
  confidence: 0.9,
  processingTimeMs: 1,
  modalities: ['audio', 'text'],
};
const validCanonicalTranscript = {
  artifactId: 'source-1',
  transcriptArtifactId: 'transcript-1',
  text: 'hello',
  languageTag: 'en',
  confidence: 0.9,
  words: [{ text: 'hello', startMs: 0, endMs: 0, confidence: 0.9 }],
  providerId: 'provider-1',
  modelId: 'model-1',
  modelVersion: '1',
  processingTimeMs: Number.MAX_SAFE_INTEGER,
};

for (const [format, api, contracts] of formats) {
  assert.equal(api.parseSTTResult(validStt).words[0].start, -0.25, `${format} fractional source time`);
  assert.equal(api.parseDetectionResult(validDetection).objects[0].bbox.width, 0, `${format} zero-area box`);
  assert.equal(api.parseMultimodalResult(validMultimodal).processingTimeMs, 1, `${format} valid result`);
  assert.equal(contracts.TranscriptionResultSchema.parse(validCanonicalTranscript)
    .words[0].startMs, 0, `${format} canonical zero-duration word`);

  for (const processingTimeMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => api.parseSTTResult({ ...validStt, processingTimeMs }), `${format} STT elapsed time`);
    assert.throws(() => api.parseDetectionResult({ ...validDetection, processingTimeMs }), `${format} vision elapsed time`);
    assert.throws(() => api.parseMultimodalResult({ ...validMultimodal, processingTimeMs }), `${format} multimodal elapsed time`);
  }
  assert.throws(() => api.parseSTTResult({
    ...validStt,
    words: [{ word: 'bad', start: 1, end: 0, confidence: 0.9 }],
  }), `${format} reversed word interval`);
  assert.throws(() => api.parseDetectionResult({
    ...validDetection,
    objects: [{ ...validDetection.objects[0], bbox: { x: 0, y: 0, width: -1, height: 1 } }],
  }), `${format} negative box extent`);
  assert.throws(() => api.parseDetectionResult({
    ...validDetection,
    imageSize: { width: 0, height: 10 },
  }), `${format} zero image dimension`);
  for (const [field, value] of [
    ['processingTimeMs', -1],
    ['processingTimeMs', 0.5],
    ['processingTimeMs', Number.MAX_SAFE_INTEGER + 1],
  ]) {
    assert.throws(() => contracts.TranscriptionResultSchema.parse({
      ...validCanonicalTranscript,
      [field]: value,
    }), `${format} canonical ${field}`);
  }
  assert.throws(() => contracts.TranscriptionResultSchema.parse({
    ...validCanonicalTranscript,
    words: [{ text: 'bad', startMs: 1, endMs: 0, confidence: 0.9 }],
  }), `${format} canonical reversed interval`);
}

console.log('Emitted ESM and CJS contracts preserve identical numeric boundaries.');
