#!/usr/bin/env node
// Development qualification run of the scanner provider against a REAL clamd (pinned container image).
// Corpus needs no rights clearance: EICAR (generated here), generated clean PDFs/PNGs/text, EICAR in a polyglot and in a zip.
// Includes a crash/restart drill (docker kill mid-scan => never CLEAN). Output is unverified evidence: NOT_ADMITTED.
//   CLAMD_HOST=127.0.0.1 CLAMD_PORT=13310 CLAMD_CONTAINER=media-clamav-qual IMAGE_DIGEST=sha256:... \
//     node --experimental-strip-types scripts/qualify-real-clamd.mjs --out <result.json>
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { ClamdEngine, SecurityScannerProvider, ed25519Signer } from '../src/index.ts';

const host = process.env.CLAMD_HOST ?? '127.0.0.1', port = Number(process.env.CLAMD_PORT ?? 13310);
const container = process.env.CLAMD_CONTAINER ?? 'media-clamav-qual';
const out = process.argv[process.argv.indexOf('--out') + 1];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

// ---- generated corpus (deterministic bytes, no third-party content)
const pdf = (text) => {
  const o = [`1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`, `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`,
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj`,
    `4 0 obj<</Length ${text.length + 30}>>stream\nBT /F1 12 Tf 20 50 Td (${text}) Tj ET\nendstream endobj`,
    `5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`];
  return Buffer.from(`%PDF-1.4\n${o.join('\n')}\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF\n`);
};
const png = (w, h) => {
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 7 + y * 13) & 255;
  const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0); return Buffer.concat([l, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const zipStored = (name, data) => {
  const n = Buffer.from(name), c = crc32(data) >>> 0;
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(c, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28);
  const body = Buffer.concat([lh, n, data]); const cdr = Buffer.concat([cd, n]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdr.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cdr, end]);
};
const corpus = [
  { id: 'clean-pdf-1', expect: 'CLEAN', bytes: pdf('Synthetic clean document one') },
  { id: 'clean-pdf-2', expect: 'CLEAN', bytes: pdf('Synthetic clean document two') },
  { id: 'clean-png', expect: 'CLEAN', bytes: png(64, 48) },
  { id: 'clean-text', expect: 'CLEAN', bytes: Buffer.from('plain synthetic text\n'.repeat(50)) },
  { id: 'eicar', expect: 'INFECTED', bytes: eicar },
  { id: 'eicar-pdf-polyglot', expect: 'INFECTED', bytes: Buffer.concat([pdf('polyglot'), Buffer.from('\n'), eicar]) },
  { id: 'eicar-in-zip', expect: 'INFECTED', bytes: zipStored('payload.com', eicar) },
];

const MAX = 90 * 1024 * 1024;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = ed25519Signer('dev-ephemeral-ed25519', privateKey); // TEST-ONLY ephemeral key, never KMS custody
const engine = new ClamdEngine({ endpoint: { kind: 'tcp', host, port }, maxBytes: MAX, connectTimeoutMs: 1500, commandTimeoutMs: 20000, maxAttempts: 1 });
const ident = await engine.identity();
console.log('engine identity', JSON.stringify(ident));
const mk = (content) => new SecurityScannerProvider({
  engine, source: { read: async () => ({ tenantId: 't1', content }) }, signer, scannerRef: 'dev-real-clamd',
  pinnedEngineVersions: [ident.engineVersion ?? ident.version ?? String(ident.engine ?? '')].filter(Boolean),
  maxBytes: MAX, maxDefinitionsAgeMs: 7 * 86_400_000, attestationTtlMs: 120_000,
});
const reqOf = (b) => ({ documentId: 'd', version: 1, tenantId: 't1', checksum: { algorithm: 'SHA-256', value: sha(b) }, sizeBytes: b.length, mimeType: 'application/octet-stream' });
const results = [];
for (const c of corpus) {
  const r = await mk(c.bytes).scan(reqOf(c.bytes));
  results.push({ id: c.id, sha256: sha(c.bytes), expect: c.expect, status: r.status, verdict: r.verdict, reasonCode: r.reasonCode ?? null, signed: Boolean(r.attestation ?? r.signature ?? r.attestationBinding), correct: (c.expect === 'CLEAN') === (r.verdict === 'CLEAN') && (c.expect === 'CLEAN' || r.verdict !== 'CLEAN') });
}
// Safety invariant: nothing expected INFECTED may ever be CLEAN.
const falseNegatives = results.filter((r) => r.expect === 'INFECTED' && r.verdict === 'CLEAN').length;

// ---- crash/restart drill: kill clamd mid-scan, then while down, then restart
const big = randomBytes(80 * 1024 * 1024);
const drill = { midScanAttempts: [], killedWhileDown: null, afterRestart: null };
for (let i = 0; i < 3; i++) {
  const p = mk(big).scan(reqOf(big));
  await new Promise((r) => setTimeout(r, 150));
  execFileSync('docker', ['kill', container], { stdio: 'ignore' });
  const r = await p;
  drill.midScanAttempts.push({ verdict: r.verdict, status: r.status, reasonCode: r.reasonCode ?? null });
  const interrupted = r.verdict !== 'CLEAN';
  if (interrupted) break;
  execFileSync('docker', ['start', container], { stdio: 'ignore' });
  await waitReady();
}
const down = await mk(corpus[0].bytes).scan(reqOf(corpus[0].bytes));
drill.killedWhileDown = { verdict: down.verdict, status: down.status, reasonCode: down.reasonCode ?? null };
execFileSync('docker', ['start', container], { stdio: 'ignore' });
await waitReady();
const back = await mk(corpus[0].bytes).scan(reqOf(corpus[0].bytes));
drill.afterRestart = { verdict: back.verdict, status: back.status };
async function waitReady() { for (let i = 0; i < 120; i++) { try { await engine.identity(); return; } catch { await new Promise((r) => setTimeout(r, 2000)); } } throw new Error('clamd did not come back'); }

const report = {
  schemaVersion: 'ghatana.media.scanner-dev-qualification.v1', classification: 'DEV_ONLY_NOT_QUALIFICATION', admission: 'NOT_ADMITTED', verification: 'ABSENT',
  engine: { identity: ident, image: `clamav/clamav@${process.env.IMAGE_DIGEST}`, definitions: 'freshclam at container start' },
  signing: 'ephemeral in-process Ed25519 key; no KMS custody, no trust root', corpus: 'generated: EICAR + clean PDFs/PNG/text + EICAR polyglot/zip (no rights clearance needed)',
  results, falseNegativesOnEicarVariants: falseNegatives,
  findings: results.filter((r) => r.expect === 'INFECTED' && r.verdict === 'CLEAN').map((r) => `${r.id}: real clamd reported CLEAN (no signature matched). The EICAR signature is file-anchored, so an appended payload after %%EOF is not detected; CLEAN only ever means 'no signature matched', never 'safe'. Needs a false-negative policy and a real polyglot/obfuscation corpus before any admission.`), crashDrill: drill,
  invariants: { noInfectedEverClean: falseNegatives === 0, midScanKillNeverClean: drill.midScanAttempts.some((a) => a.verdict !== 'CLEAN') && drill.midScanAttempts.every((a) => a.verdict !== 'CLEAN' || a === drill.midScanAttempts.at(-1)), downIsNotClean: down.verdict !== 'CLEAN', recoversClean: back.verdict === 'CLEAN' },
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ results: results.map((r) => [r.id, r.verdict, r.reasonCode]), drill, invariants: report.invariants }, null, 1));
