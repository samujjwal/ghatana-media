import { describe, expect, it } from 'vitest';
import { DocumentExtractionError, type DocumentParseRequest } from '@ghatana/document-extraction';
import { collectContentBytes, mapParsedDocument } from '../src/parsed-document-mapping.js';
import { PROTOCOL_VERSION, type WireParsedDocument } from '../src/protocol.js';

const source = { ownerRef: 'owner-1', documentId: 'doc-1', version: 1 } as const;

const wire = (): WireParsedDocument => ({
  protocolVersion: PROTOCOL_VERSION,
  operationId: 'op-1',
  providerRef: 'ghatana.docling-docx',
  pages: [
    {
      pageNumber: 1,
      blocks: [{
        blockId: 'b1',
        kind: 'TEXT',
        boundingRegion: { x: 0, y: 0, width: 1, height: 1 },
        lines: [{ lineId: 'l1', text: 'नमस्ते Alice', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9, languageTag: 'ne' }],
        confidence: 0.95,
        languageTag: 'ne',
      }],
      tables: [{
        tableId: 't1',
        boundingRegion: { x: 0, y: 0, width: 1, height: 1 },
        rowCount: 2,
        columnCount: 2,
        headers: ['a', 'b'],
        cells: [{ cellId: 'c1', rowIndex: 0, columnIndex: 0, text: 'x', boundingRegion: { x: 0, y: 0, width: 0.5, height: 0.5 }, rowSpan: 1, columnSpan: 2 }],
      }],
      languageTag: 'ne',
    },
  ],
  providerProvenance: { providerRef: 'ghatana.docling-docx', providerVersion: '0.1.0', modelRef: 'docling-ooxml-pipeline', modelVersion: 'pinned-runtime' },
  quality: { parseConfidence: 0.9, completeness: 1, warnings: ['w'] },
  languageTag: 'ne',
});

describe('generic parsed-document mapping', () => {
  it('reconstructs pages, blocks, lines, tables and provenance with deep immutability', () => {
    const result = mapParsedDocument(source, wire());
    expect(result.source).toBe(source);
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.blocks[0]?.lines[0]?.text).toBe('नमस्ते Alice');
    expect(page.blocks[0]?.languageTag).toBe('ne');
    expect(page.tables[0]?.cells[0]?.columnSpan).toBe(2);
    expect(result.providerProvenance.modelRef).toBe('docling-ooxml-pipeline');
    expect(result.languageTag).toBe('ne');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pages)).toBe(true);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.blocks[0]?.lines[0])).toBe(true);
    expect(Object.isFrozen(page.tables[0]?.cells[0])).toBe(true);
    expect(Object.isFrozen(result.providerProvenance)).toBe(true);
    expect(Object.isFrozen(result.quality)).toBe(true);
  });

  it('omits optional fields when absent rather than writing undefined', () => {
    const minimal: WireParsedDocument = {
      protocolVersion: PROTOCOL_VERSION,
      operationId: 'op-2',
      providerRef: 'ghatana.docling-xlsx',
      pages: [{ pageNumber: 1, blocks: [], tables: [] }],
      providerProvenance: { providerRef: 'ghatana.docling-xlsx', providerVersion: '0.1.0' },
      quality: {},
    };
    const result = mapParsedDocument(source, minimal);
    expect('languageTag' in result).toBe(false);
    expect('confidence' in (result.pages[0] ?? {})).toBe(false);
    expect(result.pages[0]?.blocks).toHaveLength(0);
  });
});

describe('collectContentBytes', () => {
  const request = (chunks: readonly Uint8Array[], maxSourceBytes: number): DocumentParseRequest => ({
    executionId: 'op-3',
    source,
    sourceMetadata: { mediaType: 'application/pdf', sizeBytes: 1 },
    content: { open: async function* () { for (const chunk of chunks) yield chunk; } },
    limits: { maxSourceBytes },
  }) as unknown as DocumentParseRequest;

  it('concatenates streamed chunks', async () => {
    const bytes = await collectContentBytes(request([new Uint8Array([1, 2]), new Uint8Array([3])], 8), 'ghatana.test');
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('fails closed when the stream exceeds maxSourceBytes', async () => {
    await expect(collectContentBytes(request([new Uint8Array([1, 2, 3, 4])], 3), 'ghatana.test')).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
    await expect(collectContentBytes(request([new Uint8Array([1, 2, 3, 4])], 3), 'ghatana.test')).rejects.toBeInstanceOf(DocumentExtractionError);
  });
});
