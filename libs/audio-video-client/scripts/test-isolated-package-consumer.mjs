import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const npmCache = path.join(tempRoot, 'npm-cache');
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

const npmOptions = (cwd) => ({
  cwd,
  env: { ...process.env, npm_config_cache: npmCache },
});

async function pack(root, manifest, destination) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const output = run('npm', ['pack', '--json', '--pack-destination', destination], npmOptions(root));
  const result = JSON.parse(output);
  assert.equal(result.length, 1, 'expected one package tarball');
  return path.join(destination, result[0].filename);
}

function assertSourceFreePackage(packResult, packageName) {
  const files = packResult.files.map(({ path: filePath }) => filePath);
  assert.ok(files.length > 0, `${packageName} tarball must contain files`);
  for (const filePath of files) {
    assert.match(filePath, /^(package\.json|dist\/|dist-cjs\/)/u,
      `${packageName} tarball must contain only package metadata and built output: ${filePath}`);
    assert.doesNotMatch(filePath, /(?:^|\/)(?:\.env|credentials?[^/]*|secrets?[^/]*)(?:\/|$)/iu,
      `${packageName} tarball must not contain credentials: ${filePath}`);
    assert.doesNotMatch(filePath, /\.(?:bin|onnx|safetensors|gguf|pt|pth|ckpt)$/iu,
      `${packageName} tarball must not bundle model weights: ${filePath}`);
  }
}

async function assertNoSensitiveLiterals(root, packageName) {
  const scan = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await scan(filePath));
      else files.push(filePath);
    }
    return files;
  };

  const leaks = [];
  for (const filePath of await scan(root)) {
    if (path.basename(filePath) === 'package.json') continue;
    const contents = await readFile(filePath, 'utf8');
    if (/Bearer\s+[A-Za-z0-9_-]{16,}/u.test(contents)
      || /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(contents)
      || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(contents)
      || /\b(?:\+?1[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]\d{3}[-. ]\d{4}\b/u.test(contents)) {
      leaks.push(path.relative(root, filePath));
    }
  }
  assert.deepEqual(leaks, [], `${packageName} packed output must not contain credentials or PII-like literals`);
}

