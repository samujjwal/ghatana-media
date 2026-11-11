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
  SceneTextAdapterError,
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
  | 'SOURCE_DENIED' | 'SOURCE_NOT_ADMITTED' | 'SOURCE_UNAVAILABLE'
  | 'RECOGNIZER_NOT_ADMITTED' | 'RECOGNIZER_UNAVAILABLE'
  | 'RECOGNIZER_OUTCOME_UNKNOWN' | 'RECOGNIZER_RESULT_INVALID';

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
type AdmittedSceneTextDecision = Extract<MediaSceneTextDecision, { readonly status: 'ADMITTED' }>;

function snapshotPolicy(policy: SceneTextAdapterPolicy): SceneTextAdapterPolicy {
  try {
    // The caller owns this object too. Copy it before the first await so its
    // provider/model pin, timeout and limits cannot change during admission.
    return Object.freeze({
      providerRef: policy.providerRef,
      providerVersion: policy.providerVersion,
      modelRef: policy.modelRef,
      modelVersion: policy.modelVersion,
      acceptedMediaTypes: Array.isArray(policy.acceptedMediaTypes)
        ? Object.freeze([...policy.acceptedMediaTypes]) : policy.acceptedMediaTypes,
      acceptedLanguages: Array.isArray(policy.acceptedLanguages)
        ? Object.freeze([...policy.acceptedLanguages]) : policy.acceptedLanguages,
      timeoutMs: policy.timeoutMs,
      workerLimits: policy.workerLimits !== null && typeof policy.workerLimits === 'object'
        ? Object.freeze({ ...policy.workerLimits }) : policy.workerLimits,
    });
  } catch {
    reject('INVALID_SOURCE');
  }
}

