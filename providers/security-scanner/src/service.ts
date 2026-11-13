import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { canonicalPayload } from './attestation.ts';
import type { UnsignedAttestation } from './attestation.ts';
import type { DocumentContentScanInput, SignedScanAttestation } from './contract.ts';
import type { EngineIdentity, ScanEngine } from './engine.ts';
import type { SecurityScannerProvider } from './provider.ts';

/**
 * Minimal, language-neutral HTTP/JSON entrypoint for the scanner provider (node:http only).
 *
 *   POST   /v1/scans        submit a scan of a quarantined object ref + expected digest -> 202 {scanId}
 *   GET    /v1/scans/{id}   status (QUEUED|RUNNING|COMPLETED|CANCELLED); COMPLETED carries the signed attestation
 *   DELETE /v1/scans/{id}   cancel (idempotent; 409 once COMPLETED)
 *   GET    /v1/health       authenticated detail: engine/definitions version, pinning, admissionState
 *   GET    /healthz         unauthenticated liveness only ({status}); no engine detail
 *
 * Authentication is mandatory: the constructor refuses to start without an `authenticate` hook, and
 * every /v1 route runs it. Production admission stays NOT_ADMITTED; this file does not change that.
 */
export interface ServicePrincipal {
  readonly principalId: string;
  /** Explicit tenant allow-list; there is no wildcard. */
  readonly tenantIds: readonly string[];
}

export interface AuthRequestContext {
  readonly headers: IncomingMessage['headers'];
  /** Present only for a TLS connection whose client certificate chain was verified (mTLS). */
  readonly peerCertificate?: ReturnType<TLSSocket['getPeerCertificate']>;
}

export type ServiceAuthenticator = (ctx: AuthRequestContext) => ServicePrincipal | undefined | Promise<ServicePrincipal | undefined>;

export interface ScannerHttpServiceOptions {
  readonly provider: SecurityScannerProvider;
  readonly engine: ScanEngine;
  readonly authenticate: ServiceAuthenticator;
  readonly pinnedEngineVersions: readonly string[];
  readonly maxDefinitionsAgeMs: number;
  /** When set the service speaks HTTPS and requires a verified client certificate (mTLS). */
  readonly tls?: Pick<https.ServerOptions, 'key' | 'cert' | 'ca' | 'passphrase'>;
  readonly maxRequestBodyBytes?: number; // default 16 KiB
  readonly maxActiveScans?: number; // queued + running, default 64
  readonly maxRetainedScans?: number; // finished jobs kept for status polling, default 1024
  readonly retentionMs?: number; // default 10 min
  /** Per-principal submit rate limit (fixed window). Defaults: 600 submits per 60 s. */
  readonly maxSubmitsPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly healthTimeoutMs?: number; // default 2 s
  readonly now?: () => Date;
}

export type ScanJobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';

export interface AttestationBinding {
  readonly attestationRef: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: string;
  /** SHA-256 (hex) of the canonical signed payload; mirrors Java `ScanAttestationBinding`. */
  readonly payloadSha256: string;
}

interface Job {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  state: ScanJobState;
  readonly createdAt: number;
  finishedAt?: number;
  attestation?: SignedScanAttestation;
  readonly controller: AbortController;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA_RE = /^[a-f0-9]{64}$/u;
const SUBMIT_KEYS = new Set(['tenantId', 'documentId', 'version', 'checksum', 'sizeBytes', 'mimeType', 'objectRef', 'scopeRef']);

export function attestationBinding(att: SignedScanAttestation): AttestationBinding {
  const { attestation, ...unsigned } = att;
  return {
    attestationRef: att.attestationRef,
    algorithm: attestation.algorithm,
    keyId: attestation.keyId,
    signature: attestation.signature,
    payloadSha256: createHash('sha256').update(canonicalPayload(unsigned as UnsignedAttestation)).digest('hex'),
  };
}

/** Static bearer-token authenticator. Tokens are hashed at construction; comparison is constant-time. */
export function bearerTokenAuthenticator(
  entries: ReadonlyArray<{ token: string; principalId: string; tenantIds: readonly string[] }>,
): ServiceAuthenticator {
  if (entries.length === 0) throw new RangeError('at least one bearer token entry is required');
  const hashed = entries.map((e) => {
    if (typeof e.token !== 'string' || e.token.length < 32) throw new RangeError('bearer tokens must be at least 32 characters');
    if (!e.principalId || e.tenantIds.length === 0 || e.tenantIds.some((t) => !ID_RE.test(t))) {
      throw new TypeError('principalId and an explicit tenantIds allow-list are required');
    }
    return { digest: createHash('sha256').update(e.token).digest(), principal: { principalId: e.principalId, tenantIds: [...e.tenantIds] } };
  });
  return ({ headers }) => {
    const header = headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [!-~]+$/u.test(header)) return undefined;
    const digest = createHash('sha256').update(header.slice(7)).digest();
    let found: ServicePrincipal | undefined;
    for (const h of hashed) if (timingSafeEqual(h.digest, digest)) found = h.principal; // no early exit
    return found;
  };
}

