import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const devBin = fileURLToPath(new URL('../dist/cli-dev.js', import.meta.url));
const endpoint = 'http://127.0.0.1:43127';
const directoryPromise = mkdtemp(join(tmpdir(), 'media-cli-unbound-local-'));
let directory: string;
let preload: string;

const token = (() => {
  const iat = Math.floor(Date.now() / 1_000);
  const claims = {
    sub: 'principal-a', tenant_id: 'tenant-a', iss: 'urn:ghatana:media:dev-only', aud: 'ghatana-media-dev',
    dev_only: true, iat, exp: iat + 120,
    permissions: ['media:project:dev:read', 'media:project:dev:write', 'media:artifact:read', 'media:artifact:create',
      'media:delivery:dev:export', 'media:delivery:dev:read'],
  };
  return `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
})();

beforeAll(async () => {
  directory = await directoryPromise;
  preload = join(directory, 'fetch.mjs');
  await writeFile(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (input, init = {}) => {
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ url: String(input), method: init.method ?? 'GET' }) + '\\n');
  return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fixture response', retryable: false } }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });
};
`);
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function invoke(args: string[], logPath: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, devBin, ...args], {
      env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: token, FIXTURE_LOG: logPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

const common = ['--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a'];
const unboundCommands = [
  { name: 'project render', args: ['project', 'render', ...common, '--project-id', 'project-a', '--revision-id', 'rev-1',
    '--timeline-id', 'timeline-a', '--request-id', 'request-a', '--width', '32', '--height', '24', '--fps', '10'] },
  { name: 'project render-get', args: ['project', 'render-get', ...common, '--project-id', 'project-a', '--render-id', 'render-a'] },
  { name: 'export create', args: ['export', 'create', ...common, '--request-id', 'request-a', '--artifact-id', 'artifact-a',
    '--artifact-version-id', `sha256:${'b'.repeat(64)}`, '--destination-id', 'destination-a'] },
  { name: 'export get', args: ['export', 'get', ...common, '--request-id', 'request-a'] },
];

describe('ghatanamedia-api-dev unbound render/export commands', () => {
  it.each(unboundCommands)('$name is rejected before credentials or transport dispatch', async ({ name, args }) => {
    const logPath = join(directory, `${name.replaceAll(' ', '-')}.jsonl`);
    const result = await invoke(args, logPath);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.invocation', code: 'INVALID_INVOCATION',
    });
    expect(JSON.parse(result.stderr).message).not.toContain(name);
    expect(result.stderr).not.toContain(token);
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
