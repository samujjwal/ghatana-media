/**
 * Media-owned source/rights admission around any optional scene-text recognizer.
 * No Data Cloud or Document Intelligence imports: Media can use its own
 * qualified Vision OCR provider, or a published DI v1 adapter when admitted.
 *
 * This boundary has no OCR inference implementation or default model. A
 * trusted source authority MUST be supplied for all real recognition effects.
 */
import type { SceneTextObservation, SceneTextSourceFrame } from './scene-text-adapter.js';

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

export interface MediaSceneTextRecognizer {
  recognizeFrame(operationId: string, frame: SceneTextSourceFrame,
    signal?: AbortSignal): Promise<readonly SceneTextObservation[]>;
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

/** The recognizer is a pure optional port: core Media does not import Data Cloud or DI. */
export async function recognizeAuthorizedMediaSceneText(
  sourceAuthority: MediaSceneTextSourceAuthority,
  recognizer: MediaSceneTextRecognizer,
  operationId: string,
  frame: SceneTextSourceFrame,
  access: MediaSceneTextAccess,
  signal?: AbortSignal,
): Promise<readonly AuthorizedMediaSceneTextObservation[]> {
  if (!sourceAuthority || typeof sourceAuthority.verifyCurrentSource !== 'function'
    || !recognizer || typeof recognizer.recognizeFrame !== 'function'
    || !validText(operationId) || !frame || !access
    || ![frame.sourceArtifactId,frame.sourceVersion,frame.frameId,frame.mediaType,
      access.tenantId,access.principalId,access.purposeRef].every(validText)
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

  const results = await recognizer.recognizeFrame(operationId, frozenFrame, signal);
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