async function currentSourceDecision(
  sourceAuthority: MediaSceneTextSourceAuthority,
  frame: SceneTextSourceFrame,
  access: Readonly<MediaSceneTextAccess>,
): Promise<AdmittedSceneTextDecision> {
  let current: MediaSceneTextDecision;
  try {
    current = await sourceAuthority.verifyCurrentSource(Object.freeze({
      tenantId:access.tenantId,principalId:access.principalId,purposeRef:access.purposeRef,
      sourceArtifactId:frame.sourceArtifactId,sourceVersion:frame.sourceVersion,
      frameId:frame.frameId,originalFrameSha256:access.originalFrameSha256,
    }));
  } catch {
    // A failed authority lookup cannot be treated as a denial or as permission.
    reject('SOURCE_UNAVAILABLE');
  }
  if (!current) reject('SOURCE_UNAVAILABLE');
  if (current.status === 'DENIED') reject('SOURCE_DENIED');
  if (current.status === 'NOT_ADMITTED') reject('SOURCE_NOT_ADMITTED');
  if (current.status !== 'ADMITTED') reject('SOURCE_UNAVAILABLE');
  if (current.sourceVersion !== frame.sourceVersion) reject('SOURCE_VERSION_MISMATCH');
  if (current.originalFrameSha256 !== access.originalFrameSha256) reject('SOURCE_DIGEST_MISMATCH');
  if (!validText(current.decisionRef)) reject('SOURCE_DENIED');
  return current;
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
    || typeof access !== 'object') reject('INVALID_SOURCE');

  const admittedPolicy = snapshotPolicy(diPolicy);

  // The access object is caller-owned. Snapshot its identity and digest scope
  // before the asynchronous digest or authority lookup can observe mutations.
  const admittedAccess = Object.freeze({
    tenantId: access.tenantId,
    principalId: access.principalId,
    purposeRef: access.purposeRef,
    originalFrameSha256: access.originalFrameSha256,
    croppedFrameSha256: access.croppedFrameSha256,
  });
  if (![frame.sourceArtifactId,frame.sourceVersion,frame.frameId,
      admittedAccess.tenantId,admittedAccess.principalId,admittedAccess.purposeRef].every(validText)
    || !MIME.test(frame.mediaType)
    || !(frame.bytes instanceof Uint8Array)
    || frame.bytes.byteLength === 0 || frame.bytes.byteLength > MAX_FRAME_BYTES
    || !Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0
    || !HASH.test(admittedAccess.originalFrameSha256)
    || !HASH.test(admittedAccess.croppedFrameSha256)) reject('INVALID_SOURCE');

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
  if (hash !== admittedAccess.croppedFrameSha256) reject('SOURCE_DIGEST_MISMATCH');

  let current = await currentSourceDecision(sourceAuthority, frozenFrame, admittedAccess);
  if (signal?.aborted) reject('SOURCE_UNAVAILABLE');

  // DI's provider registry owns OCR engine selection. There is no alternate
  // Media-level recognizer callback or parallel Media OCR execution path. The
  // authority guard is placed at the client's parse boundary, after provider
  // negotiation, so revocation during catalog lookup prevents content egress.
  let preDispatchFailure: MediaSceneTextAdmissionError | undefined;
  const guardedClient: DocumentIntelligenceV1Client = {
    get lastProtocolVersion() { return diClient.lastProtocolVersion; },
    get lastWorkerCapabilityVersion() { return diClient.lastWorkerCapabilityVersion; },
    providers: (providerSignal) => diClient.providers(providerSignal),
    parse: async (input) => {
      try {
        current = await currentSourceDecision(sourceAuthority, frozenFrame, admittedAccess);
        if (signal?.aborted || input.signal?.aborted) reject('SOURCE_UNAVAILABLE');
      } catch (error) {
        if (error instanceof MediaSceneTextAdmissionError) preDispatchFailure = error;
        throw error;
      }
      return diClient.parse(input);
    },
  };
  const di = new DocumentIntelligenceSceneTextAdapter(guardedClient, admittedPolicy);
  let results: readonly SceneTextObservation[];
  try {
    results = await di.recognizeFrame(operationId, frozenFrame, signal);
  } catch (error) {
    if (preDispatchFailure) throw preDispatchFailure;
    if (error instanceof SceneTextAdapterError) {
      switch (error.code) {
        case 'PROVIDER_NOT_ADMITTED':
        case 'PROVIDER_VERSION_MISMATCH':
        case 'CLIENT_PROTOCOL_MISMATCH':
        case 'WORKER_VERSION_NOT_ADMITTED':
        case 'MODEL_IDENTITY_MISSING':
        case 'MODEL_VERSION_MISMATCH':
        case 'SOURCE_MEDIA_TYPE_NOT_ADMITTED':
        case 'SOURCE_LANGUAGE_NOT_ADMITTED':
          // These checks complete before parse dispatch, so report a typed
          // admission failure without implying an OCR effect.
          reject('RECOGNIZER_NOT_ADMITTED');
        case 'PROVIDER_CATALOG_UNAVAILABLE':
          reject('RECOGNIZER_UNAVAILABLE');
        case 'OUTCOME_UNKNOWN':
          // The installed client's typed rejection contract is not available
          // at this seam. Once parse is invoked, an unclassified rejection
          // cannot establish whether DI dispatched work.
          reject('RECOGNIZER_OUTCOME_UNKNOWN');
        case 'RESPONSE_IDENTITY_MISMATCH':
        case 'PAGE_SCOPE_UNSUPPORTED':
        case 'RESULT_GEOMETRY_INVALID':
        case 'RESULT_CONFIDENCE_MISSING':
        case 'RESULT_SHAPE_UNSUPPORTED':
          // DI has returned, but its payload cannot be safely attached to the
          // admitted Media source. Never expose any response text on rejection.
          reject('RECOGNIZER_RESULT_INVALID');
      }
    }
    throw error;
  }
  // Cancellation after dispatch also cannot establish that the provider did
  // no work. Discard any returned text and require reconciliation before retry.
  if (signal?.aborted) reject('RECOGNIZER_OUTCOME_UNKNOWN');
  if (!Array.isArray(results) || results.length > 5000
      || !results.every(row=>validObservation(row, frozenFrame))) {
    reject('RECOGNIZER_RESULT_INVALID');
  }
  // A source may be revoked while DI is running. Discard its text rather than
  // disclosing observations after current authority has changed.
  current = await currentSourceDecision(sourceAuthority, frozenFrame, admittedAccess);
  if (signal?.aborted) reject('RECOGNIZER_OUTCOME_UNKNOWN');
  // Detach the nested geometry too: the DI client owns its response objects
  // and may reuse or mutate them after this promise resolves.
  return Object.freeze(results.map(row=>Object.freeze({
    ...row,
    boundingRegion:Object.freeze({ ...row.boundingRegion }),
    tenantId:admittedAccess.tenantId,rightsDecisionRef:current.decisionRef,
    originalFrameSha256:admittedAccess.originalFrameSha256,
  })));
}
