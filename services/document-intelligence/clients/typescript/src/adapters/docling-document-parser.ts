import { DocumentExtractionError, type DocumentParseRequest, type DocumentParserCapabilities, type DocumentParserPort, type ParsedDocument } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { mapParsedDocument } from '../parsed-document-mapping.js';
import { advertisedParserCapabilitiesFor } from '../provider-catalog.js';

export { mapParsedDocument as mapParsed } from '../parsed-document-mapping.js';

export class DoclingDocumentParserAdapter implements DocumentParserPort {
  constructor(private readonly client: DocumentIntelligenceClient, private readonly timeoutMs = 30_000) {}
  async capabilities(): Promise<DocumentParserCapabilities> { return advertisedParserCapabilitiesFor(this.client, 'ghatana.docling'); }
  async parse(input: DocumentParseRequest): Promise<ParsedDocument> {
    if (input.sourceMetadata.mediaType !== 'application/pdf') throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE', { providerRef: 'ghatana.docling' });
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of input.content.open()) { total += chunk.byteLength; chunks.push(chunk); if (total > (input.limits.maxSourceBytes ?? 50 * 1024 * 1024)) throw new DocumentExtractionError('SOURCE_TOO_LARGE', { providerRef: 'ghatana.docling' }); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const wire = await this.client.parse({ operationId: input.executionId, providerRef: 'ghatana.docling', mediaType: input.sourceMetadata.mediaType, timeoutMs: Math.min(this.timeoutMs, input.limits.maxExternalCallMs ?? this.timeoutMs), limits: input.limits, bytes, signal: input.signal });
    if (wire.providerProvenance.providerRef !== 'ghatana.docling' || wire.providerProvenance.modelRef !== 'docling-standard-pdf-pipeline' || wire.providerProvenance.modelVersion !== 'pinned-docling-runtime') throw new DocumentExtractionError('PARSE_OUTPUT_INVALID', { providerRef: 'ghatana.docling' });
    return mapParsedDocument(input.source, wire);
  }
}
