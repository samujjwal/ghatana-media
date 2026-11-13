import {
  PROTOCOL_VERSION,
  type WireBlock,
  type WireEmbeddingResponse,
  type WireError,
  type WireIdentity,
  type WireLine,
  type WirePage,
  type WireParsedDocument,
  type WireTable,
  type WireBox,
  type WireExtractionResponse,
  type WireProviderCatalog,
} from './protocol.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): boolean => {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};
const str = (value: unknown, limit = 1_000_000): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;
const identifier = (value: unknown, limit = 256): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value) && value.length <= limit;
const modelRef = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?$/u.test(value) && value.length <= 256;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value);

const box = (value: unknown): value is WireBox => {
  if (!isRecord(value) || !within(value, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height'])) return false;
  const values = ['x', 'y', 'width', 'height'].map((key) => value[key]);
  return values.every(finite) && values.every((item) => item >= 0) && Number(value.x) + Number(value.width) <= 1 && Number(value.y) + Number(value.height) <= 1;
};

export function assertWireIdentity(value: unknown): asserts value is WireIdentity {
  if (!isRecord(value) || !within(value, ['providerRef', 'providerVersion', 'modelRef', 'modelVersion'], ['providerRef', 'providerVersion'])) throw new Error('invalid provider identity');
  if (!identifier(value.providerRef) || !identifier(value.providerVersion, 128)) throw new Error('invalid provider identity');
  const hasModelRef = value.modelRef !== undefined;
  const hasModelVersion = value.modelVersion !== undefined;
  if (hasModelRef !== hasModelVersion || (hasModelRef && !modelRef(value.modelRef)) || (hasModelVersion && !identifier(value.modelVersion, 128))) throw new Error('invalid provider identity');
}

function assertLine(value: unknown): asserts value is WireLine {
  if (!isRecord(value) || !within(value, ['lineId', 'text', 'boundingRegion', 'confidence', 'languageTag'], ['lineId', 'text', 'boundingRegion'])) throw new Error('invalid wire line');
  if (!str(value.lineId, 256) || typeof value.text !== 'string' || value.text.length > 1_000_000 || !box(value.boundingRegion)) throw new Error('invalid wire line');
  if (value.confidence !== undefined && (!finite(value.confidence) || value.confidence < 0 || value.confidence > 1)) throw new Error('invalid wire line');
  if (value.languageTag !== undefined && !str(value.languageTag, 64)) throw new Error('invalid wire line');
}

function assertBlock(value: unknown): asserts value is WireBlock {
  if (!isRecord(value) || !within(value, ['blockId', 'kind', 'boundingRegion', 'lines', 'confidence', 'languageTag'], ['blockId', 'kind', 'boundingRegion', 'lines']) || !str(value.blockId, 256) || !str(value.kind, 256) || !box(value.boundingRegion) || !Array.isArray(value.lines) || value.lines.length > 2_000) throw new Error('invalid wire block');
  if (value.confidence !== undefined && (!finite(value.confidence) || value.confidence < 0 || value.confidence > 1)) throw new Error('invalid wire block');
  if (value.languageTag !== undefined && !str(value.languageTag, 64)) throw new Error('invalid wire block');
  value.lines.forEach(assertLine);
}

function assertTable(value: unknown): asserts value is WireTable {
  if (!isRecord(value) || !within(value, ['tableId', 'boundingRegion', 'rowCount', 'columnCount', 'headers', 'cells', 'confidence'], ['tableId', 'boundingRegion', 'rowCount', 'columnCount', 'cells']) || !str(value.tableId, 256) || !box(value.boundingRegion) || !integer(value.rowCount) || value.rowCount < 0 || !integer(value.columnCount) || value.columnCount < 0 || !Array.isArray(value.cells) || value.cells.length > 100_000) throw new Error('invalid wire table');
  if (value.headers !== undefined && (!Array.isArray(value.headers) || value.headers.some((item) => typeof item !== 'string'))) throw new Error('invalid wire table');
  if (value.confidence !== undefined && (!finite(value.confidence) || value.confidence < 0 || value.confidence > 1)) throw new Error('invalid wire table');
  for (const cell of value.cells) {
    if (!isRecord(cell) || !within(cell, ['cellId', 'rowIndex', 'columnIndex', 'rowSpan', 'columnSpan', 'text', 'boundingRegion', 'confidence'], ['cellId', 'rowIndex', 'columnIndex', 'text', 'boundingRegion']) || !str(cell.cellId, 256) || !integer(cell.rowIndex) || cell.rowIndex < 0 || !integer(cell.columnIndex) || cell.columnIndex < 0 || typeof cell.text !== 'string' || !box(cell.boundingRegion)) throw new Error('invalid wire cell');
    for (const key of ['rowSpan', 'columnSpan']) if (cell[key] !== undefined && (!integer(cell[key]) || Number(cell[key]) <= 0)) throw new Error('invalid wire cell');
    if (cell.confidence !== undefined && (!finite(cell.confidence) || cell.confidence < 0 || cell.confidence > 1)) throw new Error('invalid wire cell');
  }
}

function assertPage(value: unknown): asserts value is WirePage {
  if (!isRecord(value) || !within(value, ['pageNumber', 'blocks', 'tables', 'languageTag'], ['pageNumber', 'blocks', 'tables']) || !integer(value.pageNumber) || value.pageNumber < 1 || !Array.isArray(value.blocks) || !Array.isArray(value.tables)) throw new Error('invalid wire page');
  if (value.languageTag !== undefined && !str(value.languageTag, 64)) throw new Error('invalid wire page');
  value.blocks.forEach(assertBlock);
  value.tables.forEach(assertTable);
}

function assertQuality(value: unknown): void {
  if (!isRecord(value) || !within(value, ['parseConfidence', 'completeness', 'warnings'])) throw new Error('invalid quality');
  for (const key of ['parseConfidence', 'completeness']) if (value[key] !== undefined && (!finite(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 1)) throw new Error('invalid quality');
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.some((item) => typeof item !== 'string'))) throw new Error('invalid quality');
}

function assertEvidence(value: unknown): void {
  if (!isRecord(value) || !within(value, ['pageNumber', 'blockId', 'lineId', 'boundingRegion', 'textSpan'], ['pageNumber']) || !integer(value.pageNumber) || value.pageNumber < 1) throw new Error('invalid evidence');
  if (value.blockId !== undefined && !str(value.blockId, 256)) throw new Error('invalid evidence');
  if (value.lineId !== undefined && !str(value.lineId, 256)) throw new Error('invalid evidence');
  if (value.boundingRegion !== undefined && !box(value.boundingRegion)) throw new Error('invalid evidence');
  if (value.textSpan !== undefined) {
    if (!isRecord(value.textSpan) || !within(value.textSpan, ['start', 'end'], ['start', 'end']) || !integer(value.textSpan.start) || !integer(value.textSpan.end) || Number(value.textSpan.start) < 0 || Number(value.textSpan.end) < Number(value.textSpan.start)) throw new Error('invalid evidence');
  }
}

export function validateParsedResponse(value: unknown): WireParsedDocument {
  if (!isRecord(value) || !within(value, ['protocolVersion', 'operationId', 'providerRef', 'pages', 'providerProvenance', 'quality', 'languageTag'], ['protocolVersion', 'operationId', 'providerRef', 'pages', 'providerProvenance', 'quality']) || value.protocolVersion !== PROTOCOL_VERSION || !identifier(value.operationId) || !identifier(value.providerRef) || !Array.isArray(value.pages) || value.pages.length > 500) throw new Error('invalid parsed response');
  assertWireIdentity(value.providerProvenance);
  if (value.providerProvenance.providerRef !== value.providerRef) throw new Error('provider identity mismatch');
  assertQuality(value.quality);
  value.pages.forEach(assertPage);
  if (value.languageTag !== undefined && !str(value.languageTag, 64)) throw new Error('invalid parsed response');
  return value as unknown as WireParsedDocument;
}

export function validateExtractionResponse(value: unknown): WireExtractionResponse {
  if (!isRecord(value) || !within(value, ['protocolVersion', 'operationId', 'providerRef', 'candidates', 'provider'], ['protocolVersion', 'operationId', 'providerRef', 'candidates', 'provider']) || value.protocolVersion !== PROTOCOL_VERSION || !identifier(value.operationId) || !identifier(value.providerRef) || !Array.isArray(value.candidates) || value.candidates.length > 16_000) throw new Error('invalid extraction response');
  assertWireIdentity(value.provider);
  if (value.provider.providerRef !== value.providerRef) throw new Error('provider identity mismatch');
  value.candidates.forEach((candidate) => {
    if (!isRecord(candidate) || !within(candidate, ['fieldId', 'value', 'source', 'confidence', 'evidence', 'provider'], ['fieldId', 'value', 'source', 'confidence', 'evidence', 'provider']) || !str(candidate.fieldId, 256) || candidate.source !== 'MODEL' || !finite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 || !Array.isArray(candidate.evidence) || candidate.evidence.length > 32 || !isRecord(candidate.value) || !within(candidate.value, ['kind', 'value'], ['kind', 'value']) || !['TEXT', 'IDENTIFIER'].includes(String(candidate.value.kind)) || typeof candidate.value.value !== 'string') throw new Error('invalid extraction candidate');
    assertWireIdentity(candidate.provider);
    if (candidate.provider.providerRef !== value.providerRef) throw new Error('candidate identity mismatch');
    candidate.evidence.forEach(assertEvidence);
  });
  return value as unknown as WireExtractionResponse;
}

export function validateEmbeddingResponse(value: unknown): WireEmbeddingResponse {
  if (!isRecord(value) || !within(value, ['protocolVersion', 'operationId', 'providerRef', 'model', 'dimensions', 'values'], ['protocolVersion', 'operationId', 'providerRef', 'model', 'dimensions', 'values']) || value.protocolVersion !== PROTOCOL_VERSION || !identifier(value.operationId) || !identifier(value.providerRef) || !integer(value.dimensions) || value.dimensions !== 384 || !Array.isArray(value.values) || value.values.length !== 384 || value.values.some((item) => !finite(item))) throw new Error('invalid embedding response');
  assertWireIdentity(value.model);
  if (value.model.providerRef !== value.providerRef) throw new Error('provider identity mismatch');
  return value as unknown as WireEmbeddingResponse;
}

export function validateError(value: unknown): WireError {
  if (!isRecord(value) || !within(value, ['protocolVersion', 'operationId', 'code', 'retryable', 'providerRef'], ['protocolVersion', 'operationId', 'code', 'retryable']) || value.protocolVersion !== PROTOCOL_VERSION || !identifier(value.operationId) || !identifier(value.code, 64) || typeof value.retryable !== 'boolean') throw new Error('invalid worker error');
  if (value.providerRef !== undefined && !identifier(value.providerRef)) throw new Error('invalid worker error');
  return value as unknown as WireError;
}

export function validateProviderCatalog(value: unknown): WireProviderCatalog {
  if (!isRecord(value) || !within(value, ['protocolVersion', 'workerCapabilityVersion', 'providers'], ['protocolVersion', 'providers']) || value.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(value.providers) || value.providers.length > 256) throw new Error('invalid provider catalog');
  if (value.workerCapabilityVersion !== undefined && !str(value.workerCapabilityVersion, 128)) throw new Error('invalid provider catalog');
  for (const provider of value.providers) {
    if (!isRecord(provider) || !within(provider, ['providerRef', 'providerVersion', 'modelRef', 'modelVersion', 'languageModelIdentities', 'mediaTypes', 'supportedLanguages', 'supportedValueTypes', 'capabilityIds', 'languages', 'features', 'maxDimensions', 'supportsTables', 'supportsCoordinates', 'supportsLanguages', 'supportsConfidenceScores', 'supportsMultipleCardinality', 'promotionStatus', 'loaded', 'ready'], ['providerRef', 'providerVersion', 'promotionStatus', 'loaded', 'ready'])) throw new Error('invalid provider catalog entry');
    assertWireIdentity({ providerRef: provider.providerRef, providerVersion: provider.providerVersion, ...(provider.modelRef === undefined ? {} : { modelRef: provider.modelRef }), ...(provider.modelVersion === undefined ? {} : { modelVersion: provider.modelVersion }) });
    if (typeof provider.loaded !== 'boolean' || typeof provider.ready !== 'boolean' || (provider.promotionStatus !== 'ACCEPTED' && provider.promotionStatus !== 'UNPROMOTED')) throw new Error('invalid provider catalog entry');
    for (const key of ['mediaTypes', 'supportedLanguages', 'supportedValueTypes', 'capabilityIds', 'languages', 'features']) if (provider[key] !== undefined && (!Array.isArray(provider[key]) || provider[key].some((item) => !str(item, 256)))) throw new Error('invalid provider catalog entry');
    if (provider.languageModelIdentities !== undefined) {
      if (!Array.isArray(provider.languageModelIdentities)) throw new Error('invalid provider catalog entry');
      for (const identity of provider.languageModelIdentities) {
        if (!isRecord(identity) || !within(identity, ['language', 'modelRef', 'modelVersion'], ['language', 'modelRef', 'modelVersion']) || typeof identity.language !== 'string' || !/^[a-z]{2,3}$/u.test(identity.language)) throw new Error('invalid provider language model identity');
        assertWireIdentity({ providerRef: provider.providerRef, providerVersion: provider.providerVersion, modelRef: identity.modelRef, modelVersion: identity.modelVersion });
      }
    }
    if (provider.maxDimensions !== undefined && (!integer(provider.maxDimensions) || Number(provider.maxDimensions) <= 0)) throw new Error('invalid provider catalog entry');
    for (const key of ['supportsTables', 'supportsCoordinates', 'supportsLanguages', 'supportsConfidenceScores', 'supportsMultipleCardinality']) if (provider[key] !== undefined && typeof provider[key] !== 'boolean') throw new Error('invalid provider catalog entry');
  }
  return value as unknown as WireProviderCatalog;
}
