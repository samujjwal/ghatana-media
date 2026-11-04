import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkWhisperExportManifest, MANIFEST_SCHEMA } from '../scripts/qualification/check-whisper-onnx-export-manifest.mjs';

const catalog = JSON.parse(readFileSync(new URL('../config/qualification/wave2-reference-candidates.v1.json', import.meta.url)));
const encoderSha = '1'.repeat(64);
const decoderSha = '2'.repeat(64);
const descriptor = {
  name: 'synthetic-exporter', version: '0.0-test', sourceRevision: 'c'.repeat(40),
  dependencyLockSha256: 'a'.repeat(64), argv: ['export', '--no-network'],
};

function manifest() {
  const candidate = catalog.candidates.find(item => item.id === 'stt-whisper-tiny-multilingual');
  const tokenizer = catalog.candidates.find(item => item.id === 'stt-whisper-multilingual-tokenizer');
  return {
    schemaVersion: MANIFEST_SCHEMA,
    candidateId: candidate.id,
    status: 'REVIEW_ONLY',
    admissionClaim: 'NONE',
    sourceCheckpoint: {
      url: candidate.upstreamUrl, sha256: candidate.artifactSha256,
      format: 'PYTORCH_CHECKPOINT_NOT_ONNX',
    },
    frontend: { tokenizerSha256: tokenizer.artifactSha256, melFiltersSha256: candidate.compatibleOnnxExport.frontendAsset.sha256 },
    exportConfig: { architecture: 'whisper-tiny-multilingual', opset: '17', quantization: 'none', dynamicAxes: ['audio_frames', 'tokens'] },
    // These paths intentionally need not exist: validation is declaration-only.
    runs: ['run-a', 'run-b'].map(id => ({
      id,
      converter: structuredClone(descriptor),
      environment: { python: '3.x', platform: 'synthetic-test', dependencyLockSha256: descriptor.dependencyLockSha256 },
      artifacts: [
        { role: 'encoder', path: `${id}/encoder.onnx`, sha256: encoderSha, sizeBytes: 23 },
        { role: 'decoder', path: `${id}/decoder.onnx`, sha256: decoderSha, sizeBytes: 23 },
      ],
    })),
  };
}

test('checks pinned metadata and declared digest agreement without opening artifact paths', () => {
  const result = checkWhisperExportManifest(manifest(), { catalog });
  assert.equal(result.status, 'EXPORT_METADATA_CHECKED_REVIEW_ONLY');
  assert.equal(result.pinnedSourceCheckpointSha256, manifest().sourceCheckpoint.sha256);
  assert.equal(result.verificationMode, 'DECLARATION_ONLY_NO_ARTIFACT_IO');
  assert.equal(result.declaredRunCount, 2);
  assert.equal(result.declaredOutputDigestRecordsAgree, true);
  assert.equal(result.artifactBytesInspected, false);
  assert.equal(result.rightsApproved, false);
  assert.equal(result.parityQualified, false);
  assert.equal(result.inferenceAdmitted, false);
});

test('rejects a checkpoint digest that differs from the official candidate pin', () => {
  const candidate = manifest();
  candidate.sourceCheckpoint.sha256 = '0'.repeat(64);
  assert.throws(() => checkWhisperExportManifest(candidate, { catalog }), /SOURCE_CHECKPOINT_DOES_NOT_MATCH_OFFICIAL_PIN/);
});

test('rejects declared encoder or decoder digest disagreement', () => {
  const candidate = manifest();
  candidate.runs[1].artifacts[0].sha256 = 'b'.repeat(64);
  assert.throws(() => checkWhisperExportManifest(candidate, { catalog }), /DECLARED_EXPORT_RUNS_DISAGREE/);
});

test('rejects admission claims, unknown fields, transcript text, local paths, and secret-like arguments', () => {
  const admitted = manifest();
  admitted.admissionClaim = 'APPROVED';
  assert.throws(() => checkWhisperExportManifest(admitted, { catalog }), /INVALID_OR_PROMOTING_EXPORT_MANIFEST/);
  const extraTop = manifest();
  extraTop.transcript = 'must not enter export provenance';
  assert.throws(() => checkWhisperExportManifest(extraTop, { catalog }), /UNKNOWN_MANIFEST_FIELDS/);
  const extraNested = manifest();
  extraNested.exportConfig.secret = 'credential';
  assert.throws(() => checkWhisperExportManifest(extraNested, { catalog }), /UNKNOWN_EXPORT_CONFIG_FIELDS/);
  const freeText = manifest();
  freeText.runs[0].converter.argv.push('private transcript text');
  assert.throws(() => checkWhisperExportManifest(freeText, { catalog }), /INCOMPLETE_EXPORT_RUN_PROVENANCE/);
  const secretArg = manifest();
  secretArg.runs[0].converter.argv.push('sk-abcdefghijklmnop');
  assert.throws(() => checkWhisperExportManifest(secretArg, { catalog }), /INCOMPLETE_EXPORT_RUN_PROVENANCE/);
  const localPathArg = manifest();
  localPathArg.runs[0].converter.argv.push('--out=/Users/alice/model.onnx');
  assert.throws(() => checkWhisperExportManifest(localPathArg, { catalog }), /INCOMPLETE_EXPORT_RUN_PROVENANCE/);
});

test('rejects traversal and noncanonical artifact path declarations without filesystem access', () => {
  const traversal = manifest();
  traversal.runs[0].artifacts[0].path = '../encoder.onnx';
  assert.throws(() => checkWhisperExportManifest(traversal, { catalog }), /NONCANONICAL_EXPORT_ARTIFACT_PATH/);
});

test('CLI rejects artifact-root verification and unexpected arguments', () => {
  const checker = fileURLToPath(new URL('../scripts/qualification/check-whisper-onnx-export-manifest.mjs', import.meta.url));
  const artifactRoot = spawnSync(process.execPath, [checker, '--artifact-root', '/tmp'], { encoding: 'utf8' });
  assert.equal(artifactRoot.status, 1);
  assert.equal(artifactRoot.stdout, '');
  assert.match(artifactRoot.stderr, /ARTIFACT_ROOT_UNSUPPORTED_DECLARATION_ONLY_CHECKER/);

  const extra = spawnSync(process.execPath, [checker, '--manifest', 'manifest.json', '--unexpected'], { encoding: 'utf8' });
  assert.equal(extra.status, 1);
  assert.equal(extra.stdout, '');
  assert.match(extra.stderr, /INVALID_CHECKER_ARGUMENTS/);
});

test('CLI reads a bounded manifest from one non-symlink file handle', () => {
  const checker = fileURLToPath(new URL('../scripts/qualification/check-whisper-onnx-export-manifest.mjs', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'whisper-export-cli-'));
  const manifestPath = join(root, 'manifest.json');
  const aliasPath = join(root, 'manifest-alias.json');
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest()), { mode: 0o600 });
    const valid = spawnSync(process.execPath, [checker, '--manifest', manifestPath], { encoding: 'utf8' });
    assert.equal(valid.status, 0);
    assert.match(valid.stdout, /"artifactBytesInspected": false/u);

    symlinkSync(manifestPath, aliasPath);
    const symlinked = spawnSync(process.execPath, [checker, '--manifest', aliasPath], { encoding: 'utf8' });
    assert.equal(symlinked.status, 1);
    assert.equal(symlinked.stdout, '');
    assert.match(symlinked.stderr, /UNSAFE_OR_OVERSIZED_JSON/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
