import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '../..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'audio-video-types-consumer-'));
const buildRoot = path.join(tempRoot, 'build');
const packRoot = path.join(tempRoot, 'pack');
const consumerRoot = path.join(tempRoot, 'consumer');
const npmCache = path.join(tempRoot, 'npm-cache');
const sourceNodeModules = path.join(packageRoot, 'node_modules');
const npmEnv = { ...process.env, npm_config_cache: npmCache };

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ''}`, { cause: error });
  }
}

try {
  const sourceManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const zodManifestPath = path.join(sourceNodeModules, 'zod', 'package.json');
  const zodManifest = JSON.parse(await readFile(zodManifestPath, 'utf8'));
  assert.equal(sourceManifest.dependencies?.zod, 'catalog:', 'expected the declared workspace zod dependency');

  await mkdir(buildRoot, { recursive: true });
  await mkdir(packRoot, { recursive: true });
  await cp(path.join(packageRoot, 'src'), path.join(buildRoot, 'src'), { recursive: true });
  for (const file of ['tsconfig.build.json', 'tsconfig.cjs.json', 'tsconfig.json', 'cjs-package.json']) {
    await cp(path.join(packageRoot, file), path.join(buildRoot, file));
  }
  await mkdir(path.join(buildRoot, 'scripts'), { recursive: true });
  await cp(path.join(packageRoot, 'scripts/copy-cjs-package.mjs'), path.join(buildRoot, 'scripts/copy-cjs-package.mjs'));
  await symlink(sourceNodeModules, path.join(buildRoot, 'node_modules'), 'dir');

  const tsc = path.join(sourceNodeModules, 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: buildRoot });
  run(process.execPath, [tsc, '-p', 'tsconfig.cjs.json'], { cwd: buildRoot });
  run(process.execPath, ['scripts/copy-cjs-package.mjs'], { cwd: buildRoot });

  // Run the existing emitted-contract parity assertions against this temporary build.
  const tempParityPath = path.join(buildRoot, 'scripts/check-emitted-contract-parity.mjs');
  await cp(path.join(packageRoot, 'scripts/check-emitted-contract-parity.mjs'), tempParityPath);
  run(process.execPath, [tempParityPath], { cwd: buildRoot });

  const packedManifest = {
    ...sourceManifest,
    dependencies: { ...sourceManifest.dependencies, zod: zodManifest.version },
    devDependencies: undefined,
    scripts: undefined,
    files: ['dist', 'dist-cjs'],
  };
  await writeFile(path.join(packRoot, 'package.json'), `${JSON.stringify(packedManifest, null, 2)}\n`);
  await cp(path.join(buildRoot, 'dist'), path.join(packRoot, 'dist'), { recursive: true });
  await cp(path.join(buildRoot, 'dist-cjs'), path.join(packRoot, 'dist-cjs'), { recursive: true });

  const packOutput = run('npm', ['pack', '--json', '--pack-destination', tempRoot], { cwd: packRoot, env: npmEnv });
  const packResult = JSON.parse(packOutput);
  assert.equal(packResult.length, 1, 'expected exactly one package tarball');
  const tarballPath = path.join(tempRoot, packResult[0].filename);
  // Keep this consumer smoke fully offline without depending on a populated
  // package-manager store: pack the exact locally installed runtime dependency beside
  // the package under test and install both explicit tarballs.
  const zodPackOutput = run('npm', ['pack', '--json', '--pack-destination', tempRoot], {
    cwd: path.join(sourceNodeModules, 'zod'),
    env: npmEnv,
  });
  const zodPackResult = JSON.parse(zodPackOutput);
  assert.equal(zodPackResult.length, 1, 'expected exactly one zod dependency tarball');
  const zodTarballPath = path.join(tempRoot, zodPackResult[0].filename);

  await mkdir(consumerRoot, { recursive: true });
  await writeFile(path.join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'audio-video-types-isolated-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@audio-video/types': `file:${tarballPath}`,
      zod: `file:${zodTarballPath}`,
    },
  }, null, 2)}\n`);
  const npmOptions = { cwd: consumerRoot, env: npmEnv };
  run('npm', ['cache', 'add', zodTarballPath], npmOptions);
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], npmOptions);

  await writeFile(path.join(consumerRoot, 'consumer.mjs'), `
    import assert from 'node:assert/strict';
    import * as root from '@audio-video/types';
    import * as contracts from '@audio-video/types/contracts';
    import * as production from '@audio-video/types/production';
    assert.equal(root.createAudioData(new ArrayBuffer(0)).sampleRate, 16000);
    assert.equal(contracts.MediaArtifactKindSchema.parse('AUDIO'), 'AUDIO');
    const sourceTime = contracts.SourcePresentationTimeSchema.parse({
      numerator: 45000, denominator: 90000, clockRef: 'source-pts-1',
    });
    assert.equal(sourceTime.denominator, 90000);
    assert.throws(() => contracts.SourcePresentationTimeSchema.parse({
      numerator: 1, denominator: 0, clockRef: 'source-pts-1',
    }));
    assert.throws(() => contracts.SourcePresentationTimeSchema.parse({
      numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1, clockRef: 'source-pts-1',
    }));
    assert.equal(production.OpaqueIdSchema.parse('scene-1'), 'scene-1');
    const requestFixture = { artifactId: 'source-1', idempotencyKey: 'idem-1' };
    assert.equal(contracts.TranscriptionRequestSchema.parse(requestFixture).idempotencyKey, 'idem-1');
    assert.throws(() => contracts.TranscriptionRequestSchema.parse({ artifactId: 'source-1' }));
    // This is a structural fixture for the result shape, not evidence of a provider effect.
    const resultFixture = {
      artifactId: 'source-1', transcriptArtifactId: 'transcript-1', text: 'fixture transcript',
      languageTag: 'en', confidence: 0.9, providerId: 'fixture-provider',
      modelId: 'fixture-model', modelVersion: 'fixture-v1', processingTimeMs: 1,
    };
    assert.equal(contracts.TranscriptionResultSchema.parse(resultFixture).text, 'fixture transcript');
    assert.throws(() => contracts.TranscriptionResultSchema.parse(requestFixture));
    assert.throws(() => contracts.TranscriptionRequestSchema.parse(resultFixture));
    const cancelledJob = contracts.MediaProcessingJobSchema.parse({
      id: 'job-1', tenantId: 'tenant-1', kind: 'TRANSCRIBE',
      createdAt: '2026-08-05T12:00:00.000Z', updatedAt: '2026-08-05T12:00:00.000Z',
      correlationId: 'correlation-1', inputArtifactIds: ['source-1'], outputArtifactIds: [],
      cancellable: true, retryable: false, state: 'CANCELLED', progress: 0,
      completedAt: '2026-08-05T12:00:00.000Z',
    });
    assert.equal(cancelledJob.state, 'CANCELLED');
    assert.equal(contracts.observeMediaJobState('CANCELLING').mappingDisposition, 'LEGACY_STATE_UNMAPPED');
    console.log('isolated ESM consumer imported all public package exports');
  `);
  await writeFile(path.join(consumerRoot, 'consumer.cjs'), `
    const assert = require('node:assert/strict');
    const root = require('@audio-video/types');
    const contracts = require('@audio-video/types/contracts');
    const production = require('@audio-video/types/production');
    assert.equal(root.createAudioData(new ArrayBuffer(0)).sampleRate, 16000);
    assert.equal(contracts.MediaArtifactKindSchema.parse('AUDIO'), 'AUDIO');
    const sourceTime = contracts.SourcePresentationTimeSchema.parse({
      numerator: 45000, denominator: 90000, clockRef: 'source-pts-1',
    });
    assert.equal(sourceTime.denominator, 90000);
    assert.throws(() => contracts.SourcePresentationTimeSchema.parse({
      numerator: 1, denominator: 0, clockRef: 'source-pts-1',
    }));
    assert.throws(() => contracts.SourcePresentationTimeSchema.parse({
      numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1, clockRef: 'source-pts-1',
    }));
    assert.equal(production.OpaqueIdSchema.parse('scene-1'), 'scene-1');
    const requestFixture = { artifactId: 'source-1', idempotencyKey: 'idem-1' };
    assert.equal(contracts.TranscriptionRequestSchema.parse(requestFixture).idempotencyKey, 'idem-1');
    assert.throws(() => contracts.TranscriptionRequestSchema.parse({ artifactId: 'source-1' }));
    // This is a structural fixture for the result shape, not evidence of a provider effect.
    const resultFixture = {
      artifactId: 'source-1', transcriptArtifactId: 'transcript-1', text: 'fixture transcript',
      languageTag: 'en', confidence: 0.9, providerId: 'fixture-provider',
      modelId: 'fixture-model', modelVersion: 'fixture-v1', processingTimeMs: 1,
    };
    assert.equal(contracts.TranscriptionResultSchema.parse(resultFixture).text, 'fixture transcript');
    assert.throws(() => contracts.TranscriptionResultSchema.parse(requestFixture));
    assert.throws(() => contracts.TranscriptionRequestSchema.parse(resultFixture));
    const cancelledJob = contracts.MediaProcessingJobSchema.parse({
      id: 'job-1', tenantId: 'tenant-1', kind: 'TRANSCRIBE',
      createdAt: '2026-08-05T12:00:00.000Z', updatedAt: '2026-08-05T12:00:00.000Z',
      correlationId: 'correlation-1', inputArtifactIds: ['source-1'], outputArtifactIds: [],
      cancellable: true, retryable: false, state: 'CANCELLED', progress: 0,
      completedAt: '2026-08-05T12:00:00.000Z',
    });
    assert.equal(cancelledJob.state, 'CANCELLED');
    assert.equal(contracts.observeMediaJobState('CANCELLING').mappingDisposition, 'LEGACY_STATE_UNMAPPED');
    console.log('isolated CJS consumer imported all public package exports');
  `);
  await writeFile(path.join(consumerRoot, 'consumer.ts'), `
    import { createAudioData, type AudioFormat } from '@audio-video/types';
    import {
      MediaArtifactKindSchema, SourcePresentationTimeSchema, type MediaArtifact,
      type SourcePresentationTime,
      type TranscriptionRequest, type TranscriptionResult,
    } from '@audio-video/types/contracts';
    import { StoryTimeSchema, type AnimationSpec } from '@audio-video/types/production';

    const format: AudioFormat = 'wav';
    const audio = createAudioData(new ArrayBuffer(0), { format });
    const kind: MediaArtifact['kind'] = MediaArtifactKindSchema.parse('AUDIO');
    const sourceTime: SourcePresentationTime = SourcePresentationTimeSchema.parse({
      numerator: 45000, denominator: 90000, clockRef: 'source-pts-1',
    });
    const story = StoryTimeSchema.parse({
      clockKind: 'story',
      clockId: 'clock-1',
      streamId: 'stream-1',
      originRef: 'origin-v1',
      ticks: '0',
      timeBase: { numerator: '1', denominator: '1000' },
    });
    const animation: AnimationSpec = {
      schemaVersion: 'media.declarative.value.animation-spec.v1',
      sceneGraphRef: 'scene-graph-v1',
      animationGraphRef: 'animation-graph-v1',
      operatorTreeRef: 'operator-tree-v1',
      assetsRef: 'assets-v1',
      propertyCurveRefs: [],
      tStoryRef: story,
      renderingRef: 'rendering-v1',
    };
    const request: TranscriptionRequest = {
      artifactId: 'source-1', punctuation: true, wordTimestamps: true,
      alternatives: 1, profanityPolicy: 'PRESERVE', idempotencyKey: 'idem-1',
    };
    const result: TranscriptionResult = {
      artifactId: 'source-1', transcriptArtifactId: 'transcript-1', text: 'fixture transcript',
      languageTag: 'en', confidence: 0.9, providerId: 'fixture-provider',
      words: [], alternatives: [], modelId: 'fixture-model', modelVersion: 'fixture-v1', processingTimeMs: 1,
    };
    void [audio, kind, sourceTime, animation, request, result];
  `);

  run(process.execPath, [path.join(consumerRoot, 'consumer.mjs')], { cwd: consumerRoot });
  run(process.execPath, [path.join(consumerRoot, 'consumer.cjs')], { cwd: consumerRoot });
  run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: consumerRoot });

  console.log(`Packed source-free ESM/CJS/types consumer passed (zod ${zodManifest.version})`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
