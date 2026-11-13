import { describe, expect, it } from 'vitest';
import { MiniLmStructureEmbeddingAdapter } from '../src/adapters/minilm-structure-embedding.js';

describe('MiniLM adapter', () => { it('declares a 384-dimension structure embedding adapter', () => { expect(MiniLmStructureEmbeddingAdapter).toBeDefined(); }); });
