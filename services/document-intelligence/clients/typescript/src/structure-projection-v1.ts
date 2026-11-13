import type { StructureDescriptor } from '@ghatana/document-extraction';

export interface StructureProjectionV1 {
  readonly version: 'document-structure-embedding.v1';
  readonly pageCount: number;
  readonly blockKindCounts: Readonly<Record<string, number>>;
  readonly tableShapes: readonly { readonly rows: number; readonly columns: number }[];
  readonly normalizedBlockGeometry: readonly { readonly pageNumber: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
  readonly semanticTextBasis: string;
  readonly structuralFingerprint: string;
}
export function createStructureProjectionV1(descriptor: StructureDescriptor): StructureProjectionV1 {
  return Object.freeze({
    version: 'document-structure-embedding.v1',
    pageCount: descriptor.pageCount,
    blockKindCounts: Object.fromEntries(Object.entries(descriptor.blockKindCounts).sort(([left], [right]) => left.localeCompare(right))),
    tableShapes: descriptor.tableShapes.map(({ rows, columns }) => ({ rows, columns })),
    normalizedBlockGeometry: descriptor.normalizedBlockGeometry.map(({ pageNumber, x, y, width, height }) => ({ pageNumber, x, y, width, height })),
    semanticTextBasis: descriptor.semanticTextBasis,
    structuralFingerprint: descriptor.structuralFingerprint,
  });
}
export function canonicalStructureProjectionV1(descriptor: StructureDescriptor): string {
  return JSON.stringify(createStructureProjectionV1(descriptor));
}
