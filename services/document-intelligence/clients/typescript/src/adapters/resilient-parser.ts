import { DocumentExtractionError, type DocumentParseRequest, type DocumentParserCapabilities, type DocumentParserPort, type ParsedDocument } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { mapParsedDocument } from '../parsed-document-mapping.js';
import { PROVIDER_RESILIENT_PARSER } from '../media-types.js';
import { acceptedCatalogEntry, advertisedParserCapabilitiesFor } from '../provider-catalog.js';

/**
 * Thin adapter over the worker's `ghatana.resilient-parser` route provider.
 * Route chains, fallback eligibility, and deadline budgeting are governed
 * exclusively inside the worker by `routing/parser-routing.v1.yaml`; this
 * adapter invokes the worker exactly once per request and never re-executes
 * routing policy client-side. Its admitted media surface is the worker's
 * accepted `/v1/providers` catalog record, never candidate constants.
 */
export class ResilientParserAdapter implements DocumentParserPort {
  constructor(private readonly client: DocumentIntelligenceClient, private readonly timeoutMs = 120_000) {}

  async capabilities(): Promise<DocumentParserCapabilities> {
    return advertisedParserCapabilitiesFor(this.client, PROVIDER_RESILIENT_PARSER);
  }

  async parse(input: DocumentParseRequest): Promise<ParsedDocument> {
    const mediaType = input.sourceMetadata.mediaType;
    const admitted = acceptedCatalogEntry(await this.client.providers(), PROVIDER_RESILIENT_PARSER)?.mediaTypes ?? [];
    if (!admitted.includes(mediaType)) throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE');
    const chunks: Uint8Array[] = []; let total = 0; for await (const chunk of input.content.open()) { total += chunk.byteLength; if (total > input.limits.maxSourceBytes) throw new DocumentExtractionError('SOURCE_TOO_LARGE', { providerRef: PROVIDER_RESILIENT_PARSER }); chunks.push(chunk); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const wire = await this.client.parse({ operationId: input.executionId, providerRef: PROVIDER_RESILIENT_PARSER, mediaType, languageHint: input.languageHint, timeoutMs: Math.min(this.timeoutMs, input.limits.maxExternalCallMs ?? this.timeoutMs), limits: input.limits, bytes, signal: input.signal });
    if (wire.providerProvenance.providerRef !== PROVIDER_RESILIENT_PARSER) throw new DocumentExtractionError('PARSE_OUTPUT_INVALID', { providerRef: PROVIDER_RESILIENT_PARSER });
    return mapParsedDocument(input.source, wire);
  }
}
