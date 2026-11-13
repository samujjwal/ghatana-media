import { DocumentIntelligenceClient } from '../client.js';
import { MEDIA_PNG } from '../media-types.js';
import { WorkerDocumentParserAdapter } from './ooxml-document-parser.js';

/**
 * Worker-route adapter over `ghatana.resilient-parser`. The accepted provider
 * authority admits the resilient route for `image/png` only — the media types
 * the Paddle→Tesseract image fallback was qualified on. JPEG remains direct
 * PaddleOCR and PDF stays with the hybrid strategy; no other media type may be
 * claimed through this adapter.
 */
export class ResilientDocumentParserAdapter extends WorkerDocumentParserAdapter {
  constructor(client: DocumentIntelligenceClient, timeoutMs = 30_000) {
    super(client, {
      providerRef: 'ghatana.resilient-parser',
      mediaTypes: [MEDIA_PNG],
      supportsTables: true,
      supportsCoordinates: true,
      supportsLanguages: true,
      expectedModelRef: 'governed-fallback',
    }, timeoutMs);
  }
}
