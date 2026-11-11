import { describe, expect, it, vi } from 'vitest';
import {
  recognizeAuthorizedMediaSceneText,
  type MediaSceneTextAccess,
  type MediaSceneTextSourceAuthority,
} from './authorized-scene-text.js';
import type {
  DocumentIntelligenceV1Client,
  SceneTextAdapterPolicy,
  SceneTextSourceFrame,
  SceneTextWireDocument,
} from './scene-text-adapter.js';

// These are protocol fixtures, NOT real DI provider/model qualification.
const policy: SceneTextAdapterPolicy = {
  providerRef: 'di.ocr.en',
  providerVersion: '2.4.1',
  modelRef: 'model.scene-text.en',
  modelVersion: '2026.09.2',
  acceptedMediaTypes: ['image/png'],
  acceptedLanguages: ['en'],
  timeoutMs: 3_000,
  workerLimits: { maxPages: 1, maxRegions: 50 },
};
const frame: SceneTextSourceFrame = {
  sourceArtifactId: 'artifact-1',
  sourceVersion: 'v3',
  frameId: 'frame-7',
  timestampUs: 123456,
  mediaType: 'image/png',
  bytes: new Uint8Array([1, 2, 3]),
  languageHint: 'en',
};
const originalSha = 'a'.repeat(64);
async function croppedDigest() {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(frame.bytes).buffer);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
const admission = async (): Promise<MediaSceneTextAccess> => ({
  tenantId: 'tenant-1',
  principalId: 'principal-1',
  purposeRef: 'caption',
  originalFrameSha256: originalSha,
  croppedFrameSha256: await croppedDigest(),
});
const authorized = (): MediaSceneTextSourceAuthority => ({
  verifyCurrentSource: vi.fn(async () => ({
    status: 'ADMITTED' as const,
    sourceVersion: 'v3',
    originalFrameSha256: originalSha,
    decisionRef: 'decision-1',
  })),
});
const parsed: SceneTextWireDocument = {
  protocolVersion: 'document-intelligence.v1',
  operationId: 'op-1',
  providerRef: policy.providerRef,
  providerProvenance: {
    providerRef: policy.providerRef,
    providerVersion: policy.providerVersion,
    modelRef: policy.modelRef,
    modelVersion: policy.modelVersion,
  },
  pages: [{
    pageNumber: 1,
    tables: [],
    blocks: [{
      blockId: 'block-1',
      lines: [{
        lineId: 'line-1',
        text: 'EXIT',
        confidence: 0.9,
        boundingRegion: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      }],
    }],
  }],
};
function diClient(result: SceneTextWireDocument = parsed) {
  return {
    lastProtocolVersion: 'document-intelligence.v1',
    lastWorkerCapabilityVersion: 'document-intelligence-worker.v1',
    providers: vi.fn(async () => ({
      protocolVersion: 'document-intelligence.v1',
      workerCapabilityVersion: 'document-intelligence-worker.v1',
      providers: [{
        providerRef: policy.providerRef,
        providerVersion: policy.providerVersion,
        modelRef: policy.modelRef,
        modelVersion: policy.modelVersion,
        mediaTypes: ['image/png'],
        supportedLanguages: ['en'],
        promotionStatus: 'ACCEPTED' as const,
        loaded: true,
        ready: true,
      }],
    })),
    parse: vi.fn(async () => result),
  } satisfies DocumentIntelligenceV1Client;
}

