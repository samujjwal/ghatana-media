import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createDocumentExtractionEngine,
  invokeFieldExtractionWithCapabilityAdmission,
  type ExtractionEngineDependencies,
  type ExtractionRoutingPolicy,
  type ExtractionSchema,
  type ExtractionTemplate,
  type FieldExtractionRequest,
  type ParsedDocument,
} from '@ghatana/document-extraction';
import {
  FixedExtractionClock,
  InMemoryExtractionExecutionRepository,
  InMemoryExtractionResultStore,
  InMemoryExtractionReviewStore,
  InMemoryExtractionSchemaPort,
  InMemoryExtractionSourcePort,
  InMemoryExtractionTemplatePort,
  InMemoryStructureSimilarityPort,
} from '@ghatana/document-extraction/testing';
import { DocumentIntelligenceClient } from '../src/client.js';
import { DoclingDocumentParserAdapter } from '../src/adapters/docling-document-parser.js';
import { PaddleDocumentParserAdapter } from '../src/adapters/paddle-document-parser.js';
import { GlinerFieldExtractionAdapter } from '../src/adapters/gliner-field-extractor.js';
import { MiniLmStructureEmbeddingAdapter } from '../src/adapters/minilm-structure-embedding.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { bootstrapCanonicalWorker, type CanonicalWorkerHandle } from './support/canonical-worker-bootstrap.js';

