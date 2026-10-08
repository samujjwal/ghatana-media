#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { MediaClientError, createMediaOperationClient } from './operations.js';

const COMMAND_ID = 'media.cli.artifact.inspect';
const USAGE = 'Usage: ghatanamedia-api artifact inspect --endpoint URL --tenant ID --principal ID --artifact ID';

interface Arguments {
  endpoint: string;
  tenant: string;
  principal: string;
  artifact: string;
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] !== 'artifact' || argv[1] !== 'inspect') throw new Error('Unknown command.');
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
  for (const required of allowed) if (!values.has(required)) throw new Error(`Missing required option ${required}.`);
  const parsed = {
    endpoint: values.get('--endpoint')!,
    tenant: values.get('--tenant')!,
    principal: values.get('--principal')!,
    artifact: values.get('--artifact')!,
  };
  for (const [name, value] of Object.entries(parsed).filter(([name]) => name !== 'endpoint')) {
    if (!/^[\x21-\x7e]{1,255}$/u.test(value)) throw new Error(`${name} must be a non-empty printable identity of at most 255 characters.`);
  }
  if (parsed.artifact === '.' || parsed.artifact === '..' || /[\\/]/u.test(parsed.artifact)) {
    throw new Error('artifact must be a single path-segment identity.');
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

function writeError(code: string, message: string, extra: Record<string, unknown> = {}, exitCode = 1): void {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 'media.cli-error.v1', commandId: COMMAND_ID, code, message, ...extra,
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

async function run(argv: readonly string[], token: string | undefined): Promise<void> {
  let args: Arguments;
  try { args = parseArguments(argv); }
  catch (error) {
    writeError('INVALID_INVOCATION', `${error instanceof Error ? error.message : 'Invalid invocation'} ${USAGE}`, {}, 2);
    return;
  }
  if (!token?.trim()) {
    writeError('MISSING_AUTH_TOKEN', 'Set GHATANA_MEDIA_BEARER_TOKEN in the environment; credentials are never accepted as command arguments.', {}, 2);
    return;
  }
  let endpoint: string;
  try { endpoint = validateEndpoint(args.endpoint); }
  catch (error) {
    writeError('INVALID_ENDPOINT', error instanceof Error ? error.message : 'Endpoint is invalid.', {}, 2);
    return;
  }

  try {
    const client = createMediaOperationClient({
      baseUrl: endpoint,
      tenantId: args.tenant,
      defaultHeaders: { 'X-Principal-Id': args.principal },
      getAccessToken: () => token,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error' }),
    });
    const artifact = await client.getArtifact(args.artifact);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 'media.cli-result.v1', commandId: COMMAND_ID, artifact })}\n`);
  } catch (error) {
    if (error instanceof MediaClientError) {
      if (error.statusCode === 404 && error.detail.code === 'ARTIFACT_NOT_FOUND') {
        writeError('ARTIFACT_NOT_FOUND', 'Artifact was not visible in the requested tenant and principal scope.', {
          statusCode: 404, ...safeCorrelationExtra(error.detail.correlationId, token),
        });
      } else {
        writeError('MEDIA_REQUEST_FAILED', 'Media did not return an artifact observation; success is not inferred.', {
          statusCode: error.statusCode, ...safeCorrelationExtra(error.detail.correlationId, token),
        });
      }
      return;
    }
    if (error instanceof TypeError && /^Canonical Media artifact/u.test(error.message)) {
      writeError('INVALID_MEDIA_RESPONSE', 'Media returned an artifact response that did not match the canonical runtime DTO.');
      return;
    }
    writeError('OBSERVATION_UNAVAILABLE', 'No artifact observation was received. Check the configured endpoint and retry this read.');
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
