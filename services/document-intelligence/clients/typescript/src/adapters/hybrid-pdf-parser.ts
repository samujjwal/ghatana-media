import type { DocumentParserPort } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { MEDIA_PDF, PROVIDER_HYBRID_PDF } from '../media-types.js';
import { WorkerDocumentParserAdapter } from './ooxml-document-parser.js';

/**
 * Composite parser adapter for the Increment-4A `ghatana.hybrid-pdf` provider.
 * It admits `application/pdf` regardless of native/scanned/mixed composition;
 * the worker-side hybrid strategy (`routing/hybrid-pdf.v1.yaml`) owns
 * classification and per-page OCR orchestration.
 */
export class HybridPdfParserAdapter extends WorkerDocumentParserAdapter implements DocumentParserPort {
  constructor(client: DocumentIntelligenceClient, timeoutMs = 30_000) {
    super(client, { providerRef: PROVIDER_HYBRID_PDF, mediaTypes: [MEDIA_PDF], supportsTables: true, supportsCoordinates: true, supportsLanguages: true }, timeoutMs);
  }
}