try {
  const sourceClient = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const sourceTypes = JSON.parse(await readFile(path.join(typesRoot, 'package.json'), 'utf8'));
  const zodRoot = path.join(typeNodeModules, 'zod');
  const zodManifest = JSON.parse(await readFile(path.join(zodRoot, 'package.json'), 'utf8'));
  const zodTarball = path.join(tempRoot, 'zod-pack');
  await mkdir(zodTarball, { recursive: true });
  const zodPacked = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', zodTarball], npmOptions(zodRoot)));
  assert.equal(zodPacked.length, 1, 'expected one local zod dependency tarball');
  const zodPackage = path.join(zodTarball, zodPacked[0].filename);

  await copyTree(path.join(typesRoot, 'dist'), path.join(typePackRoot, 'dist'));
  await copyTree(path.join(typesRoot, 'dist-cjs'), path.join(typePackRoot, 'dist-cjs'));
  const typesTarball = await pack(typePackRoot, {
    ...sourceTypes,
    dependencies: { ...sourceTypes.dependencies, zod: `file:${zodPackage}` },
    devDependencies: undefined,
    scripts: undefined,
  }, tempRoot);
  assertSourceFreePackage(JSON.parse(run('npm', ['pack', '--json', '--dry-run'], npmOptions(typePackRoot)))[0], sourceTypes.name);
  await assertNoSensitiveLiterals(typePackRoot, sourceTypes.name);

  await copyTree(path.join(packageRoot, 'dist'), path.join(clientPackRoot, 'dist'));
  await copyTree(path.join(packageRoot, 'dist-cjs'), path.join(clientPackRoot, 'dist-cjs'));
  const clientTarball = await pack(clientPackRoot, {
    ...sourceClient,
    dependencies: { '@audio-video/types': sourceTypes.version },
    devDependencies: undefined,
    scripts: undefined,
  }, tempRoot);
  assertSourceFreePackage(JSON.parse(run('npm', ['pack', '--json', '--dry-run'], npmOptions(clientPackRoot)))[0], sourceClient.name);
  await assertNoSensitiveLiterals(clientPackRoot, sourceClient.name);

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
    import { DocumentIntelligenceSceneTextAdapter, SceneTextAdapterError,
      DOCUMENT_INTELLIGENCE_PROTOCOL_V1, DOCUMENT_INTELLIGENCE_WORKER_V1 } from '@audio-video/client';
    import { MediaArtifactKindSchema } from '@audio-video/types/contracts';
    assert.equal(typeof client.createAudioVideoClient, 'function');
    assert.equal(typeof operations.createMediaOperationClient, 'function');
    assert.equal(typeof routes.canonicalMediaHttpRoutes, 'object');
    assert.equal(typeof canonical.createMediaCanonicalClient, 'function');
    assert.equal(typeof http.MediaHttpTransport, 'function');
    assert.equal(typeof capture.captureWithAdmission, 'function');
    assert.equal(typeof recorder.orchestrateScenario, 'function');
    assert.equal(typeof production.compileProductionPlan, 'function');
    assert.equal(typeof DocumentIntelligenceSceneTextAdapter, 'function');
    assert.equal(typeof SceneTextAdapterError, 'function');
    assert.equal(MediaArtifactKindSchema.parse('AUDIO'), 'AUDIO');

    // Source-free DI client fixture: a non-admitted provider must remain a
    // typed pre-dispatch error through the installed package entrypoint.
    let parseCalled = false;
    const diAdapter = new DocumentIntelligenceSceneTextAdapter({
      lastProtocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
      lastWorkerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
      providers: async () => ({
        protocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
        workerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
        providers: [],
      }),
      parse: async () => { parseCalled = true; throw new Error('unexpected DI dispatch'); },
    }, {
      providerRef: 'fixture-provider', providerVersion: '1',
      modelRef: 'fixture-model', modelVersion: '1',
      acceptedMediaTypes: ['image/png'], acceptedLanguages: ['en'], timeoutMs: 1000,
      workerLimits: { maxPages: 1 },
    });
    await assert.rejects(diAdapter.recognizeFrame('fixture-operation', {
      sourceArtifactId: 'fixture-source', sourceVersion: 'v1', frameId: 'frame-1',
      timestampUs: 0, mediaType: 'image/png', languageHint: 'en', bytes: new Uint8Array([1]),
    }), (error) => error instanceof SceneTextAdapterError && error.code === 'PROVIDER_NOT_ADMITTED');
    assert.equal(parseCalled, false, 'non-admitted DI provider must not dispatch parse');

    // The published DI client error vocabulary is not available here. Even an
    // error-shaped rejection must therefore stay effect-ambiguous after parse
    // dispatch, with no provider detail crossing the installed Media seam.
    const parseFailure = Object.assign(new Error('sensitive provider timeout detail'), {
      code: 'ARBITRARY_FIXTURE_CODE', retryable: true, providerRef: 'fixture-provider',
    });
    const rejectingDiAdapter = new DocumentIntelligenceSceneTextAdapter({
      lastProtocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
      lastWorkerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
      providers: async () => ({
        protocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
        workerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
        providers: [{
          providerRef: 'fixture-provider', providerVersion: '1',
          modelRef: 'fixture-model', modelVersion: '1',
          mediaTypes: ['image/png'], supportedLanguages: ['en'],
          promotionStatus: 'ACCEPTED', loaded: true, ready: true,
        }],
      }),
      parse: async () => { throw parseFailure; },
    }, {
      providerRef: 'fixture-provider', providerVersion: '1',
      modelRef: 'fixture-model', modelVersion: '1',
      acceptedMediaTypes: ['image/png'], acceptedLanguages: ['en'], timeoutMs: 1000,
      workerLimits: { maxPages: 1 },
    });
    await assert.rejects(rejectingDiAdapter.recognizeFrame('fixture-operation', {
      sourceArtifactId: 'fixture-source', sourceVersion: 'v1', frameId: 'frame-1',
      timestampUs: 0, mediaType: 'image/png', languageHint: 'en', bytes: new Uint8Array([1]),
    }), (error) => error instanceof SceneTextAdapterError && error.code === 'OUTCOME_UNKNOWN'
      && error.message === 'Scene-text adapter rejected the operation: OUTCOME_UNKNOWN'
      && !error.message.includes('sensitive provider timeout detail'));

    // Synthetic read fixture: exercise the installed, source-free package runtime
    // through the existing canonical GET and its injected fetch implementation.
    const timestamp = '2026-10-30T12:00:00.000Z';
    const fixtureJob = {
      jobId: 'job-installed-42', requestId: 'request-installed-42',
      tenantId: 'fixture-tenant', principalId: 'fixture-principal', artifactId: 'artifact-installed-42',
      jobType: 'SPEECH_TO_TEXT', providerId: 'fixture-provider', status: 'RUNNING',
      createdAt: timestamp, startedAt: timestamp, completedAt: null, result: {}, failureCode: null,
      version: 3, expectedArtifactVersion: '', requestFingerprint: 'sha256:' + 'b'.repeat(64),
    };
    const requests = [];
    const readClient = canonical.createMediaCanonicalClient({
      baseUrl: 'https://media.example.test', tenantId: 'fixture-tenant',
      defaultHeaders: { 'X-Principal-Id': 'fixture-principal' },
      getAccessToken: () => 'installed-read-fixture-token',
      fetchImpl: async (input, init) => {
        requests.push({ url: new URL(String(input)).pathname, method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(JSON.stringify(fixtureJob), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const readJob = await readClient.getJob('job-installed-42');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, '/api/v1/jobs/job-installed-42');
    assert.equal(requests[0].headers.authorization, 'Bearer installed-read-fixture-token');
    assert.equal(requests[0].headers['x-tenant-id'], 'fixture-tenant');
    assert.equal(requests[0].headers['x-principal-id'], 'fixture-principal');
    assert.deepEqual(readJob, fixtureJob, 'installed canonical getJob must parse the synthetic HTTP response');

    const wrongScopeClient = canonical.createMediaCanonicalClient({
      baseUrl: 'https://media.example.test', tenantId: 'fixture-tenant',
      defaultHeaders: { 'X-Principal-Id': 'fixture-principal' },
      getAccessToken: () => 'installed-read-fixture-token',
      fetchImpl: async () => new Response(JSON.stringify({ ...fixtureJob, tenantId: 'other-tenant' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    await assert.rejects(wrongScopeClient.getJob('job-installed-42'), /outside the caller's tenant and principal scope/u);
  `);
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
    import type * as main from '@audio-video/client';
    import { createMediaOperationClient } from '@audio-video/client/operations';
    import type * as operations from '@audio-video/client/operations';
    import type * as routes from '@audio-video/client/canonical-routes';
    import type * as canonical from '@audio-video/client/canonical-operations';
    import type * as http from '@audio-video/client/http-core';
    import type * as capture from '@audio-video/client/capture-adapters';
    import type * as recorder from '@audio-video/client/recorder-orchestrator';
    import type * as productionExports from '@audio-video/client/production-plan';
    import { compileProductionPlan, type CaptureSourceResolver } from '@audio-video/client/production-plan';
    import type { SceneTextAdapterErrorCode } from '@audio-video/client';
    import { MediaArtifactKindSchema } from '@audio-video/types/contracts';
    const create: typeof createMediaOperationClient = createMediaOperationClient;
    const compile: typeof compileProductionPlan = compileProductionPlan;
    const publicExportTypes: [typeof main, typeof operations, typeof routes, typeof canonical,
      typeof http, typeof capture, typeof recorder, typeof productionExports] = null!;
    const kind = MediaArtifactKindSchema.parse('AUDIO');
    const resolver: CaptureSourceResolver | undefined = undefined;
    const diErrorCodes = [
      'SOURCE_IDENTITY_INVALID', 'SOURCE_PAYLOAD_INVALID', 'SOURCE_MEDIA_TYPE_NOT_ADMITTED',
      'SOURCE_LANGUAGE_NOT_ADMITTED', 'PROVIDER_CATALOG_UNAVAILABLE', 'CLIENT_PROTOCOL_MISMATCH',
      'WORKER_VERSION_NOT_ADMITTED',
      'PROVIDER_NOT_ADMITTED', 'PROVIDER_VERSION_MISMATCH', 'RESPONSE_IDENTITY_MISMATCH',
      'PAGE_SCOPE_UNSUPPORTED', 'MODEL_IDENTITY_MISSING', 'MODEL_VERSION_MISMATCH',
      'RESULT_GEOMETRY_INVALID', 'RESULT_CONFIDENCE_MISSING', 'RESULT_SHAPE_UNSUPPORTED',
      'OUTCOME_UNKNOWN', 'REQUEST_ABORTED',
    ] as const satisfies readonly SceneTextAdapterErrorCode[];
    type MissingDiErrorCode = Exclude<SceneTextAdapterErrorCode, typeof diErrorCodes[number]>;
    const diVocabularyIsExhaustive: MissingDiErrorCode extends never ? true : never = true;
    void [create, compile, kind, resolver, publicExportTypes, diVocabularyIsExhaustive];
  `);
  run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: consumerRoot });
  run(process.execPath, [path.join(consumerRoot, 'consumer.mjs')], { cwd: consumerRoot });

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

  const token = 'installed-consumer-secret-do-not-print';
  const args = ['artifact', 'inspect', '--endpoint', 'http://127.0.0.1:1', '--tenant', 'fixture-tenant',
    '--principal', 'fixture-principal', '--artifact', 'fixture-artifact'];
  const trustedResult = spawnSync(process.execPath, [cli, ...args], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: token },
  });
  assert.equal(trustedResult.status, 1, 'loopback HTTP must pass endpoint admission and attempt a read');
  assert.equal(JSON.parse(trustedResult.stderr.trim()).code, 'OBSERVATION_UNAVAILABLE');
  assert.equal(trustedResult.stdout, '');
  assert.equal((trustedResult.stdout + trustedResult.stderr).includes(token), false,
    'installed CLI must not expose the credential on transport failure');

  const untrustedArgs = [...args];
  untrustedArgs[3] = 'http://media.example.test';
  const untrustedResult = spawnSync(process.execPath, [cli, ...untrustedArgs], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: token },
  });
  assert.equal(untrustedResult.status, 2);
  assert.equal(JSON.parse(untrustedResult.stderr.trim()).code, 'INVALID_ENDPOINT');
  assert.equal(untrustedResult.stdout, '');
  assert.equal((untrustedResult.stdout + untrustedResult.stderr).includes(token), false,
    'installed CLI must not expose the credential while rejecting an endpoint');

  const ipv6Loopback = [...args];
  ipv6Loopback[3] = 'http://[::1]:1';
  const ipv6LoopbackResult = spawnSync(process.execPath, [cli, ...ipv6Loopback], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: token },
  });
  assert.equal(ipv6LoopbackResult.status, 1, 'installed CLI must admit IPv6 loopback HTTP for local testing');
  assert.equal(JSON.parse(ipv6LoopbackResult.stderr.trim()).code, 'OBSERVATION_UNAVAILABLE');

  for (const endpoint of [
    'https://user:password@media.example.test',
    'https://media.example.test?access_token=do-not-forward',
    'https://media.example.test#fragment',
    'https://media.example.test/%2F..%2Fprivate',
  ]) {
    const endpointArgs = [...args];
    endpointArgs[3] = endpoint;
    const rejected = spawnSync(process.execPath, [cli, ...endpointArgs], {
      cwd: consumerRoot,
      encoding: 'utf8',
      env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: token },
    });
    assert.equal(rejected.status, 2, `installed CLI must reject untrusted endpoint ${endpoint}`);
    assert.equal(JSON.parse(rejected.stderr.trim()).code, 'INVALID_ENDPOINT');
    assert.equal(rejected.stdout, '');
    assert.equal((rejected.stdout + rejected.stderr).includes(token), false,
      'installed CLI must not expose credentials during endpoint validation');
  }

  console.log(`Installed ESM/CJS/types consumers, injected-fetch job-read and wrong-scope fixtures, packed-output credential/PII scan, and trusted URL/credential CLI admission checks passed (zod ${zodManifest.version}).`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
