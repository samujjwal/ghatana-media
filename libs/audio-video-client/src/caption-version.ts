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
  versions(tenantId: string, principalId: string, sourceArtifactId: string, sourceArtifactVersionId: string, signal?: AbortSignal): Promise<readonly CaptionVersionRegistered[]>;
  /** Exact readback of one registered version; null only when the server reports a definitive 404. */
  version(captionVersionId: string, signal?: AbortSignal): Promise<CaptionVersionSnapshot | null>;
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
  return sha256HexUtf8(`[${json}]`);
}

// This synchronous fingerprint is part of the public client API, so WebCrypto's
// asynchronous digest interface cannot preserve its ABI. Keep the small SHA-256
// implementation local and platform-neutral instead of importing node:crypto.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexUtf8(text: string): string {
  const input = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
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
const REGISTRATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST', 'ACCESS_DENIED', 'VERSION_REGISTRATION_NOT_ALLOWED',
  'SOURCE_NOT_READY', 'CAPTION_DRAFT_EMPTY', 'CAPTION_ALIGNMENT_REQUIRED',
  'CAPTION_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'UNAVAILABLE', 'UNKNOWN_OUTCOME',
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isRegisteredVersion(value: unknown): value is CaptionVersionRegistered {
  if (!isRecord(value)) return false;
  return typeof value.requestId === 'string' && REQUEST_ID.test(value.requestId)
    && typeof value.requestFingerprint === 'string' && /^[0-9a-f]{64}$/u.test(value.requestFingerprint)
    && isIdentifier(value.captionVersionId) && isIdentifier(value.registrationReceiptId)
    && isIdentifier(value.sourceArtifactId) && isIdentifier(value.sourceArtifactVersionId)
    && (value.parentVersionKind === 'TRANSCRIPT_VERSION' || value.parentVersionKind === 'CAPTION_VERSION')
    && isIdentifier(value.parentVersionId)
    && (value.languageDisposition === 'NOT_SELECTED' || value.languageDisposition === 'DECLARED_BY_USER'
      || value.languageDisposition === 'UNCERTAIN')
    && isIdentifier(value.sourceClockId) && safeInt(value.registeredAt);
}

function isCaptionSegment(value: unknown, duration: number): value is CaptionVersionSegment {
  if (!isRecord(value)) return false;
  return isIdentifier(value.segmentId) && typeof value.text === 'string'
    && safeInt(value.startTick) && safeInt(value.endTick)
    && value.startTick < value.endTick && value.endTick <= duration
    && (value.origin === 'RECOGNIZED' || value.origin === 'USER_EDITED')
    && (value.speakerLabel === undefined || typeof value.speakerLabel === 'string');
}

function isCaptionSnapshot(value: unknown, captionVersionId: string): value is CaptionVersionSnapshot {
  if (!isRegisteredVersion(value) || value.captionVersionId !== captionVersionId) return false;
  const snapshot = value as unknown as Record<string, unknown>;
  if (!safeInt(snapshot.ticksPerSecond) || snapshot.ticksPerSecond < 1
    || !safeInt(snapshot.sourceDurationTicks)
    || !Array.isArray(snapshot.captionSegments) || snapshot.captionSegments.length === 0
    || snapshot.captionSegments.length > 4096
    || !snapshot.captionSegments.every((segment) => isCaptionSegment(segment, snapshot.sourceDurationTicks as number))) {
    return false;
  }
  if (snapshot.languageTag !== undefined && (typeof snapshot.languageTag !== 'string'
    || snapshot.languageTag.trim().length === 0 || snapshot.languageTag.length > 64)) return false;
  if (snapshot.purpose !== undefined && (typeof snapshot.purpose !== 'string'
    || snapshot.purpose.trim().length === 0 || [...snapshot.purpose].length > 240)) return false;
  return true;
}

function malformedRead(status: number, detail: string): CaptionVersionReadError {
  return new CaptionVersionReadError('UNKNOWN_OUTCOME', status, false, detail);
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
    async versions(tenantId, principalId, sourceArtifactId, sourceArtifactVersionId, signal) {
      if (tenantId !== options.tenantId || principalId !== options.principalId) {
        throw new CaptionVersionReadError('ACCESS_DENIED', 403, false, 'requested identity does not match transport scope');
      }
      const response = await impl(
        `${base}/api/v1/caption-versions?sourceArtifactId=${encodeURIComponent(sourceArtifactId)}&sourceArtifactVersionId=${encodeURIComponent(sourceArtifactVersionId)}`,
        { method: 'GET', headers: await headers(), signal });
      if (!response.ok) throw readError(response.status);
      const body = await response.json().catch(() => ({}));
      if (!Array.isArray(body?.captionVersions)) {
        throw malformedRead(response.status, 'malformed list body');
      }
      const versions: CaptionVersionRegistered[] = [];
      const seenVersionIds = new Set<string>();
      for (const value of body.captionVersions as unknown[]) {
        if (!isRegisteredVersion(value) || value.sourceArtifactId !== sourceArtifactId
          || value.sourceArtifactVersionId !== sourceArtifactVersionId || seenVersionIds.has(value.captionVersionId)) {
          throw malformedRead(response.status, 'malformed, duplicate, or out-of-scope caption version');
        }
        seenVersionIds.add(value.captionVersionId);
        versions.push(value);
      }
      return versions;
    },
    async version(captionVersionId, signal) {
      const response = await impl(
        `${base}/api/v1/caption-versions/${encodeURIComponent(captionVersionId)}`,
        { method: 'GET', headers: await headers(), signal });
      if (response.status === 404) return null;
      if (!response.ok) throw readError(response.status);
      const body = await response.json().catch(() => ({}));
      if (!isCaptionSnapshot(body, captionVersionId)) {
        throw malformedRead(response.status, 'malformed or mismatched snapshot');
      }
      return body;
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
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.requestId !== request.requestId) {
    return { requestId: request.requestId, requestFingerprint: fingerprint, error: 'UNKNOWN_OUTCOME', retryable: true };
  }
  // Registration is immutable and idempotent on request identity plus the
  // canonical fingerprint. A matching requestId with a mismatched/missing
  // fingerprint is not proof that this exact caption payload was registered.
  if ('captionVersionId' in result) {
    if (result.requestFingerprint !== fingerprint
      || typeof result.captionVersionId !== 'string' || result.captionVersionId.length === 0
      || typeof result.registrationReceiptId !== 'string' || result.registrationReceiptId.length === 0
      || !Number.isSafeInteger(result.registeredAt) || result.registeredAt < 0
      || result.sourceArtifactId !== request.sourceArtifactId
      || result.sourceArtifactVersionId !== request.sourceArtifactVersionId
      || result.parentVersionKind !== request.parentVersionKind
      || result.parentVersionId !== request.parentVersionId
      || result.languageDisposition !== request.languageDisposition
      || result.sourceClockId !== request.sourceClockId) {
      return { requestId: request.requestId, requestFingerprint: fingerprint, error: 'UNKNOWN_OUTCOME', retryable: true };
    }
  } else {
    if (!REGISTRATION_ERROR_CODES.has(result.error)
      || typeof result.retryable !== 'boolean'
      || (result.requestFingerprint != null
        && (typeof result.requestFingerprint !== 'string'
          || !/^[0-9a-f]{64}$/u.test(result.requestFingerprint)
          || result.requestFingerprint !== fingerprint))) {
      return { requestId: request.requestId, requestFingerprint: fingerprint, error: 'UNKNOWN_OUTCOME', retryable: true };
    }
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