export class ScannerHttpService {
  readonly #o: ScannerHttpServiceOptions;
  readonly #jobs = new Map<string, Job>();
  readonly #server: http.Server | https.Server;
  readonly #maxBody: number;

  constructor(options: ScannerHttpServiceOptions) {
    if (typeof options.authenticate !== 'function') throw new TypeError('authenticate hook is required (bearer or mTLS); the service never runs unauthenticated');
    if (!(options.maxDefinitionsAgeMs > 0)) throw new RangeError('maxDefinitionsAgeMs must be positive');
    this.#o = options;
    this.#maxBody = options.maxRequestBodyBytes ?? 16 * 1024;
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
        else res.destroy();
      });
    };
    const common = { maxHeaderSize: 8 * 1024 };
    this.#server = options.tls
      ? https.createServer({ ...common, ...options.tls, requestCert: true, rejectUnauthorized: true }, handler)
      : http.createServer(common, handler);
    this.#server.headersTimeout = 10_000;
    this.#server.requestTimeout = 15_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.maxRequestsPerSocket = 100;
  }

  listen(port: number, host = '127.0.0.1'): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve({ host, port: (this.#server.address() as { port: number }).port });
      });
    });
  }

  async close(): Promise<void> {
    for (const job of this.#jobs.values()) if (job.state === 'QUEUED' || job.state === 'RUNNING') job.controller.abort();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') return void send(res, 200, { status: 'UP' });
    if (!path.startsWith('/v1/')) return void send(res, 404, err('NOT_FOUND', 'unknown route'));

    const principal = await this.#authenticate(req);
    if (!principal) {
      res.setHeader('www-authenticate', 'Bearer');
      return void send(res, 401, err('UNAUTHENTICATED', 'valid credentials required'));
    }
    if (req.method === 'GET' && path === '/v1/health') return void send(res, ...(await this.#health()));
    if (req.method === 'POST' && path === '/v1/scans') return void (await this.#submit(req, res, principal));
    const m = /^\/v1\/scans\/([A-Za-z0-9-]{1,64})$/u.exec(path);
    if (m && (req.method === 'GET' || req.method === 'DELETE')) {
      const job = this.#jobs.get(m[1]!);
      // Other principals/tenants cannot distinguish "not yours" from "unknown".
      if (!job || job.principalId !== principal.principalId || !principal.tenantIds.includes(job.tenantId)) {
        return void send(res, 404, err('NOT_FOUND', 'scan not found'));
      }
      if (req.method === 'GET') return void send(res, 200, view(job));
      if (job.state === 'COMPLETED') return void send(res, 409, { ...err('ALREADY_COMPLETED', 'scan already completed'), ...view(job) });
      if (job.state !== 'CANCELLED') {
        job.state = 'CANCELLED';
        job.finishedAt = Date.now();
        job.controller.abort();
      }
      return void send(res, 200, view(job));
    }
    if (path === '/v1/health' || path === '/v1/scans' || m) {
      res.setHeader('allow', path === '/v1/scans' ? 'POST' : m ? 'GET, DELETE' : 'GET');
      return void send(res, 405, err('METHOD_NOT_ALLOWED', 'method not allowed'));
    }
    return void send(res, 404, err('NOT_FOUND', 'unknown route'));
  }

  async #authenticate(req: IncomingMessage): Promise<ServicePrincipal | undefined> {
    try {
      const sock = req.socket as Partial<TLSSocket>;
      const peerCertificate = this.#o.tls && sock.authorized ? sock.getPeerCertificate?.() : undefined;
      const p = await this.#o.authenticate({ headers: req.headers, ...(peerCertificate ? { peerCertificate } : {}) });
      return p && p.principalId && Array.isArray(p.tenantIds) && p.tenantIds.length > 0 ? p : undefined;
    } catch {
      return undefined; // fail closed
    }
  }

  async #health(): Promise<[number, unknown]> {
    const o = this.#o;
    let identity: EngineIdentity | undefined;
    try {
      identity = await o.engine.identity(AbortSignal.timeout(o.healthTimeoutMs ?? 2_000));
    } catch {
      identity = undefined;
    }
    const now = (o.now ?? (() => new Date()))().getTime();
    const defs = identity?.definitionsDate?.getTime();
    const counts = { queued: 0, running: 0, retained: 0 };
    for (const j of this.#jobs.values()) {
      if (j.state === 'QUEUED') counts.queued++;
      else if (j.state === 'RUNNING') counts.running++;
      else counts.retained++;
    }
    const pinned = identity ? o.pinnedEngineVersions.includes(identity.version) : false;
    const fresh = defs !== undefined && now - defs <= o.maxDefinitionsAgeMs && defs - now < 5 * 60_000;
    const ready = Boolean(identity) && pinned && fresh;
    return [
      ready ? 200 : 503,
      {
        status: ready ? 'READY' : 'DEGRADED',
        scannerRef: o.provider.scannerRef,
        engine: identity
          ? {
              name: identity.name,
              version: identity.version,
              ...(identity.definitionsVersion ? { definitionsVersion: identity.definitionsVersion } : {}),
              ...(identity.definitionsDate ? { definitionsDate: identity.definitionsDate.toISOString() } : {}),
            }
          : null,
        enginePinned: pinned,
        definitionsFresh: fresh,
        // Static by design: readiness here is liveness of a (possibly fake) engine, never qualification.
        admissionState: 'NOT_ADMITTED',
        productionEligible: false,
        jobs: counts,
      },
    ];
  }

  async #submit(req: IncomingMessage, res: ServerResponse, principal: ServicePrincipal): Promise<void> {
    if (!/^application\/json(?:\s*;.*)?$/iu.test(req.headers['content-type'] ?? '')) {
      return void send(res, 415, err('UNSUPPORTED_MEDIA_TYPE', 'application/json required'));
    }
    const body = await readBody(req, this.#maxBody);
    if (body === undefined) {
      res.setHeader('connection', 'close');
      return void send(res, 413, err('PAYLOAD_TOO_LARGE', `body exceeds ${this.#maxBody} bytes`));
    }
    const parsed = parseSubmit(body);
    if (typeof parsed === 'string') return void send(res, 400, err('INVALID_REQUEST', parsed));
    if (!principal.tenantIds.includes(parsed.tenantId)) {
      return void send(res, 403, err('TENANT_FORBIDDEN', 'principal is not authorized for this tenant'));
    }
    if (!this.#admitRate(principal.principalId)) {
      res.setHeader('retry-after', '10');
      return void send(res, 429, err('RATE_LIMITED', 'principal exceeded its submit rate'));
    }
    this.#prune();
    let active = 0;
    for (const j of this.#jobs.values()) if (j.state === 'QUEUED' || j.state === 'RUNNING') active++;
    if (active >= (this.#o.maxActiveScans ?? 64)) {
      res.setHeader('retry-after', '5');
      return void send(res, 429, err('SCANNER_BUSY', 'too many active scans'));
    }
    const job: Job = {
      id: randomUUID(), tenantId: parsed.tenantId, principalId: principal.principalId,
      state: 'QUEUED', createdAt: Date.now(), controller: new AbortController(),
    };
    this.#jobs.set(job.id, job);
    void this.#run(job, parsed.input);
    res.setHeader('location', `/v1/scans/${job.id}`);
    send(res, 202, view(job));
  }

  readonly #rate = new Map<string, { windowStart: number; count: number }>();
  #admitRate(principalId: string): boolean {
    const now = Date.now();
    const window = this.#o.rateWindowMs ?? 60_000;
    const max = this.#o.maxSubmitsPerWindow ?? 600;
    const cur = this.#rate.get(principalId);
    if (!cur || now - cur.windowStart >= window) {
      if (this.#rate.size >= 10_000) this.#rate.clear(); // bounded memory; a flood of principals only resets counters
      this.#rate.set(principalId, { windowStart: now, count: 1 });
      return true;
    }
    cur.count++;
    return cur.count <= max;
  }

  async #run(job: Job, input: DocumentContentScanInput): Promise<void> {
    job.state = 'RUNNING';
    try {
      const att = await this.#o.provider.scanSigned(input, { signal: job.controller.signal });
      if (stateOf(job) === 'CANCELLED') return; // result of a cancelled scan is discarded, never reported
      job.attestation = att;
      job.state = 'COMPLETED';
    } catch {
      job.state = 'CANCELLED'; // provider never throws for scan problems; treat as aborted
    } finally {
      job.finishedAt = Date.now();
    }
  }

  #prune(): void {
    const now = Date.now();
    const keep = this.#o.retentionMs ?? 10 * 60_000;
    const finished: Job[] = [];
    for (const j of this.#jobs.values()) {
      if (j.finishedAt === undefined) continue;
      if (now - j.finishedAt > keep) this.#jobs.delete(j.id);
      else finished.push(j);
    }
    const cap = this.#o.maxRetainedScans ?? 1024;
    if (finished.length > cap) {
      finished.sort((a, b) => a.finishedAt! - b.finishedAt!);
      for (const j of finished.slice(0, finished.length - cap)) this.#jobs.delete(j.id);
    }
  }
}

const stateOf = (job: Job): ScanJobState => job.state;

function view(job: Job): Record<string, unknown> {
  return {
    scanId: job.id,
    state: job.state,
    tenantId: job.tenantId,
    ...(job.state === 'COMPLETED' && job.attestation
      ? { attestation: job.attestation, attestationBinding: attestationBinding(job.attestation) }
      : {}),
  };
}

function parseSubmit(raw: string): string | { tenantId: string; input: DocumentContentScanInput } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return 'body must be valid JSON';
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'body must be a JSON object';
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!SUBMIT_KEYS.has(k)) return `unknown field: ${k}`;
  const str = (k: string, re = ID_RE) => (typeof o[k] === 'string' && re.test(o[k] as string) ? (o[k] as string) : undefined);
  const tenantId = str('tenantId');
  const documentId = str('documentId');
  const objectRef = str('objectRef');
  const scopeRef = o.scopeRef === undefined ? undefined : str('scopeRef');
  const mimeType = str('mimeType', /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u);
  const checksum = o.checksum as { algorithm?: unknown; value?: unknown } | undefined;
  if (!tenantId) return 'tenantId is required (safe identifier)';
  if (!documentId) return 'documentId is required (safe identifier)';
  if (!objectRef) return 'objectRef is required (safe identifier of a quarantined object)';
  if (o.scopeRef !== undefined && !scopeRef) return 'scopeRef must be a safe identifier';
  if (!mimeType) return 'mimeType is required';
  if (typeof o.version !== 'number' || !Number.isSafeInteger(o.version) || o.version < 0) return 'version must be a non-negative integer';
  if (typeof o.sizeBytes !== 'number' || !Number.isSafeInteger(o.sizeBytes) || o.sizeBytes < 1) return 'sizeBytes must be a positive integer';
  if (!checksum || checksum.algorithm !== 'SHA-256' || typeof checksum.value !== 'string' || !SHA_RE.test(checksum.value)) {
    return 'checksum must be {algorithm:"SHA-256", value:<64 lowercase hex>}';
  }
  return {
    tenantId,
    input: {
      documentId, version: o.version, checksum: { algorithm: 'SHA-256', value: checksum.value }, sizeBytes: o.sizeBytes,
      mimeType, tenantRef: tenantId, sourceRef: objectRef, ...(scopeRef ? { scopeRef } : {}),
    },
  };
}

async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const err = (code: string, message: string) => ({ error: { code, message } });

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}
