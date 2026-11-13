import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { DocumentIntelligenceClient } from '../../src/client.js';
import type { WireProviderCatalog } from '../../src/protocol.js';

const DEFAULT_PROVIDERS = new Set([
  'ghatana.docling',
  'ghatana.paddleocr',
  'ghatana.gliner',
  'ghatana.minilm',
]);

const DEFAULT_IDENTITIES = {
  'ghatana.docling': { providerVersion: '0.1.0', modelRef: 'docling-standard-pdf-pipeline', modelVersion: 'pinned-docling-runtime' },
  'ghatana.paddleocr': { providerVersion: '0.1.0', modelRef: 'PP-OCRv5-en', modelVersion: 'PP-OCRv5-local-en' },
  'ghatana.gliner': { providerVersion: '0.1.0', modelRef: 'urchade/gliner_multi-v2.1', modelVersion: '443d26d' },
  'ghatana.minilm': { providerVersion: '0.1.0', modelRef: 'sentence-transformers/all-MiniLM-L6-v2', modelVersion: '1110a24' },
} as const;

type JsonObject = Record<string, unknown>;

export interface CanonicalWorkerIdentity {
  readonly runId: string;
  readonly baseUrl: string;
  readonly workerRoot: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly profileId: 'default';
  readonly profileIdentityExplicit: true;
  readonly providerCatalogFingerprint: string;
  readonly modelManifestFingerprint: string;
  readonly providerCatalog: WireProviderCatalog;
}

export interface CanonicalWorkerHandle {
  readonly client: DocumentIntelligenceClient;
  readonly identity: CanonicalWorkerIdentity;
  stop(): Promise<void>;
}

export interface CanonicalWorkerBootstrapOptions {
  readonly workerRoot?: string;
  readonly startupTimeoutMs?: number;
}

function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolvePort(port) : rejectPort(new Error('no ephemeral port allocated'))));
    });
  });
}

async function getJson(url: string): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`invalid JSON from ${url}`);
  return { status: response.status, body: body as JsonObject };
}

async function waitForReady(baseUrl: string, worker: ChildProcess, timeoutMs: number, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no /readyz response received';
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`worker exited during startup: ${diagnostics()}`);
    try {
      const response = await getJson(`${baseUrl}/readyz`);
      last = `${response.status} ${JSON.stringify(response.body)}`;
      if (response.status === 200 && response.body.status === 'ready') return;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`worker did not become ready; /readyz=${last}; worker=${diagnostics()}`);
}

function requiredFingerprint(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`worker authority ${key} is missing or invalid`);
  }
  return value;
}

function validateCanonicalCatalog(catalog: WireProviderCatalog): void {
  const refs = catalog.providers.map((provider) => provider.providerRef);
  if (refs.length !== DEFAULT_PROVIDERS.size || new Set(refs).size !== refs.length ||
      !refs.every((providerRef) => DEFAULT_PROVIDERS.has(providerRef))) {
    throw new Error(`canonical default provider catalog mismatch: ${refs.join(', ')}`);
  }
  for (const provider of catalog.providers) {
    const expected = DEFAULT_IDENTITIES[provider.providerRef as keyof typeof DEFAULT_IDENTITIES];
    if (!expected || provider.providerVersion !== expected.providerVersion || provider.modelRef !== expected.modelRef || provider.modelVersion !== expected.modelVersion) {
      throw new Error(`canonical provider identity mismatch for ${provider.providerRef}`);
    }
  }
  const paddle = catalog.providers.find((provider) => provider.providerRef === 'ghatana.paddleocr');
  const languageIdentities = paddle?.languageModelIdentities ?? [];
  const observedPaddle = languageIdentities.map(({ language, modelRef, modelVersion }) => ({ language, modelRef, modelVersion }));
  const expectedPaddle = [
    { language: 'en', modelRef: 'PP-OCRv5-en', modelVersion: 'PP-OCRv5-local-en' },
    { language: 'ne', modelRef: 'PP-OCRv5-devanagari-shared', modelVersion: 'PP-OCRv5-local-devanagari-shared' },
  ];
  if (JSON.stringify(observedPaddle) !== JSON.stringify(expectedPaddle)) {
    throw new Error(`canonical Paddle language identities mismatch: ${JSON.stringify(observedPaddle)}`);
  }
}

