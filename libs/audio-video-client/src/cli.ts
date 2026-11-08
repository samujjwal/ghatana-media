#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { MediaClientError } from './http-core.js';
import { createMediaOperationClient } from './operations.js';

const COMMAND_IDS: Readonly<Record<string, string>> = {
  'artifact inspect': 'media.cli.artifact.inspect',
};
const USAGE = 'Usage: ghatanamedia-api artifact inspect --endpoint URL --tenant ID --principal ID --artifact ID';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_ENDPOINT_URL_CHARS = 8_192;

interface Arguments {
  command: string;
  endpoint: string;
  tenant: string;
  principal: string;
  values: Readonly<Record<string, string>>;
}

function parseArguments(argv: readonly string[]): Arguments {
  const command = `${argv[0] ?? ''} ${argv[1] ?? ''}`;
  if (!Object.hasOwn(COMMAND_IDS, command)) throw new Error('Unknown command.');
  const values = new Map<string, string>();
  const allowed = new Set(['--endpoint', '--tenant', '--principal', '--artifact']);
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
    if (!/^[\x21-\x7e]{1,255}$/u.test(value)) throw new Error(`${name} must be a non-empty printable identity of at most 255 characters.`);
  }
  if (!values.has('--artifact')) throw new Error('Missing required option --artifact.');
  const artifact = values.get('--artifact')!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(artifact)) {
    throw new Error('artifact ID must start with a letter or number and use only letters, numbers, dots, underscores, colons, or hyphens (maximum 128 characters).');
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

function writeError(code: string, message: string, extra: Record<string, unknown> = {}, exitCode = 1, command = 'artifact inspect'): void {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 'media.cli-error.v1', commandId: COMMAND_IDS[command] ?? 'media.cli.invocation', code, message, ...extra,
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

async function run(argv: readonly string[], token: string | undefined): Promise<void> {
  // Environment values often come from secret stores or files that append a
  // newline. Bearer credentials are opaque, but surrounding whitespace is not
  // part of the credential and must not be sent as part of the header.
  const bearerToken = token?.trim();
  let args: Arguments;
  try { args = parseArguments(argv); }
  catch (error) {
    writeError('INVALID_INVOCATION', `${error instanceof Error ? error.message : 'Invalid invocation'} ${USAGE}`, {}, 2, `${argv[0] ?? ''} ${argv[1] ?? ''}`);
    return;
  }
  if (!bearerToken) {
    writeError('MISSING_AUTH_TOKEN', 'Set GHATANA_MEDIA_BEARER_TOKEN in the environment; credentials are never accepted as command arguments.', {}, 2, args.command);
    return;
  }
  // Fetch forbids control characters in HTTP header values. Catch malformed
  // local configuration here so it cannot be mistaken for a remote outage.
  if (/[\u0000-\u001f\u007f]/u.test(bearerToken)) {
    writeError('INVALID_CONFIGURATION', 'GHATANA_MEDIA_BEARER_TOKEN contains characters that cannot be sent in an HTTP header.', {}, 2, args.command);
    return;
  }
  // RFC 6750 bearer credentials allow visible token characters followed only
  // by optional trailing '=' padding. Reject malformed local credentials
  // before fetch can send them or a remote service can misclassify the error.
  if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(bearerToken)) {
    writeError('INVALID_CONFIGURATION', 'GHATANA_MEDIA_BEARER_TOKEN is not a valid bearer credential.', {}, 2, args.command);
    return;
  }
  let requestTimeoutMs: number;
  try { requestTimeoutMs = parseRequestTimeout(process.env.GHATANA_MEDIA_REQUEST_TIMEOUT_MS); }
  catch (error) {
    writeError('INVALID_CONFIGURATION', error instanceof Error ? error.message : 'Request timeout configuration is invalid.', {}, 2, args.command);
    return;
  }
  let endpoint: string;
  try { endpoint = validateEndpoint(args.endpoint); }
  catch (error) {
    writeError('INVALID_ENDPOINT', error instanceof Error ? error.message : 'Endpoint is invalid.', {}, 2, args.command);
    return;
  }

  try {
    const client = createMediaOperationClient({
      baseUrl: endpoint,
      tenantId: args.tenant,
      requestTimeoutMs,
      defaultHeaders: { 'X-Principal-Id': args.principal },
      getAccessToken: () => bearerToken,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error' }),
    });
    const artifact = await client.getArtifact(args.values['--artifact']!);
    if (containsCredential(artifact, bearerToken)) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned an artifact response containing credential material.', {}, 1, args.command);
      return;
    }
    const canonicalArtifact = { ...artifact, metadata: canonicalizeJsonValue(artifact.metadata) };
    process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: COMMAND_IDS[args.command], artifact: canonicalArtifact })}\n`);
  } catch (error) {
    if (error instanceof MediaClientError) {
      if (error.statusCode === 404 && error.detail.code === 'ARTIFACT_NOT_FOUND') {
        writeError('ARTIFACT_NOT_FOUND', 'Artifact was not visible in the requested tenant and principal scope.', {
          statusCode: 404, ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
        }, 1, args.command);
      } else {
        writeError('MEDIA_REQUEST_FAILED', 'Media did not return an artifact observation; success is not inferred.', {
          statusCode: error.statusCode, ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
        }, 1, args.command);
      }
      return;
    }
    if (error instanceof TypeError && /^Canonical Media artifact/u.test(error.message)) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned a response that did not match the canonical runtime DTO.', {}, 1, args.command);
      return;
    }
    if (error instanceof SyntaxError) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned a response that was not valid JSON.', {}, 1, args.command);
      return;
    }
    writeError('OBSERVATION_UNAVAILABLE', 'No observation was received. Check the configured endpoint and retry this read.', {}, 1, args.command);
  }
}

function isMainEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(argvPath) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainEntrypoint()) void run(process.argv.slice(2), process.env.GHATANA_MEDIA_BEARER_TOKEN);
