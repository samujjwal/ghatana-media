import { inflateRawSync } from 'node:zlib';

/**
 * Structural pre-scan validation (false-negative policy). A signature engine answering "no match" is NOT proof of
 * safety: payloads appended after a format terminator, content whose magic number contradicts the declared type, and
 * deeply nested archives evade signature matching. Any such finding prevents CLEAN:
 *   - REJECTED: the bytes are structurally not what was declared (trailing bytes, magic mismatch, missing terminator,
 *     nesting beyond the bound) -> verdict REJECTED_STRUCTURE;
 *   - UNDETERMINED: the structure cannot be established (unsupported declared type, parse limits) -> verdict UNKNOWN.
 * Pure, bounded, allocation-limited; never throws for hostile input.
 */
export type StructureReason =
  | 'STRUCTURE_MAGIC_MISMATCH'
  | 'STRUCTURE_TRAILING_BYTES'
  | 'STRUCTURE_TERMINATOR_MISSING'
  | 'STRUCTURE_NESTED_ARCHIVE_DEPTH'
  | 'STRUCTURE_UNDETERMINED'
  | 'STRUCTURE_UNSUPPORTED_TYPE';

export type StructureResult =
  | { readonly kind: 'OK' }
  | { readonly kind: 'REJECTED'; readonly reason: StructureReason }
  | { readonly kind: 'UNDETERMINED'; readonly reason: StructureReason };

export interface StructureOptions {
  /** Archive nesting allowed below the top-level container (default 1: a DOCX may embed one archive level). */
  readonly maxNestingDepth?: number;
  /** Declared types that are deliberately not structurally inspected (default none: unsupported => UNKNOWN). */
  readonly unstructuredTypes?: readonly string[];
  readonly maxEntries?: number;
  readonly maxInflatedBytes?: number;
}

const OK: StructureResult = { kind: 'OK' };
const reject = (reason: StructureReason): StructureResult => ({ kind: 'REJECTED', reason });
const undetermined = (reason: StructureReason): StructureResult => ({ kind: 'UNDETERMINED', reason });

type Family = 'PDF' | 'PNG' | 'JPEG' | 'ZIP' | 'OOXML';
const OOXML = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function familyOf(mimeType: string): Family | undefined {
  const t = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (t === 'application/pdf') return 'PDF';
  if (t === 'image/png') return 'PNG';
  if (t === 'image/jpeg' || t === 'image/jpg') return 'JPEG';
  if (OOXML.has(t)) return 'OOXML';
  if (t === 'application/zip' || t === 'application/x-zip-compressed') return 'ZIP';
  return undefined;
}

/** Magic-number family of the bytes, independent of the declared type. */
function sniff(b: Uint8Array): Family | 'OTHER' {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'PDF';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'PNG';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) return 'ZIP';
  return 'OTHER';
}

export function inspectStructure(content: Uint8Array, declaredMimeType: string, options: StructureOptions = {}): StructureResult {
  const declared = declaredMimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if ((options.unstructuredTypes ?? []).includes(declared)) return OK;
  const family = familyOf(declared);
  if (!family) return undetermined('STRUCTURE_UNSUPPORTED_TYPE');
  const actual = sniff(content);
  const expectZip = family === 'ZIP' || family === 'OOXML';
  if (expectZip ? actual !== 'ZIP' : actual !== family) return reject('STRUCTURE_MAGIC_MISMATCH');
  const o = { maxNestingDepth: options.maxNestingDepth ?? 1, maxEntries: options.maxEntries ?? 10_000, maxInflatedBytes: options.maxInflatedBytes ?? 16 * 1024 * 1024 };
  try {
    switch (family) {
      case 'PDF': return inspectPdf(content);
      case 'PNG': return inspectPng(content);
      case 'JPEG': return inspectJpeg(content);
      case 'ZIP': return inspectZip(content, 0, o, false);
      case 'OOXML': return inspectZip(content, 0, o, true);
    }
  } catch {
    return undetermined('STRUCTURE_UNDETERMINED');
  }
}

function inspectPdf(b: Uint8Array): StructureResult {
  const tail = Buffer.from(b.subarray(Math.max(0, b.length - 2048))).toString('latin1');
  const at = tail.lastIndexOf('%%EOF');
  if (at < 0) return reject('STRUCTURE_TERMINATOR_MISSING');
  const after = tail.slice(at + 5);
  // Only line-ending whitespace may follow the final %%EOF.
  return /^[\r\n ]{0,4}$/u.test(after) ? OK : reject('STRUCTURE_TRAILING_BYTES');
}

