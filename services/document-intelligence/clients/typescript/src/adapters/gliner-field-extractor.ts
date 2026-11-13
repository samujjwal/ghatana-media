import type { FieldExtractionCapabilities, FieldExtractionProviderPort, FieldExtractionProviderResult, FieldExtractionRequest, ExtractionCandidate } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { acceptedCatalogEntry } from '../provider-catalog.js';
import type { WireEvidence, WireIdentity } from '../protocol.js';

const IDENTITY: WireIdentity = Object.freeze({ providerRef: 'ghatana.gliner', providerVersion: '0.1.0', modelRef: 'urchade/gliner_multi-v2.1', modelVersion: '443d26d' });
const sameIdentity = (left: WireIdentity, right: WireIdentity): boolean => left.providerRef === right.providerRef && left.providerVersion === right.providerVersion && left.modelRef === right.modelRef && left.modelVersion === right.modelVersion;
const evidence = (value: WireEvidence): ExtractionCandidate['evidence'][number] => ({ pageNumber: value.pageNumber, ...(value.blockId === undefined ? {} : { blockId: value.blockId }), ...(value.lineId === undefined ? {} : { lineId: value.lineId }), ...(value.boundingRegion === undefined ? {} : { boundingRegion: value.boundingRegion }), ...(value.textSpan === undefined ? {} : { textSpan: { ...value.textSpan } }) });

function boundedParsed(input: FieldExtractionRequest): unknown {
  return { pages: input.parsedDocument.pages.map((page) => ({ pageNumber: page.pageNumber, blocks: page.blocks.map((block) => ({ blockId: block.blockId, lines: block.lines.map((line) => ({ lineId: line.lineId, text: line.text, boundingRegion: line.boundingRegion })) })) })) };
}

export class GlinerFieldExtractionAdapter implements FieldExtractionProviderPort {
  constructor(private readonly client: DocumentIntelligenceClient, private readonly timeoutMs = 30_000) {}
  /**
   * Advertised capabilities are gated on the worker's `GET /v1/providers`
   * record: GLiNER only advertises extraction support when its catalog entry
   * is `promotionStatus === 'ACCEPTED'`. Under the Increment-4A authority
   * GLiNER is admitted for `en`/`ne` only — the measured hi/mr leaves are
   * `NOT_QUALIFIED` / `DEFERRED_TO_FUTURE_RELEASE` and are never advertised.
   */
  async capabilities(): Promise<FieldExtractionCapabilities> {
    const catalog = await this.client.providers();
    if (acceptedCatalogEntry(catalog, IDENTITY.providerRef) === undefined) return {};
    return { supportedValueTypes: ['TEXT', 'IDENTIFIER'], supportsConfidenceScores: true, supportsMultipleCardinality: true };
  }
  async extract(input: FieldExtractionRequest): Promise<FieldExtractionProviderResult> {
    const fields = input.schema.fields.filter((field) => input.requestedFieldIds.includes(field.fieldId)).map((field) => ({ fieldId: field.fieldId, aliases: field.aliases, valueType: field.valueType, cardinality: field.cardinality }));
    const wire = await this.client.extract({ operationId: input.executionId, providerRef: IDENTITY.providerRef, timeoutMs: this.timeoutMs, limits: { maxCandidates: 16_000, maxEvidence: 32 }, fields, parsed: boundedParsed(input), signal: input.signal });
    if (!sameIdentity(wire.provider, IDENTITY)) throw new Error('unexpected GLiNER identity');
    const candidates = wire.candidates.map((candidate) => {
      if (!sameIdentity(candidate.provider, IDENTITY)) throw new Error('candidate/provider identity mismatch');
      return { fieldId: candidate.fieldId, value: { kind: candidate.value.kind, value: candidate.value.value }, source: 'MODEL' as const, confidence: candidate.confidence, evidence: candidate.evidence.map(evidence), provider: { ...candidate.provider } };
    });
    return { candidates, provider: { ...wire.provider } };
  }
}
