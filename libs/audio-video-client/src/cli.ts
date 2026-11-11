#!/usr/bin/env node
/**
 * Purpose: dispatch the authenticated production and local-development Media CLIs.
 * Consumers: the installed `ghatanamedia-api` and `ghatanamedia-api-dev` binaries.
 * Non-goals: this client-side parser does not grant production admission or act as host authority.
 * Change policy: preserve channel separation and add commands only with source-bound operation contracts.
 */
import { basename, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { MediaClientError, MediaOperationAmbiguousError } from './http-core.js';
import { createMediaOperationClient } from './operations.js';
import type { CanonicalMediaArtifactObservation, CanonicalMediaUploadSessionObservation } from './operations.js';
import { createMediaCanonicalClient } from './canonical-operations.js';
import { MediaDevProjectTimelineClient } from './dev-project-timeline.js';
import { MediaDevOnlyJobCancellationClient } from './dev-job-cancellation.js';
import { sameMediaRetention } from './retention-duration.js';
import { isCanonicalMediaContentType } from './upload-validation.js';

const PRODUCTION_COMMAND_IDS: Readonly<Record<string, string>> = {
  'artifact inspect': 'media.cli.artifact.inspect',
};
const LOCAL_DEVELOPMENT_COMMAND_IDS: Readonly<Record<string, string>> = {
  'artifact upload': 'media.cli.local-development.artifact.upload',
  'artifact inspect': 'media.cli.local-development.artifact.inspect',
  'job get': 'media.cli.local-development.job.get',
  'job cancel': 'media.cli.local-development.job.cancel',
};
const PRODUCTION_USAGE = 'Usage: ghatanamedia-api artifact inspect --endpoint URL --tenant ID --principal ID --artifact ID';
const LOCAL_DEVELOPMENT_USAGE = 'Usage: ghatanamedia-api-dev artifact upload --endpoint LOOPBACK_URL --tenant ID --principal ID --file PATH --content-type TYPE --classification CLASS --retention PERIOD --idempotency-key KEY | artifact inspect --endpoint LOOPBACK_URL --tenant ID --principal ID --artifact ID | job get --endpoint LOOPBACK_URL --tenant ID --principal ID --job ID [--request-id ID] | job cancel --endpoint LOOPBACK_URL --tenant ID --principal ID --job ID --request-id ID [--expected-version N]';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_ENDPOINT_URL_CHARS = 8_192;
const MAX_UPLOAD_BYTES = 2_147_483_648;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,255}$/u;
const DEV_ONLY_ISSUER = 'urn:ghatana:media:dev-only';
const DEV_ONLY_AUDIENCE = 'ghatana-media-dev';

type CliCommandIds = Readonly<Record<string, string>>;
type CliChannel = 'production' | 'local-development';

interface Arguments {
  command: string;
  endpoint: string;
  tenant: string;
  principal: string;
  values: Readonly<Record<string, string>>;
}

const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  'artifact upload': ['--endpoint', '--tenant', '--principal', '--file', '--content-type', '--classification', '--retention', '--idempotency-key'],
  'artifact inspect': ['--endpoint', '--tenant', '--principal', '--artifact'],
  'job get': ['--endpoint', '--tenant', '--principal', '--job', '--request-id'],
  'job cancel': ['--endpoint', '--tenant', '--principal', '--job'],
};

const LOCAL_DEVELOPMENT_COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  ...COMMAND_OPTIONS,
  'job cancel': ['--endpoint', '--tenant', '--principal', '--job', '--request-id', '--expected-version'],
};

const OPTIONAL_COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  'job get': ['--request-id'],
  'job cancel': ['--expected-version'],
};

