#!/usr/bin/env node
// MED-09(a): packed-tarball installed-consumer check for the two optional Media providers.
// Builds + `npm pack`s the DI TypeScript client and the security-scanner provider, extracts them into an EMPTY
// project's node_modules (plus the unpublished Shared peer packages the DI client requires), then runs a
// consumer script from that project that uses ONLY package-name entrypoints (real Node resolution), against
// synthetic fakes (fake clamd, fake DI worker). Not qualification evidence; no published/immutable artifact.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPackage, diClientDir, extractTarball, packPackage, scannerDir, sharedPeerDirs, startFakeClamd, startFakeDiWorker } from './support.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'media-optional-consumer-'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); if (!ok) failed++; };
const walk = (d, out = []) => { for (const e of readdirSync(d)) { const p = path.join(d, e); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
const externalImports = (dir) => {
  const found = new Set();
  for (const f of walk(dir).filter((f) => f.endsWith('.js'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/gm)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('.')) found.add(spec);
    }
  }
  return [...found];
};

const peers = sharedPeerDirs();
let clamd; let worker;
try {
  if (!peers) throw new Error('Shared @ghatana/document-extraction / @ghatana/documents dist not built in ../ghatana-shared (needed as the DI client peer)');
  buildPackage(scannerDir);
  buildPackage(diClientDir);
  const tarballs = {
    scanner: packPackage(scannerDir, path.join(work, 'tarballs')),
    di: packPackage(diClientDir, path.join(work, 'tarballs')),
    extraction: packPackage(peers['document-extraction'], path.join(work, 'tarballs')),
    documents: packPackage(peers.documents, path.join(work, 'tarballs')),
  };
  const consumer = path.join(work, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'empty-consumer', private: true, type: 'module' }));
  const scanner = extractTarball(tarballs.scanner, consumer, '@ghatana-media/security-scanner-provider');
  const di = extractTarball(tarballs.di, consumer, '@ghatana/document-intelligence-client');
  extractTarball(tarballs.extraction, consumer, '@ghatana/document-extraction');
  extractTarball(tarballs.documents, consumer, '@ghatana/documents');

  const scannerManifest = JSON.parse(readFileSync(path.join(scanner, 'package.json'), 'utf8'));
  const diManifest = JSON.parse(readFileSync(path.join(di, 'package.json'), 'utf8'));
  check('scanner: no runtime dependencies; only node:* imports', !scannerManifest.dependencies && externalImports(path.join(scanner, 'dist')).every((s) => s.startsWith('node:')), externalImports(path.join(scanner, 'dist')).join(','));
  check('DI client: only external import is its declared peer @ghatana/document-extraction', JSON.stringify(externalImports(path.join(di, 'dist'))) === JSON.stringify(['@ghatana/document-extraction']), externalImports(path.join(di, 'dist')).join(','));
  check('DI client: peer declared, no hard dependencies', Boolean(diManifest.peerDependencies?.['@ghatana/document-extraction']) && !diManifest.dependencies);
  check('tarballs contain dist only (no src/tests)', [scanner, di].every((d) => walk(d).every((f) => /\/(dist|package\.json|README\.md)/u.test(f.slice(d.length)))));

  clamd = await startFakeClamd();
  worker = await startFakeDiWorker();
  writeFileSync(path.join(consumer, 'consumer.mjs'), `
import { createHash } from 'node:crypto';
import * as scannerPkg from '@ghatana-media/security-scanner-provider';
import * as diPkg from '@ghatana/document-intelligence-client';
const { ClamdEngine, SecurityScannerProvider, ScannerHttpService, bearerTokenAuthenticator, hmacSha256Signer, verifyCleanAttestation } = scannerPkg;
const { DocumentIntelligenceClient, PROTOCOL_VERSION } = diPkg;
const out = {};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const content = Buffer.from('installed-consumer-bytes');
const signer = hmacSha256Signer('consumer-key', Buffer.alloc(32, 3));
const clock = () => new Date('2025-11-12T12:00:00Z');
const provider = new SecurityScannerProvider({
  engine: new ClamdEngine({ endpoint: { kind: 'tcp', host: '127.0.0.1', port: ${clamd.port} }, maxBytes: 1 << 20, maxAttempts: 1 }),
  source: { read: async () => ({ tenantId: 't1', content }) }, signer, scannerRef: 'consumer-scanner',
  pinnedEngineVersions: ['ClamAV 1.4.2'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 3 * 86_400_000, attestationTtlMs: 60_000, now: clock,
});
const req = { documentId: 'd1', version: 1, tenantId: 't1', checksum: { algorithm: 'SHA-256', value: sha(content) }, sizeBytes: content.length, mimeType: 'application/pdf' };
const att = await provider.scan(req);
out.scanClean = att.status === 'CLEAN' && verifyCleanAttestation(att, [signer], { tenantId: 't1', checksum: req.checksum, now: clock() }).ok === true;

const svc = new ScannerHttpService({ provider, engine: new ClamdEngine({ endpoint: { kind: 'tcp', host: '127.0.0.1', port: ${clamd.port} }, maxBytes: 1 << 20, maxAttempts: 1 }),
  pinnedEngineVersions: ['ClamAV 1.4.2'], maxDefinitionsAgeMs: 3 * 86_400_000, now: clock,
  authenticate: bearerTokenAuthenticator([{ token: 'c'.repeat(40), principalId: 'p', tenantIds: ['t1'] }]) });
const addr = await svc.listen(0);
out.serviceNoAuth401 = (await fetch('http://127.0.0.1:' + addr.port + '/v1/health')).status === 401;
const health = await (await fetch('http://127.0.0.1:' + addr.port + '/v1/health', { headers: { authorization: 'Bearer ' + 'c'.repeat(40) } })).json();
out.serviceHealth = health.admissionState === 'NOT_ADMITTED' && health.productionEligible === false;
await svc.close();

const di = new DocumentIntelligenceClient({ baseUrl: 'http://127.0.0.1:${worker.port}', defaultTimeoutMs: 2000 });
const catalog = await di.providers();
out.diCatalog = catalog.protocolVersion === PROTOCOL_VERSION && di.lastProtocolVersion === PROTOCOL_VERSION;
const parsed = await di.parse({ operationId: 'op-1', providerRef: 'di.ocr.synthetic', mediaType: 'image/png', timeoutMs: 2000, limits: { maxPages: 1 }, bytes: new Uint8Array([1, 2, 3]) });
out.diParse = parsed.operationId === 'op-1' && parsed.pages[0].blocks[0].lines[0].text === 'Exit 42';

for (const [label, spec] of [['scanner', '@ghatana-media/security-scanner-provider/dist/index.js'], ['di', '@ghatana/document-intelligence-client/dist/index.js'], ['scannerSrc', '@ghatana-media/security-scanner-provider/src/provider.ts']]) {
  try { await import(spec); out['deepImportBlocked_' + label] = false; } catch (e) { out['deepImportBlocked_' + label] = e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
}
console.log(JSON.stringify(out));
`);
  // Async spawn: the fake clamd/DI worker live in this process and must keep serving.
  const { stdout } = await promisify(execFile)(process.execPath, ['consumer.mjs'], { cwd: consumer, encoding: 'utf8' });
  const r = JSON.parse(stdout.trim().split('\n').pop());
  check('scanner: signed CLEAN attestation verifies from published entry point', r.scanClean);
  check('scanner HTTP service: unauthenticated request refused; health is NOT_ADMITTED', r.serviceNoAuth401 && r.serviceHealth);
  check('DI client: providers() + parse() round trip against fake worker', r.diCatalog && r.diParse);
  check('only public entrypoints: dist/ and src/ deep imports are blocked by the exports map', r.deepImportBlocked_scanner && r.deepImportBlocked_di && r.deepImportBlocked_scannerSrc);
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await clamd?.close();
  await worker?.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS (synthetic fakes only; no published artifact, not qualification)');
process.exit(failed ? 1 : 0);
