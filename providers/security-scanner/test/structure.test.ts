// Structural pre-scan (false-negative policy) regression tests. Fixtures are generated here: EICAR plus synthetic
// formats; an always-CLEAN stub engine models the real-clamd miss (appended EICAR after %%EOF reported CLEAN).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { SecurityScannerProvider, hmacSha256Signer, inspectStructure, type ScanEngine } from '../src/index.ts';
import { EICAR } from './fake-clamd.ts';

const eicar = Buffer.from(EICAR);
const pdf = () => Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const chunk = (t: string, d: Buffer) => { const b = Buffer.concat([Buffer.from(t), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0); return Buffer.concat([l, b, c]); };
const png = () => { const ih = Buffer.alloc(13); ih.writeUInt32BE(1, 0); ih.writeUInt32BE(1, 4); ih[8] = 8; ih[9] = 0; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(Buffer.from([0, 0]))), chunk('IEND', Buffer.alloc(0))]); };
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd0, 0x44, 0xff, 0xd9]);
function zip(entries: Array<[string, Buffer]>, comment = Buffer.alloc(0)) {
  const body: Buffer[] = [], cd: Buffer[] = []; let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), c = crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6); ce.writeUInt32LE(c, 16); ce.writeUInt32LE(data.length, 20); ce.writeUInt32LE(data.length, 24); ce.writeUInt16LE(n.length, 28); ce.writeUInt32LE(off, 42);
    body.push(lh, n, data); cd.push(ce, n); off += 30 + n.length + data.length;
  }
  const cdb = Buffer.concat(cd); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...body, cdb, end, comment]);
}
const docx = () => zip([['[Content_Types].xml', Buffer.from('<Types/>')], ['word/document.xml', Buffer.from('<w:document/>')]]);
const PDF = 'application/pdf', PNG = 'image/png', JPG = 'image/jpeg', ZIP = 'application/zip';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const kind = (b: Buffer, t: string, o = {}) => { const r = inspectStructure(b, t, o); return r.kind === 'OK' ? 'OK' : `${r.kind}:${r.reason}`; };

describe('structure: valid files pass', () => {
  it('PDF, PNG, JPEG (with stuffing/restart bytes), ZIP and DOCX', () => {
    assert.equal(kind(pdf(), PDF), 'OK'); assert.equal(kind(png(), PNG), 'OK'); assert.equal(kind(jpeg(), JPG), 'OK');
    assert.equal(kind(zip([['a.txt', Buffer.from('hi')]]), ZIP), 'OK'); assert.equal(kind(docx(), DOCX), 'OK');
  });
});

describe('structure: appended payloads and mismatches never pass', () => {
  it('EICAR after %%EOF (the real-clamd miss), PNG after IEND, JPEG after EOI, ZIP after EOCD', () => {
    assert.equal(kind(Buffer.concat([pdf(), Buffer.from('\n'), eicar]), PDF), 'REJECTED:STRUCTURE_TRAILING_BYTES');
    assert.equal(kind(Buffer.concat([png(), eicar]), PNG), 'REJECTED:STRUCTURE_TRAILING_BYTES');
    assert.equal(kind(Buffer.concat([jpeg(), eicar]), JPG), 'REJECTED:STRUCTURE_TRAILING_BYTES');
    assert.equal(kind(Buffer.concat([zip([['a', Buffer.from('x')]]), eicar]), ZIP), 'REJECTED:STRUCTURE_TRAILING_BYTES');
    assert.equal(kind(Buffer.concat([docx(), eicar]), DOCX), 'REJECTED:STRUCTURE_TRAILING_BYTES');
  });
  it('magic number contradicting the declared type', () => {
    assert.equal(kind(png(), PDF), 'REJECTED:STRUCTURE_MAGIC_MISMATCH');
    assert.equal(kind(pdf(), PNG), 'REJECTED:STRUCTURE_MAGIC_MISMATCH');
    assert.equal(kind(Buffer.from('MZ\x90\x00 not an image'), JPG), 'REJECTED:STRUCTURE_MAGIC_MISMATCH');
    assert.equal(kind(zip([['a.txt', Buffer.from('x')]]), DOCX), 'REJECTED:STRUCTURE_MAGIC_MISMATCH'); // zip without [Content_Types].xml
    assert.equal(kind(Buffer.from('plain text'), PDF), 'REJECTED:STRUCTURE_MAGIC_MISMATCH');
  });
  it('missing terminators / truncation', () => {
    assert.equal(kind(Buffer.from('%PDF-1.7 no end'), PDF), 'REJECTED:STRUCTURE_TERMINATOR_MISSING');
    assert.equal(kind(png().subarray(0, png().length - 5), PNG), 'REJECTED:STRUCTURE_TERMINATOR_MISSING');
    assert.equal(kind(jpeg().subarray(0, jpeg().length - 2), JPG), 'REJECTED:STRUCTURE_TERMINATOR_MISSING');
    assert.equal(kind(zip([['a', Buffer.from('x')]]).subarray(0, 40), ZIP), 'REJECTED:STRUCTURE_TERMINATOR_MISSING');
  });
  it('nested archives beyond the bound', () => {
    const l1 = zip([['x.txt', Buffer.from('x')]]);
    const l2 = zip([['inner.zip', l1]]);
    const l3 = zip([['mid.zip', l2]]);
    assert.equal(kind(l2, ZIP), 'OK'); // one nested level is allowed by default
    assert.equal(kind(l3, ZIP), 'REJECTED:STRUCTURE_NESTED_ARCHIVE_DEPTH');
    assert.equal(kind(l2, ZIP, { maxNestingDepth: 0 }), 'REJECTED:STRUCTURE_NESTED_ARCHIVE_DEPTH');
    assert.equal(kind(zip([['evil.zip', Buffer.concat([l1, eicar])]]), ZIP), 'REJECTED:STRUCTURE_TRAILING_BYTES'); // payload hidden inside a nested archive
  });
  it('unsupported types and unparseable input are UNDETERMINED, never OK', () => {
    assert.equal(kind(Buffer.from('x'), 'application/octet-stream'), 'UNDETERMINED:STRUCTURE_UNSUPPORTED_TYPE');
    assert.equal(kind(Buffer.from('x'), 'text/plain'), 'UNDETERMINED:STRUCTURE_UNSUPPORTED_TYPE');
    assert.equal(kind(Buffer.from('x'), 'text/plain', { unstructuredTypes: ['text/plain'] }), 'OK'); // explicit opt-out only
    assert.equal(kind(Buffer.alloc(0), PDF), 'REJECTED:STRUCTURE_MAGIC_MISMATCH');
  });
  it('hostile input never throws', () => {
    for (let i = 0; i < 200; i++) {
      const b = Buffer.alloc(i * 7 + 1, i); b[0] = 0x50; b[1] = 0x4b;
      for (const t of [PDF, PNG, JPG, ZIP, DOCX]) assert.doesNotThrow(() => inspectStructure(b, t));
    }
  });
});

