import type { DocumentParserPort } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { MEDIA_DOCX, PROVIDER_DOCLING_DOCX } from '../media-types.js';
import { WorkerDocumentParserAdapter } from './ooxml-document-parser.js';

/** DOCX parser adapter for the Increment-4A `ghatana.docling-docx` provider. */
export class DocxDocumentParserAdapter extends WorkerDocumentParserAdapter implements DocumentParserPort {
  constructor(client: DocumentIntelligenceClient, timeoutMs = 30_000) {
    super(client, { providerRef: PROVIDER_DOCLING_DOCX, mediaTypes: [MEDIA_DOCX], supportsTables: true, supportsCoordinates: true, supportsLanguages: true }, timeoutMs);
  }
}
