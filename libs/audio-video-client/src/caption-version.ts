import { createHash } from 'node:crypto';
import type { ParentVersionKind } from './caption-draft.js';

/**
 * media.operation.caption-version-write client binding: validated request,
 * deterministic caller-retained fingerprint, and a transport seam. The durable
 * server binding is unresolved in source — callers inject the transport; this
 * module only guarantees request shape, fingerprint identity, and typed errors.
 */

export type SegmentOrigin = 'RECOGNIZED' | 'USER_EDITED';
export type LanguageDisposition = 'NOT_SELECTED' | 'DECLARED_BY_USER' | 'UNCERTAIN';

export interface CaptionVersionSegment {
  segmentId: string;
  text: string;
  startTick: number;
  endTick: number;
  origin: SegmentOrigin;
  speakerLabel?: string;
}

export interface CaptionRegistrationRequest {
  requestId: string;
  sourceArtifactId: string;
  sourceArtifactVersionId: string;
  parentVersionKind: ParentVersionKind;
  parentVersionId: string;
  sourceClockId: string;
  ticksPerSecond: number;
  sourceDurationTicks: number;
  languageDisposition: LanguageDisposition;
  languageTag?: string;
  captionSegments: readonly CaptionVersionSegment[];
  purpose?: string;
}

export type RegistrationErrorCode =
  | 'INVALID_REQUEST' | 'ACCESS_DENIED' | 'VERSION_REGISTRATION_NOT_ALLOWED'
  | 'SOURCE_NOT_READY' | 'CAPTION_DRAFT_EMPTY' | 'CAPTION_ALIGNMENT_REQUIRED'
  | 'CAPTION_VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'UNAVAILABLE' | 'UNKNOWN_OUTCOME';

export class CaptionRegistrationError extends Error {
  constructor(public readonly code: RegistrationErrorCode, detail = '') {
    super(`Caption registration rejected: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'CaptionRegistrationError';
  }
}

export interface CaptionVersionRegistered {
  requestId: string;
  requestFingerprint: string;
  captionVersionId: string;
  registrationReceiptId: string;
  sourceArtifactId: string;
  sourceArtifactVersionId: string;
  parentVersionKind: ParentVersionKind;
  parentVersionId: string;
  languageDisposition: LanguageDisposition;
  sourceClockId: string;
  registeredAt: number;
}

export interface CaptionVersionRejected {
  requestId: string;
  requestFingerprint: string | null;
  error: RegistrationErrorCode;
  retryable: boolean;
}

/** Complete durable readback of one registered caption version (media.operation.caption-version-read). */
export interface CaptionVersionSnapshot {
  requestId: string;
  requestFingerprint: string;
  captionVersionId: string;
  registrationReceiptId: string;
  sourceArtifactId: string;
  sourceArtifactVersionId: string;
  parentVersionKind: ParentVersionKind;
  parentVersionId: string;
  sourceClockId: string;
  ticksPerSecond: number;
  sourceDurationTicks: number;
  languageDisposition: LanguageDisposition;
  languageTag?: string;
  captionSegments: readonly CaptionVersionSegment[];
  purpose?: string;
  registeredAt: number;
}

export type CaptionReadErrorCode =
  | 'UNAUTHENTICATED' | 'ACCESS_DENIED' | 'NOT_FOUND' | 'UNAVAILABLE' | 'UNKNOWN_OUTCOME';

/** Typed caption-read failure: a failed request is never reported as an empty result. */
export class CaptionVersionReadError extends Error {
  constructor(
    public readonly code: CaptionReadErrorCode,
    public readonly status: number,
    public readonly retryable: boolean,
    detail = '',
  ) {
    super(`Caption version read failed: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'CaptionVersionReadError';
  }
}

/** Server contract: durable registration + scoped readback. */
export interface CaptionVersionTransport {
  register(request: CaptionRegistrationRequest & { requestFingerprint: string }): Promise<CaptionVersionRegistered | CaptionVersionRejected>;
  versions(tenantId: string, principalId: string, sourceArtifactId: string, sourceArtifactVersionId: string): Promise<readonly CaptionVersionRegistered[]>;
  /** Exact readback of one registered version; null only when the server reports a definitive 404. */
  version(captionVersionId: string): Promise<CaptionVersionSnapshot | null>;
}

const REQUEST_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,255}$/u;
const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** media.caption-registration-request.v1 fingerprint (spec tuple order, UTF-8 compact JSON). */
export function requestFingerprint(tenantId: string, principalId: string, request: CaptionRegistrationRequest): string {
  const json = [
    '"media.caption-registration-request.v1"',
    j(tenantId), j(principalId), j(request.sourceArtifactId), j(request.sourceArtifactVersionId),
    j(request.parentVersionKind), j(request.parentVersionId), j(request.sourceClockId),
    String(request.ticksPerSecond), String(request.sourceDurationTicks),
    j(request.languageDisposition),
    request.languageTag !== undefined ? 'true' : 'false',
    request.languageTag !== undefined ? j(request.languageTag) : 'null',
    '[' + request.captionSegments.map((s) => [
      j(s.segmentId), j(s.text), String(s.startTick), String(s.endTick), j(s.origin),
      s.speakerLabel !== undefined ? 'true' : 'false',
      s.speakerLabel !== undefined ? j(s.speakerLabel) : 'null',
    ].join(',')).map((t) => `[${t}]`).join(',') + ']',
    request.purpose !== undefined ? 'true' : 'false',
    request.purpose !== undefined ? j(request.purpose) : 'null',
  ].join(',');
  return createHash('sha256').update(`[${json}]`, 'utf8').digest('hex');
}