describe('provider: a "no signature matched" engine answer cannot make polyglots CLEAN', () => {
  const cleanEngine: ScanEngine = {
    identity: async () => ({ name: 'ClamAV', version: 'ClamAV 1.5.4', definitionsDate: new Date('2026-11-13T00:00:00Z') }),
    scan: async () => ({ kind: 'CLEAN' }),
  };
  const now = new Date('2026-11-13T12:00:00Z');
  async function scan(content: Buffer, mimeType: string) {
    const p = new SecurityScannerProvider({
      engine: cleanEngine, source: { read: async () => ({ tenantId: 't1', content }) }, signer: hmacSha256Signer('k', Buffer.alloc(32, 5)),
      scannerRef: 's', pinnedEngineVersions: ['ClamAV 1.5.4'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 7 * 86_400_000, attestationTtlMs: 60_000, now: () => now,
    });
    return p.scanSigned({ documentId: 'd', version: 1, tenantId: 't1', checksum: { algorithm: 'SHA-256', value: createHash('sha256').update(content).digest('hex') }, sizeBytes: content.length, mimeType });
  }
  it('valid files are still CLEAN', async () => {
    for (const [b, t] of [[pdf(), PDF], [png(), PNG], [jpeg(), JPG], [docx(), DOCX]] as const) assert.equal((await scan(b, t)).verdict, 'CLEAN');
  });
  it('EICAR after %%EOF, PNG IEND trailer and JPEG EOI trailer => REJECTED_STRUCTURE (never CLEAN), base status FAILED, quarantined finality', async () => {
    for (const [b, t] of [[Buffer.concat([pdf(), eicar]), PDF], [Buffer.concat([png(), eicar]), PNG], [Buffer.concat([jpeg(), eicar]), JPG]] as const) {
      const r = await scan(b, t);
      assert.equal(r.verdict, 'REJECTED_STRUCTURE'); assert.equal(r.reasonCode, 'STRUCTURE_TRAILING_BYTES');
      assert.equal(r.status, 'FAILED'); assert.equal(r.finality?.verdict, 'QUARANTINED');
    }
  });
  it('unsupported declared type is UNKNOWN, not CLEAN', async () => {
    const r = await scan(Buffer.from('hello'), 'application/octet-stream');
    assert.equal(r.verdict, 'UNKNOWN'); assert.equal(r.reasonCode, 'STRUCTURE_UNSUPPORTED_TYPE');
  });
});

describe('cross-language vector', () => {
  it('committed REJECTED_STRUCTURE vector has the documented triple and a self-consistent binding', async () => {
    const { readFileSync } = await import('node:fs');
    const v = JSON.parse(readFileSync(new URL('./fixtures/rejected-structure-vector.json', import.meta.url), 'utf8'));
    assert.deepEqual(v.expectedTriple, { verdict: 'REJECTED_STRUCTURE', status: 'FAILED', finalityVerdict: 'QUARANTINED', reasonCode: 'STRUCTURE_TRAILING_BYTES' });
    assert.equal(createHash('sha256').update(v.canonicalPayload).digest('hex'), v.binding.payloadSha256);
    assert.equal(v.binding.keyId, v.keyId);
  });
});
