import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typesRoot = path.resolve(packageRoot, '../audio-video-types');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'audio-video-client-consumer-'));
const typePackRoot = path.join(tempRoot, 'type-pack');
const clientPackRoot = path.join(tempRoot, 'client-pack');
const consumerRoot = path.join(tempRoot, 'consumer');
const typeNodeModules = path.join(typesRoot, 'node_modules');
const tsc = path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');

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

function copyTree(source, destination) {
  return cp(source, destination, { recursive: true, force: true });
}

async function pack(root, manifest, destination) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const output = run('npm', ['pack', '--json', '--pack-destination', destination], { cwd: root });
  const result = JSON.parse(output);
  assert.equal(result.length, 1, 'expected one package tarball');
  return path.join(destination, result[0].filename);
}

try {
  const sourceClient = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const sourceTypes = JSON.parse(await readFile(path.join(typesRoot, 'package.json'), 'utf8'));
  const zodManifest = JSON.parse(await readFile(path.join(typeNodeModules, 'zod/package.json'), 'utf8'));

  await copyTree(path.join(typesRoot, 'dist'), path.join(typePackRoot, 'dist'));
  await copyTree(path.join(typesRoot, 'dist-cjs'), path.join(typePackRoot, 'dist-cjs'));
  const typesTarball = await pack(typePackRoot, {
    ...sourceTypes,
    dependencies: { ...sourceTypes.dependencies, zod: zodManifest.version },
    devDependencies: undefined,
    scripts: undefined,
  }, tempRoot);

  await copyTree(path.join(packageRoot, 'dist'), path.join(clientPackRoot, 'dist'));
  await copyTree(path.join(packageRoot, 'dist-cjs'), path.join(clientPackRoot, 'dist-cjs'));
  const clientTarball = await pack(clientPackRoot, {
    ...sourceClient,
    dependencies: { '@audio-video/types': sourceTypes.version },
    devDependencies: undefined,
    scripts: undefined,
  }, tempRoot);

  const consumerManifest = {
    name: 'audio-video-client-isolated-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@audio-video/client': `file:${clientTarball}`,
      '@audio-video/types': `file:${typesTarball}`,
    },
    pnpm: {
      overrides: { '@audio-video/types': `file:${typesTarball}` },
    },
  };
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(path.join(consumerRoot, 'package.json'), `${JSON.stringify(consumerManifest, null, 2)}\n`);
  run('pnpm', ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: consumerRoot });

  await writeFile(path.join(consumerRoot, 'consumer.mjs'), `
    import assert from 'node:assert/strict';
    import * as client from '@audio-video/client';
    import * as operations from '@audio-video/client/operations';
    import * as routes from '@audio-video/client/canonical-routes';
    import * as canonical from '@audio-video/client/canonical-operations';
    import * as http from '@audio-video/client/http-core';
    import * as capture from '@audio-video/client/capture-adapters';
    import * as recorder from '@audio-video/client/recorder-orchestrator';
    import * as production from '@audio-video/client/production-plan';
    import { MediaArtifactKindSchema } from '@audio-video/types/contracts';
    assert.equal(typeof client.createAudioVideoClient, 'function');
    assert.equal(typeof operations.createMediaOperationClient, 'function');
    assert.equal(typeof routes.canonicalMediaHttpRoutes, 'object');
    assert.equal(typeof canonical.createMediaCanonicalClient, 'function');
    assert.equal(typeof http.MediaHttpTransport, 'function');
    assert.equal(typeof capture.captureWithAdmission, 'function');
    assert.equal(typeof recorder.orchestrateScenario, 'function');
    assert.equal(typeof production.compileProductionPlan, 'function');
    assert.equal(MediaArtifactKindSchema.parse('AUDIO'), 'AUDIO');
  `);
  run(process.execPath, [path.join(consumerRoot, 'consumer.mjs')], { cwd: consumerRoot });

  await writeFile(path.join(consumerRoot, 'consumer.cjs'), `
    const assert = require('node:assert/strict');
    const client = require('@audio-video/client');
    const operations = require('@audio-video/client/operations');
    const routes = require('@audio-video/client/canonical-routes');
    const canonical = require('@audio-video/client/canonical-operations');
    const http = require('@audio-video/client/http-core');
    const capture = require('@audio-video/client/capture-adapters');
    const recorder = require('@audio-video/client/recorder-orchestrator');
    const production = require('@audio-video/client/production-plan');
    const contracts = require('@audio-video/types/contracts');
    assert.equal(typeof client.createAudioVideoClient, 'function');
    assert.equal(typeof operations.createMediaOperationClient, 'function');
    assert.equal(typeof routes.canonicalMediaHttpRoutes, 'object');
    assert.equal(typeof canonical.createMediaCanonicalClient, 'function');
    assert.equal(typeof http.MediaHttpTransport, 'function');
    assert.equal(typeof capture.captureWithAdmission, 'function');
    assert.equal(typeof recorder.orchestrateScenario, 'function');
    assert.equal(typeof production.compileProductionPlan, 'function');
    assert.equal(contracts.MediaArtifactKindSchema.parse('AUDIO'), 'AUDIO');
  `);
  run(process.execPath, [path.join(consumerRoot, 'consumer.cjs')], { cwd: consumerRoot });

  await writeFile(path.join(consumerRoot, 'consumer.ts'), `
    import { createMediaOperationClient } from '@audio-video/client/operations';
    import { compileProductionPlan, type CaptureSourceResolver } from '@audio-video/client/production-plan';
    import { MediaArtifactKindSchema } from '@audio-video/types/contracts';
    const create: typeof createMediaOperationClient = createMediaOperationClient;
    const compile: typeof compileProductionPlan = compileProductionPlan;
    const kind = MediaArtifactKindSchema.parse('AUDIO');
    const resolver: CaptureSourceResolver | undefined = undefined;
    void [create, compile, kind, resolver];
  `);
  run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: consumerRoot });

  const cli = path.join(consumerRoot, 'node_modules/@audio-video/client/dist/cli.js');
  const cliMode = (await stat(cli)).mode;
  assert.notEqual(cliMode & 0o111, 0, 'installed CLI entrypoint must remain executable');
  await access(path.join(consumerRoot, 'node_modules/.bin/ghatanamedia-api'), constants.X_OK);
  const cliResult = spawnSync(process.execPath, [cli, 'artifact', 'inspect', '--endpoint', 'http://127.0.0.1',
    '--tenant', 'fixture-tenant', '--principal', 'fixture-principal', '--artifact', 'fixture-artifact'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: '' },
  });
  assert.equal(cliResult.status, 2, 'CLI without an environment token should fail closed');
  const cliError = JSON.parse(cliResult.stderr.trim());
  assert.equal(cliError.code, 'MISSING_AUTH_TOKEN');
  assert.match(cliError.message, /environment/u);

  console.log(`Installed ESM/CJS/types consumers and CLI passed (zod ${zodManifest.version}).`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
