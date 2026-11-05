#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createMediaCanonicalClient } from './canonical-operations.js';
import { MediaClientError, MediaOperationAmbiguousError, MediaOperationNotAdmittedError } from './http-core.js';
import { createMediaOperationClient } from './operations.js';

const COMMAND_IDS: Readonly<Record<string, string>> = {
  'artifact inspect': 'media.cli.artifact.inspect',
  'job status': 'media.cli.job.status',
  'job cancel': 'media.cli.job.cancel',
  'job submit': 'media.cli.job.submit',
  'capture start': 'media.cli.capture.start',
  'recorder start': 'media.cli.recorder.start',
};
const USAGE = 'Usage: ghatanamedia-api <artifact inspect|job status|job cancel|job submit|capture start|recorder start> --endpoint URL --tenant ID --principal ID [operation options]';

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
  const operationOptions: Readonly<Record<string, readonly string[]>> = {
    'artifact inspect': ['--artifact'],
    'job status': ['--job'],
    'job cancel': ['--job'],
    'job submit': ['--request-id', '--correlation-id', '--artifact', '--job-type', '--idempotency-key', '--parameters'],
    'capture start': [],
    'recorder start': [],
  };
  const allowed = new Set(['--endpoint', '--tenant', '--principal', ...(operationOptions[command] ?? [])]);
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
  const required = (operationOptions[command] ?? []).filter((option) => option !== '--parameters');
  for (const option of required) if (!values.has(option)) throw new Error(`Missing required option ${option}.`);
  for (const option of ['--artifact', '--job']) {
    const value = values.get(option);
    if (value !== undefined && (value === '.' || value === '..' || /[\\/]/u.test(value))) {
      throw new Error(`${option.slice(2)} must be a single path-segment identity.`);
    }
  }
  return parsed;
}

