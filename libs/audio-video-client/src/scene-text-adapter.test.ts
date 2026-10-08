import { describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
  DOCUMENT_INTELLIGENCE_WORKER_V1,
  DocumentIntelligenceSceneTextAdapter,
  SceneTextAdapterError,
  type DocumentIntelligenceV1Client,
  type SceneTextAdapterPolicy,
  type SceneTextProviderCatalog,
  type SceneTextSourceFrame,
  type SceneTextWireDocument,
} from './scene-text-adapter.js';

const policy: SceneTextAdapterPolicy = {
  providerRef: 'di.ocr.en',
  providerVersion: '2.4.1',
  modelRef: 'model.scene-text.en',
  modelVersion: '2026.09.2',
  acceptedMediaTypes: ['image/png'],
  acceptedLanguages: ['en-US'],
  timeoutMs: 3_000,
  workerLimits: { maxPages: 1, maxRegions: 50 },
};
const frame: SceneTextSourceFrame = {
  sourceArtifactId: 'artifact-7', sourceVersion: 'v3', frameId: 'frame-12',
  timestampUs: 2_345_678, mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]), languageHint: 'en-US',
};

function catalog(overrides: Partial<SceneTextProviderCatalog> = {}): SceneTextProviderCatalog {
  return {
    protocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
    workerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
    providers: [{
      providerRef: policy.providerRef, providerVersion: policy.providerVersion,
      modelRef: policy.modelRef, modelVersion: policy.modelVersion,
      mediaTypes: ['image/png'], supportedLanguages: ['en-US'],
      promotionStatus: 'ACCEPTED', loaded: true, ready: true,
    }],
    ...overrides,
  };
}

function document(overrides: Partial<SceneTextWireDocument> = {}): SceneTextWireDocument {
  return {
    protocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
    operationId: 'op-scene-text', providerRef: policy.providerRef,
    providerProvenance: {
      providerRef: policy.providerRef, providerVersion: policy.providerVersion,
      modelRef: policy.modelRef, modelVersion: policy.modelVersion,
    },
    pages: [{
      pageNumber: 1,
      tables: [],
      blocks: [{ blockId: 'b-1', lines: [{
        lineId: 'l-1', text: 'Exit 42', confidence: 0.98, languageTag: 'en-US',
        boundingRegion: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
      }] }],
    }],
    ...overrides,
  };
}

function client(options: {
  readonly catalog?: SceneTextProviderCatalog;
  readonly result?: SceneTextWireDocument;
  readonly protocolVersion?: string;
  readonly workerVersion?: string;
} = {}): DocumentIntelligenceV1Client {
  return {
    lastProtocolVersion: options.protocolVersion ?? DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
    lastWorkerCapabilityVersion: options.workerVersion ?? DOCUMENT_INTELLIGENCE_WORKER_V1,
    providers: vi.fn(async () => options.catalog ?? catalog()),
    parse: vi.fn(async () => options.result ?? document()),
  };
}

async function expectCode(
  adapter: DocumentIntelligenceSceneTextAdapter,
  code: string,
  source = frame,
  signal?: AbortSignal,
) {
  await expect(adapter.recognizeFrame('op-scene-text', source, signal)).rejects.toMatchObject({ code });
}

