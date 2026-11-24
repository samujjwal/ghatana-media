import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const devBin = fileURLToPath(new URL('../dist/cli-dev.js', import.meta.url));
const endpoint = 'http://127.0.0.1:43127';
let directory: string;
let preload: string;
let logPath: string;
let missingBatchPath: string;

const token = (() => {
  const iat = Math.floor(Date.now() / 1_000);
  const claims = {
    sub: 'principal-a', tenant_id: 'tenant-a', iss: 'urn:ghatana:media:dev-only', aud: 'ghatana-media-dev',
    dev_only: true, iat, exp: iat + 120, permissions: ['media:job:read'],
  };
  return `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
})();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'media-cli-unbound-batch-'));
  preload = join(directory, 'fetch.mjs');
  logPath = join(directory, 'requests.jsonl');
  missingBatchPath = join(directory, 'not-admitted-batch.json');
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

function invoke() {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, devBin, 'batch', 'run', '--endpoint', endpoint,
      '--tenant', 'tenant-a', '--principal', 'principal-a', '--file', missingBatchPath], {
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

describe('ghatanamedia-api-dev unbound batch command', () => {
  it('rejects batch run before reading its file or dispatching any item', async () => {
    const result = await invoke();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.invocation', code: 'INVALID_INVOCATION',
    });
    expect(JSON.parse(result.stderr).message).not.toContain('batch run');
    expect(result.stderr).not.toContain(token);
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