function validateEndpoint(input: string): string {
  let endpoint: URL;
  try { endpoint = new URL(input); }
  catch { throw new Error('Endpoint must be an absolute HTTPS URL (HTTP is allowed only for loopback testing).'); }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const loopbackHttp = endpoint.protocol === 'http:' && localHosts.has(endpoint.hostname.toLowerCase());
  if ((endpoint.protocol !== 'https:' && !loopbackHttp)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Endpoint must use HTTPS, contain no credentials or query, and use HTTP only on loopback.');
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

function writeError(code: string, message: string, extra: Record<string, unknown> = {}, exitCode = 1, command = 'artifact inspect'): void {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 'media.cli-error.v1', commandId: COMMAND_IDS[command] ?? 'media.cli.invocation', code, message, ...extra,
  })}\n`);
  process.exitCode = exitCode;
}

function safeCorrelationExtra(correlationId: unknown, token: string): Record<string, string> {
  if (typeof correlationId !== 'string' || correlationId.length < 1 || correlationId.length > 255
    || !/^[^\u0000-\u001f\u007f]+$/u.test(correlationId) || !correlationId.trim()
    || correlationId === 'not-reported') return {};
  const secrets = [token, token.trim()].filter(Boolean);
  if (secrets.some(secret => correlationId.includes(secret))) return {};
  return { correlationId };
}

function containsCredential(value: unknown, token: string): boolean {
  const secrets = [token, token.trim()].filter(Boolean);
  if (typeof value === 'string') return secrets.some(secret => value.includes(secret));
  if (Array.isArray(value)) return value.some(item => containsCredential(item, token));
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => containsCredential(item, token));
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
  let args: Arguments;
  try { args = parseArguments(argv); }
  catch (error) {
    writeError('INVALID_INVOCATION', `${error instanceof Error ? error.message : 'Invalid invocation'} ${USAGE}`, {}, 2, `${argv[0] ?? ''} ${argv[1] ?? ''}`);
    return;
  }
  if (!token?.trim()) {
    writeError('MISSING_AUTH_TOKEN', 'Set GHATANA_MEDIA_BEARER_TOKEN in the environment; credentials are never accepted as command arguments.', {}, 2, args.command);
    return;
  }
  let endpoint: string;
  try { endpoint = validateEndpoint(args.endpoint); }
  catch (error) {
    writeError('INVALID_ENDPOINT', error instanceof Error ? error.message : 'Endpoint is invalid.', {}, 2, args.command);
    return;
  }

  if (args.command === 'capture start' || args.command === 'recorder start') {
    writeError('NOT_ADMITTED', 'Capture and recorder execution require contracts not exposed by the canonical SDK.', {}, 3, args.command);
    return;
  }

  try {
    if (args.command.startsWith('job ')) {
      const client = createMediaCanonicalClient({
        baseUrl: endpoint,
        tenantId: args.tenant,
        defaultHeaders: { 'X-Principal-Id': args.principal },
        getAccessToken: () => token,
        fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      });
      let job;
      if (args.command === 'job status') job = await client.getJob(args.values['--job']!);
      else if (args.command === 'job cancel') job = await client.cancelJob(args.values['--job']!);
      else {
        let parameters: unknown = {};
        try { parameters = args.values['--parameters'] === undefined ? {} : JSON.parse(args.values['--parameters']); }
        catch { writeError('INVALID_INVOCATION', '--parameters must be valid JSON.', {}, 2, args.command); return; }
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
          writeError('INVALID_INVOCATION', '--parameters must be a JSON object.', {}, 2, args.command); return;
        }
        job = await client.submitJob({
          requestId: args.values['--request-id']!, correlationId: args.values['--correlation-id']!,
          artifactId: args.values['--artifact']!, jobType: args.values['--job-type'] as 'TRANSCODE' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH' | 'VISION' | 'MULTIMODAL',
          idempotencyKey: args.values['--idempotency-key']!, parameters: parameters as Record<string, unknown>,
        });
      }
      if (containsCredential(job, token)) {
        writeError('INVALID_MEDIA_RESPONSE', 'Media returned a job response containing credential material.', {}, 1, args.command);
        return;
      }
      const canonicalJob = { ...job, result: canonicalizeJsonValue(job.result) };
      process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: COMMAND_IDS[args.command], job: canonicalJob })}\n`);
      return;
    }
    const client = createMediaOperationClient({
      baseUrl: endpoint,
      tenantId: args.tenant,
      defaultHeaders: { 'X-Principal-Id': args.principal },
      getAccessToken: () => token,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error' }),
    });
    const artifact = await client.getArtifact(args.values['--artifact']!);
    if (containsCredential(artifact, token)) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned an artifact response containing credential material.', {}, 1, args.command);
      return;
    }
    const canonicalArtifact = { ...artifact, metadata: canonicalizeJsonValue(artifact.metadata) };
    process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: COMMAND_IDS[args.command], artifact: canonicalArtifact })}\n`);
  } catch (error) {
    if (error instanceof MediaOperationNotAdmittedError) {
      writeError('NOT_ADMITTED', 'This operation has no admitted canonical route.', { operation: error.operation }, 3, args.command);
      return;
    }
    if (error instanceof MediaOperationAmbiguousError) {
      writeError('OUTCOME_UNKNOWN', 'The request was dispatched without an authoritative acknowledgement; reconcile before retrying.', {
        requestId: error.requestId, requestKey: error.requestKey,
      }, 3, args.command);
      return;
    }
    if (error instanceof MediaClientError) {
      if (error.statusCode === 404 && error.detail.code === 'ARTIFACT_NOT_FOUND') {
        writeError('ARTIFACT_NOT_FOUND', 'Artifact was not visible in the requested tenant and principal scope.', {
          statusCode: 404, ...safeCorrelationExtra(error.detail.correlationId, token),
        }, 1, args.command);
      } else {
        writeError('MEDIA_REQUEST_FAILED', 'Media did not return an artifact observation; success is not inferred.', {
          statusCode: error.statusCode, ...safeCorrelationExtra(error.detail.correlationId, token),
        }, 1, args.command);
      }
      return;
    }
    if (error instanceof TypeError && /^Canonical Media (artifact|job)/u.test(error.message)) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned a response that did not match the canonical runtime DTO.', {}, 1, args.command);
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
