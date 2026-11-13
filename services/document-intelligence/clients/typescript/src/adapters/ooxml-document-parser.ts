import { DocumentExtractionError, type DocumentParseRequest, type DocumentParserCapabilities, type DocumentParserPort, type ParsedDocument } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { collectContentBytes, mapParsedDocument } from '../parsed-document-mapping.js';
import { advertisedParserCapabilitiesFor } from '../provider-catalog.js';

export interface WorkerParserAdapterOptions {
  readonly providerRef: string;
  readonly mediaTypes: readonly string[];
  readonly supportedLanguages?: readonly string[];
  readonly supportsTables?: boolean;
  readonly supportsCoordinates?: boolean;
  readonly supportsLanguages?: boolean;
  /**
   * When set, the worker's returned `providerProvenance.modelRef` must equal
   * this value. When omitted, provenance is verified by `providerRef` only;
   * model pinning remains worker-side (`models/increment4a/model-manifest.yaml`).
   */
  readonly expectedModelRef?: string;
}

/**
 * Generic transport adapter for Increment-4A parse providers. It performs the
 * declared media-type admission check, drains the bounded content handle, calls
 * the worker `/v1/parse` boundary, verifies provider provenance, and maps the
 * wire document through the single shared `ParsedDocument` mapping.
 */
export class WorkerDocumentParserAdapter implements DocumentParserPort {
  constructor(
    private readonly client: DocumentIntelligenceClient,
    private readonly options: WorkerParserAdapterOptions,
    private readonly timeoutMs = 30_000,
  ) {}

  /**
   * Advertised capabilities are derived from the worker's `GET /v1/providers`
   * record for this provider — only `promotionStatus === 'ACCEPTED'` entries
   * contribute `capabilityIds`/`languages`/`features`/`mediaTypes`. Candidate
   * constants are never advertised; an unpromoted provider advertises empty
   * capability sets.
   */
  async capabilities(): Promise<DocumentParserCapabilities> {
    return advertisedParserCapabilitiesFor(this.client, this.options.providerRef);
  }

  async parse(input: DocumentParseRequest): Promise<ParsedDocument> {
    const providerRef = this.options.providerRef;
    if (!this.options.mediaTypes.includes(input.sourceMetadata.mediaType)) {
      throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE', { providerRef });
    }
    const bytes = await collectContentBytes(input, providerRef);
    const wire = await this.client.parse({
      operationId: input.executionId,
      providerRef,
      mediaType: input.sourceMetadata.mediaType,
      ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
      timeoutMs: Math.min(this.timeoutMs, input.limits.maxExternalCallMs ?? this.timeoutMs),
      limits: input.limits,
      bytes,
      signal: input.signal,
    });
    const provenance = wire.providerProvenance;
    if (provenance.providerRef !== providerRef) throw new DocumentExtractionError('PARSE_OUTPUT_INVALID', { providerRef });
    if (this.options.expectedModelRef !== undefined && provenance.modelRef !== this.options.expectedModelRef) {
      throw new DocumentExtractionError('PARSE_OUTPUT_INVALID', { providerRef });
    }
    return mapParsedDocument(input.source, wire);
  }
}
