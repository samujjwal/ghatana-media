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
const JOB_TYPES = new Set(['TRANSCODE', 'SPEECH_TO_TEXT', 'TEXT_TO_SPEECH', 'VISION', 'MULTIMODAL']);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_PARAMETERS_BYTES = 64 * 1024;
const MAX_PARAMETERS_DEPTH = 32;

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
    if (value !== undefined && (!/^[\x21-\x7e]{1,255}$/u.test(value) || value === '.' || value === '..' || /[\\/]/u.test(value))) {
      throw new Error(`${option.slice(2)} must be a printable single path-segment identity of at most 255 characters.`);
    }
  }
  for (const option of ['--request-id', '--correlation-id', '--idempotency-key']) {
    const value = values.get(option);
    if (value !== undefined && !/^[\x21-\x7e]{1,255}$/u.test(value)) {
      throw new Error(`${option.slice(2)} must be a non-empty printable identity of at most 255 characters.`);
    }
  }
  const jobType = values.get('--job-type');
  if (jobType !== undefined && !JOB_TYPES.has(jobType)) {
    throw new Error('--job-type must be one of the canonical Media job types.');
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

function parseStrictJsonObject(input: string): Record<string, unknown> {
  if (new TextEncoder().encode(input).byteLength > MAX_PARAMETERS_BYTES) {
    throw new Error(`--parameters must not exceed ${MAX_PARAMETERS_BYTES} UTF-8 bytes.`);
  }
  let offset = 0;
  const fail = (): never => { throw new Error('--parameters must be a strict JSON object.'); };
  const whitespace = (): void => {
    while (input[offset] === ' ' || input[offset] === '\n' || input[offset] === '\r' || input[offset] === '\t') offset += 1;
  };
  const string = (): string => {
    const start = offset;
    if (input[offset] !== '"') return fail();
    offset += 1;
    let escaped = false;
    while (offset < input.length) {
      const character = input[offset]!;
      offset += 1;
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') {
        try {
          const parsed = JSON.parse(input.slice(start, offset)) as string;
          // URL and JSON encoders replace unpaired UTF-16 surrogates with U+FFFD.
          // Reject them here so a parameter value cannot change during dispatch.
          for (let index = 0; index < parsed.length; index += 1) {
            const unit = parsed.charCodeAt(index);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              const next = parsed.charCodeAt(index + 1);
              if (!(next >= 0xdc00 && next <= 0xdfff)) return fail();
              index += 1;
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              return fail();
            }
          }
          return parsed;
        }
        catch { return fail(); }
      }
      if (character.charCodeAt(0) < 0x20) return fail();
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_PARAMETERS_DEPTH) return fail();
    whitespace();
    const character = input[offset];
    if (character === '"') return string();
    if (character === '{') {
      offset += 1;
      whitespace();
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      if (input[offset] === '}') { offset += 1; return object; }
      while (true) {
        whitespace();
        const key = string();
        if (seen.has(key)) return fail();
        seen.add(key);
        whitespace();
        if (input[offset] !== ':') return fail();
        offset += 1;
        object[key] = value(depth + 1);
        whitespace();
        if (input[offset] === '}') { offset += 1; return object; }
        if (input[offset] !== ',') return fail();
        offset += 1;
      }
    }
    if (character === '[') {
      offset += 1;
      whitespace();
      const array: unknown[] = [];
      if (input[offset] === ']') { offset += 1; return array; }
      while (true) {
        array.push(value(depth + 1));
        whitespace();
        if (input[offset] === ']') { offset += 1; return array; }
        if (input[offset] !== ',') return fail();
        offset += 1;
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (input.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(input.slice(offset));
    if (numeric) {
      offset += numeric[0].length;
      const numberToken = numeric[0];
      const number = Number(numberToken);
      // JSON permits integers that JavaScript cannot represent exactly. Letting
      // one through would silently change the submitted operation parameters.
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) return fail();
      // A fractional decimal near the safe-integer boundary can round *down* to
      // a safe integer (for example 9007199254740991.1 -> 9007199254740991).
      // Do not let that turn a non-integer request value into an integer.
      if (Number.isInteger(number) && numberToken.includes('.')) {
        const [mantissa, exponentText = '0'] = numberToken.split(/[eE]/u);
        const fraction = mantissa!.split('.')[1] ?? '';
        const exponent = Number(exponentText);
        const digits = mantissa!.replace(/[-.]/gu, '');
        const trailingZeroes = digits.length - digits.replace(/0+$/u, '').length;
        const placesToShift = fraction.length - exponent;
        if (digits.replace(/0/gu, '').length > 0
          && (!Number.isSafeInteger(placesToShift) || (placesToShift > 0 && trailingZeroes < placesToShift))) return fail();
      }
      return number;
    }
    return fail();
  };

  whitespace();
  if (input[offset] !== '{') return fail();
  const parsed = value(0);
  whitespace();
  if (offset !== input.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
  return parsed as Record<string, unknown>;
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
  const credentialKeys = new Set(['authorization', 'accesstoken', 'refreshtoken', 'clientsecret', 'apikey', 'password', 'credential', 'credentials', 'privatekey']);
  if (typeof value === 'string') return secrets.some(secret => value.includes(secret));
  if (Array.isArray(value)) return value.some(item => containsCredential(item, token));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => secrets.some(secret => key.includes(secret))
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

  if (args.command === 'capture start' || args.command === 'recorder start') {
    writeError('NOT_ADMITTED', 'Capture and recorder execution require contracts not exposed by the canonical SDK.', {}, 3, args.command);
    return;
  }

  try {
    if (args.command.startsWith('job ')) {
      const client = createMediaCanonicalClient({
        baseUrl: endpoint,
        tenantId: args.tenant,
        requestTimeoutMs,
        defaultHeaders: { 'X-Principal-Id': args.principal },
        getAccessToken: () => bearerToken,
        fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      });
      let job;
      if (args.command === 'job status') job = await client.getJob(args.values['--job']!);
      else if (args.command === 'job cancel') job = await client.cancelJob(args.values['--job']!);
      else {
        const jobType = args.values['--job-type']!;
        let parameters: Record<string, unknown>;
        try { parameters = args.values['--parameters'] === undefined ? {} : parseStrictJsonObject(args.values['--parameters']); }
        catch (error) {
          writeError('INVALID_INVOCATION', error instanceof Error ? error.message : '--parameters is invalid.', {}, 2, args.command);
          return;
        }
        if (containsCredential(parameters, bearerToken)) {
          writeError('INVALID_INVOCATION', '--parameters must not contain bearer credential material.', {}, 2, args.command);
          return;
        }
        job = await client.submitJob({
          requestId: args.values['--request-id']!, correlationId: args.values['--correlation-id']!,
          artifactId: args.values['--artifact']!, jobType: jobType as 'TRANSCODE' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH' | 'VISION' | 'MULTIMODAL',
          idempotencyKey: args.values['--idempotency-key']!, parameters: parameters as Record<string, unknown>,
        });
      }
      if (containsCredential(job, bearerToken)) {
        writeError('INVALID_MEDIA_RESPONSE', 'Media returned a job response containing credential material.', {}, 1, args.command);
        return;
      }
      if (args.command === 'job submit'
        && (job.requestId !== args.values['--request-id']
          || job.artifactId !== args.values['--artifact']
          || job.jobType !== args.values['--job-type'])) {
        writeError('INVALID_MEDIA_RESPONSE', 'Media returned a job response that does not match the submitted request.', {}, 1, args.command);
        return;
      }
      const canonicalJob = { ...job, result: canonicalizeJsonValue(job.result) };
      if (job.status === 'OUTCOME_UNKNOWN') {
        writeError('OUTCOME_UNKNOWN', args.command === 'job status'
          ? 'The observed job state is OUTCOME_UNKNOWN; reconcile with the canonical job service.'
          : 'The job operation outcome is not confirmed; reconcile the returned job before retrying.', {
          jobId: job.jobId, requestId: job.requestId,
        }, 3, args.command);
        return;
      }
      process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: COMMAND_IDS[args.command], job: canonicalJob })}\n`);
      return;
    }
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
          statusCode: 404, ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
        }, 1, args.command);
      } else {
        const message = args.command === 'job submit'
          ? 'Media did not return an authoritative job acknowledgement; success is not inferred.'
          : args.command.startsWith('job ')
            ? 'Media did not return the requested job observation; success is not inferred.'
            : 'Media did not return an artifact observation; success is not inferred.';
        writeError('MEDIA_REQUEST_FAILED', message, {
          statusCode: error.statusCode, ...safeCorrelationExtra(error.detail.correlationId, bearerToken),
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