const ownership = { ownerRef: 'i3-owner', storageProfileRef: 'i3-storage', learningScopeRef: 'i3-learning' } as const;
const sourceRef = { documentId: 'i3-doc', version: 1, ownerRef: ownership.ownerRef } as const;
const schemaRef = { schemaId: 'i3-schema', version: 1 } as const;
const checksum = { algorithm: 'SHA-256' as const, value: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' };
const bytes = new Uint8Array([1, 2, 3]);
const lineText = 'Name: Alice';

const schema: ExtractionSchema = {
  ref: schemaRef,
  additionalFields: 'REJECT',
  fields: [{ fieldId: 'name', aliases: ['Name'], valueType: 'TEXT', cardinality: 'SINGLE', required: true, normalizers: [], validators: [] }],
};
const template = (templateId: string, rules: ExtractionTemplate['fieldExtractionRules'] = {}): ExtractionTemplate => ({
  ref: { templateId, version: 1 },
  ownerRef: ownership.ownerRef,
  schemaRef,
  name: templateId,
  status: 'ACTIVE',
  matching: { requiredAnchors: [{ text: 'Name' }] },
  fieldExtractionRules: rules,
});
const policy: ExtractionRoutingPolicy = {
  policyRef: 'i3-policy', maxSourceBytes: 1024, maxPages: 10, minTemplateScore: 0.5,
  templateAmbiguityDelta: 0.05, minimumDeterministicAutoAcceptScore: 0.5,
  defaultRequiredFieldConfidence: 0.5, reviewOnOptionalUncertain: false, auditRequired: false, maxAttempts: 1,
};

const documentFor = (mimeType: string) => ({
  documentId: sourceRef.documentId,
  owner: { ownerRef: ownership.ownerRef },
  subject: { subjectType: 'case', subjectId: 'i3-case' },
  classification: 'INTERNAL' as const,
  lifecycle: 'ACTIVE' as const,
  scanState: 'CLEAN' as const,
  currentVersion: { version: 1, checksum, sizeBytes: bytes.byteLength, storage: { storeRef: 'i3-store', objectRef: 'i3-object' } },
  metadata: { fileName: 'i3-fixture', mimeType },
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'i3-test',
});

const GLINER_IDENTITY = { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', modelRef: 'urchade/gliner_multi-v2.1', modelVersion: '443d26d' } as const;
const MINILM_IDENTITY = { providerRef: 'ghatana.minilm', providerVersion: '0.1.0', modelRef: 'sentence-transformers/all-MiniLM-L6-v2', modelVersion: '1110a24' } as const;
const PADDLE_MODEL_IDENTITIES = {
  en: { modelRef: 'PP-OCRv5-en', modelVersion: 'PP-OCRv5-local-en' },
  ne: { modelRef: 'PP-OCRv5-devanagari-shared', modelVersion: 'PP-OCRv5-local-devanagari-shared' },
} as const;

const parsedLines = (text: string) => [{ lineId: 'l1', text, boundingRegion: { x: 0, y: 0, width: 1, height: 1 } }];
const parsedPage = (text: string) => ({ pageNumber: 1, blocks: [{ blockId: 'b1', kind: 'TEXT', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, lines: parsedLines(text) }], tables: [] });

const doclingWire = (operationId: string, text = lineText) => ({
  protocolVersion: PROTOCOL_VERSION,
  operationId,
  providerRef: 'ghatana.docling',
  pages: [parsedPage(text)],
  providerProvenance: { providerRef: 'ghatana.docling', providerVersion: '0.1.0', modelRef: 'docling-standard-pdf-pipeline', modelVersion: 'pinned-docling-runtime' },
  quality: {},
});

const paddleWire = (operationId: string, language: 'en' | 'ne', text = lineText) => ({
  protocolVersion: PROTOCOL_VERSION,
  operationId,
  providerRef: 'ghatana.paddleocr',
  pages: [{ ...parsedPage(text), languageTag: language }],
  providerProvenance: { providerRef: 'ghatana.paddleocr', providerVersion: '0.1.0', ...PADDLE_MODEL_IDENTITIES[language] },
  languageTag: language,
  quality: {},
});

const paddleParseRequest = (executionId: string, languageHint: string) => ({
  executionId,
  source: sourceRef,
  sourceMetadata: { mediaType: 'image/png' },
  content: {
    async *open() { yield bytes; },
  },
  limits: { maxSourceBytes: 1024, maxExternalCallMs: 1000 },
  languageHint,
} as never);

const glinerWire = (operationId: string, confidence: number, value = 'Alice') => ({
  protocolVersion: PROTOCOL_VERSION,
  operationId,
  providerRef: 'ghatana.gliner',
  candidates: [{
    fieldId: 'name',
    value: { kind: 'TEXT', value },
    source: 'MODEL',
    confidence,
    evidence: [{ pageNumber: 1, blockId: 'b1', lineId: 'l1', textSpan: { start: lineText.indexOf(value), end: lineText.indexOf(value) + value.length } }],
    provider: { ...GLINER_IDENTITY },
  }],
  provider: { ...GLINER_IDENTITY },
});

const minilmWire = (operationId: string) => ({
  protocolVersion: PROTOCOL_VERSION,
  operationId,
  providerRef: 'ghatana.minilm',
  model: { ...MINILM_IDENTITY },
  dimensions: 384,
  values: Array.from({ length: 384 }, (_, index) => (index % 16) / 16),
});

const respond = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const operationIdOf = (init?: RequestInit): string => {
  const body = init?.body;
  if (body instanceof FormData) {
    const metadata = body.get('metadata');
    if (typeof metadata === 'string') return (JSON.parse(metadata) as { operationId: string }).operationId;
  }
  if (typeof body === 'string') return (JSON.parse(body) as { operationId: string }).operationId;
  return 'unknown';
};

/** Catalog fixture granting ACCEPTED records to the providers exercised here. */
const catalog = {
  protocolVersion: PROTOCOL_VERSION,
  providers: [
    { providerRef: 'ghatana.docling', providerVersion: '0.1.0', mediaTypes: ['application/pdf'], languages: ['en', 'ne'], features: ['text', 'coordinates'], capabilityIds: ['parser.pdf.docling.text.en', 'parser.pdf.docling.text.ne'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: 'ghatana.paddleocr', providerVersion: '0.1.0', mediaTypes: ['image/png', 'image/jpeg'], languages: ['en', 'ne'], features: ['text', 'coordinates'], capabilityIds: ['ocr.paddle.en', 'ocr.paddle.ne'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', languages: ['en'], features: ['extraction'], capabilityIds: ['extraction.gliner.en'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
  ],
};

const clientFor = (wire: (operationId: string, init?: RequestInit) => unknown | Promise<unknown>): DocumentIntelligenceClient =>
  new DocumentIntelligenceClient({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: (async (url: string, init?: RequestInit) => respond(init?.method === 'GET' && String(url).endsWith('/v1/providers') ? catalog : await wire(operationIdOf(init), init))) as typeof fetch });

function makeDeps(overrides: Partial<ExtractionEngineDependencies> = {}, mimeType = 'application/pdf', registeredTemplates: ExtractionTemplate[] = [template('i3-template')]): ExtractionEngineDependencies {
  const sourcePort = new InMemoryExtractionSourcePort();
  const document = documentFor(mimeType);
  sourcePort.register(ownership, { ref: sourceRef, document: document as never, version: document.currentVersion as never }, bytes);
  const schemas = new InMemoryExtractionSchemaPort();
  schemas.register(ownership, schema);
  const templates = new InMemoryExtractionTemplatePort();
  for (const item of registeredTemplates) templates.register(ownership, item);
  return {
    source: sourcePort,
    schemas,
    templates,
    results: new InMemoryExtractionResultStore(),
    reviews: new InMemoryExtractionReviewStore(),
    executions: new InMemoryExtractionExecutionRepository(),
    parser: new DoclingDocumentParserAdapter(clientFor((op) => doclingWire(op))),
    extractor: new GlinerFieldExtractionAdapter(clientFor((op) => glinerWire(op, 0.9))),
    clock: new FixedExtractionClock('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const run = (deps: ExtractionEngineDependencies, executionId: string, extra: Record<string, unknown> = {}) =>
  createDocumentExtractionEngine(deps).run({ executionId, ownership, source: sourceRef, schema: schemaRef, policy, ...extra });

describe('increment 3 engine-level provider conformance', () => {
  it('docling deterministic acceptance', async () => {
    const rules = { name: [{ kind: 'LABEL_VALUE' as const, aliases: ['Name'], direction: 'RIGHT' as const }] };
    const deps = makeDeps({
      parser: new DoclingDocumentParserAdapter(clientFor((op) => doclingWire(op))),
    }, 'application/pdf', [template('i3-template', rules)]);
    const result = await run(deps, 'i3-docling-accept');
    expect(result.execution.status).toBe('COMPLETED');
    expect(result.reviewRef).toBeUndefined();
    const stored = await deps.results.findByExecution(ownership, 'i3-docling-accept');
    expect(stored?.result.fields[0]?.selectedCandidate?.value).toEqual({ kind: 'TEXT', value: 'Alice' });
  });

  it('docling and gliner supplementation completes', async () => {
    const deps = makeDeps({
      parser: new DoclingDocumentParserAdapter(clientFor((op) => doclingWire(op))),
      extractor: new GlinerFieldExtractionAdapter(clientFor((op) => glinerWire(op, 0.9))),
    });
    const result = await run(deps, 'i3-docling-gliner');
    expect(result.execution.status).toBe('COMPLETED');
    const stored = await deps.results.findByExecution(ownership, 'i3-docling-gliner');
    expect(stored?.result.fields[0]?.selectedCandidate?.source).toBe('MODEL');
  });

  it('paddle and gliner low confidence routes to review', async () => {
    const deps = makeDeps({
      parser: new PaddleDocumentParserAdapter(clientFor((op) => paddleWire(op, 'en'))),
      extractor: new GlinerFieldExtractionAdapter(clientFor((op) => glinerWire(op, 0.2))),
    }, 'image/png');
    const result = await run(deps, 'i3-paddle-review', { languageHint: 'en' });
    expect(result.execution.status).toBe('REVIEW_REQUIRED');
    expect(result.reviewRef).toBeDefined();
    const stored = await deps.results.findByExecution(ownership, 'i3-paddle-review');
    expect(stored?.result.disposition).toBe('REVIEW_REQUIRED');
  });

  it('paddle Nepali parser binds the frozen shared Devanagari model and sends ne', async () => {
    let requestedLanguage: unknown;
    const parser = new PaddleDocumentParserAdapter(clientFor((operationId, init) => {
      const body = init?.body;
      if (body instanceof FormData) {
        const metadata = body.get('metadata');
        if (typeof metadata === 'string') {
          requestedLanguage = (JSON.parse(metadata) as { languageHint?: unknown }).languageHint;
        }
      }
      return { ...paddleWire(operationId, 'ne'), operationId };
    }));
    const parsed = await parser.parse(paddleParseRequest('i3-paddle-ne', 'ne'));
    expect(requestedLanguage).toBe('ne');
    expect(parsed.providerProvenance).toMatchObject({
      providerRef: 'ghatana.paddleocr',
      modelRef: 'PP-OCRv5-devanagari-shared',
      modelVersion: 'PP-OCRv5-local-devanagari-shared',
    });
  });

  it('paddle Nepali parser rejects the stale language-specific model alias', async () => {
    const parser = new PaddleDocumentParserAdapter(clientFor((operationId) => ({
      ...paddleWire(operationId, 'ne'),
      operationId,
      providerProvenance: {
        providerRef: 'ghatana.paddleocr',
        providerVersion: '0.1.0',
        modelRef: 'PP-OCRv5-ne',
        modelVersion: 'PP-OCRv5-local-ne',
      },
    })));
    await expect(parser.parse(paddleParseRequest('i3-paddle-ne-stale', 'ne')))
      .rejects.toMatchObject({ code: 'PARSE_OUTPUT_INVALID' });
  });

  it('ambiguous minilm template match routes to review', async () => {
    const similarity = new InMemoryStructureSimilarityPort();
    similarity.setMatches([
      { templateRef: { templateId: 'i3-template-a', version: 1 }, score: 0.9 },
      { templateRef: { templateId: 'i3-template-b', version: 1 }, score: 0.88 },
    ], ownership);
    // The real worker extracts only the requested field ids. When the schema
    // fallback resolves every field deterministically the engine sends an
    // empty field list and a faithful provider must return no candidates.
    const requestedAwareGliner = (op: string, init?: RequestInit) => {
      const wire = glinerWire(op, 0.9);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { payload?: { fields?: { fieldId?: unknown }[] } }) : {};
      const fields = body.payload?.fields ?? [];
      return fields.some((field) => field?.fieldId === 'name') ? wire : { ...wire, candidates: [] };
    };
    const deps = makeDeps({
      parser: new DoclingDocumentParserAdapter(clientFor((op) => doclingWire(op))),
      extractor: new GlinerFieldExtractionAdapter(clientFor(requestedAwareGliner)),
      embedding: new MiniLmStructureEmbeddingAdapter(clientFor((op) => minilmWire(op))),
      similarity,
    }, 'application/pdf', [template('i3-template-a'), template('i3-template-b')]);
    const result = await run(deps, 'i3-minilm-ambiguous');
    expect(result.execution.status).toBe('REVIEW_REQUIRED');
    const stored = await deps.results.findByExecution(ownership, 'i3-minilm-ambiguous');
    expect(stored?.result.templateMatch.status).toBe('AMBIGUOUS');
  });

  it('provider timeout fails the execution without persisting a result', async () => {
    const hanging = new DocumentIntelligenceClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: ((url: string, init?: RequestInit) => init?.method === 'GET' && String(url).endsWith('/v1/providers') ? Promise.resolve(respond(catalog)) : new Promise<Response>(() => { /* never resolves */ })) as typeof fetch,
    });
    const deps = makeDeps({ parser: new DoclingDocumentParserAdapter(hanging), externalCallTimeoutMs: 50 });
    await expect(run(deps, 'i3-timeout')).rejects.toMatchObject({ code: 'EXTERNAL_CALL_TIMEOUT', retryable: true, stage: 'PARSING' });
    expect((await deps.executions.get('i3-timeout'))?.status).toBe('FAILED');
    expect(await deps.results.findByExecution(ownership, 'i3-timeout')).toBeUndefined();
  });

  it('cancellation during provider execution marks the execution cancelled', async () => {
    const controller = new AbortController();
    const cancelling = new DocumentIntelligenceClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (init?.method === 'GET' && String(url).endsWith('/v1/providers')) return respond(catalog);
        controller.abort();
        return respond(doclingWire('i3-cancel'));
      }) as typeof fetch,
    });
    const deps = makeDeps({ parser: new DoclingDocumentParserAdapter(cancelling) });
    await expect(run(deps, 'i3-cancel', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await deps.executions.get('i3-cancel'))?.status).toBe('CANCELLED');
  });

  it('malformed provider output fails closed and persists no result', async () => {
    const malformed = { ...doclingWire('i3-malformed'), providerProvenance: { providerRef: 'ghatana.docling', providerVersion: '0.1.0', modelRef: 'unexpected-model', modelVersion: 'unexpected-version' } };
    const deps = makeDeps({ parser: new DoclingDocumentParserAdapter(clientFor(() => malformed)) });
    await expect(run(deps, 'i3-malformed')).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    expect((await deps.executions.get('i3-malformed'))?.status).toBe('FAILED');
    expect(await deps.results.findByExecution(ownership, 'i3-malformed')).toBeUndefined();
  });

  it('astral unicode evidence spans index exact shared line text after admission', async () => {
    const astralLine = 'prefix 😀 invoice INV-1001';
    const value = 'INV-1001';
    const parsedDocument = {
      source: sourceRef,
      pages: [parsedPage(astralLine)],
      providerProvenance: { providerRef: 'ghatana.docling', providerVersion: '0.1.0' },
      quality: {},
    } as unknown as ParsedDocument;
    const start = astralLine.indexOf(value);
    const wire = {
      protocolVersion: PROTOCOL_VERSION,
      operationId: 'i3-astral',
      providerRef: 'ghatana.gliner',
      candidates: [{
        fieldId: 'name',
        value: { kind: 'TEXT', value },
        source: 'MODEL',
        confidence: 0.9,
        evidence: [{ pageNumber: 1, blockId: 'b1', lineId: 'l1', textSpan: { start, end: start + value.length } }],
        provider: { ...GLINER_IDENTITY },
      }],
      provider: { ...GLINER_IDENTITY },
    };
    const adapter = new GlinerFieldExtractionAdapter(clientFor(() => wire));
    const request = { executionId: 'i3-astral', schema, parsedDocument, requestedFieldIds: ['name'] } as unknown as FieldExtractionRequest;
    const result = await invokeFieldExtractionWithCapabilityAdmission(adapter, request);
    const span = result.candidates[0]?.evidence[0]?.textSpan;
    expect(span).toBeDefined();
    // JavaScript string indexing is UTF-16; the emitted span must slice the
    // exact Shared line text even across the astral code point.
    expect(astralLine.slice(span!.start, span!.end)).toBe(value);
    expect(span!.start).toBe(start);
  });
});

const liveSchema: ExtractionSchema = {
  ref: schemaRef,
  additionalFields: 'REJECT',
  fields: [{ fieldId: 'document_number', aliases: ['invoice number', 'invoice'], valueType: 'IDENTIFIER', cardinality: 'SINGLE', required: true, normalizers: [], validators: [] }],
};
const liveTemplate = (templateId: string, rules: ExtractionTemplate['fieldExtractionRules'] = {}): ExtractionTemplate => ({
  ref: { templateId, version: 1 },
  ownerRef: ownership.ownerRef,
  schemaRef,
  name: templateId,
  status: 'ACTIVE',
  matching: { requiredAnchors: [{ text: 'Synthetic' }] },
  fieldExtractionRules: rules,
});

function makeLiveDeps(client: DocumentIntelligenceClient, sourceBytes: Uint8Array, mimeType: string, registeredTemplates: ExtractionTemplate[], overrides: Partial<ExtractionEngineDependencies> = {}): ExtractionEngineDependencies {
  const sourcePort = new InMemoryExtractionSourcePort();
  const liveChecksum = { algorithm: 'SHA-256' as const, value: createHash('sha256').update(sourceBytes).digest('hex') };
  const document = {
    ...documentFor(mimeType),
    currentVersion: { ...documentFor(mimeType).currentVersion, checksum: liveChecksum, sizeBytes: sourceBytes.byteLength },
  };
  sourcePort.register(ownership, { ref: sourceRef, document: document as never, version: document.currentVersion as never }, sourceBytes);
  const schemas = new InMemoryExtractionSchemaPort();
  schemas.register(ownership, liveSchema);
  const templates = new InMemoryExtractionTemplatePort();
  for (const item of registeredTemplates) templates.register(ownership, item);
  return {
    source: sourcePort,
    schemas,
    templates,
    results: new InMemoryExtractionResultStore(),
    reviews: new InMemoryExtractionReviewStore(),
    executions: new InMemoryExtractionExecutionRepository(),
    parser: new DoclingDocumentParserAdapter(client, 120_000),
    extractor: new GlinerFieldExtractionAdapter(client, 120_000),
    clock: new FixedExtractionClock('2026-01-01T00:00:00Z'),
    externalCallTimeoutMs: 120_000,
    ...overrides,
  };
}

const runLive = (deps: ExtractionEngineDependencies, executionId: string, extra: Record<string, unknown> = {}) =>
  createDocumentExtractionEngine(deps).run({ executionId, ownership, source: sourceRef, schema: schemaRef, policy: { ...policy, maxSourceBytes: 5 * 1024 * 1024 }, ...extra });

const runLiveProviders = process.env.DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS === '1';

describe.runIf(runLiveProviders)('increment 3 live-worker engine provider composition', () => {
  let workerRoot = '';
  let client: DocumentIntelligenceClient;
  let bootstrap: CanonicalWorkerHandle | undefined;

  beforeAll(async () => {
    bootstrap = await bootstrapCanonicalWorker();
    workerRoot = bootstrap.identity.workerRoot;
    client = bootstrap.client;
  }, 430_000);

  afterAll(async () => {
    await bootstrap?.stop();
  });

  it('live docling crosses adapter admission and engine to accepted result', async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(workerRoot, 'evaluation/corpus/pdf-en-simple.pdf')));
    const rules = { document_number: [{ kind: 'LABEL_VALUE' as const, aliases: ['invoice number'], direction: 'RIGHT' as const }] };
    const deps = makeLiveDeps(client, sourceBytes, 'application/pdf', [liveTemplate('i3-live-docling', rules)]);
    const result = await runLive(deps, 'i3-live-docling');
    expect(result.execution.status).toBe('COMPLETED');
    expect((await deps.results.findByExecution(ownership, 'i3-live-docling'))?.result.disposition).toBe('ACCEPTED');
  }, 180_000);

  it('live docling and gliner cross adapter admissions and engine to accepted result', async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(workerRoot, 'evaluation/corpus/pdf-en-simple.pdf')));
    const deps = makeLiveDeps(client, sourceBytes, 'application/pdf', [liveTemplate('i3-live-docling-gliner')]);
    const result = await runLive(deps, 'i3-live-docling-gliner');
    expect(result.execution.status).toBe('COMPLETED');
    const stored = await deps.results.findByExecution(ownership, 'i3-live-docling-gliner');
    expect(stored?.result.disposition).toBe('ACCEPTED');
    expect(stored?.result.fields[0]?.selectedCandidate?.source).toBe('MODEL');
  }, 180_000);

  it('live paddle and gliner cross adapter admissions and engine to review', async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(workerRoot, 'evaluation/corpus/image-en-clean.png')));
    const deps = makeLiveDeps(client, sourceBytes, 'image/png', [liveTemplate('i3-live-paddle-gliner')], { parser: new PaddleDocumentParserAdapter(client, 120_000) });
    const result = await runLive(deps, 'i3-live-paddle-gliner', { languageHint: 'en', policy: { ...policy, maxSourceBytes: 5 * 1024 * 1024, defaultRequiredFieldConfidence: 0.99 } });
    expect(result.execution.status).toBe('REVIEW_REQUIRED');
    expect((await deps.results.findByExecution(ownership, 'i3-live-paddle-gliner'))?.result.disposition).toBe('REVIEW_REQUIRED');
  }, 180_000);

  it('live minilm crosses adapter admission before test-owned similarity routes ambiguity to review', async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(workerRoot, 'evaluation/corpus/pdf-en-simple.pdf')));
    const similarity = new InMemoryStructureSimilarityPort();
    similarity.setMatches([
      { templateRef: { templateId: 'i3-live-template-a', version: 1 }, score: 0.9 },
      { templateRef: { templateId: 'i3-live-template-b', version: 1 }, score: 0.88 },
    ], ownership);
    const rules = { document_number: [{ kind: 'LABEL_VALUE' as const, aliases: ['invoice number'], direction: 'RIGHT' as const }] };
    const deps = makeLiveDeps(client, sourceBytes, 'application/pdf', [liveTemplate('i3-live-template-a', rules), liveTemplate('i3-live-template-b', rules)], {
      embedding: new MiniLmStructureEmbeddingAdapter(client, 120_000),
      similarity,
    });
    const result = await runLive(deps, 'i3-live-minilm');
    expect(result.execution.status).toBe('REVIEW_REQUIRED');
    expect((await deps.results.findByExecution(ownership, 'i3-live-minilm'))?.result.templateMatch.status).toBe('AMBIGUOUS');
  }, 180_000);
});
