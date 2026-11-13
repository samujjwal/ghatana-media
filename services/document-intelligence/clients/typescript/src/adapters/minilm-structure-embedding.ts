import type { EmbeddingCapabilities, StructureEmbedding, StructureEmbeddingPort, StructureEmbeddingRequest } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../client.js';
import { createStructureProjectionV1 } from '../structure-projection-v1.js';

const MODEL_REF = 'sentence-transformers/all-MiniLM-L6-v2';
export class MiniLmStructureEmbeddingAdapter implements StructureEmbeddingPort {
  constructor(private readonly client: DocumentIntelligenceClient, private readonly timeoutMs = 30_000) {}
  async capabilities(): Promise<EmbeddingCapabilities> { return { maxDimensions: 384, modelRef: MODEL_REF }; }
  async embed(input: StructureEmbeddingRequest): Promise<StructureEmbedding> {
    const wire = await this.client.embed({ operationId: input.executionId, providerRef: 'ghatana.minilm', timeoutMs: this.timeoutMs, limits: { maxDimensions: 384 }, projection: createStructureProjectionV1(input.descriptor) as unknown as Record<string, unknown>, signal: input.signal });
    if (wire.model.modelRef !== MODEL_REF || wire.dimensions !== 384 || wire.values.length !== 384 || wire.values.some((value) => !Number.isFinite(value))) throw new Error('invalid MiniLM embedding');
    return { model: { ...wire.model }, dimensions: wire.dimensions, values: [...wire.values] };
  }
}