/** JSON string: escapes quote/backslash, b/f/n/r/t short escapes, other controls lowercase hex; unpaired surrogates rejected (for...of yields them as lone code points). */
function j(value: string): string {
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new CaptionRegistrationError('INVALID_REQUEST', 'unpaired surrogate');
    }
    if (cp === 0x22) out += '\\"';
    else if (cp === 0x5c) out += '\\\\';
    else if (cp === 0x08) out += '\\b';
    else if (cp === 0x0c) out += '\\f';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x0d) out += '\\r';
    else if (cp === 0x09) out += '\\t';
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

export function validateRequest(request: CaptionRegistrationRequest): void {
  if (!request || !REQUEST_ID.test(request.requestId)) fail('INVALID_REQUEST', 'requestId');
  for (const [key, value] of Object.entries({
    sourceArtifactId: request.sourceArtifactId,
    sourceArtifactVersionId: request.sourceArtifactVersionId,
    parentVersionId: request.parentVersionId,
    sourceClockId: request.sourceClockId,
  })) {
    if (!IDENTIFIER.test(value)) fail('INVALID_REQUEST', key);
  }
  if (!safeInt(request.ticksPerSecond) || request.ticksPerSecond < 1) fail('INVALID_REQUEST', 'ticksPerSecond');
  if (!safeInt(request.sourceDurationTicks)) fail('INVALID_REQUEST', 'sourceDurationTicks');
  if (request.languageTag !== undefined && (request.languageTag.trim().length === 0 || request.languageTag.length > 64)) {
    fail('INVALID_REQUEST', 'languageTag');
  }
  if (!Array.isArray(request.captionSegments) || request.captionSegments.length === 0) fail('CAPTION_DRAFT_EMPTY');
  if (request.captionSegments.length > 4096) fail('INVALID_REQUEST', 'segment bound');
  const seen = new Set<string>();
  for (const s of request.captionSegments) {
    if (!s || !IDENTIFIER.test(s.segmentId) || seen.has(s.segmentId)) fail('INVALID_REQUEST', 'segmentId');
    seen.add(s.segmentId);
    if (!safeInt(s.startTick) || !safeInt(s.endTick) || s.startTick >= s.endTick || s.endTick > request.sourceDurationTicks) {
      fail('CAPTION_ALIGNMENT_REQUIRED');
    }
    if (s.origin !== 'RECOGNIZED' && s.origin !== 'USER_EDITED') fail('INVALID_REQUEST', 'origin');
  }
  if (request.purpose !== undefined) {
    const purpose = request.purpose.trim();
    if (purpose.length === 0 || [...purpose].length > 240) fail('INVALID_REQUEST', 'purpose');
  }
}

function fail(code: RegistrationErrorCode, detail = ''): never {
  throw new CaptionRegistrationError(code, detail);
}

/**
 * Register one immutable caption version through the injected durable
 * transport. The caller retains requestId + fingerprint before dispatch; an
 * uncertain transport outcome must be reconciled with the same key first.
 */
