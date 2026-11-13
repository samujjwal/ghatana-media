import type { DocumentParseRequest, DocumentParserCapabilities, DocumentParserPort, ParsedDocument } from '@ghatana/document-extraction';
import { DocumentExtractionError } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { mapParsedDocument } from '../parsed-document-mapping.js';
import { advertisedParserCapabilitiesFor } from '../provider-catalog.js';

/** Bounded worker adapter for the independently qualified Tesseract route. */
export class TesseractDocumentParserAdapter implements DocumentParserPort {
  constructor(private readonly client: DocumentIntelligenceClient, private readonly timeoutMs = 30_000) {}
  async capabilities(): Promise<DocumentParserCapabilities> {
    return advertisedParserCapabilitiesFor(this.client, 'ghatana.tesseractocr');
  }
  async parse(input: DocumentParseRequest): Promise<ParsedDocument> {
    if (input.sourceMetadata.mediaType !== 'image/png' && input.sourceMetadata.mediaType !== 'image/jpeg') throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE');
    if (!['en', 'ne', 'hi', 'mr'].includes(input.languageHint ?? '')) throw new DocumentExtractionError('PARSE_FAILED', { providerRef: 'ghatana.tesseractocr' });
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of input.content.open()) { total += chunk.byteLength; if (total > input.limits.maxSourceBytes) throw new DocumentExtractionError('SOURCE_TOO_LARGE', { providerRef: 'ghatana.tesseractocr' }); chunks.push(chunk); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const wire = await this.client.parse({ operationId: input.executionId, providerRef: 'ghatana.tesseractocr', mediaType: input.sourceMetadata.mediaType, languageHint: input.languageHint, timeoutMs: Math.min(this.timeoutMs, input.limits.maxExternalCallMs ?? this.timeoutMs), limits: input.limits, bytes, signal: input.signal });
    if (wire.providerProvenance.providerRef !== 'ghatana.tesseractocr' || wire.providerProvenance.modelRef !== 'tesseract-5') throw new DocumentExtractionError('PARSE_OUTPUT_INVALID', { providerRef: 'ghatana.tesseractocr' });
    return mapParsedDocument(input.source, wire);
  }
}
