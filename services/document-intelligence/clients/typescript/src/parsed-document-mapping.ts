import type { ParsedDocument } from '@ghatana/document-extraction';
import { DocumentExtractionError } from '@ghatana/document-extraction';
import type { DocumentParseRequest } from '@ghatana/document-extraction';
import type { WireParsedDocument } from './protocol.js';

function identity(value: WireParsedDocument['providerProvenance']): WireParsedDocument['providerProvenance'] {
  return Object.freeze({ ...value });
}

/**
 * Generic wire → Shared `ParsedDocument` mapping. Every Increment 4A parser
 * adapter funnels through this single mapping so that structure reconstruction,
 * optional-field handling, and deep immutability stay identical across
 * providers. The input must already have passed `validateParsedResponse`.
 */
export function mapParsedDocument(source: ParsedDocument['source'], value: WireParsedDocument): ParsedDocument {
  return Object.freeze({
    source,
    pages: Object.freeze(value.pages.map((page) => Object.freeze({
      pageNumber: page.pageNumber,
      blocks: Object.freeze(page.blocks.map((block) => Object.freeze({
        blockId: block.blockId,
        kind: block.kind as ParsedDocument['pages'][number]['blocks'][number]['kind'],
        boundingRegion: Object.freeze({ ...block.boundingRegion }),
        lines: Object.freeze(block.lines.map((line) => Object.freeze({
          lineId: line.lineId,
          text: line.text,
          boundingRegion: Object.freeze({ ...line.boundingRegion }),
          ...(line.confidence === undefined ? {} : { confidence: line.confidence }),
          ...(line.languageTag === undefined ? {} : { languageTag: line.languageTag }),
        }))),
        ...(block.confidence === undefined ? {} : { confidence: block.confidence }),
        ...(block.languageTag === undefined ? {} : { languageTag: block.languageTag }),
      }))),
      tables: Object.freeze(page.tables.map((table) => Object.freeze({
        tableId: table.tableId,
        boundingRegion: Object.freeze({ ...table.boundingRegion }),
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        ...(table.headers === undefined ? {} : { headers: Object.freeze([...table.headers]) }),
        cells: Object.freeze(table.cells.map((cell) => Object.freeze({ ...cell, boundingRegion: Object.freeze({ ...cell.boundingRegion }) }))),
      }))),
      ...(page.languageTag === undefined ? {} : { languageTag: page.languageTag }),
    }))),
    providerProvenance: identity(value.providerProvenance),
    quality: Object.freeze({ ...value.quality }),
    ...(value.languageTag === undefined ? {} : { languageTag: value.languageTag }),
  });
}

/**
 * Drains the Shared content handle into a single bounded byte array. The bound
 * is the request's `maxSourceBytes` limit (default 50 MiB), matching the
 * worker-side upload ceiling.
 */
export async function collectContentBytes(input: DocumentParseRequest, providerRef: string): Promise<Uint8Array> {
  const limit = input.limits.maxSourceBytes ?? 50 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input.content.open()) {
    total += chunk.byteLength;
    if (total > limit) throw new DocumentExtractionError('SOURCE_TOO_LARGE', { providerRef });
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