function parseArguments(argv: readonly string[], channel: CliChannel): Arguments {
  const command = `${argv[0] ?? ''} ${argv[1] ?? ''}`;
  const commandIds = channel === 'production' ? PRODUCTION_COMMAND_IDS : LOCAL_DEVELOPMENT_COMMAND_IDS;
  const commandOptions = channel === 'production'
    ? { 'artifact inspect': COMMAND_OPTIONS['artifact inspect']! }
    : LOCAL_DEVELOPMENT_COMMAND_OPTIONS;
  if (!Object.hasOwn(commandIds, command)) throw new Error('Unknown command.');
  const values = new Map<string, string>();
  const allowed = new Set(commandOptions[command]);
  for (let index = 2; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(option) || value === undefined || value.startsWith('--') || values.has(option)) {
      throw new Error('Invalid or unknown command option.');
    }
    values.set(option, value);
  }
  for (const required of ['--endpoint', '--tenant', '--principal']) {
    if (!values.has(required)) throw new Error(`Missing required option ${required}.`);
  }
  const parsed = {
    command,
    endpoint: values.get('--endpoint')!,
    tenant: values.get('--tenant')!,
    principal: values.get('--principal')!,
    values: Object.fromEntries(values),
  };
  for (const [name, value] of [['tenant', parsed.tenant], ['principal', parsed.principal]] as const) {
    if (!OPAQUE_ID_PATTERN.test(value)) {
      throw new Error(`${name} must be a PDP-1 opaque ID of 1 to 128 characters.`);
    }
  }
  const optional = new Set(OPTIONAL_COMMAND_OPTIONS[command] ?? []);
  for (const required of commandOptions[command]!.slice(3)) {
    if (!optional.has(required) && !values.has(required)) throw new Error(`Missing required option ${required}.`);
  }
  for (const [option, label] of [['--artifact', 'artifact ID'], ['--job', 'job ID'], ['--idempotency-key', 'idempotency key']] as const) {
    const value = values.get(option);
    if (value !== undefined && !OPAQUE_ID_PATTERN.test(value)) {
      throw new Error(`${label} must start with a letter or number and use only letters, numbers, dots, underscores, colons, or hyphens (maximum 128 characters).`);
    }
  }
  const requestId = values.get('--request-id');
  if (requestId !== undefined && !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('request ID must contain 1 to 255 visible ASCII characters.');
  }
  if (channel === 'local-development' && command === 'job cancel'
    && requestId !== undefined && !OPAQUE_ID_PATTERN.test(requestId)) {
    throw new Error('Cancellation request ID must be a PDP-1 opaque ID of 1 to 128 characters.');
  }
  if (channel === 'local-development' && command === 'job cancel'
    && values.has('--expected-version')) {
    const rawVersion = values.get('--expected-version')!;
    const expectedVersion = Number(rawVersion);
    if (!/^[1-9]\d*$/u.test(rawVersion) || !Number.isSafeInteger(expectedVersion)) {
      throw new Error('Expected job version must be a positive safe integer.');
    }
  }
  if (command === 'artifact upload') {
    const contentType = values.get('--content-type')!;
    if (!isCanonicalMediaContentType(contentType)) {
      throw new Error('content type must match the PDP-1 media type grammar and contain 3 to 127 characters.');
    }
    if (!['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(values.get('--classification')!)) {
      throw new Error('classification must be PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED.');
    }
    if (!values.get('--retention')!.trim()) throw new Error('retention period is required.');
  }
  return parsed;
}

