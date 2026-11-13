import type { DocumentParseRequest, DocumentParserCapabilities, DocumentParserPort, ParsedDocument } from '@ghatana/document-extraction';
import { DocumentExtractionError } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { mapParsedDocument } from '../parsed-document-mapping.js';
import { advertisedParserCapabilitiesFor } from '../provider-catalog.js';

/** Language binding → physical artifact identity. The single PP-OCRv5
 * Devanagari recognition artifact covers ne/hi/mr. */
const EXPECTED_MODEL: Readonly<Record<string, readonly [string, string]>> = {
  en: ['PP-OCRv5-en', 'PP-OCRv5-local-en'],
  ne: ['PP-OCRv5-devanagari-shared', 'PP-OCRv5-local-devanagari-shared'],
  hi: ['PP-OCRv5-devanagari-shared', 'PP-OCRv5-local-devanagari-shared'],
  mr: ['PP-OCRv5-devanagari-shared', 'PP-OCRv5-local-devanagari-shared'],
};

export class PaddleDocumentParserAdapter implements DocumentParserPort {
  constructor(private readonly client: DocumentIntelligenceClient, private readonly timeoutMs = 120_000) {}
  async capabilities(): Promise<DocumentParserCapabilities> { return advertisedParserCapabilitiesFor(this.client, 'ghatana.paddleocr'); }
  async parse(input: DocumentParseRequest): Promise<ParsedDocument> {
    if (input.sourceMetadata.mediaType !== 'image/png' && input.sourceMetadata.mediaType !== 'image/jpeg') throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE');
    if (input.languageHint !== 'en' && input.languageHint !== 'ne' && input.languageHint !== 'hi' && input.languageHint !== 'mr') throw new DocumentExtractionError('PARSE_FAILED', { providerRef: 'ghatana.paddleocr' });
    const chunks: Uint8Array[] = []; let total = 0; for await (const chunk of input.content.open()) { total += chunk.byteLength; if (total > input.limits.maxSourceBytes) throw new DocumentExtractionError('SOURCE_TOO_LARGE', { providerRef: 'ghatana.paddleocr' }); chunks.push(chunk); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const wire = await this.client.parse({ operationId: input.executionId, providerRef: 'ghatana.paddleocr', mediaType: input.sourceMetadata.mediaType, languageHint: input.languageHint, timeoutMs: Math.min(this.timeoutMs, input.limits.maxExternalCallMs ?? this.timeoutMs), limits: input.limits, bytes, signal: input.signal });
    const expected = EXPECTED_MODEL[input.languageHint];
    if (expected === undefined || wire.providerProvenance.providerRef !== 'ghatana.paddleocr' || wire.providerProvenance.modelRef !== expected[0] || wire.providerProvenance.modelVersion !== expected[1]) throw new DocumentExtractionError('PARSE_OUTPUT_INVALID', { providerRef: 'ghatana.paddleocr' });
    return mapParsedDocument(input.source, wire);
  }
}