describe('Media source admission through sole DI v1 OCR provider (fixture only)', () => {
  it('preserves source/rights/frame identity while using DI provider catalog and parse', async () => {
    const di = diClient();
    const output = await recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission());
    expect(output).toMatchObject([{
      sourceVersion: 'v3',
      frameId: 'frame-7',
      timestampUs: 123456,
      tenantId: 'tenant-1',
      rightsDecisionRef: 'decision-1',
      originalFrameSha256: originalSha,
      text: 'EXIT',
      confidence: 0.9,
    }]);
    expect(di.providers).toHaveBeenCalledTimes(1);
    expect(di.parse).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'image/png',
      operationId: 'op-1',
      providerRef: policy.providerRef,
      bytes: frame.bytes,
    }));
  });

  it('detaches returned geometry from mutable DI response objects', async () => {
    const response = structuredClone(parsed);
    const sourceRegion = response.pages[0]!.blocks[0]!.lines[0]!.boundingRegion!;
    const output = await recognizeAuthorizedMediaSceneText(
      authorized(), diClient(response), policy, 'op-1', frame, await admission());

    Reflect.set(sourceRegion, 'x', 0.95);
    expect(output[0]!.boundingRegion.x).toBe(0.1);
    expect(Object.isFrozen(output[0]!.boundingRegion)).toBe(true);
  });

  it('snapshots the caller-owned access scope before asynchronous digest verification', async () => {
    const access = { ...await admission() };
    const source = authorized();
    const di = diClient();
    let resolveDigest!: (digest: ArrayBuffer) => void;
    const digestResult = new Promise<ArrayBuffer>(resolve => { resolveDigest = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => digestResult);

    try {
      const result = recognizeAuthorizedMediaSceneText(source, di, policy, 'op-1', frame, access);
      expect(digest).toHaveBeenCalledTimes(1);
      Reflect.set(access, 'tenantId', 'tenant-forged');
      Reflect.set(access, 'principalId', 'principal-forged');
      Reflect.set(access, 'purposeRef', 'purpose-forged');
      Reflect.set(access, 'originalFrameSha256', 'b'.repeat(64));
      Reflect.set(access, 'croppedFrameSha256', 'c'.repeat(64));
      resolveDigest(await originalDigest('SHA-256', new Uint8Array(frame.bytes).buffer));

      const observations = await result;
      expect(source.verifyCurrentSource).toHaveBeenCalledWith({
        tenantId: 'tenant-1', principalId: 'principal-1', purposeRef: 'caption',
        sourceArtifactId: 'artifact-1', sourceVersion: 'v3', frameId: 'frame-7',
        originalFrameSha256: originalSha,
      });
      expect(observations[0]).toMatchObject({ tenantId: 'tenant-1', originalFrameSha256: originalSha });
      expect(di.parse).toHaveBeenCalledTimes(1);
    } finally {
      digest.mockRestore();
    }
  });

  it('snapshots the provider/model policy before asynchronous digest verification', async () => {
    const admittedPolicy = {
      ...policy,
      acceptedMediaTypes: [...policy.acceptedMediaTypes],
      acceptedLanguages: [...policy.acceptedLanguages],
      workerLimits: { ...policy.workerLimits },
    };
    const source = authorized();
    const di = diClient();
    const access = await admission();
    let resolveDigest!: (digest: ArrayBuffer) => void;
    const digestResult = new Promise<ArrayBuffer>(resolve => { resolveDigest = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => digestResult);

    try {
      const result = recognizeAuthorizedMediaSceneText(
        source, di, admittedPolicy, 'op-1', frame, access);
      expect(digest).toHaveBeenCalledTimes(1);
      admittedPolicy.providerRef = 'di.ocr.forged';
      admittedPolicy.providerVersion = 'forged';
      admittedPolicy.modelRef = 'model.forged';
      admittedPolicy.modelVersion = 'forged';
      admittedPolicy.timeoutMs = 1;
      admittedPolicy.acceptedMediaTypes.splice(0, 1, 'image/jpeg');
      admittedPolicy.acceptedLanguages.splice(0, 1, 'fr');
      admittedPolicy.workerLimits.maxPages = 99;
      resolveDigest(await originalDigest('SHA-256', new Uint8Array(frame.bytes).buffer));

      await result;
      expect(di.parse).toHaveBeenCalledWith(expect.objectContaining({
        providerRef: policy.providerRef,
        timeoutMs: 3_000,
        limits: { maxPages: 1, maxRegions: 50 },
        mediaType: 'image/png',
        languageHint: 'en',
      }));
    } finally {
      digest.mockRestore();
    }
  });

  it('prevents any DI call on revoked consent', async () => {
    const di = diClient();
    const denied = {
      verifyCurrentSource: vi.fn(async () => ({ status: 'DENIED' as const })),
    };
    await expect(recognizeAuthorizedMediaSceneText(
      denied, di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({ code: 'SOURCE_DENIED' });
    expect(di.providers).not.toHaveBeenCalled();
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('rechecks source authority after provider negotiation and before DI parse dispatch', async () => {
    const di = diClient();
    const verifyCurrentSource = vi.fn()
      .mockResolvedValueOnce({
        status: 'ADMITTED' as const, sourceVersion: 'v3',
        originalFrameSha256: originalSha, decisionRef: 'decision-1',
      })
      .mockResolvedValueOnce({ status: 'DENIED' as const });

    await expect(recognizeAuthorizedMediaSceneText(
      { verifyCurrentSource }, di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({ code: 'SOURCE_DENIED' });
    expect(verifyCurrentSource).toHaveBeenCalledTimes(2);
    expect(di.providers).toHaveBeenCalledTimes(1);
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('does not dispatch DI if cancellation arrives during the pre-dispatch authority read', async () => {
    const di = diClient();
    const admitted = {
      status: 'ADMITTED' as const, sourceVersion: 'v3',
      originalFrameSha256: originalSha, decisionRef: 'decision-1',
    };
    let markSecondReadStarted!: () => void;
    const secondReadStarted = new Promise<void>(resolve => { markSecondReadStarted = resolve; });
    let resolveSecondDecision!: (decision: typeof admitted) => void;
    const secondDecision = new Promise<typeof admitted>(resolve => { resolveSecondDecision = resolve; });
    const verifyCurrentSource = vi.fn(async () => {
      if (verifyCurrentSource.mock.calls.length === 1) return admitted;
      markSecondReadStarted();
      return secondDecision;
    });
    const controller = new AbortController();
    const pending = recognizeAuthorizedMediaSceneText(
      { verifyCurrentSource }, di, policy, 'op-1', frame, await admission(), controller.signal);

    await secondReadStarted;
    controller.abort();
    resolveSecondDecision(admitted);

    await expect(pending).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(verifyCurrentSource).toHaveBeenCalledTimes(2);
    expect(di.providers).toHaveBeenCalledTimes(1);
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('does not disclose DI text when source authority is revoked while recognition is running', async () => {
    const di = diClient();
    const admitted = {
      status: 'ADMITTED' as const, sourceVersion: 'v3',
      originalFrameSha256: originalSha, decisionRef: 'decision-1',
    };
    const verifyCurrentSource = vi.fn()
      .mockResolvedValueOnce(admitted)
      .mockResolvedValueOnce(admitted)
      .mockResolvedValueOnce({ status: 'DENIED' as const });
    const result = recognizeAuthorizedMediaSceneText(
      { verifyCurrentSource }, di, policy, 'op-1', frame, await admission());

    await expect(result).rejects.toMatchObject({ code: 'SOURCE_DENIED' });
    await expect(result).rejects.not.toThrow('EXIT');
    expect(verifyCurrentSource).toHaveBeenCalledTimes(3);
    expect(di.parse).toHaveBeenCalledTimes(1);
  });

  it('preserves source NOT_ADMITTED separately from an explicit denial', async () => {
    const di = diClient();
    const notAdmitted = {
      verifyCurrentSource: vi.fn(async () => ({ status: 'NOT_ADMITTED' as const })),
    };
    await expect(recognizeAuthorizedMediaSceneText(
      notAdmitted, di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_ADMITTED' });
    expect(di.providers).not.toHaveBeenCalled();
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('maps a source-authority outage to UNAVAILABLE without calling DI', async () => {
    const di = diClient();
    const unavailable = {
      verifyCurrentSource: vi.fn(async () => { throw new Error('authority unavailable'); }),
    };
    await expect(recognizeAuthorizedMediaSceneText(
      unavailable, di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(di.providers).not.toHaveBeenCalled();
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('rejects modified crop bytes before source authority or DI', async () => {
    const di = diClient();
    const source = authorized();
    await expect(recognizeAuthorizedMediaSceneText(
      source, di, policy, 'op-1',
      { ...frame, bytes: new Uint8Array([1, 2, 4]) }, await admission()))
      .rejects.toMatchObject({ code: 'SOURCE_DIGEST_MISMATCH' });
    expect(source.verifyCurrentSource).not.toHaveBeenCalled();
    expect(di.providers).not.toHaveBeenCalled();
  });

  it('rejects stale source version before DI provider negotiation', async () => {
    const di = diClient();
    const stale = {
      verifyCurrentSource: vi.fn(async () => ({
        status: 'ADMITTED' as const,
        sourceVersion: 'v2',
        originalFrameSha256: originalSha,
        decisionRef: 'decision-1',
      })),
    };
    await expect(recognizeAuthorizedMediaSceneText(
      stale, di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({ code: 'SOURCE_VERSION_MISMATCH' });
    expect(di.providers).not.toHaveBeenCalled();
  });

  it('rejects forged or mismatched DI operation and provider results', async () => {
    const bad = diClient({ ...parsed, operationId: 'op-forged' });
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), bad, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({
        name: 'MediaSceneTextAdmissionError',
        code: 'RECOGNIZER_RESULT_INVALID',
        message: 'Media scene-text operation rejected: RECOGNIZER_RESULT_INVALID',
      });
    expect(bad.parse).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a DI client instead of selecting Media OCR', async () => {
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), null as unknown as DocumentIntelligenceV1Client,
      policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('binds the exact tenant/principal/purpose to source authority and denies a foreign tenant before DI', async () => {
    const di = diClient();
    const tenantScoped = {
      verifyCurrentSource: vi.fn(async (request: { tenantId: string }) => (request.tenantId === 'tenant-owner'
        ? { status: 'ADMITTED' as const, sourceVersion: 'v3', originalFrameSha256: originalSha, decisionRef: 'decision-1' }
        : { status: 'DENIED' as const })),
    };
    await expect(recognizeAuthorizedMediaSceneText(
      tenantScoped, di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({ code: 'SOURCE_DENIED' });
    expect(tenantScoped.verifyCurrentSource).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', principalId: 'principal-1', purposeRef: 'caption',
      sourceArtifactId: 'artifact-1', sourceVersion: 'v3', frameId: 'frame-7',
    }));
    expect(di.providers).not.toHaveBeenCalled();
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('cancellation before DI produces no DI call and no text', async () => {
    const di = diClient();
    const controller = new AbortController();
    controller.abort();
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission(), controller.signal))
      .rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(di.providers).not.toHaveBeenCalled();
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('late cancellation discards DI text and reports unknown outcome after dispatch', async () => {
    const controller = new AbortController();
    const di = diClient();
    di.parse.mockImplementationOnce(async () => {
      controller.abort();
      return parsed;
    });
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission(), controller.signal))
      .rejects.toMatchObject({ code: 'RECOGNIZER_OUTCOME_UNKNOWN' });
    expect(di.parse).toHaveBeenCalledTimes(1);
  });

  it('maps parse rejection to a sanitized unknown outcome because dispatch finality is unavailable', async () => {
    const di = diClient();
    di.parse.mockRejectedValueOnce(new Error('provider timed out after dispatch; sensitive detail'));
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({
        code: 'RECOGNIZER_OUTCOME_UNKNOWN',
        message: 'Media scene-text operation rejected: RECOGNIZER_OUTCOME_UNKNOWN',
      });
    expect(di.parse).toHaveBeenCalledTimes(1);
  });

  it('maps an unadmitted DI provider to a typed Media NOT_ADMITTED failure before parse', async () => {
    const di = diClient();
    di.providers.mockResolvedValueOnce({
      protocolVersion: 'document-intelligence.v1',
      workerCapabilityVersion: 'document-intelligence-worker.v1',
      providers: [],
    });
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({
        name: 'MediaSceneTextAdmissionError',
        code: 'RECOGNIZER_NOT_ADMITTED',
        message: 'Media scene-text operation rejected: RECOGNIZER_NOT_ADMITTED',
      });
    expect(di.providers).toHaveBeenCalledTimes(1);
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('maps a mismatched DI response identity to a sanitized invalid-result failure', async () => {
    const di = diClient();
    di.parse.mockResolvedValueOnce({ ...parsed, operationId: 'other-operation' });
    const rejection = recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission());
    await expect(rejection).rejects.toMatchObject({
      name: 'MediaSceneTextAdmissionError',
      code: 'RECOGNIZER_RESULT_INVALID',
      message: 'Media scene-text operation rejected: RECOGNIZER_RESULT_INVALID',
    });
    await expect(rejection).rejects.not.toThrow('EXIT');
    expect(di.parse).toHaveBeenCalledTimes(1);
  });

  it('maps invalid DI geometry to a sanitized invalid-result failure without returning text', async () => {
    const di = diClient();
    const line = parsed.pages[0].blocks[0].lines[0];
    const invalidGeometry: SceneTextWireDocument = {
      ...parsed,
      pages: [{
        ...parsed.pages[0],
        blocks: [{
          ...parsed.pages[0].blocks[0],
          lines: [{ ...line, text: 'private OCR text', boundingRegion: { x: -1, y: 0.2, width: 0.3, height: 0.1 } }],
        }],
      }],
    };
    di.parse.mockResolvedValueOnce(invalidGeometry);
    const rejection = recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission());
    await expect(rejection).rejects.toMatchObject({
      name: 'MediaSceneTextAdmissionError',
      code: 'RECOGNIZER_RESULT_INVALID',
      message: 'Media scene-text operation rejected: RECOGNIZER_RESULT_INVALID',
    });
    await expect(rejection).rejects.not.toThrow('private OCR text');
    expect(di.parse).toHaveBeenCalledTimes(1);
  });

  it('keeps a typed DI timeout outcome unknown until the public contract proves finality', async () => {
    const di = diClient();
    const timeout = Object.assign(new Error('worker timeout; sensitive detail'), {
      code: 'EXTERNAL_CALL_TIMEOUT',
      retryable: true,
      providerRef: policy.providerRef,
    });
    di.parse.mockRejectedValueOnce(timeout);
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({
        code: 'RECOGNIZER_OUTCOME_UNKNOWN',
        message: 'Media scene-text operation rejected: RECOGNIZER_OUTCOME_UNKNOWN',
      });
    expect(di.parse).toHaveBeenCalledTimes(1);
  });

  it('DI outage surfaces as a failure with zero OCR text and no Media fallback', async () => {
    const di = diClient();
    di.providers.mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'));
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({
        name: 'MediaSceneTextAdmissionError',
        code: 'RECOGNIZER_UNAVAILABLE',
        message: 'Media scene-text operation rejected: RECOGNIZER_UNAVAILABLE',
      });
    expect(di.parse).not.toHaveBeenCalled();
  });

  it('does not execute unadmitted DI engines', async () => {
    const di = diClient();
    di.providers.mockResolvedValueOnce({
      protocolVersion: 'document-intelligence.v1',
      workerCapabilityVersion: 'document-intelligence-worker.v1',
      providers: [],
    });
    await expect(recognizeAuthorizedMediaSceneText(
      authorized(), di, policy, 'op-1', frame, await admission()))
      .rejects.toMatchObject({
        name: 'MediaSceneTextAdmissionError',
        code: 'RECOGNIZER_NOT_ADMITTED',
      });
    expect(di.parse).not.toHaveBeenCalled();
  });
});
