import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  assert.deepEqual(sourceClient.bin, {
    'ghatanamedia-api': './dist/cli.js',
    'ghatanamedia-api-dev': './dist/cli-dev.js',
  }, 'the published production and local-development executables must remain distinct');
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
  for (const outputPath of ['dist/caption-version.js', 'dist-cjs/caption-version.js']) {
    const output = await readFile(path.join(clientPackRoot, outputPath), 'utf8');
    assert.doesNotMatch(output, /(?:from\s*|require\s*\()\s*['"](?:node:)?(?:crypto|buffer|process)['"]/u,
      `${outputPath} must not import Node-only modules`);
  }
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
    import * as offlineStore from '@audio-video/client/offline-edit-store';
    import * as devProjects from '@audio-video/client/dev-project-timeline';
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
    assert.equal(typeof offlineStore.IndexedDbOfflineEditStore, 'function');
    assert.equal(typeof offlineStore.IndexedDbOfflineEditStoreError, 'function');
    assert.equal(typeof devProjects.MediaDevProjectTimelineClient, 'function');
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

    const devProjectRequests = [];
    const devContextFixture = {
      tenantId: 'fixture-tenant', principalId: 'fixture-principal',
      selectedAuthorizedWorkspaceId: 'dev-workspace.fixture-owner',
      workspaceName: 'Private DEV_ONLY workspace',
      authority: 'synthetic-local-owner-scope; no Shared membership or production authority',
      capabilities: { artifactUpload: false, artifactRead: false },
      scope: 'DEV_ONLY',
    };
    const devInitialRevision = {
      tenantId: 'fixture-tenant', projectId: 'dev-project-1', revisionId: 'dev-revision-0',
      parentRevisionId: null, timelines: [],
    };
    const devTimelineRevision = {
      tenantId: 'fixture-tenant', projectId: 'dev-project-1', revisionId: 'dev-revision-1',
      parentRevisionId: 'dev-revision-0', timelines: [{
        semanticVersionId: 'semantic-v1',
        graph: { timelineId: 'main', scenes: [], tracks: [], clips: [] },
      }],
    };
    let devHead = devInitialRevision;
    const devProjectFixture = {
      tenantId: 'fixture-tenant', projectId: 'dev-project-1',
      workspaceId: devContextFixture.selectedAuthorizedWorkspaceId, ownerPrincipalId: 'fixture-principal',
      title: 'Packed local project', headRevisionId: devInitialRevision.revisionId,
    };
    const devProjectClient = new devProjects.MediaDevProjectTimelineClient({
      baseUrl: 'http://127.0.0.1:8093', bearerToken: () => 'packed-dev-only-token',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        devProjectRequests.push({ method: init?.method, path: url.pathname, body, init });
        let value;
        if (init?.method === 'GET' && url.pathname === '/dev/v1/context') value = devContextFixture;
        else if (init?.method === 'POST' && url.pathname === '/dev/v1/projects') {
          value = { project: devProjectFixture, initialRevision: devInitialRevision, createdNow: true, scope: 'DEV_ONLY' };
        } else if (init?.method === 'POST' && url.pathname === '/dev/v1/projects/dev-project-1/timelines') {
          devHead = devTimelineRevision;
          value = { revision: devTimelineRevision, scope: 'DEV_ONLY' };
        } else if (init?.method === 'GET' && url.pathname === '/dev/v1/projects/dev-project-1') {
          value = { project: { ...devProjectFixture, headRevisionId: devHead.revisionId }, currentRevision: devHead, scope: 'DEV_ONLY' };
        } else if (init?.method === 'GET'
          && url.pathname === '/dev/v1/projects/dev-project-1/revisions/dev-revision-0') {
          value = { revision: devInitialRevision, scope: 'DEV_ONLY' };
        } else throw new Error('Unexpected DEV_ONLY request: ' + init?.method + ' ' + url.pathname);
        return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    const devContext = await devProjectClient.getContext();
    const devCreated = await devProjectClient.createProject({
      selectedAuthorizedWorkspaceId: devContext.selectedAuthorizedWorkspaceId,
      title: 'Packed local project', requestId: 'packed-create-1',
    });
    const devTimeline = await devProjectClient.createTimeline(devCreated.project.projectId, {
      expectedHeadRevisionId: devCreated.initialRevision.revisionId, timelineId: 'main',
    });
    const devReopened = await devProjectClient.getProject(devCreated.project.projectId);
    const devExact = await devProjectClient.getRevision(devCreated.project.projectId,
      devCreated.initialRevision.revisionId);
    assert.equal(devContext.scope, 'DEV_ONLY');
    assert.deepEqual(devContext.capabilities, { artifactUpload: false, artifactRead: false });
    assert.equal(devCreated.project.projectId, 'dev-project-1');
    assert.equal(devTimeline.revision.timelines[0].graph.timelineId, 'main');
    assert.equal(devReopened.currentRevision.revisionId, 'dev-revision-1');
    assert.deepEqual(devExact.revision.timelines, []);
    assert.deepEqual(devProjectRequests.map(({ method, path: requestPath }) => [method, requestPath]), [
      ['GET', '/dev/v1/context'],
      ['POST', '/dev/v1/projects'],
      ['POST', '/dev/v1/projects/dev-project-1/timelines'],
      ['GET', '/dev/v1/projects/dev-project-1'],
      ['GET', '/dev/v1/projects/dev-project-1/revisions/dev-revision-0'],
    ]);
    assert.equal(devProjectRequests[0].init.headers.Authorization, 'Bearer packed-dev-only-token');
    assert.equal(devProjectRequests[0].init.credentials, 'omit');
    assert.equal(devProjectRequests[0].init.redirect, 'error');
    assert.equal(devProjectRequests[1].body.requestId, 'packed-create-1');
    assert.equal(devProjectRequests[2].body.expectedHeadRevisionId, 'dev-revision-0');

    // The caption-version subpath is a browser-host entrypoint. Import it only
    // after removing Node globals and verify its synchronous wire fingerprint.
    const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    try {
      Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });
      Object.defineProperty(globalThis, 'Buffer', { configurable: true, value: undefined });
      const captionVersion = await import('@audio-video/client/caption-version');
      assert.equal(typeof captionVersion.httpCaptionVersionTransport, 'function');
      assert.equal(captionVersion.requestFingerprint('t', 'p', {
        requestId: 'r', sourceArtifactId: 'a', sourceArtifactVersionId: 'av',
        parentVersionKind: 'TRANSCRIPT_VERSION', parentVersionId: 'pv', sourceClockId: 'c',
        ticksPerSecond: 1, sourceDurationTicks: 10, languageDisposition: 'NOT_SELECTED',
        captionSegments: [{ segmentId: 's', text: 'x', startTick: 0, endTick: 1, origin: 'USER_EDITED' }],
      }), 'b3b87f7127f7f20bc96e8c1c9dc53488b0138897f5b419b3a3f88a6abf2689ec');
    } finally {
      if (processDescriptor) Object.defineProperty(globalThis, 'process', processDescriptor);
      else Reflect.deleteProperty(globalThis, 'process');
      if (bufferDescriptor) Object.defineProperty(globalThis, 'Buffer', bufferDescriptor);
      else Reflect.deleteProperty(globalThis, 'Buffer');
    }
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
    const offlineStore = require('@audio-video/client/offline-edit-store');
    const devProjects = require('@audio-video/client/dev-project-timeline');
    const captionVersion = require('@audio-video/client/caption-version');
    const contracts = require('@audio-video/types/contracts');
    assert.equal(typeof client.createAudioVideoClient, 'function');
    assert.equal(typeof operations.createMediaOperationClient, 'function');
    assert.equal(typeof routes.canonicalMediaHttpRoutes, 'object');
    assert.equal(typeof canonical.createMediaCanonicalClient, 'function');
    assert.equal(typeof http.MediaHttpTransport, 'function');
    assert.equal(typeof capture.captureWithAdmission, 'function');
    assert.equal(typeof recorder.orchestrateScenario, 'function');
    assert.equal(typeof production.compileProductionPlan, 'function');
    assert.equal(typeof offlineStore.IndexedDbOfflineEditStore, 'function');
    assert.equal(typeof offlineStore.IndexedDbOfflineEditStoreError, 'function');
    assert.equal(typeof devProjects.MediaDevProjectTimelineClient, 'function');
    assert.equal(typeof captionVersion.requestFingerprint, 'function');
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
    import { MediaDevProjectTimelineClient } from '@audio-video/client/dev-project-timeline';
    import type { DevProjectContext, DevProjectTimelineClientOptions, CreateDevProjectRequest } from '@audio-video/client/dev-project-timeline';
    import type * as captionVersion from '@audio-video/client/caption-version';
    import { requestFingerprint } from '@audio-video/client/caption-version';
    import { IndexedDbOfflineEditStore, type IndexedDbOfflineEditStoreOptions } from '@audio-video/client/offline-edit-store';
    import { compileProductionPlan, type CaptureSourceResolver } from '@audio-video/client/production-plan';
    import type { SceneTextAdapterErrorCode } from '@audio-video/client';
    import { MediaArtifactKindSchema } from '@audio-video/types/contracts';
    const create: typeof createMediaOperationClient = createMediaOperationClient;
    const compile: typeof compileProductionPlan = compileProductionPlan;
    const offlineStoreConstructor: typeof IndexedDbOfflineEditStore = IndexedDbOfflineEditStore;
    const offlineStoreOptions: IndexedDbOfflineEditStoreOptions | undefined = undefined;
    const devProjectClient: typeof MediaDevProjectTimelineClient = MediaDevProjectTimelineClient;
    const devProjectOptions: DevProjectTimelineClientOptions | undefined = undefined;
    const devProjectRequest: CreateDevProjectRequest | undefined = undefined;
    const devProjectContext: DevProjectContext | undefined = undefined;
    const publicExportTypes: [typeof main, typeof operations, typeof routes, typeof canonical,
      typeof http, typeof capture, typeof recorder, typeof productionExports] = null!;
    const fingerprint: typeof requestFingerprint = requestFingerprint;
    const captionVersionExports: typeof captionVersion = null!;
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
    void [create, compile, kind, resolver, publicExportTypes, offlineStoreConstructor,
      offlineStoreOptions, devProjectClient, devProjectOptions, devProjectRequest, devProjectContext,
      diVocabularyIsExhaustive, fingerprint, captionVersionExports];
  `);
  run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: consumerRoot });
  await writeFile(path.join(consumerRoot, 'consumer.cts'), `
    import client = require('@audio-video/client');
    import operations = require('@audio-video/client/operations');
    import routes = require('@audio-video/client/canonical-routes');
    import canonical = require('@audio-video/client/canonical-operations');
    import http = require('@audio-video/client/http-core');
    import capture = require('@audio-video/client/capture-adapters');
    import recorder = require('@audio-video/client/recorder-orchestrator');
    import production = require('@audio-video/client/production-plan');
    import offlineStore = require('@audio-video/client/offline-edit-store');
    import devProjects = require('@audio-video/client/dev-project-timeline');
    import captionVersion = require('@audio-video/client/caption-version');
    import type { IndexedDbOfflineEditStoreOptions } from '@audio-video/client/offline-edit-store';
    import type { DevProjectContext, DevProjectTimelineClientOptions } from '@audio-video/client/dev-project-timeline';
    import types = require('@audio-video/types/contracts');
    const createClient: typeof client.createAudioVideoClient = client.createAudioVideoClient;
    const createOperationClient: typeof operations.createMediaOperationClient = operations.createMediaOperationClient;
    const routeTable: typeof routes.canonicalMediaHttpRoutes = routes.canonicalMediaHttpRoutes;
    const createCanonicalClient: typeof canonical.createMediaCanonicalClient = canonical.createMediaCanonicalClient;
    const transport: typeof http.MediaHttpTransport = http.MediaHttpTransport;
    const captureWithAdmission: typeof capture.captureWithAdmission = capture.captureWithAdmission;
    const orchestrate: typeof recorder.orchestrateScenario = recorder.orchestrateScenario;
    const compilePlan: typeof production.compileProductionPlan = production.compileProductionPlan;
    const indexedDbStore: typeof offlineStore.IndexedDbOfflineEditStore = offlineStore.IndexedDbOfflineEditStore;
    const devProjectClient: typeof devProjects.MediaDevProjectTimelineClient = devProjects.MediaDevProjectTimelineClient;
    const devProjectOptions: DevProjectTimelineClientOptions | undefined = undefined;
    const devProjectContext: DevProjectContext | undefined = undefined;
    const storeOptions: IndexedDbOfflineEditStoreOptions | undefined = undefined;
    const fingerprint: typeof captionVersion.requestFingerprint = captionVersion.requestFingerprint;
    const kind: typeof types.MediaArtifactKindSchema = types.MediaArtifactKindSchema;
    void [createClient, createOperationClient, routeTable, createCanonicalClient, transport,
      captureWithAdmission, orchestrate, compilePlan, indexedDbStore, storeOptions, devProjectClient,
      devProjectOptions, devProjectContext, kind, fingerprint];
  `);
  run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.cts'], { cwd: consumerRoot });
  run(process.execPath, [path.join(consumerRoot, 'consumer.mjs')], { cwd: consumerRoot });

  const cli = path.join(consumerRoot, 'node_modules/@audio-video/client/dist/cli.js');
  const cliMode = (await stat(cli)).mode;
  assert.notEqual(cliMode & 0o111, 0, 'installed CLI entrypoint must remain executable');
  await access(path.join(consumerRoot, 'node_modules/.bin/ghatanamedia-api'), constants.X_OK);
  const cliDev = path.join(consumerRoot, 'node_modules/@audio-video/client/dist/cli-dev.js');
  const cliDevMode = (await stat(cliDev)).mode;
  assert.notEqual(cliDevMode & 0o111, 0, 'installed local-development CLI entrypoint must remain executable');
  await access(path.join(consumerRoot, 'node_modules/.bin/ghatanamedia-api-dev'), constants.X_OK);
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  const devClaims = {
    sub: 'fixture-principal', tenant_id: 'fixture-tenant',
    iss: 'urn:ghatana:media:dev-only', aud: 'ghatana-media-dev', dev_only: true,
    iat: nowSeconds, exp: nowSeconds + 120,
    permissions: ['media:artifact:create', 'media:artifact:read', 'media:artifact:write',
      'media:job:read', 'media:job:cancel'],
  };
  // This token-shaped fixture reaches an injected-fetch fixture only; the real
  // local host remains responsible for verifying signed DEV_ONLY identity.
  const devToken = `test.${Buffer.from(JSON.stringify(devClaims)).toString('base64url')}.fixture`;
  const uploadDevClaims = { ...devClaims, sub: 'principal-a', tenant_id: 'tenant-a' };
  const uploadDevToken = `test.${Buffer.from(JSON.stringify(uploadDevClaims)).toString('base64url')}.fixture`;
  const cliArtifact = {
    tenantId: 'fixture-tenant', principalId: 'fixture-principal', artifactId: 'fixture-artifact',
    fileName: 'fixture.wav', contentType: 'audio/wav', sizeBytes: 42, sha256: 'a'.repeat(64),
    objectReference: 'opaque://fixture/artifact', classification: 'INTERNAL',
    createdAt: '2026-10-30T12:00:00.000Z', expiresAt: '2026-11-30T12:00:00.000Z',
    metadata: { purpose: 'packed-cli-inspect' },
  };
  const cliJob = {
    jobId: 'fixture-job', requestId: 'fixture-job-request',
    tenantId: 'fixture-tenant', principalId: 'fixture-principal', artifactId: 'fixture-artifact',
    jobType: 'SPEECH_TO_TEXT', providerId: 'fixture-provider', status: 'RUNNING',
    createdAt: '2026-10-30T12:00:00.000Z', startedAt: '2026-10-30T12:00:01.000Z',
    completedAt: null, result: {}, failureCode: null, version: 3,
    expectedArtifactVersion: '', requestFingerprint: 'sha256:' + 'b'.repeat(64),
  };
  const cliFetchFixture = path.join(packageRoot, 'src/__fixtures__/cli-fetch.mjs');
  const cliRequestLog = path.join(consumerRoot, 'cli-requests.jsonl');
  const unsupportedCommandArgs = [
    ['artifact', 'upload-inspect', '--upload', 'fixture-upload'],
    ['artifact', 'upload', '--file', '/not-read-before-cli-admission', '--content-type', 'audio/wav',
      '--classification', 'INTERNAL', '--retention', 'P30D', '--idempotency-key', 'upload-request'],
    ['job', 'get', '--job', 'fixture-job'],
    ['job', 'cancel', '--job', 'fixture-job', '--request-id', 'cancel-request'],
    ['job', 'submit', '--artifact', 'fixture-artifact', '--job-type', 'SPEECH_TO_TEXT',
      '--request-id', 'request-fixture', '--correlation-id', 'correlation-fixture',
      '--idempotency-key', 'job-fixture'],
  ];
  for (const commandArgs of unsupportedCommandArgs) {
    const args = [...commandArgs, '--endpoint', 'http://127.0.0.1:1',
      '--tenant', 'fixture-tenant', '--principal', 'fixture-principal'];
    for (const bearerToken of [token, '']) {
      const rejected = spawnSync(process.execPath, ['--import', cliFetchFixture, cli, ...args], {
        cwd: consumerRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GHATANA_MEDIA_BEARER_TOKEN: bearerToken,
          GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'success',
          GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
          GHATANA_MEDIA_CLI_TEST_LOG: cliRequestLog,
        },
      });
      assert.equal(rejected.status, 2, `${commandArgs.slice(0, 2).join(' ')} must be rejected as an invalid invocation`);
      assert.equal(rejected.stdout, '', `${commandArgs.slice(0, 2).join(' ')} must not write stdout`);
      const error = JSON.parse(rejected.stderr.trim());
      assert.equal(error.code, 'INVALID_INVOCATION');
      assert.equal(error.commandId, 'media.cli.invocation');
      assert.match(error.message, /Usage: ghatanamedia-api artifact inspect --endpoint/u);
      assert.doesNotMatch(error.message, /artifact upload-inspect|job submit/u);
      assert.equal((rejected.stdout + rejected.stderr).includes(token), false,
        `${commandArgs.slice(0, 2).join(' ')} must not expose credentials`);
    }
  }
  try {
    await access(cliRequestLog, constants.F_OK);
    assert.fail('unsupported packed CLI commands must not dispatch fetch');
  } catch (error) {
    assert.equal(error.code, 'ENOENT', 'unsupported packed CLI commands must leave no fetch log');
  }

  const devInspectArgs = ['artifact', 'inspect', '--endpoint', 'http://127.0.0.1:1',
    '--tenant', 'fixture-tenant', '--principal', 'fixture-principal', '--artifact', 'fixture-artifact'];
  const missingDevTokenResult = spawnSync(process.execPath, [cliDev, ...devInspectArgs], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: '' },
  });
  assert.equal(missingDevTokenResult.status, 2, 'local-development commands require an environment token');
  assert.equal(JSON.parse(missingDevTokenResult.stderr.trim()).code, 'MISSING_AUTH_TOKEN');

  const devRequestLog = path.join(consumerRoot, 'cli-dev-requests.jsonl');
  const remoteEndpointResult = spawnSync(process.execPath, ['--import', cliFetchFixture, cliDev,
    'artifact', 'inspect', '--endpoint', 'https://media.example.test', '--tenant', 'fixture-tenant',
    '--principal', 'fixture-principal', '--artifact', 'fixture-artifact'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: devToken,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: devToken,
      GHATANA_MEDIA_CLI_TEST_LOG: devRequestLog,
    },
  });
  assert.equal(remoteEndpointResult.status, 3, 'local-development commands must reject remote hosts');
  assert.equal(JSON.parse(remoteEndpointResult.stderr.trim()).code, 'LOCAL_DEV_ENDPOINT_REQUIRED');
  assert.equal(remoteEndpointResult.stdout, '');

  const devCancelRequestLog = path.join(consumerRoot, 'cli-dev-cancel-requests.jsonl');
  const devCancelResult = spawnSync(process.execPath, ['--import', cliFetchFixture, cliDev,
    'job', 'cancel', '--endpoint', 'http://127.0.0.1:1', '--tenant', 'fixture-tenant',
    '--principal', 'fixture-principal', '--job', 'fixture-job', '--request-id', 'cancel-request',
    '--expected-version', '3'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: devToken,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'job-get-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: devToken,
      GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(cliJob),
      GHATANA_MEDIA_CLI_TEST_LOG: devCancelRequestLog,
    },
  });
  assert.equal(devCancelResult.status, 0, 'installed local-development CLI must use the scoped DEV_ONLY cancellation route');
  assert.equal(JSON.parse(devCancelResult.stdout.trim()).cancellation.outcome, 'UNSUPPORTED');
  assert.equal(JSON.parse(devCancelResult.stdout.trim()).cancellation.requestId, 'cancel-request');
  const devCancelRequests = (await readFile(devCancelRequestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(devCancelRequests.length, 1);
  assert.equal(devCancelRequests[0].path, '/dev/v1/jobs/fixture-job/cancel');
  assert.equal(devCancelRequests[0].method, 'POST');
  assert.equal(devCancelRequests[0].bearerMatches, true);
  assert.equal((devCancelResult.stdout + devCancelResult.stderr).includes(devToken), false);
  try {
    await access(devRequestLog, constants.F_OK);
    assert.fail('remote-host preflight rejection must not dispatch fetch');
  } catch (error) {
    assert.equal(error.code, 'ENOENT', 'remote-host preflight rejection must leave no fetch log');
  }

  const packedDevInspectLog = path.join(consumerRoot, 'packed-dev-inspect.jsonl');
  const packedDevInspect = spawnSync(process.execPath, ['--import', cliFetchFixture, cliDev, ...devInspectArgs], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: devToken,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: devToken,
      GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(cliArtifact),
      GHATANA_MEDIA_CLI_TEST_LOG: packedDevInspectLog,
    },
  });
  assert.equal(packedDevInspect.status, 0, 'installed local-development CLI must return a loopback artifact observation');
  assert.equal(packedDevInspect.stderr, '');
  assert.deepEqual(JSON.parse(packedDevInspect.stdout.trim()), {
    schemaVersion: 'media.cli-result.v1',
    commandId: 'media.cli.local-development.artifact.inspect',
    artifact: cliArtifact,
  });
  const packedDevInspectRequests = (await readFile(packedDevInspectLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(packedDevInspectRequests.length, 1);
  assert.deepEqual({
    path: packedDevInspectRequests[0].path,
    method: packedDevInspectRequests[0].method,
    tenant: packedDevInspectRequests[0].tenant,
    principal: packedDevInspectRequests[0].principal,
    authenticated: packedDevInspectRequests[0].authenticated,
    bearerMatches: packedDevInspectRequests[0].bearerMatches,
    redirect: packedDevInspectRequests[0].redirect,
  }, {
    path: '/api/v1/artifacts/fixture-artifact', method: 'GET',
    tenant: 'fixture-tenant', principal: 'fixture-principal',
    authenticated: true, bearerMatches: true, redirect: 'error',
  });
  assert.equal((packedDevInspect.stdout + packedDevInspect.stderr).includes(devToken), false);

  const packedDevJobLog = path.join(consumerRoot, 'packed-dev-job.jsonl');
  const packedDevJob = spawnSync(process.execPath, ['--import', cliFetchFixture, cliDev,
    'job', 'get', '--endpoint', 'http://127.0.0.1:8093', '--tenant', 'fixture-tenant',
    '--principal', 'fixture-principal', '--job', 'fixture-job', '--request-id', 'fixture-job-request'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: devToken,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'job-get-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: devToken,
      GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(cliJob),
      GHATANA_MEDIA_CLI_TEST_LOG: packedDevJobLog,
    },
  });
  assert.equal(packedDevJob.status, 0, 'installed local-development CLI must return a request-bound job observation');
  assert.deepEqual(JSON.parse(packedDevJob.stdout.trim()), {
    schemaVersion: 'media.cli-result.v1',
    commandId: 'media.cli.local-development.job.get', job: cliJob,
  });
  const packedDevJobRequests = (await readFile(packedDevJobLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(packedDevJobRequests.length, 1);
  assert.equal(packedDevJobRequests[0].path, '/api/v1/jobs/fixture-job');
  assert.equal(packedDevJobRequests[0].search, '?requestId=fixture-job-request');
  assert.equal(packedDevJobRequests[0].method, 'GET');
  assert.equal(packedDevJobRequests[0].tenant, 'fixture-tenant');
  assert.equal(packedDevJobRequests[0].principal, 'fixture-principal');
  assert.equal(packedDevJobRequests[0].bearerMatches, true);
  assert.equal(packedDevJobRequests[0].redirect, 'error');
  assert.equal((packedDevJob.stdout + packedDevJob.stderr).includes(devToken), false);

  const packedDevMalformedJobLog = path.join(consumerRoot, 'packed-dev-malformed-job.jsonl');
  const packedDevMalformedJob = spawnSync(process.execPath, ['--import', cliFetchFixture, cliDev,
    'job', 'get', '--endpoint', 'http://127.0.0.1:8093', '--tenant', 'fixture-tenant',
    '--principal', 'fixture-principal', '--job', 'fixture-job'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: devToken,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'job-get-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: devToken,
      GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify({ jobId: 'fixture-job' }),
      GHATANA_MEDIA_CLI_TEST_LOG: packedDevMalformedJobLog,
    },
  });
  assert.equal(packedDevMalformedJob.status, 1, 'installed local-development CLI must reject malformed job observations');
  assert.equal(packedDevMalformedJob.stdout, '');
  assert.equal(JSON.parse(packedDevMalformedJob.stderr.trim()).code, 'INVALID_MEDIA_RESPONSE');
  assert.equal((packedDevMalformedJob.stdout + packedDevMalformedJob.stderr).includes(devToken), false);
  const packedDevMalformedJobRequests = (await readFile(packedDevMalformedJobLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(packedDevMalformedJobRequests.length, 1);
  assert.equal(packedDevMalformedJobRequests[0].path, '/api/v1/jobs/fixture-job');
  assert.equal(packedDevMalformedJobRequests[0].method, 'GET');
  assert.equal(packedDevMalformedJobRequests[0].bearerMatches, true);

  const packedDevMissingUploadLog = path.join(consumerRoot, 'packed-dev-missing-upload.jsonl');
  const packedDevMissingUpload = spawnSync(process.execPath, ['--import', cliFetchFixture, cliDev,
    'artifact', 'upload', '--endpoint', 'http://127.0.0.1:8093', '--tenant', 'tenant-a',
    '--principal', 'principal-a', '--file', path.join(consumerRoot, 'missing-source.bin'),
    '--content-type', 'application/octet-stream', '--classification', 'INTERNAL',
    '--retention', 'P30D', '--idempotency-key', 'missing-upload-request'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: uploadDevToken,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'upload-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: uploadDevToken,
      GHATANA_MEDIA_CLI_TEST_LOG: packedDevMissingUploadLog,
    },
  });
  assert.equal(packedDevMissingUpload.status, 1, 'installed local-development CLI must reject a missing upload source');
  assert.equal(packedDevMissingUpload.stdout, '');
  assert.equal(JSON.parse(packedDevMissingUpload.stderr.trim()).code, 'LOCAL_FILE_ERROR');
  assert.equal((packedDevMissingUpload.stdout + packedDevMissingUpload.stderr).includes(uploadDevToken), false);
  try {
    await access(packedDevMissingUploadLog, constants.F_OK);
    assert.fail('a missing upload source must fail before authenticated fetch dispatch');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }

  const uploadBytes = Buffer.from('abc');
  const uploadSha256 = createHash('sha256').update(uploadBytes).digest('hex');
  const uploadArtifact = {
    tenantId: 'tenant-a', principalId: 'principal-a', artifactId: 'fixture-uploaded-artifact',
    fileName: 'source.bin', contentType: 'application/octet-stream', sizeBytes: uploadBytes.length,
    sha256: uploadSha256, objectReference: 'opaque://fixture/uploaded-artifact', classification: 'INTERNAL',
    createdAt: '2026-10-30T12:00:00.000Z', expiresAt: '2026-11-30T12:00:00.000Z', metadata: {},
  };
  const uploadSourcePath = path.join(consumerRoot, 'source.bin');
  await writeFile(uploadSourcePath, uploadBytes);
  const packedDevUploadLog = path.join(consumerRoot, 'packed-dev-upload.jsonl');
  const packedDevUpload = spawnSync(process.execPath, ['--import', cliFetchFixture, cliDev,
    'artifact', 'upload', '--endpoint', 'http://127.0.0.1:8093', '--tenant', 'tenant-a',
    '--principal', 'principal-a', '--file', uploadSourcePath, '--content-type', 'application/octet-stream',
    '--classification', 'INTERNAL', '--retention', 'P30D', '--idempotency-key', 'fixture-upload-request'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: uploadDevToken,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'upload-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: uploadDevToken,
      GHATANA_MEDIA_CLI_TEST_UPLOAD_SHA256: uploadSha256,
      GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(uploadArtifact),
      GHATANA_MEDIA_CLI_TEST_LOG: packedDevUploadLog,
    },
  });
  assert.equal(packedDevUpload.status, 0, 'installed local-development CLI must complete and read back an uploaded artifact');
  assert.deepEqual(JSON.parse(packedDevUpload.stdout.trim()), {
    schemaVersion: 'media.cli-result.v1',
    commandId: 'media.cli.local-development.artifact.upload', artifact: uploadArtifact,
  });
  assert.equal((packedDevUpload.stdout + packedDevUpload.stderr).includes(uploadDevToken), false);
  assert.equal((packedDevUpload.stdout + packedDevUpload.stderr).includes(uploadSourcePath), false);
  const packedDevUploadRequests = (await readFile(packedDevUploadLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(packedDevUploadRequests.map(({ method, path: requestPath }) => `${method} ${requestPath}`), [
    'GET /dev/v1/artifact-upload-policy',
    'POST /api/v1/artifacts/uploads',
    'PUT /api/v1/artifacts/uploads/upload-a/chunks/0',
    'GET /api/v1/artifacts/uploads/upload-a',
    'POST /api/v1/artifacts/uploads/upload-a/complete',
    'GET /api/v1/artifacts/fixture-uploaded-artifact',
  ]);
  assert.equal(packedDevUploadRequests[1].idempotencyKey, 'fixture-upload-request');
  assert.equal(packedDevUploadRequests[2].bodySha256, uploadSha256);
  assert.ok(packedDevUploadRequests.every((request) => request.authenticated && request.bearerMatches
    && request.redirect === 'error'
    && (request.path === '/dev/v1/artifact-upload-policy'
      ? request.tenant === null && request.principal === null
      : request.tenant === 'tenant-a' && request.principal === 'principal-a')));
  assert.equal(JSON.stringify(packedDevUploadRequests).includes(uploadDevToken), false);

  const args = ['artifact', 'inspect', '--endpoint', 'http://127.0.0.1:1', '--tenant', 'fixture-tenant',
    '--principal', 'fixture-principal', '--artifact', 'fixture-artifact'];
  const packedInspectResult = spawnSync(process.execPath, ['--import', cliFetchFixture, cli, ...args], {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GHATANA_MEDIA_BEARER_TOKEN: token,
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
      GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(cliArtifact),
      GHATANA_MEDIA_CLI_TEST_LOG: cliRequestLog,
    },
  });
  assert.equal(packedInspectResult.status, 0, 'installed CLI must return the admitted artifact observation');
  assert.equal(packedInspectResult.stderr, '');
  assert.deepEqual(JSON.parse(packedInspectResult.stdout.trim()), {
    schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.artifact.inspect', artifact: cliArtifact,
  });
  assert.equal((packedInspectResult.stdout + packedInspectResult.stderr).includes(token), false,
    'installed CLI success output must not expose the bearer credential');
  const packedInspectRequests = (await readFile(cliRequestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(packedInspectRequests.length, 1, 'installed CLI inspect must dispatch exactly one request');
  const [packedInspectRequest] = packedInspectRequests;
  assert.equal(typeof packedInspectRequest.requestId, 'string', 'installed CLI inspect must carry request correlation');
  assert.ok(packedInspectRequest.requestId.length > 0);
  const { requestId: _requestId, ...packedInspectRequestWithoutRequestId } = packedInspectRequest;
  assert.deepEqual(packedInspectRequestWithoutRequestId, {
    path: '/api/v1/artifacts/fixture-artifact', search: '', method: 'GET',
    tenant: 'fixture-tenant', principal: 'fixture-principal', idempotencyKey: null,
    accept: 'application/json', contentLength: null, redirect: 'error',
    authenticated: true, bearerMatches: true,
  });
  assert.equal(JSON.stringify(packedInspectRequests).includes(token), false,
    'installed CLI request evidence must not contain the bearer credential');

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

  console.log(`Installed ESM/CJS/types consumers, DEV_ONLY timeline SDK, local upload/inspect/job-get/cancel dispatch, production artifact-inspect boundary, credential/PII scan, and packed CLI admission checks passed (zod ${zodManifest.version}).`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