function validateEndpoint(input: string): string {
  let endpoint: URL;
  try { endpoint = new URL(input); }
  catch { throw new Error('Endpoint must be an absolute HTTPS URL (HTTP is allowed only for loopback testing).'); }
  if (endpoint.href.length > MAX_ENDPOINT_URL_CHARS) {
    throw new Error(`Endpoint URL must not exceed ${MAX_ENDPOINT_URL_CHARS} characters.`);
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const loopbackHttp = endpoint.protocol === 'http:' && localHosts.has(endpoint.hostname.toLowerCase());
  if ((endpoint.protocol !== 'https:' && !loopbackHttp)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Endpoint must use HTTPS, contain no credentials or query, and use HTTP only on loopback.');
  }
  // URL parsing resolves literal and percent-encoded dot segments. Inspect the
  // caller's original path as well, so a traversal is rejected instead of
  // silently changing which base path receives the authenticated request.
  const rawPath = input.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/u)?.[1] ?? '';
  let decodedRawPath: string;
  try { decodedRawPath = decodeURIComponent(rawPath); }
  catch { throw new Error('Endpoint path is invalid.'); }
  if (/[\\\u0000-\u001f\u007f]/u.test(decodedRawPath)
    || decodedRawPath.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('Endpoint path is invalid.');
  }
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(endpoint.pathname); }
  catch { throw new Error('Endpoint path is invalid.'); }
  if (/[\\\u0000-\u001f\u007f]/u.test(decodedPath)
    || decodedPath.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('Endpoint path is invalid.');
  }
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/u, '')}`;
}

function validateLocalDevelopmentEndpoint(input: string): string {
  const endpoint = validateEndpoint(input);
  const parsed = new URL(endpoint);
  if (!new Set(['localhost', '127.0.0.1', '[::1]']).has(parsed.hostname.toLowerCase())
    || parsed.pathname !== '/') {
    throw new Error('The local-development CLI only accepts an explicitly loopback origin without a path prefix.');
  }
  return endpoint;
}

function hasLocalDevelopmentIdentityClaims(
  token: string,
  tenantId: string,
  principalId: string,
  command: string,
): boolean {
  // This is only a local preflight shape/profile check. The Media host must
  // verify the HMAC signature and current authority before accepting a request.
  try {
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) return false;
    const claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1_000);
    const permissions = Array.isArray(claims.permissions)
      ? claims.permissions.filter((permission): permission is string => typeof permission === 'string')
      : [];
    const requiredPermissions: Readonly<Record<string, readonly string[]>> = {
      'artifact upload': ['media:artifact:create', 'media:artifact:read', 'media:artifact:write'],
      'artifact inspect': ['media:artifact:read'],
      'job get': ['media:job:read'],
      'job cancel': ['media:job:cancel'],
    };
    const lifetime = typeof claims.exp === 'number' && typeof claims.iat === 'number'
      ? claims.exp - claims.iat
      : Number.NaN;
    return claims.dev_only === true
      && claims.iss === DEV_ONLY_ISSUER
      && claims.aud === DEV_ONLY_AUDIENCE
      && claims.tenant_id === tenantId
      && claims.sub === principalId
      && Number.isSafeInteger(claims.iat)
      && (claims.iat as number) <= now
      && Number.isSafeInteger(claims.exp)
      && (claims.exp as number) > now
      && Number.isSafeInteger(lifetime)
      && lifetime > 0
      && lifetime <= 300
      && (requiredPermissions[command] ?? []).every((permission) => permissions.includes(permission));
  } catch {
    return false;
  }
}

function parseRequestTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!/^[1-9]\d{0,5}$/u.test(value)) {
    throw new Error(`GHATANA_MEDIA_REQUEST_TIMEOUT_MS must be an integer in 1..${MAX_REQUEST_TIMEOUT_MS}.`);
  }
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(`GHATANA_MEDIA_REQUEST_TIMEOUT_MS must be an integer in 1..${MAX_REQUEST_TIMEOUT_MS}.`);
  }
  return timeout;
}

function writeError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  exitCode = 1,
  command = 'artifact inspect',
  commandIds: CliCommandIds = PRODUCTION_COMMAND_IDS,
): void {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 'media.cli-error.v1', commandId: commandIds[command] ?? 'media.cli.invocation', code, message, ...extra,
  })}\n`);
  process.exitCode = exitCode;
}

function safeCorrelationExtra(correlationId: unknown, token: string): Record<string, string> {
  if (typeof correlationId !== 'string' || correlationId.length < 1 || correlationId.length > 255
    || !/^[^\u0000-\u001f\u007f]+$/u.test(correlationId) || !correlationId.trim()
    || correlationId !== correlationId.trim()
    || correlationId === 'not-reported') return {};
  const secrets = [token, token.trim()].filter(Boolean);
  if (secrets.some(secret => correlationId.includes(secret))) return {};
  return { correlationId };
}

function containsCredential(value: unknown, token: string): boolean {
  const secrets = [token, token.trim()].filter(Boolean);
  const credentialKeys = new Set(['authorization', 'bearertoken', 'accesstoken', 'refreshtoken', 'clientsecret', 'apikey', 'password', 'credential', 'credentials', 'privatekey']);
  if (typeof value === 'string') return secrets.some(secret => value.includes(secret));
  if (Array.isArray(value)) return value.some(item => containsCredential(item, token));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => secrets.some(secret => key.toLowerCase().includes(secret.toLowerCase()))
      || credentialKeys.has(key.toLowerCase().replace(/[^a-z0-9]/gu, ''))
      || containsCredential(item, token));
  }
  return false;
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]));
  }
  return value;
}

class LocalUploadSourceError extends Error {
  public constructor(public readonly code: 'LOCAL_FILE_INVALID' | 'LOCAL_FILE_ERROR' | 'LOCAL_SOURCE_CHANGED') {
    super('local upload source is unavailable or invalid');
    this.name = 'LocalUploadSourceError';
  }
}

class UploadSessionReadbackMismatchError extends Error {
  public constructor() {
    super('upload session readback did not match the last confirmed chunk');
    this.name = 'UploadSessionReadbackMismatchError';
  }
}

class ArtifactReadbackMismatchError extends Error {
  public constructor() {
    super('artifact readback differed from the completed upload receipt');
    this.name = 'ArtifactReadbackMismatchError';
  }
}

class UnsafeUploadSessionIdentityError extends Error {
  public constructor() {
    super('upload session returned an unsafe or changed identity');
    this.name = 'UnsafeUploadSessionIdentityError';
  }
}