export interface HttpCaptionTransportOptions {
  baseUrl: string;
  tenantId: string;
  principalId: string;
  fetchImpl?: typeof fetch;
  /**
   * Verified credential supplier; a returned token is sent as a Bearer credential
   * and is never accepted as a per-call argument or a principal substitute.
   */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function readError(status: number): CaptionVersionReadError {
  switch (status) {
    case 401: return new CaptionVersionReadError('UNAUTHENTICATED', status, false);
    case 403: return new CaptionVersionReadError('ACCESS_DENIED', status, false);
    case 404: return new CaptionVersionReadError('NOT_FOUND', status, false);
    default:
      return new CaptionVersionReadError(
        RETRYABLE_STATUS.has(status) ? 'UNAVAILABLE' : 'UNKNOWN_OUTCOME',
        status, RETRYABLE_STATUS.has(status));
  }
}

function registerError(status: number): RegistrationErrorCode {
  switch (status) {
    case 401: case 403: return 'ACCESS_DENIED';
    case 400: return 'INVALID_REQUEST';
    case 409: return 'CAPTION_VERSION_CONFLICT';
    case 503: case 502: case 504: return 'UNAVAILABLE';
    default: return 'UNKNOWN_OUTCOME';
  }
}

/**
 * Binds the {@link CaptionVersionTransport} seam to the Media Runtime HTTP
 * surface: POST /api/v1/caption-versions, GET /api/v1/caption-versions, and
 * GET /api/v1/caption-versions/{captionVersionId}. The durable server remains
 * the authority: MediaSecurityFilter verifies the Bearer credential and derives
 * tenant/principal from it, so the identity headers here are hints only — never
 * caller-asserted authority. Transport errors surface as UNKNOWN_OUTCOME through
 * {@link saveCaptionVersion}; read errors are typed and never collapse to [].
 */
export function httpCaptionVersionTransport(options: HttpCaptionTransportOptions): CaptionVersionTransport {
  const base = options.baseUrl.replace(/\/+$/u, '');
  const impl = options.fetchImpl ?? fetch;
  const headers = async () => {
    const values: Record<string, string> = {
      'content-type': 'application/json',
      'x-tenant-id': options.tenantId,
      'x-principal-id': options.principalId,
    };
    const token = await options.getAccessToken?.();
    if (token) values['authorization'] = `Bearer ${token}`;
    return values;
  };
  return {
    async register(request) {
      const response = await impl(`${base}/api/v1/caption-versions`, {
        method: 'POST', headers: await headers(), body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 201) return body as CaptionVersionRegistered;
      const detail = body?.error?.details ?? {};
      return {
        requestId: request.requestId,
        requestFingerprint: typeof detail.requestFingerprint === 'string' && detail.requestFingerprint
          ? detail.requestFingerprint : request.requestFingerprint,
        error: (typeof detail.error === 'string' ? detail.error : registerError(response.status)) as RegistrationErrorCode,
        retryable: detail.retryable === true || RETRYABLE_STATUS.has(response.status),
      };
    },
    async versions(tenantId, principalId, sourceArtifactId, sourceArtifactVersionId) {
      const response = await impl(
        `${base}/api/v1/caption-versions?sourceArtifactId=${encodeURIComponent(sourceArtifactId)}&sourceArtifactVersionId=${encodeURIComponent(sourceArtifactVersionId)}`,
        { method: 'GET', headers: await headers() });
      if (!response.ok) throw readError(response.status);
      const body = await response.json().catch(() => ({}));
      if (!Array.isArray(body?.captionVersions)) {
        throw new CaptionVersionReadError('UNKNOWN_OUTCOME', response.status, false, 'malformed list body');
      }
      return body.captionVersions as CaptionVersionRegistered[];
    },
    async version(captionVersionId) {
      const response = await impl(
        `${base}/api/v1/caption-versions/${encodeURIComponent(captionVersionId)}`,
        { method: 'GET', headers: await headers() });
      if (response.status === 404) return null;
      if (!response.ok) throw readError(response.status);
      const body = await response.json().catch(() => ({}));
      if (!body || typeof body.captionVersionId !== 'string' || body.captionVersionId !== captionVersionId) {
        throw new CaptionVersionReadError('UNKNOWN_OUTCOME', response.status, false, 'malformed or mismatched snapshot');
      }
      return body as CaptionVersionSnapshot;
    },
  };
}

export async function saveCaptionVersion(
  transport: CaptionVersionTransport,
  tenantId: string,
  principalId: string,
  request: CaptionRegistrationRequest,
): Promise<CaptionVersionRegistered | CaptionVersionRejected> {
  validateRequest(request);
  const fingerprint = requestFingerprint(tenantId, principalId, request);
  let result;
  try {
    result = await transport.register({ ...request, requestFingerprint: fingerprint });
  } catch {
    return { requestId: request.requestId, requestFingerprint: fingerprint, error: 'UNKNOWN_OUTCOME', retryable: true };
  }
  if (!result || result.requestId !== request.requestId) {
    return { requestId: request.requestId, requestFingerprint: fingerprint, error: 'UNKNOWN_OUTCOME', retryable: true };
  }
  return result;
}

/**
 * Reconcile an uncertain registration outcome. The durable store is idempotent on
 * (tenant, principal, requestId): re-dispatching the same validated request and
 * fingerprint returns the original receipt, while a fingerprint echo that does
 * not match proves the outcome is still unknown and must not be claimed.
 */
export async function reconcileCaptionRegistration(
  transport: CaptionVersionTransport,
  tenantId: string,
  principalId: string,
  request: CaptionRegistrationRequest,
): Promise<CaptionVersionRegistered | CaptionVersionRejected> {
  const result = await saveCaptionVersion(transport, tenantId, principalId, request);
  const expected = requestFingerprint(tenantId, principalId, request);
  if (result.requestFingerprint && result.requestFingerprint !== expected) {
    return { requestId: request.requestId, requestFingerprint: expected, error: 'UNKNOWN_OUTCOME', retryable: true };
  }
  return result;
}