function inspectPng(b: Uint8Array): StructureResult {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  for (let i = 0; i < 200_000 && p + 12 <= b.length; i++) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!);
    const end = p + 12 + len;
    if (end > b.length || len > 0x7fffffff) return reject('STRUCTURE_TERMINATOR_MISSING');
    if (type === 'IEND') return end === b.length ? OK : reject('STRUCTURE_TRAILING_BYTES');
    p = end;
  }
  return reject('STRUCTURE_TERMINATOR_MISSING');
}

function inspectJpeg(b: Uint8Array): StructureResult {
  let p = 2;
  for (let guard = 0; guard < 1_000_000 && p < b.length; guard++) {
    if (b[p] !== 0xff) return reject('STRUCTURE_TERMINATOR_MISSING');
    while (p < b.length && b[p] === 0xff) p++; // fill bytes
    const marker = b[p++]!;
    if (marker === 0xd9) return p === b.length ? OK : reject('STRUCTURE_TRAILING_BYTES');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // standalone
    if (p + 2 > b.length) return reject('STRUCTURE_TERMINATOR_MISSING');
    const len = (b[p]! << 8) | b[p + 1]!;
    if (len < 2) return reject('STRUCTURE_TERMINATOR_MISSING');
    p += len;
    if (marker === 0xda) {
      // entropy-coded data: skip stuffed bytes (FF00) and restart markers (FFD0..D7) until the next real marker
      while (p + 1 < b.length) {
        if (b[p] === 0xff && b[p + 1] !== 0x00 && !(b[p + 1]! >= 0xd0 && b[p + 1]! <= 0xd7) && b[p + 1] !== 0xff) break;
        p++;
      }
    }
  }
  return reject('STRUCTURE_TERMINATOR_MISSING');
}

interface ZipLimits { maxNestingDepth: number; maxEntries: number; maxInflatedBytes: number }

function inspectZip(b: Uint8Array, depth: number, o: ZipLimits, ooxml: boolean): StructureResult {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  // End-of-central-directory: scan back at most 22 + 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return reject('STRUCTURE_TERMINATOR_MISSING');
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLen !== buf.length) return reject('STRUCTURE_TRAILING_BYTES');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) return undetermined('STRUCTURE_UNDETERMINED'); // ZIP64: not parsed
  if (entries > o.maxEntries) return undetermined('STRUCTURE_UNDETERMINED');
  if (cdOffset + cdSize > eocd) return reject('STRUCTURE_TERMINATOR_MISSING');
  let p = cdOffset;
  let hasContentTypes = false;
  let worst: StructureResult = OK;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) return reject('STRUCTURE_TERMINATOR_MISSING');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + cmtLen;
    if (name === '[Content_Types].xml') hasContentTypes = true;
    if (lho + 30 > cdOffset || buf.readUInt32LE(lho) !== 0x04034b50) return reject('STRUCTURE_TERMINATOR_MISSING');
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dataStart + csize > cdOffset) return reject('STRUCTURE_TERMINATOR_MISSING');
    const nestedByName = /\.(zip|jar|docx|xlsx|pptx|apk|7z|rar|gz|tgz|war)$/iu.test(name);
    let nested = nestedByName;
    let data: Buffer | undefined;
    if (usize <= o.maxInflatedBytes && csize <= o.maxInflatedBytes && (method === 0 || method === 8)) {
      try {
        const raw = buf.subarray(dataStart, dataStart + csize);
        data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: o.maxInflatedBytes });
        if (sniff(data) === 'ZIP') nested = true;
      } catch { return undetermined('STRUCTURE_UNDETERMINED'); }
    } else if (usize > o.maxInflatedBytes) {
      return undetermined('STRUCTURE_UNDETERMINED'); // possible zip bomb: not inspectable within bounds
    }
    if (nested) {
      if (depth + 1 > o.maxNestingDepth) return reject('STRUCTURE_NESTED_ARCHIVE_DEPTH');
      if (data && sniff(data) === 'ZIP') {
        const inner = inspectZip(data, depth + 1, o, false);
        if (inner.kind !== 'OK') worst = worst.kind === 'REJECTED' ? worst : inner;
      } else if (nestedByName) {
        worst = worst.kind === 'REJECTED' ? worst : undetermined('STRUCTURE_UNDETERMINED'); // non-zip archive: not inspectable
      }
    }
  }
  if (worst.kind !== 'OK') return worst;
  if (ooxml && !hasContentTypes) return reject('STRUCTURE_MAGIC_MISMATCH');
  return OK;
}