function assertSafeUploadSessionIdentity(
  session: CanonicalMediaUploadSessionObservation,
  token: string,
  expectedUploadId?: string,
): void {
  if (!OPAQUE_ID_PATTERN.test(session.uploadId)
    || containsCredential(session, token)
    || (expectedUploadId !== undefined && session.uploadId !== expectedUploadId)) {
    throw new UnsafeUploadSessionIdentityError();
  }
}

function sameUploadSession(
  actual: CanonicalMediaUploadSessionObservation,
  expected: CanonicalMediaUploadSessionObservation,
  expectedBytes: number,
  expectedChunks: number,
): boolean {
  return actual.uploadId === expected.uploadId
    && actual.tenantId === expected.tenantId
    && actual.principalId === expected.principalId
    && actual.fileName === expected.fileName
    && actual.contentType === expected.contentType
    && actual.expectedSizeBytes === expected.expectedSizeBytes
    && actual.expectedSha256 === expected.expectedSha256
    && actual.classification === expected.classification
    && sameMediaRetention(actual.retention, expected.retention)
    && actual.createdAt === expected.createdAt
    && actual.expiresAt === expected.expiresAt
    && JSON.stringify(canonicalizeJsonValue(actual.metadata)) === JSON.stringify(canonicalizeJsonValue(expected.metadata))
    && actual.status === 'OPEN'
    && actual.status === expected.status
    && actual.bytesReceived === expectedBytes
    && actual.nextChunkIndex === expectedChunks;
}

function sameCompletedArtifact(
  actual: CanonicalMediaArtifactObservation,
  completed: CanonicalMediaArtifactObservation,
): boolean {
  return actual.tenantId === completed.tenantId
    && actual.principalId === completed.principalId
    && actual.artifactId === completed.artifactId
    && actual.fileName === completed.fileName
    && actual.contentType === completed.contentType
    && actual.sizeBytes === completed.sizeBytes
    && actual.sha256 === completed.sha256
    && actual.objectReference === completed.objectReference
    && actual.classification === completed.classification
    && actual.createdAt === completed.createdAt
    && actual.expiresAt === completed.expiresAt
    && JSON.stringify(canonicalizeJsonValue(actual.metadata)) === JSON.stringify(canonicalizeJsonValue(completed.metadata));
}

function writeArtifact(
  artifact: CanonicalMediaArtifactObservation,
  token: string,
  command: string,
  commandIds: CliCommandIds,
  extra: Record<string, unknown> = {},
): boolean {
  if (containsCredential(artifact, token)) {
    writeError('INVALID_MEDIA_RESPONSE', 'Media returned an artifact response containing credential material.', extra, 1, command, commandIds);
    return false;
  }
  const canonicalArtifact = { ...artifact, metadata: canonicalizeJsonValue(artifact.metadata) };
  process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: commandIds[command], artifact: canonicalArtifact })}\n`);
  return true;
}

function writeJob(
  job: Awaited<ReturnType<ReturnType<typeof createMediaCanonicalClient>['getJob']>>,
  token: string,
  command: string,
  commandIds: CliCommandIds,
): boolean {
  if (containsCredential(job, token)) {
    writeError('INVALID_MEDIA_RESPONSE', 'Media returned a job response containing credential material.', {}, 1, command, commandIds);
    return false;
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: commandIds[command], job: canonicalizeJsonValue(job) })}\n`);
  return true;
}

