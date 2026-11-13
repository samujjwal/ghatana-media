import type { DocumentParserPort } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { MEDIA_XLSX, PROVIDER_DOCLING_XLSX } from '../media-types.js';
import { WorkerDocumentParserAdapter } from './ooxml-document-parser.js';

/** XLSX parser adapter for the Increment-4A `ghatana.docling-xlsx` provider. */
export class XlsxDocumentParserAdapter extends WorkerDocumentParserAdapter implements DocumentParserPort {
  constructor(client: DocumentIntelligenceClient, timeoutMs = 30_000) {
    super(client, { providerRef: PROVIDER_DOCLING_XLSX, mediaTypes: [MEDIA_XLSX], supportsTables: true, supportsCoordinates: true, supportsLanguages: true }, timeoutMs);
  }
}
