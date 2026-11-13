#!/usr/bin/env node
// Installed-consumer qualification (MED-05/MED-09 partial): build -> npm pack -> install the tarball
// into an empty project -> exercise ONLY the published entry point against a fake clamd. Proves the
// package is self-contained (no Media core, no Shared source, no runtime dependencies) and that a
// scanner-engine outage degrades to UNKNOWN without affecting an unrelated consumer service.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// TypeScript compiler entry: provider-local install first, then the workspace copy.
const tsc = [path.join(root, 'node_modules/typescript/bin/tsc'), path.resolve(root, '../../libs/audio-video-client/node_modules/typescript/bin/tsc')]
  .find((p) => existsSync(p));
if (!tsc) throw new Error('typescript is not installed; run the workspace install first');
const work = mkdtempSync(path.join(tmpdir(), 'scanner-consumer-'));
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
  const packOut = execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8' });
  const tarball = path.join(work, JSON.parse(packOut)[0].filename);
  const consumer = path.join(work, 'consumer');
  const target = path.join(consumer, 'node_modules/@ghatana-media/security-scanner-provider');
  mkdirSync(target, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1']);

  const manifest = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
  check('no runtime dependencies', !manifest.dependencies || Object.keys(manifest.dependencies).length === 0);
  const files = [];
  (function walk(d) { for (const e of readdirSync(d)) { const p = path.join(d, e); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(path.join(target, 'dist'));
  const bad = [];
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/gm)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('node:') && !spec.startsWith('./')) bad.push(`${path.basename(f)}:${spec}`);
    }
  }
  check('published code imports only node:* and package-relative files', bad.length === 0, bad.join(','));

  const lib = await import(pathToFileURL(path.join(target, 'dist/index.js')).href);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('error', () => {});
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.subarray(0, 9).toString() === 'zVERSION\0') return void s.write('ClamAV 1.4.2/27500/Tue Nov 11 08:30:12 2025\0');
      if (buf.subarray(0, 10).toString() === 'zINSTREAM\0' && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) s.write('stream: OK\0');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const content = Buffer.from('installed-consumer-bytes');
  const signer = lib.hmacSha256Signer('consumer-test-key', Buffer.alloc(32, 3));
  const clock = () => new Date('2025-11-12T12:00:00Z');
  const mk = (p) => new lib.SecurityScannerProvider({
    engine: new lib.ClamdEngine({ endpoint: { kind: 'tcp', host: '127.0.0.1', port: p }, maxBytes: 1 << 20, connectTimeoutMs: 300, commandTimeoutMs: 500, maxAttempts: 1 }),
    source: { read: async () => ({ tenantId: 't1', content }) }, signer, scannerRef: 'installed-consumer',
    pinnedEngineVersions: ['ClamAV 1.4.2'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 3 * 86_400_000, attestationTtlMs: 60_000, now: clock,
  });
  const req = { documentId: 'd1', version: 1, tenantId: 't1', checksum: { algorithm: 'SHA-256', value: sha(content) }, sizeBytes: content.length, mimeType: 'application/pdf' };

  // Unrelated consumer service (stand-in for a Media own-upload/status path): independent of the scanner.
  const unrelated = async () => ({ status: 'ok', n: [1, 2, 3].reduce((a, b) => a + b) });

  const up = await mk(port).scan(req);
  check('scanner up: signed CLEAN', up.status === 'CLEAN' && up.scannedDigest.value === sha(content));
  check('verifier accepts it', lib.verifyCleanAttestation(up, [signer], { tenantId: 't1', checksum: req.checksum, now: clock() }).ok === true);

  await new Promise((r) => server.close(r));
  const down = await mk(port).scan(req);
  check('scanner outage: UNKNOWN projected to FAILED (never throws, never CLEAN)', down.status === 'FAILED' && down.verdict === 'UNKNOWN' && down.reasonCode === 'ENGINE_UNAVAILABLE');
  check('unrelated service stays available during scanner outage', (await unrelated()).status === 'ok');
} catch (e) {
  console.error(e);
  failed++;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