describe('DocumentIntelligenceSceneTextAdapter', () => {
  it('preserves source version and Media frame timestamp while mapping public v1 provenance', async () => {
    const di = client();
    const result = await new DocumentIntelligenceSceneTextAdapter(di, policy)
      .recognizeFrame('op-scene-text', frame);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceArtifactId: 'artifact-7', sourceVersion: 'v3', frameId: 'frame-12',
      timestampUs: 2_345_678, protocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
      workerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
      provider: { providerRef: 'di.ocr.en', providerVersion: '2.4.1', modelRef: 'model.scene-text.en', modelVersion: '2026.09.2' },
      pageNumber: 1, wireOrdinal: 0, blockId: 'b-1', lineId: 'l-1', text: 'Exit 42', confidence: 0.98,
    });
    expect(di.parse).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'op-scene-text', providerRef: 'di.ocr.en', mediaType: 'image/png',
      languageHint: 'en-US', timeoutMs: 3000, limits: { maxPages: 1, maxRegions: 50 }, bytes: frame.bytes,
    }));
  });

  it('rejects source identity gaps and unsupported source media before provider calls', async () => {
    const di = client();
    const adapter = new DocumentIntelligenceSceneTextAdapter(di, policy);
    await expectCode(adapter, 'SOURCE_IDENTITY_INVALID', { ...frame, sourceVersion: '' });
    await expectCode(adapter, 'SOURCE_IDENTITY_INVALID', { ...frame, timestampUs: -1 });
    await expectCode(adapter, 'SOURCE_IDENTITY_INVALID', { ...frame, timestampUs: Number.POSITIVE_INFINITY });
    await expectCode(adapter, 'SOURCE_PAYLOAD_INVALID', { ...frame, bytes: new Uint8Array() });
    await expectCode(adapter, 'SOURCE_MEDIA_TYPE_NOT_ADMITTED', { ...frame, mediaType: 'image/tiff' });
    await expectCode(adapter, 'SOURCE_LANGUAGE_NOT_ADMITTED', { ...frame, languageHint: 'fr-FR' });
    expect(di.providers).not.toHaveBeenCalled();
  });

  it('validates pinned policy values before any provider request', async () => {
    const di = client();
    const invalidPolicies: SceneTextAdapterPolicy[] = [
      { ...policy, providerRef: ' ' },
      { ...policy, providerVersion: '' },
      { ...policy, timeoutMs: Number.POSITIVE_INFINITY },
      { ...policy, workerLimits: {} },
      { ...policy, workerLimits: { maxPages: Number.NaN } },
      { ...policy, workerLimits: { 'bad limit': 2 } },
      { ...policy, acceptedMediaTypes: ['image/png', 'image/png'] },
    ];
    for (const invalid of invalidPolicies) {
      expect(() => new DocumentIntelligenceSceneTextAdapter(di, invalid)).toThrow(SceneTextAdapterError);
    }
    expect(di.providers).not.toHaveBeenCalled();
  });

  it('does not issue a provider request for an already aborted signal', async () => {
    const di = client();
    const controller = new AbortController();
    controller.abort();
    await expectCode(new DocumentIntelligenceSceneTextAdapter(di, policy), 'REQUEST_ABORTED', frame, controller.signal);
    expect(di.providers).not.toHaveBeenCalled();
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('rejects stale protocol and worker capability versions', async () => {
    const staleProtocol = client({ catalog: catalog({ protocolVersion: 'document-intelligence.v2' }) });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(staleProtocol, policy), 'CLIENT_PROTOCOL_MISMATCH');
    expect(staleProtocol.parse).not.toHaveBeenCalled();
    const staleWorker = client({ workerVersion: 'document-intelligence-worker.v0' });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(staleWorker, policy), 'WORKER_VERSION_NOT_ADMITTED');
    expect(staleWorker.parse).not.toHaveBeenCalled();
  });

  it('rejects non-admitted, unready, and version-mismatched providers', async () => {
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ catalog: catalog({ providers: [] }) }), policy), 'PROVIDER_NOT_ADMITTED');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ catalog: catalog({ providers: [{
      ...catalog().providers[0], promotionStatus: 'UNPROMOTED',
    }] }) }), policy), 'PROVIDER_NOT_ADMITTED');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ catalog: catalog({ providers: [{
      ...catalog().providers[0], ready: false,
    }] }) }), policy), 'PROVIDER_NOT_ADMITTED');
    const staleProvider = client({ catalog: catalog({ providers: [{
      ...catalog().providers[0], providerVersion: '2.4.0',
    }] }) });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(staleProvider, policy), 'PROVIDER_VERSION_MISMATCH');
    expect(staleProvider.parse).not.toHaveBeenCalled();
    const missingModelClient = client({ catalog: catalog({ providers: [{
      providerRef: policy.providerRef, providerVersion: policy.providerVersion,
      mediaTypes: ['image/png'], supportedLanguages: ['en-US'],
      promotionStatus: 'ACCEPTED', loaded: true, ready: true,
    }] }) });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(missingModelClient, policy), 'MODEL_IDENTITY_MISSING');
    expect(missingModelClient.parse).not.toHaveBeenCalled();
    const wrongModelClient = client({ catalog: catalog({ providers: [{
      ...catalog().providers[0], modelVersion: 'older',
    }] }) });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(wrongModelClient, policy), 'MODEL_VERSION_MISMATCH');
    expect(wrongModelClient.parse).not.toHaveBeenCalled();
  });

  it('rejects catalog model identity or version before parse', async () => {
    for (const candidate of [
      { ...catalog().providers[0], modelRef: undefined },
      { ...catalog().providers[0], modelVersion: 'old' },
    ]) {
      const di = client({ catalog: catalog({ providers: [candidate] }) });
      const code = candidate.modelVersion === 'old' ? 'MODEL_VERSION_MISMATCH' : 'MODEL_IDENTITY_MISSING';
      await expectCode(new DocumentIntelligenceSceneTextAdapter(di, policy), code);
      expect(di.parse).not.toHaveBeenCalled();
    }
  });

  it('does not parse if provider lookup aborts before the parse call', async () => {
    const controller = new AbortController();
    const di: DocumentIntelligenceV1Client = {
      lastProtocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
      lastWorkerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
      providers: vi.fn(async () => {
        controller.abort();
        return catalog();
      }),
      parse: vi.fn(async () => document()),
    };
    await expectCode(new DocumentIntelligenceSceneTextAdapter(di, policy), 'REQUEST_ABORTED', frame, controller.signal);
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('rejects response correlation, page scope, and model provenance mismatches', async () => {
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ operationId: 'other' }) }), policy), 'RESPONSE_IDENTITY_MISMATCH');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ protocolVersion: 'document-intelligence.v2' }) }), policy), 'RESPONSE_IDENTITY_MISMATCH');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ providerRef: 'other-provider' }) }), policy), 'RESPONSE_IDENTITY_MISMATCH');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ pages: [] }) }), policy), 'PAGE_SCOPE_UNSUPPORTED');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ providerProvenance: {
      providerRef: policy.providerRef, providerVersion: policy.providerVersion,
    } }) }), policy), 'MODEL_IDENTITY_MISSING');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ providerProvenance: {
      providerRef: policy.providerRef, providerVersion: policy.providerVersion,
      modelRef: policy.modelRef, modelVersion: 'older',
    } }) }), policy), 'MODEL_VERSION_MISMATCH');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ providerProvenance: {
      providerRef: policy.providerRef, providerVersion: 'older',
      modelRef: policy.modelRef, modelVersion: policy.modelVersion,
    } }) }), policy), 'RESPONSE_IDENTITY_MISMATCH');
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: document({ pages: [{
      ...document().pages[0], tables: [{ tableId: 't1' }],
    }] }) }), policy), 'RESULT_SHAPE_UNSUPPORTED');
  });

  it('snapshots mutable frame identity and payload before catalog await', async () => {
    let finishCatalog!: (value: SceneTextProviderCatalog) => void;
    const deferredCatalog = new Promise<SceneTextProviderCatalog>((resolve) => { finishCatalog = resolve; });
    const di = client();
    di.providers = vi.fn(async () => deferredCatalog);
    const mutableFrame = { ...frame, bytes: new Uint8Array([1, 2, 3]) };
    const pending = new DocumentIntelligenceSceneTextAdapter(di, policy).recognizeFrame('op-scene-text', mutableFrame);
    mutableFrame.sourceArtifactId = 'attacker-change';
    mutableFrame.sourceVersion = 'attacker-version';
    mutableFrame.timestampUs = 99;
    mutableFrame.bytes[0] = 99;
    finishCatalog(catalog());

    const result = await pending;
    expect(result[0]).toMatchObject({ sourceArtifactId: 'artifact-7', sourceVersion: 'v3', timestampUs: 2_345_678 });
    expect(di.parse).toHaveBeenCalledWith(expect.objectContaining({ bytes: new Uint8Array([1, 2, 3]) }));
  });

  it('rejects invalid normalized geometry and absent/out-of-range confidence', async () => {
    const badGeometry = document({ pages: [{ ...document().pages[0], blocks: [{ blockId: 'b', lines: [{
      ...document().pages[0].blocks[0].lines[0], boundingRegion: { x: 0.8, y: 0.2, width: 0.4, height: 0.1 },
    }] }] }] });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: badGeometry }), policy), 'RESULT_GEOMETRY_INVALID');
    const nonFiniteGeometry = document({ pages: [{ ...document().pages[0], blocks: [{ blockId: 'b', lines: [{
      ...document().pages[0].blocks[0].lines[0], boundingRegion: { x: Number.NaN, y: 0.2, width: 0.4, height: 0.1 },
    }] }] }] });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: nonFiniteGeometry }), policy), 'RESULT_GEOMETRY_INVALID');
    const noConfidence = document({ pages: [{ ...document().pages[0], blocks: [{ blockId: 'b', lines: [{
      lineId: 'l', text: 'text', boundingRegion: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    }] }] }] });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: noConfidence }), policy), 'RESULT_CONFIDENCE_MISSING');
    const badConfidence = document({ pages: [{ ...document().pages[0], blocks: [{ blockId: 'b', lines: [{
      ...document().pages[0].blocks[0].lines[0], confidence: 1.1,
    }] }] }] });
    await expectCode(new DocumentIntelligenceSceneTextAdapter(client({ result: badConfidence }), policy), 'RESULT_CONFIDENCE_MISSING');
  });
});
