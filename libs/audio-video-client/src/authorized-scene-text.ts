/**
 * Media-owned scene/time and source/rights admission; Document Intelligence
 * is the ONE Ghatana OCR execution authority (MDI-001).
 *
 * This helper accepts only the frozen DI v1 public client and constructs
 * the Media-specific DI adapter after verifying source identity, consent,
 * version and cropped-content digest. DI decides among its internal OCR
 * provider adapters. No alternate Media OCR model/provider is dispatched.
 * Media's other workflows do not depend on DI availability.
 */
import {
  DocumentIntelligenceSceneTextAdapter,
  type DocumentIntelligenceV1Client,
  type SceneTextAdapterPolicy,
  type SceneTextObservation,
  type SceneTextSourceFrame,
} from './scene-text-adapter.js';

export interface MediaSceneTextAccess {
  readonly tenantId: string;
  readonly principalId: string;
  readonly purposeRef: string;
  readonly originalFrameSha256: string;
  readonly croppedFrameSha256: string;
}

export type MediaSceneTextDecision =
  | { readonly status: 'ADMITTED'; readonly sourceVersion: string;
      readonly originalFrameSha256: string; readonly decisionRef: string }
  | { readonly status: 'DENIED' | 'UNAVAILABLE' | 'NOT_ADMITTED' };

export interface MediaSceneTextSourceAuthority {
  /** Must read the authoritative Media source version and current consent. */
  verifyCurrentSource(request: Readonly<{
    tenantId: string; principalId: string; purposeRef: string;
    sourceArtifactId: string; sourceVersion: string; frameId: string;
    originalFrameSha256: string;
  }>): Promise<MediaSceneTextDecision>;
}

export type MediaSceneTextAdmissionCode =
  | 'INVALID_SOURCE' | 'SOURCE_DIGEST_MISMATCH' | 'SOURCE_VERSION_MISMATCH'
  | 'SOURCE_DENIED' | 'SOURCE_UNAVAILABLE' | 'RECOGNIZER_RESULT_INVALID';

export class MediaSceneTextAdmissionError extends Error {
  constructor(public readonly code: MediaSceneTextAdmissionCode) {
    super('Media scene-text operation rejected: ' + code);
    this.name = 'MediaSceneTextAdmissionError';
  }
}

export interface AuthorizedMediaSceneTextObservation extends SceneTextObservation {
  readonly tenantId: string;
  readonly rightsDecisionRef: string;
  readonly originalFrameSha256: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const MIME = /^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+$/u;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
function reject(code: MediaSceneTextAdmissionCode): never {
  throw new MediaSceneTextAdmissionError(code);
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && TEXT.test(value);
}
function validObservation(row: SceneTextObservation, frame: SceneTextSourceFrame): boolean {
  if (row === null || typeof row !== 'object' || row.sourceArtifactId !== frame.sourceArtifactId
    || row.sourceVersion !== frame.sourceVersion || row.frameId !== frame.frameId
    || row.timestampUs !== frame.timestampUs
    || typeof row.text !== 'string' || row.text.length > 8192
    || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1
    || row.boundingRegion == null) return false;
  const b = row.boundingRegion;
  return [b.x,b.y,b.width,b.height].every(Number.isFinite)
    && b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0
    && b.x + b.width <= 1 && b.y + b.height <= 1;
}

/** Media always calls the admitted Document Intelligence v1 OCR authority. */
export async function recognizeAuthorizedMediaSceneText(
  sourceAuthority: MediaSceneTextSourceAuthority,
  diClient: DocumentIntelligenceV1Client,
  diPolicy: SceneTextAdapterPolicy,
  operationId: string,
  frame: SceneTextSourceFrame,
  access: MediaSceneTextAccess,
  signal?: AbortSignal,
): Promise<readonly AuthorizedMediaSceneTextObservation[]> {
  if (!sourceAuthority || typeof sourceAuthority.verifyCurrentSource !== 'function'
    || !diClient || typeof diClient.providers !== 'function'
    || typeof diClient.parse !== 'function' || !diPolicy
    || !validText(operationId) || !frame || !access
    || ![frame.sourceArtifactId,frame.sourceVersion,frame.frameId,
      access.tenantId,access.principalId,access.purposeRef].every(validText)
    || !MIME.test(frame.mediaType)
    || !(frame.bytes instanceof Uint8Array)
    || frame.bytes.byteLength === 0 || frame.bytes.byteLength > MAX_FRAME_BYTES
    || !Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0
    || !HASH.test(access.originalFrameSha256)
    || !HASH.test(access.croppedFrameSha256)) reject('INVALID_SOURCE');

  // Snapshot externally mutable bytes and metadata before any await.
  const copied = Uint8Array.from(frame.bytes);
  const frozenFrame: SceneTextSourceFrame = Object.freeze({
    sourceArtifactId:frame.sourceArtifactId,sourceVersion:frame.sourceVersion,
    frameId:frame.frameId,timestampUs:frame.timestampUs,mediaType:frame.mediaType,
    bytes:copied,
    ...(frame.languageHint === undefined ? {} : {languageHint:frame.languageHint}),
  });
  if (signal?.aborted) reject('SOURCE_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copied.buffer);
  const hash = Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('');
  if (hash !== access.croppedFrameSha256) reject('SOURCE_DIGEST_MISMATCH');

  const current = await sourceAuthority.verifyCurrentSource(Object.freeze({
    tenantId:access.tenantId,principalId:access.principalId,purposeRef:access.purposeRef,
    sourceArtifactId:frozenFrame.sourceArtifactId,sourceVersion:frozenFrame.sourceVersion,
    frameId:frozenFrame.frameId,originalFrameSha256:access.originalFrameSha256,
  }));
  if (!current || current.status === 'DENIED' || current.status === 'NOT_ADMITTED') {
    reject('SOURCE_DENIED');
  }
  if (current.status !== 'ADMITTED' || signal?.aborted) reject('SOURCE_UNAVAILABLE');
  if (current.sourceVersion !== frozenFrame.sourceVersion) reject('SOURCE_VERSION_MISMATCH');
  if (current.originalFrameSha256 !== access.originalFrameSha256) reject('SOURCE_DIGEST_MISMATCH');
  if (!validText(current.decisionRef)) reject('SOURCE_DENIED');

  // DI's provider registry owns OCR engine selection. There is no alternate
  // Media-level recognizer callback or parallel Media OCR execution path.
  const di = new DocumentIntelligenceSceneTextAdapter(diClient, diPolicy);
  const results = await di.recognizeFrame(operationId, frozenFrame, signal);
  if (signal?.aborted) reject('SOURCE_UNAVAILABLE');
  if (!Array.isArray(results) || results.length > 5000
      || !results.every(row=>validObservation(row, frozenFrame))) {
    reject('RECOGNIZER_RESULT_INVALID');
  }
  return Object.freeze(results.map(row=>Object.freeze({
    ...row,tenantId:access.tenantId,rightsDecisionRef:current.decisionRef,
    originalFrameSha256:access.originalFrameSha256,
  })));
}