async function uploadArtifact(
  args: Arguments,
  endpoint: string,
  token: string,
  requestTimeoutMs: number,
  onUploadId: (uploadId: string) => void,
  onArtifactId: (artifactId: string) => void,
): Promise<CanonicalMediaArtifactObservation> {
  const filePath = args.values['--file']!;
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(filePath, 'r'); }
  catch { throw new LocalUploadSourceError('LOCAL_FILE_ERROR'); }
  try {
    let initialStat: Awaited<ReturnType<typeof file.stat>>;
    try { initialStat = await file.stat(); }
    catch { throw new LocalUploadSourceError('LOCAL_FILE_ERROR'); }
    if (!initialStat.isFile() || !Number.isSafeInteger(initialStat.size)
      || initialStat.size < 1 || initialStat.size > MAX_UPLOAD_BYTES) {
      throw new LocalUploadSourceError('LOCAL_FILE_INVALID');
    }

    // The DEV_ONLY host owns the durable upload limit. Read it before hashing
    // or creating an upload session so failures cannot leave a partial upload.
    const policyAbort = new AbortController();
    const policyTimeout = setTimeout(() => policyAbort.abort(), requestTimeoutMs);
    let uploadPolicy: Awaited<ReturnType<MediaDevProjectTimelineClient['getArtifactUploadPolicy']>>;
    try {
      uploadPolicy = await new MediaDevProjectTimelineClient({
        baseUrl: new URL(endpoint).origin,
        bearerToken: token,
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      }).getArtifactUploadPolicy(policyAbort.signal);
    } finally {
      clearTimeout(policyTimeout);
    }
    const maxChunkBytes = uploadPolicy.maxChunkBytes;

    const preflightDigest = createHash('sha256');
    let offset = 0;
    while (offset < initialStat.size) {
      const buffer = Buffer.allocUnsafe(Math.min(maxChunkBytes, initialStat.size - offset));
      let bytesRead: number;
      try { ({ bytesRead } = await file.read(buffer, 0, buffer.length, offset)); }
      catch { throw new LocalUploadSourceError('LOCAL_FILE_ERROR'); }
      if (bytesRead !== buffer.length) throw new LocalUploadSourceError('LOCAL_FILE_ERROR');
      preflightDigest.update(buffer);
      offset += bytesRead;
    }
    const expectedSha256 = preflightDigest.digest('hex');
    let preflightStat: Awaited<ReturnType<typeof file.stat>>;
    try { preflightStat = await file.stat(); }
    catch { throw new LocalUploadSourceError('LOCAL_FILE_ERROR'); }
    if (preflightStat.size !== initialStat.size || preflightStat.mtimeMs !== initialStat.mtimeMs
      || preflightStat.ctimeMs !== initialStat.ctimeMs) {
      throw new LocalUploadSourceError('LOCAL_SOURCE_CHANGED');
    }

    const client = createMediaOperationClient({
      baseUrl: endpoint,
      tenantId: args.tenant,
      requestTimeoutMs,
      defaultHeaders: { 'X-Principal-Id': args.principal },
      getAccessToken: () => token,
      fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: 'error' }),
    });
    let session = await client.createUploadSession({
      fileName: basename(filePath),
      contentType: args.values['--content-type']!,
      expectedSizeBytes: initialStat.size,
      expectedSha256,
      classification: args.values['--classification']! as 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED',
      retention: args.values['--retention']!,
      metadata: {},
      idempotencyKey: args.values['--idempotency-key']!,
    });
    assertSafeUploadSessionIdentity(session, token);
    onUploadId(session.uploadId);

    // The same idempotency key can recover a durable OPEN session from a prior
    // CLI process. Resume only from its acknowledged byte/chunk boundary.
    if (session.status !== 'OPEN' || !Number.isSafeInteger(session.bytesReceived)
      || session.bytesReceived < 0 || session.bytesReceived > initialStat.size
      || !Number.isSafeInteger(session.nextChunkIndex) || session.nextChunkIndex < 0
      || session.nextChunkIndex > session.bytesReceived
      || ((session.nextChunkIndex === 0) !== (session.bytesReceived === 0))) {
      throw new UploadSessionReadbackMismatchError();
    }

    const streamedDigest = createHash('sha256');
    // Include the acknowledged source prefix in the second digest pass so a
    // source replacement between preflight and resume cannot be completed.
    offset = 0;
    while (offset < session.bytesReceived) {
      const buffer = Buffer.allocUnsafe(Math.min(maxChunkBytes, session.bytesReceived - offset));
      let bytesRead: number;
      try { ({ bytesRead } = await file.read(buffer, 0, buffer.length, offset)); }
      catch { throw new LocalUploadSourceError('LOCAL_FILE_ERROR'); }
      if (bytesRead !== buffer.length) throw new LocalUploadSourceError('LOCAL_FILE_ERROR');
      streamedDigest.update(buffer);
      offset += bytesRead;
    }
    let chunkIndex = session.nextChunkIndex;
    while (offset < initialStat.size) {
      const buffer = Buffer.allocUnsafe(Math.min(maxChunkBytes, initialStat.size - offset));
      let bytesRead: number;
      try { ({ bytesRead } = await file.read(buffer, 0, buffer.length, offset)); }
      catch { throw new LocalUploadSourceError('LOCAL_FILE_ERROR'); }
      if (bytesRead !== buffer.length) throw new LocalUploadSourceError('LOCAL_FILE_ERROR');
      streamedDigest.update(buffer);
      const updatedSession = await client.uploadPart(session, chunkIndex, new Blob([Uint8Array.from(buffer)]));
      assertSafeUploadSessionIdentity(updatedSession, token, session.uploadId);
      session = updatedSession;
      offset += bytesRead;
      chunkIndex += 1;
    }
    let finalStat: Awaited<ReturnType<typeof file.stat>>;
    try { finalStat = await file.stat(); }
    catch { throw new LocalUploadSourceError('LOCAL_FILE_ERROR'); }
    if (streamedDigest.digest('hex') !== expectedSha256 || finalStat.size !== preflightStat.size
      || finalStat.mtimeMs !== preflightStat.mtimeMs || finalStat.ctimeMs !== preflightStat.ctimeMs) {
      throw new LocalUploadSourceError('LOCAL_SOURCE_CHANGED');
    }

    let persistedSession: CanonicalMediaUploadSessionObservation;
    try {
      persistedSession = await client.getUploadSession(session.uploadId);
    } catch (error) {
      if (error instanceof TypeError
        && error.message === 'Canonical Media upload response identity does not match the requested upload.') {
        throw new UploadSessionReadbackMismatchError();
      }
      throw error;
    }
    assertSafeUploadSessionIdentity(persistedSession, token, session.uploadId);
    if (!sameUploadSession(persistedSession, session, offset, chunkIndex)) {
      throw new UploadSessionReadbackMismatchError();
    }
    const completed = await client.completeUploadSession(persistedSession);
    onArtifactId(completed.artifactId);
    const durable = await client.getArtifact(completed.artifactId);
    if (!sameCompletedArtifact(durable, completed)) throw new ArtifactReadbackMismatchError();
    return durable;
  } finally {
    try { await file.close(); } catch { /* descriptor cleanup does not alter the operation result */ }
  }
}