/**
 * Start the real worker through its lifecycle, then validate the published
 * authority and readiness before returning a client. Tests must not call the
 * client against a merely alive process: /readyz is the material-freeze
 * boundary and the health/catalog checks bind the returned run identity.
 */
export async function bootstrapCanonicalWorker(options: CanonicalWorkerBootstrapOptions = {}): Promise<CanonicalWorkerHandle> {
  const workerRoot = options.workerRoot ?? resolve(process.cwd(), '../..');
  const port = await allocateFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const python = resolve(workerRoot, '.venv/bin/python');
  const command = existsSync(python) ? python : 'python3';
  const startedAt = new Date().toISOString();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: resolve(workerRoot, 'src'),
    DOCUMENT_INTELLIGENCE_PORT: String(port),
    DOCUMENT_INTELLIGENCE_PROFILE_ID: 'default',
    DOCUMENT_INTELLIGENCE_ENABLED_PROVIDERS: [...DEFAULT_PROVIDERS].join(','),
    DOCUMENT_INTELLIGENCE_ENABLED_LANGUAGES: 'en,ne',
    DOCUMENT_INTELLIGENCE_MODEL_CACHE: resolve(workerRoot, '.models'),
    DOCUMENT_INTELLIGENCE_OFFLINE: 'true',
    DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  delete env.DOCUMENT_INTELLIGENCE_PROFILE_PATH;

  const worker = spawn(command, ['-m', 'uvicorn', 'document_intelligence.app:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workerRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnosticsText = '';
  worker.stdout?.on('data', (chunk: Buffer) => { diagnosticsText += chunk.toString(); });
  worker.stderr?.on('data', (chunk: Buffer) => { diagnosticsText += chunk.toString(); });
  const diagnostics = () => diagnosticsText.slice(-4000);
  const stop = async (): Promise<void> => {
    if (worker.exitCode !== null) return;
    worker.kill('SIGTERM');
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        if (worker.exitCode === null) worker.kill('SIGKILL');
        resolveExit();
      }, 30_000);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  };

  try {
    await waitForReady(baseUrl, worker, options.startupTimeoutMs ?? 420_000, diagnostics);
    const health = await getJson(`${baseUrl}/healthz`);
    if (health.status !== 200 || health.body.status !== 'ok') throw new Error('canonical worker health check failed');
    if (health.body.profileId !== 'default' || health.body.profileIdentityExplicit !== true) {
      throw new Error('canonical worker did not publish explicit default profile identity');
    }
    const expectedProviderCatalogFingerprint = requiredFingerprint(health.body, 'expectedProviderCatalogFingerprint');
    const observedProviderCatalogFingerprint = requiredFingerprint(health.body, 'observedProviderCatalogFingerprint');
    const modelManifestFingerprint = requiredFingerprint(health.body, 'observedModelManifestFingerprint');
    if (expectedProviderCatalogFingerprint !== observedProviderCatalogFingerprint) {
      throw new Error('canonical worker provider authority changed before bootstrap completed');
    }
    const client = new DocumentIntelligenceClient({ baseUrl, defaultTimeoutMs: 120_000 });
    const providerCatalog = await client.providers();
    validateCanonicalCatalog(providerCatalog);
    return {
      client,
      identity: {
        runId: `i3-${Date.now().toString(36)}-${worker.pid ?? 'unknown'}`,
        baseUrl,
        workerRoot,
        pid: worker.pid ?? -1,
        startedAt,
        profileId: 'default',
        profileIdentityExplicit: true,
        providerCatalogFingerprint: observedProviderCatalogFingerprint,
        modelManifestFingerprint,
        providerCatalog,
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
