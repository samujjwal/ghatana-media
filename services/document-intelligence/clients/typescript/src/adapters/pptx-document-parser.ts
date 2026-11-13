import type { DocumentParserPort } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { MEDIA_PPTX, PROVIDER_DOCLING_PPTX } from '../media-types.js';
import { WorkerDocumentParserAdapter } from './ooxml-document-parser.js';

/** PPTX parser adapter for the Increment-4A `ghatana.docling-pptx` provider. */
export class PptxDocumentParserAdapter extends WorkerDocumentParserAdapter implements DocumentParserPort {
  constructor(client: DocumentIntelligenceClient, timeoutMs = 30_000) {
    super(client, { providerRef: PROVIDER_DOCLING_PPTX, mediaTypes: [MEDIA_PPTX], supportsTables: true, supportsCoordinates: true, supportsLanguages: true }, timeoutMs);
  }
}
