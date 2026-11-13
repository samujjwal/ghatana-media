import { describe, expect, it } from 'vitest';
import { canonicalStructureProjectionV1, createStructureProjectionV1 } from '../src/structure-projection-v1.js';
import type { StructureDescriptor } from '@ghatana/document-extraction';

const descriptor = (blockId: string): StructureDescriptor => ({ pageCount: 1, blockKindCounts: { TEXT: 1 }, tableShapes: [], normalizedBlockGeometry: [{ pageNumber: 1, blockId, x: 0, y: 0, width: 1, height: 1 }], semanticTextBasis: 'hello', structuralFingerprint: 'fingerprint' });
describe('structure projection v1', () => {
  it('excludes unstable block IDs and is canonical', () => { expect(canonicalStructureProjectionV1(descriptor('a'))).toBe(canonicalStructureProjectionV1(descriptor('b'))); expect(createStructureProjectionV1(descriptor('a')).version).toBe('document-structure-embedding.v1'); });
});
