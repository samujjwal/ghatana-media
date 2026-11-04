import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkWhisperExportManifest, verifyWhisperExportArtifacts, MANIFEST_SCHEMA, MAX_TOTAL_OUTPUT_BYTES } from '../scripts/qualification/check-whisper-onnx-export-manifest.mjs';

const catalog = JSON.parse(readFileSync(new URL('../config/qualification/wave2-reference-candidates.v1.json', import.meta.url)));
const encoderSha = '1'.repeat(64);
const decoderSha = '2'.repeat(64);
const descriptor = {
  name: 'synthetic-exporter', version: '0.0-test', sourceRevision: 'c'.repeat(40),
  dependencyLockSha256: 'a'.repeat(64), argv: ['export', '--no-network'],
};

function manifest(sourceCatalog = catalog) {
  const candidate = sourceCatalog.candidates.find(item => item.id === 'stt-whisper-tiny-multilingual');
  const tokenizer = sourceCatalog.candidates.find(item => item.id === 'stt-whisper-multilingual-tokenizer');
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

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function localFixture() {
  const sourceCatalog = structuredClone(catalog);
  const candidate = sourceCatalog.candidates.find(item => item.id === 'stt-whisper-tiny-multilingual');
  const checkpoint = Buffer.from('official pinned checkpoint fixture');
  candidate.artifactSha256 = sha(checkpoint);
  candidate.upstreamUrl = `https://huggingface.co/openai/whisper-tiny/resolve/${candidate.artifactSha256}/tiny.pt`;
  candidate.maxBytes = checkpoint.length;
  const value = manifest(sourceCatalog);
  const files = { encoder: Buffer.from('encoder model fixture'), decoder: Buffer.from('decoder model fixture') };
  for (const run of value.runs) {
    for (const artifact of run.artifacts) {
      artifact.sha256 = sha(files[artifact.role]);
      artifact.sizeBytes = files[artifact.role].length;
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'whisper-artifacts-'));
  const artifactRoot = join(root, 'exports');
  mkdirSync(artifactRoot);
  for (const run of value.runs) {
    const runDir = join(artifactRoot, run.id);
    mkdirSync(runDir);
    for (const artifact of run.artifacts) writeFileSync(join(artifactRoot, artifact.path), files[artifact.role]);
  }
  const checkpointFile = join(root, 'tiny.pt');
  writeFileSync(checkpointFile, checkpoint);
  return { sourceCatalog, value, root, artifactRoot, checkpointFile };
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

test('local opt-in hashes the checkpoint and all four outputs and remains REVIEW_ONLY', () => {
  const fixture = localFixture();
  try {
    const result = verifyWhisperExportArtifacts(fixture.value, {
      catalog: fixture.sourceCatalog, checkpointFile: fixture.checkpointFile, artifactRoot: fixture.artifactRoot,
    });
    assert.equal(result.status, 'REVIEW_ONLY');
    assert.equal(result.verificationMode, 'LOCAL_BOUNDED_ARTIFACT_HASHES');
    assert.equal(result.checkpointVerified, true);
    assert.equal(result.outputArtifactCount, 4);
    assert.equal(result.totalOutputBytes, fixture.value.runs.reduce((sum, run) => sum + run.artifacts.reduce((part, item) => part + item.sizeBytes, 0), 0));
    assert.equal(result.rightsApproved, false);
    assert.equal(result.parityQualified, false);
    assert.equal(result.inferenceAdmitted, false);
    assert.deepEqual(result.provenance.sourceCheckpoint, {
      sha256: sha(Buffer.from('official pinned checkpoint fixture')),
      sizeBytes: Buffer.byteLength('official pinned checkpoint fixture'),
    });
    assert.deepEqual(result.provenance.frontend, fixture.value.frontend);
    assert.deepEqual(result.provenance.exportConfig, fixture.value.exportConfig);
    assert.deepEqual(result.provenance.runs, fixture.value.runs.map(run => ({
      id: run.id,
      converter: run.converter,
      environment: run.environment,
      artifacts: run.artifacts.map(artifact => ({ role: artifact.role, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes })),
    })));
    assert.equal(JSON.stringify(result).includes(fixture.artifactRoot), false);
    assert.equal(JSON.stringify(result).includes('encoder.onnx'), false);
    assert.equal(JSON.stringify(result).includes('encoder model fixture'), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('local verification rejects symlinked and group/world-writable artifact directories', () => {
  const linkedRoot = localFixture();
  try {
    const alias = join(linkedRoot.root, 'exports-alias');
    symlinkSync(linkedRoot.artifactRoot, alias);
    assert.throws(() => verifyWhisperExportArtifacts(linkedRoot.value, {
      catalog: linkedRoot.sourceCatalog, checkpointFile: linkedRoot.checkpointFile, artifactRoot: alias,
    }), /UNSAFE_ARTIFACT_ROOT/);
  } finally { rmSync(linkedRoot.root, { recursive: true, force: true }); }

  const linkedRun = localFixture();
  try {
    const moved = join(linkedRun.root, 'run-a-real');
    const runDir = join(linkedRun.artifactRoot, 'run-a');
    // Move the actual directory aside and replace the declared run directory with a symlink.
    renameSync(runDir, moved);
    symlinkSync(moved, runDir);
    assert.throws(() => verifyWhisperExportArtifacts(linkedRun.value, {
      catalog: linkedRun.sourceCatalog, checkpointFile: linkedRun.checkpointFile, artifactRoot: linkedRun.artifactRoot,
    }), /UNSAFE_ARTIFACT_DIRECTORY/);
  } finally { rmSync(linkedRun.root, { recursive: true, force: true }); }

  const writable = localFixture();
  try {
    chmodSync(writable.artifactRoot, 0o777);
    assert.throws(() => verifyWhisperExportArtifacts(writable.value, {
      catalog: writable.sourceCatalog, checkpointFile: writable.checkpointFile, artifactRoot: writable.artifactRoot,
    }), /UNSAFE_ARTIFACT_ROOT/);
  } finally { rmSync(writable.root, { recursive: true, force: true }); }
});

test('local verification rejects a group/world-writable checkpoint parent directory', () => {
  const fixture = localFixture();
  try {
    chmodSync(fixture.root, 0o777);
    assert.throws(() => verifyWhisperExportArtifacts(fixture.value, {
      catalog: fixture.sourceCatalog, checkpointFile: fixture.checkpointFile, artifactRoot: fixture.artifactRoot,
    }), /UNSAFE_CHECKPOINT_DIRECTORY/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('declared output total cap is rejected before opening a missing checkpoint', () => {
  const fixture = localFixture();
  try {
    const perOutputBytes = Math.floor(MAX_TOTAL_OUTPUT_BYTES / 4) + 1;
    for (const run of fixture.value.runs) {
      for (const artifact of run.artifacts) artifact.sizeBytes = perOutputBytes;
    }
    const missingCheckpoint = join(fixture.root, 'missing-checkpoint.pt');
    assert.throws(() => verifyWhisperExportArtifacts(fixture.value, {
      catalog: fixture.sourceCatalog, checkpointFile: missingCheckpoint, artifactRoot: fixture.artifactRoot,
    }), /TOTAL_OUTPUT_SIZE_LIMIT_EXCEEDED/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('FIFO inputs are rejected without blocking for CLI manifests and local artifacts', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'whisper-fifo-'));
  try {
    const manifestFifo = join(root, 'manifest.json');
    const checkpointFifo = join(root, 'checkpoint.pt');
    const artifactFifoRoot = join(root, 'exports');
    mkdirSync(artifactFifoRoot);
    try {
      execFileSync('mkfifo', [manifestFifo]);
      execFileSync('mkfifo', [checkpointFifo]);
      execFileSync('mkfifo', [join(artifactFifoRoot, 'run-a')]);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.status !== 0) { context.skip('mkfifo unavailable'); return; }
      throw error;
    }
    const checker = fileURLToPath(new URL('../scripts/qualification/check-whisper-onnx-export-manifest.mjs', import.meta.url));
    const cli = spawnSync(process.execPath, [checker, '--manifest', manifestFifo], { encoding: 'utf8', timeout: 2000 });
    assert.equal(cli.error, undefined);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /UNSAFE_OR_OVERSIZED_JSON/u);

    const cliManifest = join(root, 'valid-manifest.json');
    writeFileSync(cliManifest, JSON.stringify(manifest()));
    const cliCheckpoint = spawnSync(process.execPath, [checker, '--verify-artifacts', '--manifest', cliManifest,
      '--checkpoint-file', checkpointFifo, '--artifact-root', artifactFifoRoot], { encoding: 'utf8', timeout: 2000 });
    assert.equal(cliCheckpoint.error, undefined);
    assert.equal(cliCheckpoint.status, 1);
    assert.match(cliCheckpoint.stderr, /UNSAFE_ARTIFACT_FILE/u);

    const checkpoint = localFixture();
    try {
      const checkerUrl = new URL('../scripts/qualification/check-whisper-onnx-export-manifest.mjs', import.meta.url).href;
      const runnerPath = join(checkpoint.root, 'verify-fixture.mjs');
      const valuePath = join(checkpoint.root, 'manifest.json');
      const catalogPath = join(checkpoint.root, 'catalog.json');
      writeFileSync(valuePath, JSON.stringify(checkpoint.value));
      writeFileSync(catalogPath, JSON.stringify(checkpoint.sourceCatalog));
      writeFileSync(runnerPath, `import { readFileSync } from 'node:fs';\nimport { verifyWhisperExportArtifacts } from ${JSON.stringify(checkerUrl)};\nconst [manifestPath, catalogPath, checkpointFile, artifactRoot] = process.argv.slice(2);\ntry { verifyWhisperExportArtifacts(JSON.parse(readFileSync(manifestPath)), { catalog: JSON.parse(readFileSync(catalogPath)), checkpointFile, artifactRoot }); } catch (error) { console.error(error.code || 'ERROR'); process.exitCode = 1; }\n`);
      const runChild = (file, artifactRoot) => spawnSync(process.execPath,
        [runnerPath, valuePath, catalogPath, file, artifactRoot], { encoding: 'utf8', timeout: 2000 });
      const checkpointChild = runChild(checkpointFifo, checkpoint.artifactRoot);
      assert.equal(checkpointChild.error, undefined);
      assert.equal(checkpointChild.status, 1);
      assert.match(checkpointChild.stderr, /UNSAFE_ARTIFACT_FILE/u);
      assert.throws(() => verifyWhisperExportArtifacts(checkpoint.value, {
        catalog: checkpoint.sourceCatalog, checkpointFile: checkpoint.checkpointFile, artifactRoot: artifactFifoRoot,
      }), /UNSAFE_ARTIFACT_DIRECTORY/);
      const outputFifo = join(checkpoint.artifactRoot, 'run-a', 'encoder.onnx');
      rmSync(outputFifo);
      execFileSync('mkfifo', [outputFifo]);
      const outputChild = runChild(checkpoint.checkpointFile, checkpoint.artifactRoot);
      assert.equal(outputChild.error, undefined);
      assert.equal(outputChild.status, 1);
      assert.match(outputChild.stderr, /UNSAFE_ARTIFACT_FILE/u);
    } finally { rmSync(checkpoint.root, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local verification rejects missing, oversized, symlinked, and mismatching files', () => {
  const missing = localFixture();
  try {
    rmSync(join(missing.artifactRoot, 'run-a', 'encoder.onnx'));
    assert.throws(() => verifyWhisperExportArtifacts(missing.value, {
      catalog: missing.sourceCatalog, checkpointFile: missing.checkpointFile, artifactRoot: missing.artifactRoot,
    }), /ARTIFACT_FILE_UNAVAILABLE/);
  } finally { rmSync(missing.root, { recursive: true, force: true }); }

  const oversized = localFixture();
  try {
    writeFileSync(oversized.checkpointFile, Buffer.alloc(oversized.sourceCatalog.candidates.find(item => item.id === 'stt-whisper-tiny-multilingual').maxBytes + 1));
    assert.throws(() => verifyWhisperExportArtifacts(oversized.value, {
      catalog: oversized.sourceCatalog, checkpointFile: oversized.checkpointFile, artifactRoot: oversized.artifactRoot,
    }), /ARTIFACT_SIZE_LIMIT_EXCEEDED/);
  } finally { rmSync(oversized.root, { recursive: true, force: true }); }

  const linked = localFixture();
  try {
    const target = join(linked.root, 'outside.onnx');
    writeFileSync(target, Buffer.from('encoder model fixture'));
    rmSync(join(linked.artifactRoot, 'run-a', 'encoder.onnx'));
    symlinkSync(target, join(linked.artifactRoot, 'run-a', 'encoder.onnx'));
    assert.throws(() => verifyWhisperExportArtifacts(linked.value, {
      catalog: linked.sourceCatalog, checkpointFile: linked.checkpointFile, artifactRoot: linked.artifactRoot,
    }), /UNSAFE_ARTIFACT_FILE/);
  } finally { rmSync(linked.root, { recursive: true, force: true }); }

  const mismatch = localFixture();
  try {
    writeFileSync(join(mismatch.artifactRoot, 'run-b', 'decoder.onnx'), Buffer.from('tampered decoder'));
    assert.throws(() => verifyWhisperExportArtifacts(mismatch.value, {
      catalog: mismatch.sourceCatalog, checkpointFile: mismatch.checkpointFile, artifactRoot: mismatch.artifactRoot,
    }), /EXPORTED_ARTIFACT_SIZE_MISMATCH|EXPORTED_ARTIFACT_DIGEST_MISMATCH/);
  } finally { rmSync(mismatch.root, { recursive: true, force: true }); }
});

test('local verification rejects traversal and a checkpoint pin mismatch', () => {
  const traversal = localFixture();
  try {
    traversal.value.runs[0].artifacts[0].path = '../encoder.onnx';
    assert.throws(() => verifyWhisperExportArtifacts(traversal.value, {
      catalog: traversal.sourceCatalog, checkpointFile: traversal.checkpointFile, artifactRoot: traversal.artifactRoot,
    }), /NONCANONICAL_EXPORT_ARTIFACT_PATH/);
  } finally { rmSync(traversal.root, { recursive: true, force: true }); }
  const mismatch = localFixture();
  try {
    writeFileSync(mismatch.checkpointFile, 'different checkpoint');
    assert.throws(() => verifyWhisperExportArtifacts(mismatch.value, {
      catalog: mismatch.sourceCatalog, checkpointFile: mismatch.checkpointFile, artifactRoot: mismatch.artifactRoot,
    }), /CHECKPOINT_SIZE_MISMATCH|CHECKPOINT_DIGEST_MISMATCH/);
  } finally { rmSync(mismatch.root, { recursive: true, force: true }); }
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

test('run agreement is independent of JSON object property order', () => {
  const candidate = manifest();
  candidate.runs[1].converter = {
    argv: [...descriptor.argv],
    dependencyLockSha256: descriptor.dependencyLockSha256,
    sourceRevision: descriptor.sourceRevision,
    version: descriptor.version,
    name: descriptor.name,
  };
  candidate.runs[1].environment = {
    dependencyLockSha256: descriptor.dependencyLockSha256,
    platform: 'synthetic-test',
    python: '3.x',
  };
  const result = checkWhisperExportManifest(candidate, { catalog });
  assert.equal(result.declaredOutputDigestRecordsAgree, true);
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

test('CLI selects metadata-only or explicit verification mode and rejects malformed arguments', () => {
  const checker = fileURLToPath(new URL('../scripts/qualification/check-whisper-onnx-export-manifest.mjs', import.meta.url));
  const partialVerification = spawnSync(process.execPath, [checker, '--verify-artifacts', '--manifest', 'manifest.json'], { encoding: 'utf8' });
  assert.equal(partialVerification.status, 1);
  assert.equal(partialVerification.stdout, '');
  assert.match(partialVerification.stderr, /INVALID_CHECKER_ARGUMENTS/);

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