async function run(argv: readonly string[], token: string | undefined, channel: CliChannel): Promise<void> {
  const commandIds = channel === 'production' ? PRODUCTION_COMMAND_IDS : LOCAL_DEVELOPMENT_COMMAND_IDS;
  const usage = channel === 'production' ? PRODUCTION_USAGE : LOCAL_DEVELOPMENT_USAGE;
  // Parse and reject unsupported command identities before reading credentials
  // or constructing an authenticated transport.
  let args: Arguments;
  try { args = parseArguments(argv, channel); }
  catch (error) {
    writeError(
      'INVALID_INVOCATION',
      `${error instanceof Error ? error.message : 'Invalid invocation'} ${usage}`,
      {},
      2,
      `${argv[0] ?? ''} ${argv[1] ?? ''}`,
      commandIds,
    );
    return;
  }
  const bearerToken = token?.trim();
  if (!bearerToken) {
    writeError('MISSING_AUTH_TOKEN', 'Set GHATANA_MEDIA_BEARER_TOKEN in the environment; credentials are never accepted as command arguments.', {}, 2, args.command, commandIds);
    return;
  }
  if (/[\u0000-\u001f\u007f]/u.test(bearerToken)) {
    writeError('INVALID_CONFIGURATION', 'GHATANA_MEDIA_BEARER_TOKEN contains characters that cannot be sent in an HTTP header.', {}, 2, args.command, commandIds);
    return;
  }
  // JWT/JWS base64url segments may contain `_`; accept the full bearer-token
  // alphabet so valid DEV_ONLY credentials are not rejected client-side.
  if (!/^[A-Za-z0-9._~+/_-]+=*$/u.test(bearerToken)) {
    writeError('INVALID_CONFIGURATION', 'GHATANA_MEDIA_BEARER_TOKEN is not a valid bearer credential.', {}, 2, args.command, commandIds);
    return;
  }
  if (channel === 'local-development' && !hasLocalDevelopmentIdentityClaims(bearerToken, args.tenant, args.principal, args.command)) {
    writeError(
      'LOCAL_DEV_IDENTITY_REJECTED',
      'The local-development CLI requires a current DEV_ONLY identity with matching tenant, principal, issuer, audience, and command permissions.',
      {},
      3,
      args.command,
      commandIds,
    );
    return;
  }
  let requestTimeoutMs: number;
  try { requestTimeoutMs = parseRequestTimeout(process.env.GHATANA_MEDIA_REQUEST_TIMEOUT_MS); }
  catch (error) {
    writeError('INVALID_CONFIGURATION', error instanceof Error ? error.message : 'Request timeout configuration is invalid.', {}, 2, args.command, commandIds);
    return;
  }
  let endpoint: string;
  try {
    endpoint = channel === 'local-development'
      ? validateLocalDevelopmentEndpoint(args.endpoint)
      : validateEndpoint(args.endpoint);
  }
  catch (error) {
    if (channel === 'local-development') {
      writeError('LOCAL_DEV_ENDPOINT_REQUIRED', 'The local-development CLI only accepts a valid loopback Media endpoint.', {}, 3, args.command, commandIds);
    } else {
      writeError('INVALID_ENDPOINT', error instanceof Error ? error.message : 'Endpoint is invalid.', {}, 2, args.command, commandIds);
    }
    return;
  }

  let knownUploadId: string | undefined;
  let knownArtifactId: string | undefined;
  try {
    const config = {
      baseUrl: endpoint,
      tenantId: args.tenant,
      requestTimeoutMs,
      defaultHeaders: { 'X-Principal-Id': args.principal },
      getAccessToken: () => bearerToken,
      fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: 'error' }),
    };
    if (args.command === 'artifact inspect') {
      const artifact = await createMediaOperationClient(config).getArtifact(args.values['--artifact']!);
      writeArtifact(artifact, bearerToken, args.command, commandIds);
      return;
    }
    if (args.command === 'artifact upload') {
      const artifact = await uploadArtifact(args, endpoint, bearerToken, requestTimeoutMs, (uploadId) => {
        knownUploadId = uploadId;
      }, (artifactId) => { knownArtifactId = artifactId; });
      writeArtifact(artifact, bearerToken, args.command, commandIds,
        { ...(knownUploadId === undefined ? {} : { uploadId: knownUploadId }),
          ...(knownArtifactId === undefined ? {} : { artifactId: knownArtifactId }) });
      return;
    }
    if (channel === 'local-development' && args.command === 'job cancel') {
      const cancellation = await new MediaDevOnlyJobCancellationClient(config).cancelJob(
        args.values['--job']!,
        {
          requestId: args.values['--request-id']!,
          ...(args.values['--expected-version'] === undefined
            ? {}
            : { expectedVersion: Number(args.values['--expected-version']) }),
        },
      );
      if (containsCredential(cancellation, bearerToken)) {
        writeError('INVALID_MEDIA_RESPONSE', 'Media returned a cancellation response containing credential material.', {}, 1, args.command, commandIds);
        return;
      }
      process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: commandIds[args.command], cancellation: canonicalizeJsonValue(cancellation) })}\n`);
      return;
    }
    const canonical = createMediaCanonicalClient(config);
    const job = args.values['--request-id'] === undefined
      ? await canonical.getJob(args.values['--job']!)
      : await canonical.getJobByRequest(args.values['--job']!, args.values['--request-id']);
    writeJob(job, bearerToken, args.command, commandIds);
  } catch (error) {
    if (error instanceof MediaOperationAmbiguousError) {
      if (args.command === 'artifact upload') {
        writeError('OUTCOME_UNKNOWN', knownUploadId === undefined
          ? 'Upload begin may have taken effect, but no upload ID was returned. Do not retry until the outcome can be reconciled.'
          : 'Upload may have taken effect. Do not retry; reconcile the known upload session before continuing.',
        { ...(knownUploadId === undefined ? {} : { uploadId: knownUploadId }),
          ...(knownArtifactId === undefined ? {} : { artifactId: knownArtifactId }) }, 1, args.command, commandIds);
      } else {
        writeError(args.command === 'job cancel' ? 'OUTCOME_UNKNOWN' : 'OBSERVATION_UNAVAILABLE',
          args.command === 'job cancel'
            ? 'Cancellation may have been durably reserved or dispatched. Reuse the same request ID to reconcile; do not issue a new cancellation request.'
            : 'No observation was received. Check endpoint availability before requesting another read.',
          args.command === 'job cancel' ? { requestId: args.values['--request-id'] } : {}, 1, args.command, commandIds);
      }
      return;
    }
    if (error instanceof LocalUploadSourceError) {
      const extra = knownUploadId === undefined ? {} : { uploadId: knownUploadId };
      const message = error.code === 'LOCAL_SOURCE_CHANGED'
        ? 'The upload source changed while it was being read. Completion was not attempted; inspect the known upload session before any retry.'
        : error.code === 'LOCAL_FILE_INVALID'
          ? 'Upload source must be a readable regular file with a size in the supported range.'
          : 'The upload source could not be read completely.';
      writeError(error.code, message, extra, 1, args.command, commandIds);
      return;
    }
    if (error instanceof UploadSessionReadbackMismatchError) {
      writeError('OUTCOME_UNKNOWN', 'Upload-session readback differed from the last confirmed chunk. Completion was not attempted; reconcile the upload ID before proceeding.', { uploadId: knownUploadId }, 1, args.command, commandIds);
      return;
    }
    if (error instanceof ArtifactReadbackMismatchError) {
      writeError('OUTCOME_UNKNOWN', 'The completed artifact did not match durable metadata readback. Inspect the known artifact ID before proceeding.',
        { ...(knownUploadId === undefined ? {} : { uploadId: knownUploadId }),
          ...(knownArtifactId === undefined ? {} : { artifactId: knownArtifactId }) }, 1, args.command, commandIds);
      return;
    }
    if (error instanceof UnsafeUploadSessionIdentityError) {
      writeError(
        'OUTCOME_UNKNOWN',
        'Upload may have taken effect, but Media returned an unsafe upload identity. No identity was included; reconcile through a trusted channel before proceeding.',
        {},
        1,
        args.command,
        commandIds,
      );
      return;
    }
    if (error instanceof MediaClientError) {
      if (args.command === 'artifact upload' && knownArtifactId !== undefined) {
        writeError('OUTCOME_UNKNOWN', 'Upload completed, but durable artifact readback was unavailable. Inspect the known artifact ID before retrying.', {
          uploadId: knownUploadId,
          artifactId: knownArtifactId,
          statusCode: error.statusCode,
          ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
        }, 1, args.command, commandIds);
      } else if (error.statusCode === 404 && error.detail.code === 'ARTIFACT_NOT_FOUND' && args.command === 'artifact inspect') {
        writeError('ARTIFACT_NOT_FOUND', 'Artifact was not visible in the requested tenant and principal scope.', {
          statusCode: 404,
          ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
        }, 1, args.command, commandIds);
      } else if (error.statusCode === 404 && error.detail.code === 'JOB_NOT_FOUND' && args.command.startsWith('job ')) {
        writeError('JOB_NOT_FOUND', 'Job was not visible in the requested tenant and principal scope.', {
          statusCode: 404,
          jobId: args.values['--job'],
          ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
        }, 1, args.command, commandIds);
      } else if (args.command === 'job cancel' && error.statusCode === 409
        && ['JOB_VERSION_CONFLICT', 'CANCELLATION_REQUEST_CONFLICT'].includes(error.detail.code)) {
        writeError(error.detail.code, error.detail.code === 'JOB_VERSION_CONFLICT'
          ? 'The job version changed before cancellation was reserved. Re-read the job and choose whether to issue a new cancellation request.'
          : 'A different cancellation request already owns this job. Reconcile using the existing request identity before proceeding.',
        { statusCode: 409, requestId: args.values['--request-id'],
          ...safeCorrelationExtra(error.detail.correlationId, bearerToken) }, 1, args.command, commandIds);
      } else if (args.command === 'job cancel' && error.statusCode === 422
        && error.detail.code === 'JOB_CANCELLATION_NOT_ADMITTED') {
        writeError('JOB_CANCELLATION_NOT_ADMITTED', 'This local-development host or provider does not admit job cancellation.',
          { statusCode: 422, requestId: args.values['--request-id'] }, 1, args.command, commandIds);
      } else {
        writeError('MEDIA_REQUEST_FAILED', 'Media did not return the requested observation; success is not inferred.', {
          statusCode: error.statusCode,
          ...(knownUploadId === undefined ? {} : { uploadId: knownUploadId }),
          ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
        }, 1, args.command, commandIds);
      }
      return;
    }
    if (error instanceof TypeError && /^Canonical Media (?:artifact|job|upload)/u.test(error.message)) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned a response that did not match the canonical runtime DTO.', {
        ...(args.command === 'artifact upload' && knownUploadId !== undefined ? { uploadId: knownUploadId } : {}),
        ...(args.command === 'artifact upload' && knownArtifactId !== undefined ? { artifactId: knownArtifactId } : {}),
      }, 1, args.command, commandIds);
      return;
    }
    if (error instanceof SyntaxError) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned a response that was not valid JSON.', {}, 1, args.command, commandIds);
      return;
    }
    writeError('OBSERVATION_UNAVAILABLE', 'No observation was received. Check endpoint availability before requesting another read.', {}, 1, args.command, commandIds);
  }
}

export function runLocalDevelopmentCli(argv: readonly string[], token: string | undefined): Promise<void> {
  return run(argv, token, 'local-development');
}

function isMainEntrypoint(expectedFileName: string): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return basename(realpathSync(argvPath)) === expectedFileName;
  } catch {
    return basename(resolve(argvPath)) === expectedFileName;
  }
}

if (isMainEntrypoint('cli.js')) void run(process.argv.slice(2), process.env.GHATANA_MEDIA_BEARER_TOKEN, 'production');
