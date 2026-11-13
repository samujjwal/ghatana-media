// Shared helpers for the MED-09 optional-provider installed-consumer, outage and benchmark scripts.
// Everything here is a synthetic test double (fake clamd, fake DI worker). Nothing is qualification evidence.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const scannerDir = path.join(repoRoot, 'providers/security-scanner');
export const diClientDir = path.join(repoRoot, 'services/document-intelligence/clients/typescript');

export function findTsc(pkgDir) {
  const found = [
    path.join(pkgDir, 'node_modules/typescript/bin/tsc'),
    path.join(repoRoot, 'libs/audio-video-client/node_modules/typescript/bin/tsc'),
  ].find((p) => existsSync(p));
  if (!found) throw new Error(`typescript is not installed for ${pkgDir}; run the workspace install first`);
  return found;
}

/** Build a package with tsc -p tsconfig.build.json (outputs to its gitignored dist/). */
export function buildPackage(pkgDir) {
  execFileSync(process.execPath, [findTsc(pkgDir), '-p', 'tsconfig.build.json'], { cwd: pkgDir, stdio: 'inherit' });
}

/** npm pack without lifecycle scripts; returns the tarball path. */
export function packPackage(pkgDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const out = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destDir], { cwd: pkgDir, encoding: 'utf8' });
  return path.join(destDir, JSON.parse(out)[0].filename);
}

export function extractTarball(tarball, consumerDir, name) {
  const target = path.join(consumerDir, 'node_modules', ...name.split('/'));
  mkdirSync(target, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1']);
  return target;
}

/** The DI client's peer (@ghatana/document-extraction and its @ghatana/documents dependency) is an UNPUBLISHED Shared package; resolve it from the workspace link. */
export function sharedPeerDirs() {
  const ext = realpathSync(path.join(diClientDir, 'node_modules/@ghatana/document-extraction'));
  const docs = path.resolve(ext, '../documents');
  for (const d of [ext, docs]) if (!existsSync(path.join(d, 'dist/index.js'))) return undefined;
  return { 'document-extraction': ext, documents: docs };
}

export function environmentFingerprint() {
  return {
    node: process.version, platform: process.platform, arch: process.arch,
    cpus: (globalThis.navigator?.hardwareConcurrency) ?? null,
    capturedAt: new Date().toISOString(),
  };
}

/** Minimal clamd protocol double (zVERSION, zINSTREAM). EICAR substring => FOUND. mode: normal | hang. */
export async function startFakeClamd() {
  const state = { mode: 'normal', streams: 0 };
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('error', () => {});
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (state.mode === 'hang') return;
      if (buf.subarray(0, 9).toString() === 'zVERSION\0') return void s.write('ClamAV 1.4.2/27500/Tue Nov 11 08:30:12 2025\0');
      if (buf.subarray(0, 10).toString() === 'zINSTREAM\0') {
        let off = 10;
        const parts = [];
        for (;;) {
          if (buf.length < off + 4) return;
          const len = buf.readUInt32BE(off);
          if (len === 0) break;
          if (buf.length < off + 4 + len) return;
          parts.push(buf.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        }
        state.streams++;
        s.write(Buffer.concat(parts).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return Object.assign(state, {
    port: server.address().port,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  });
}

export const FAKE_DI = {
  providerRef: 'di.ocr.synthetic', providerVersion: '1.0.0', modelRef: 'model.synthetic', modelVersion: '1',
};

/** Fake DI worker speaking document-intelligence.v1 for providers() and parse(). mode: normal | garbage | hang. */
export async function startFakeDiWorker() {
  const state = { mode: 'normal', parses: 0, catalogs: 0 };
  const server = http.createServer((req, res) => {
    const send = (status, body) => { const p = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json' }); res.end(p); };
    if (state.mode === 'hang') return;
    if (state.mode === 'garbage') return send(200, 'not json at all');
    if (req.method === 'GET' && req.url === '/v1/providers') {
      state.catalogs++;
      return send(200, {
        protocolVersion: 'document-intelligence.v1', workerCapabilityVersion: 'document-intelligence-worker.v1',
        providers: [{ ...FAKE_DI, mediaTypes: ['image/png'], supportedLanguages: ['en-US'], promotionStatus: 'ACCEPTED', loaded: true, ready: true }],
      });
    }
    if (req.method === 'POST' && req.url === '/v1/parse') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.parses++;
        const text = Buffer.concat(chunks).toString('latin1');
        const operationId = /"operationId":"([^"]+)"/u.exec(text)?.[1] ?? 'unknown';
        const box = { x: 0.1, y: 0.2, width: 0.4, height: 0.1 };
        send(200, {
          protocolVersion: 'document-intelligence.v1', operationId, providerRef: FAKE_DI.providerRef,
          providerProvenance: { ...FAKE_DI },
          pages: [{ pageNumber: 1, tables: [], blocks: [{ blockId: 'b-1', kind: 'TEXT', boundingRegion: box, lines: [{ lineId: 'l-1', text: 'Exit 42', confidence: 0.98, languageTag: 'en-US', boundingRegion: box }] }] }],
          quality: { parseConfidence: 0.9, completeness: 1, warnings: [] },
        });
      });
      return;
    }
    send(404, { protocolVersion: 'document-intelligence.v1', operationId: 'x', code: 'NOT_FOUND', retryable: false });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return Object.assign(state, {
    port: server.address().port,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  });
}

/** A port that nothing listens on (bind then close). */
export async function deadPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
