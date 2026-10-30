import {
  MediaHttpTransport,
  MediaOperationAmbiguousError,
  MediaOperationNotAdmittedError,
  safeIdentityHeader,
  type MediaTransportConfig,
  type RuntimeParser,
} from "./http-core.js";

/**
 * Canonical `/api/v1/jobs` and `/api/v1/streams` client bound to
 * contracts/openapi/media.yaml. Every method validates the exact runtime
 * DTO: required fields, enums, bounds and response scope are verified, and
 * the caller's tenant/principal scope never comes from a request body.
 *
 * Operations absent from the admitted contract (watch, raw byte download,
 * cursor pagination) are explicit NOT_ADMITTED, never an invented route.
 */

export type CanonicalJobType =
  | "TRANSCODE" | "SPEECH_TO_TEXT" | "TEXT_TO_SPEECH" | "VISION" | "MULTIMODAL";

export type CanonicalJobStatus =
  | "ACCEPTED" | "RUNNING" | "OUTCOME_UNKNOWN" | "COMPLETED" | "FAILED" | "CANCELLED";

export type CanonicalStreamKind = "AUDIO" | "VIDEO" | "MULTIMODAL";

export type CanonicalStreamState =
  | "OPEN" | "CONNECTED" | "DEGRADED" | "DRAINING" | "CLOSED" | "FAILED";

/** Exact runtime ProcessingJob projection (tolerates unknown properties). */
export interface CanonicalProcessingJob {
  readonly jobId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly artifactId: string;
  readonly jobType: CanonicalJobType;
  readonly providerId: string | null;
  readonly status: CanonicalJobStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly result: Readonly<Record<string, unknown>>;
  readonly failureCode: string | null;
  readonly version: number;
  readonly expectedArtifactVersion: string;
  readonly requestFingerprint: string;
}

/** Exact runtime StreamSession projection (additionalProperties: false). */
export interface CanonicalStreamSession {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly streamKind: CanonicalStreamKind;
  readonly providerId: string;
  readonly state: CanonicalStreamState;
  readonly lastSequence: number;
  readonly bufferedBytes: number;
  readonly maximumBufferedBytes: number;
  readonly reconnectCount: number;
  readonly leaseExpiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly acknowledgementRevision: number;
  readonly finality: "NONE" | "FINAL_ACKNOWLEDGED" | "UNKNOWN";
}

/** One-time stream registration: session plus its single-use connect token. */
export interface CanonicalStreamRegistration {
  readonly session: CanonicalStreamSession;
  readonly connectionToken: string;
}

/** Ordered frame acknowledgement and backpressure state. */
export interface CanonicalStreamAck {
  readonly acceptedSequence: number;
  readonly bufferedBytes: number;
  readonly backpressured: boolean;
}

export interface SubmitMediaJobRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly artifactId: string;
  readonly jobType: CanonicalJobType;
  readonly providerHint?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Required by the contract's idempotency declaration. */
  readonly idempotencyKey: string;
}

export interface OpenMediaStreamRequest {
  readonly correlationId: string;
  readonly streamKind: CanonicalStreamKind;
  readonly providerHint?: string;
  readonly maximumBufferedBytes: number;
  /** ISO-8601 duration, for example PT30S. */
  readonly leaseDuration: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Required by the contract's idempotency declaration. */
  readonly idempotencyKey: string;
}

const JOB_TYPES = new Set(["TRANSCODE", "SPEECH_TO_TEXT", "TEXT_TO_SPEECH", "VISION", "MULTIMODAL"]);
const JOB_STATUSES = new Set(["ACCEPTED", "RUNNING", "OUTCOME_UNKNOWN", "COMPLETED", "FAILED", "CANCELLED"]);
const STREAM_KINDS = new Set(["AUDIO", "VIDEO", "MULTIMODAL"]);
const STREAM_STATES = new Set(["OPEN", "CONNECTED", "DEGRADED", "DRAINING", "CLOSED", "FAILED"]);
const FINALITIES = new Set(["NONE", "FINAL_ACKNOWLEDGED", "UNKNOWN"]);

const STREAM_SESSION_FIELDS = new Set([
  "tenantId", "sessionId", "principalId", "streamKind", "providerId", "state",
  "lastSequence", "bufferedBytes", "maximumBufferedBytes", "reconnectCount",
  "leaseExpiresAt", "createdAt", "updatedAt", "closedAt", "metadata", "version",
  "acknowledgementRevision", "finality",
]);

const PROCESSING_JOB_FIELDS = new Set([
  "jobId", "requestId", "tenantId", "principalId", "artifactId", "jobType",
  "providerId", "status", "createdAt", "startedAt", "completedAt", "result",
  "failureCode", "version", "expectedArtifactVersion", "requestFingerprint",
]);

function requiredText(value: Record<string, unknown>, key: string, dto: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new TypeError(`${dto} ${key} must be a non-empty string.`);
  }
  return field;
}

function nullableText(value: Record<string, unknown>, key: string, dto: string): string | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string") {
    throw new TypeError(`${dto} ${key} must be a string or null.`);
  }
  return field;
}

function requiredInt(value: Record<string, unknown>, key: string, min: number, dto: string, max?: number): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < min
    || (max !== undefined && field > max)) {
    throw new TypeError(`${dto} ${key} must be a bounded safe integer.`);
  }
  return field;
}

function requiredObject(value: Record<string, unknown>, key: string, dto: string): Readonly<Record<string, unknown>> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new TypeError(`${dto} ${key} must be an object.`);
  }
  return field as Readonly<Record<string, unknown>>;
}

function asRecord(input: unknown, dto: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${dto} must be an object.`);
  }
  return input as Record<string, unknown>;
}

/** Runtime ProcessingJob: required fields exact, unknown properties tolerated. */
export function parseCanonicalProcessingJob(input: unknown): CanonicalProcessingJob {
  const value = asRecord(input, "Canonical Media job");
  for (const key of PROCESSING_JOB_FIELDS) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`Canonical Media job is missing required field ${key}.`);
    }
  }
  const jobType = requiredText(value, "jobType", "Canonical Media job");
  if (!JOB_TYPES.has(jobType)) throw new TypeError("Canonical Media job jobType is outside the runtime enum.");
  const status = requiredText(value, "status", "Canonical Media job");
  if (!JOB_STATUSES.has(status)) throw new TypeError("Canonical Media job status is outside the runtime enum.");
  const requestFingerprint = value.requestFingerprint;
  if (typeof requestFingerprint !== "string"
    || !/^(|sha256:[0-9a-f]{64})$/u.test(requestFingerprint)) {
    throw new TypeError("Canonical Media job requestFingerprint must be empty or sha256:<hex>.");
  }
  const expectedArtifactVersion = value.expectedArtifactVersion;
  if (typeof expectedArtifactVersion !== "string"
    || (expectedArtifactVersion !== "" && !/^sha256:[0-9a-f]{64}$/u.test(expectedArtifactVersion))) {
    throw new TypeError("Canonical Media job expectedArtifactVersion must be empty or sha256:<hex>.");
  }
  return {
    jobId: requiredText(value, "jobId", "Canonical Media job"),
    requestId: requiredText(value, "requestId", "Canonical Media job"),
    tenantId: requiredText(value, "tenantId", "Canonical Media job"),
    principalId: requiredText(value, "principalId", "Canonical Media job"),
    artifactId: requiredText(value, "artifactId", "Canonical Media job"),
    jobType: jobType as CanonicalJobType,
    providerId: nullableText(value, "providerId", "Canonical Media job"),
    status: status as CanonicalJobStatus,
    createdAt: requiredText(value, "createdAt", "Canonical Media job"),
    startedAt: nullableText(value, "startedAt", "Canonical Media job"),
    completedAt: nullableText(value, "completedAt", "Canonical Media job"),
    result: requiredObject(value, "result", "Canonical Media job"),
    failureCode: nullableText(value, "failureCode", "Canonical Media job"),
    version: requiredInt(value, "version", 1, "Canonical Media job"),
    expectedArtifactVersion,
    requestFingerprint,
  };
}

/** Runtime StreamSession: strict — the contract declares additionalProperties: false. */
export function parseCanonicalStreamSession(input: unknown): CanonicalStreamSession {
  const value = asRecord(input, "Canonical Media stream session");
  if (Object.keys(value).some((key) => !STREAM_SESSION_FIELDS.has(key))
    || [...STREAM_SESSION_FIELDS].some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Canonical Media stream session fields do not match the runtime DTO.");
  }
  const streamKind = requiredText(value, "streamKind", "Canonical Media stream session");
  if (!STREAM_KINDS.has(streamKind)) throw new TypeError("Canonical Media stream session streamKind is outside the runtime enum.");
  const state = requiredText(value, "state", "Canonical Media stream session");
  if (!STREAM_STATES.has(state)) throw new TypeError("Canonical Media stream session state is outside the runtime enum.");
  const finality = requiredText(value, "finality", "Canonical Media stream session");
  if (!FINALITIES.has(finality)) throw new TypeError("Canonical Media stream session finality is outside the runtime enum.");
  const closedAt = nullableText(value, "closedAt", "Canonical Media stream session");
  return {
    tenantId: requiredText(value, "tenantId", "Canonical Media stream session"),
    sessionId: requiredText(value, "sessionId", "Canonical Media stream session"),
    principalId: requiredText(value, "principalId", "Canonical Media stream session"),
    streamKind: streamKind as CanonicalStreamKind,
    providerId: requiredText(value, "providerId", "Canonical Media stream session"),
    state: state as CanonicalStreamState,
    lastSequence: requiredInt(value, "lastSequence", -1, "Canonical Media stream session"),
    bufferedBytes: requiredInt(value, "bufferedBytes", 0, "Canonical Media stream session"),
    maximumBufferedBytes: requiredInt(value, "maximumBufferedBytes", 1, "Canonical Media stream session", 1_073_741_824),
    reconnectCount: requiredInt(value, "reconnectCount", 0, "Canonical Media stream session"),
    leaseExpiresAt: requiredText(value, "leaseExpiresAt", "Canonical Media stream session"),
    createdAt: requiredText(value, "createdAt", "Canonical Media stream session"),
    updatedAt: requiredText(value, "updatedAt", "Canonical Media stream session"),
    closedAt,
    metadata: requiredObject(value, "metadata", "Canonical Media stream session"),
    version: requiredInt(value, "version", 1, "Canonical Media stream session"),
    acknowledgementRevision: requiredInt(value, "acknowledgementRevision", 0, "Canonical Media stream session"),
    finality: finality as CanonicalStreamSession["finality"],
  };
}

export function parseCanonicalStreamAck(input: unknown): CanonicalStreamAck {
  const value = asRecord(input, "Canonical Media stream ack");
  if (Object.keys(value).some((key) => !["acceptedSequence", "bufferedBytes", "backpressured"].includes(key))
    || !Object.hasOwn(value, "acceptedSequence") || !Object.hasOwn(value, "bufferedBytes")
    || !Object.hasOwn(value, "backpressured")) {
    throw new TypeError("Canonical Media stream ack fields do not match the runtime DTO.");
  }
  if (typeof value.backpressured !== "boolean") {
    throw new TypeError("Canonical Media stream ack backpressured must be a boolean.");
  }
  return {
    acceptedSequence: requiredInt(value, "acceptedSequence", 0, "Canonical Media stream ack"),
    bufferedBytes: requiredInt(value, "bufferedBytes", 0, "Canonical Media stream ack"),
    backpressured: value.backpressured,
  };
}

function safePathSegment(name: string, value: string): string {
  const checked = safeIdentityHeader(name, value);
  if (!checked || checked === "." || checked === ".." || /[\\/]/u.test(checked)) {
    throw new Error(`${name} must be a safe single path-segment identity.`);
  }
  return checked;
}

/**
 * Client bound to the canonical job and stream routes. The caller's
 * X-Principal-Id scope header is required, but it is routing scope — the
 * bearer token is the only authentication and never comes from arguments.
 */
export class MediaCanonicalClient {
  private readonly transport: MediaHttpTransport;

  public constructor(config: MediaTransportConfig) {
    this.transport = new MediaHttpTransport(config);
  }

  private get tenantId(): string {
    return this.transport.tenantId;
  }

  private requirePrincipalId(operation: string): string {
    const value = Object.entries(this.transport.callerDefaultHeaders())
      .find(([name]) => name.toLowerCase() === "x-principal-id")?.[1];
    const principalId = safeIdentityHeader("principalId", value);
    if (!principalId) throw new Error(`Canonical ${operation} require the caller's X-Principal-Id scope header.`);
    return principalId;
  }

  private assertJobScope(job: CanonicalProcessingJob, principalId: string): CanonicalProcessingJob {
    if (job.tenantId !== this.tenantId || job.principalId !== principalId) {
      throw new TypeError("Canonical Media job response is outside the caller's tenant and principal scope.");
    }
    return job;
  }

  private assertSessionScope(session: CanonicalStreamSession, principalId: string): CanonicalStreamSession {
    if (session.tenantId !== this.tenantId || session.principalId !== principalId) {
      throw new TypeError("Canonical Media stream session is outside the caller's tenant and principal scope.");
    }
    return session;
  }

  /** POST /api/v1/jobs — submit with the contract-required idempotency key. */
  public async submitJob(
    request: SubmitMediaJobRequest,
    signal?: AbortSignal,
  ): Promise<CanonicalProcessingJob> {
    const principalId = this.requirePrincipalId("job submit");
    const allowed = new Set(["requestId", "correlationId", "artifactId", "jobType",
      "providerHint", "parameters", "idempotencyKey"]);
    if (!request || Object.keys(request).some((key) => !allowed.has(key))) {
      throw new Error("Job submit contains fields outside the canonical request.");
    }
    const idempotencyKey = safeIdentityHeader("idempotencyKey", request.idempotencyKey);
    if (!idempotencyKey) throw new Error("idempotencyKey is required by the declared HTTP contract.");
    if (!JOB_TYPES.has(request.jobType)) throw new Error("jobType is outside the runtime enum.");
    const body = {
      requestId: safeIdentityHeader("requestId", request.requestId),
      tenantId: this.tenantId,
      principalId,
      correlationId: safeIdentityHeader("correlationId", request.correlationId),
      artifactId: safeIdentityHeader("artifactId", request.artifactId),
      jobType: request.jobType,
      ...(request.providerHint === undefined ? {} : { providerHint: request.providerHint }),
      parameters: request.parameters ?? {},
    };
    if (!body.requestId || !body.correlationId || !body.artifactId) {
      throw new Error("requestId, correlationId and artifactId are required.");
    }
    let job: CanonicalProcessingJob;
    try {
      job = await this.transport.request(
        "POST", "/api/v1/jobs", body,
        { parse: parseCanonicalProcessingJob }, signal,
        { "Idempotency-Key": idempotencyKey },
      );
    } catch (failure) {
      // A post-dispatch abort is OUTCOME_UNKNOWN — never a clean failure that
      // invites a duplicate submit.
      if (failure instanceof DOMException
        && (failure.name === "AbortError" || failure.name === "TimeoutError")) {
        throw new MediaOperationAmbiguousError("/api/v1/jobs", failure);
      }
      throw failure;
    }
    return this.assertJobScope(job, principalId);
  }

  /** GET /api/v1/jobs/{jobId} — scope-verified point-in-time job read. */
  public async getJob(jobId: string, signal?: AbortSignal): Promise<CanonicalProcessingJob> {
    const principalId = this.requirePrincipalId("job reads");
    const requested = safePathSegment("jobId", jobId);
    const job = await this.transport.request(
      "GET", `/api/v1/jobs/${encodeURIComponent(requested)}`, undefined,
      { parse: parseCanonicalProcessingJob }, signal,
    );
    this.assertJobScope(job, principalId);
    if (job.jobId !== requested) {
      throw new TypeError("Canonical Media job response identity does not match the request.");
    }
    return job;
  }

  /**
   * GET /api/v1/jobs?limit=N — the only admitted pagination is the bounded
   * limit parameter; the contract declares no cursor, so none is offered.
   */
  public async listJobs(
    options: { readonly limit?: number; readonly signal?: AbortSignal } = {},
  ): Promise<readonly CanonicalProcessingJob[]> {
    const principalId = this.requirePrincipalId("job lists");
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("listJobs limit must be a safe integer in 1..1000 per the contract.");
    }
    const parser: RuntimeParser<readonly CanonicalProcessingJob[]> = {
      parse: (input: unknown) => {
        const value = asRecord(input, "Canonical Media job list");
        const jobs = value.jobs;
        if (!Array.isArray(jobs)) {
          throw new TypeError("Canonical Media job list jobs must be an array.");
        }
        return jobs.map(parseCanonicalProcessingJob);
      },
    };
    const jobs = await this.transport.request(
      "GET", `/api/v1/jobs?limit=${limit}`, undefined, parser, options.signal,
    );
    return jobs.map((job) => this.assertJobScope(job, principalId));
  }

  /**
   * POST /api/v1/jobs/{jobId}/cancel — the contract declares no replay-safe
   * idempotency, so a post-dispatch abort is OUTCOME_UNKNOWN, never retried.
   */
  public async cancelJob(jobId: string, signal?: AbortSignal): Promise<CanonicalProcessingJob> {
    const principalId = this.requirePrincipalId("job cancel");
    const requested = safePathSegment("jobId", jobId);
    let job: CanonicalProcessingJob;
    try {
      job = await this.transport.request(
        "POST", `/api/v1/jobs/${encodeURIComponent(requested)}/cancel`, {},
        { parse: parseCanonicalProcessingJob }, signal,
      );
    } catch (failure) {
      if (failure instanceof DOMException
        && (failure.name === "AbortError" || failure.name === "TimeoutError")) {
        throw new MediaOperationAmbiguousError(`/api/v1/jobs/${requested}/cancel`, failure);
      }
      throw failure;
    }
    this.assertJobScope(job, principalId);
    if (job.jobId !== requested) {
      throw new TypeError("Canonical Media job cancel response identity does not match the request.");
    }
    return job;
  }

  /** POST /api/v1/streams — open a session and receive the one-time token. */
  public async openStream(
    request: OpenMediaStreamRequest,
    signal?: AbortSignal,
  ): Promise<CanonicalStreamRegistration> {
    const principalId = this.requirePrincipalId("stream open");
    const allowed = new Set(["correlationId", "streamKind", "providerHint",
      "maximumBufferedBytes", "leaseDuration", "metadata", "idempotencyKey"]);
    if (!request || Object.keys(request).some((key) => !allowed.has(key))) {
      throw new Error("Stream open contains fields outside the canonical request.");
    }
    const idempotencyKey = safeIdentityHeader("idempotencyKey", request.idempotencyKey);
    if (!idempotencyKey) throw new Error("idempotencyKey is required by the declared HTTP contract.");
    if (!STREAM_KINDS.has(request.streamKind)) throw new Error("streamKind is outside the runtime enum.");
    if (!Number.isSafeInteger(request.maximumBufferedBytes)
      || request.maximumBufferedBytes < 1 || request.maximumBufferedBytes > 1_073_741_824) {
      throw new Error("maximumBufferedBytes must be a safe integer in 1..1GiB per the contract.");
    }
    if (!request.leaseDuration.trim()) throw new Error("leaseDuration ISO-8601 duration is required.");
    const correlationId = safeIdentityHeader("correlationId", request.correlationId);
    if (!correlationId) throw new Error("correlationId is required.");
    const body = {
      tenantId: this.tenantId,
      principalId,
      correlationId,
      streamKind: request.streamKind,
      ...(request.providerHint === undefined ? {} : { providerHint: request.providerHint }),
      maximumBufferedBytes: request.maximumBufferedBytes,
      leaseDuration: request.leaseDuration,
      metadata: request.metadata ?? {},
    };
    const parser: RuntimeParser<CanonicalStreamRegistration> = {
      parse: (input: unknown) => {
        const value = asRecord(input, "Canonical Media stream registration");
        if (Object.keys(value).some((key) => key !== "session" && key !== "connectionToken")
          || !Object.hasOwn(value, "session") || !Object.hasOwn(value, "connectionToken")) {
          throw new TypeError("Canonical Media stream registration fields do not match the runtime DTO.");
        }
        const token = value.connectionToken;
        if (typeof token !== "string" || token.length < 32) {
          throw new TypeError("Canonical Media stream registration connectionToken must be >= 32 chars.");
        }
        return { session: parseCanonicalStreamSession(value.session), connectionToken: token };
      },
    };
    let registration: CanonicalStreamRegistration;
    try {
      registration = await this.transport.request(
        "POST", "/api/v1/streams", body, parser, signal,
        { "Idempotency-Key": idempotencyKey },
      );
    } catch (failure) {
      if (failure instanceof DOMException
        && (failure.name === "AbortError" || failure.name === "TimeoutError")) {
        throw new MediaOperationAmbiguousError("/api/v1/streams", failure);
      }
      throw failure;
    }
    this.assertSessionScope(registration.session, principalId);
    return registration;
  }

  /** GET /api/v1/streams/{sessionId} — session read without the token. */
  public async getStream(
    sessionId: string, signal?: AbortSignal,
  ): Promise<CanonicalStreamSession> {
    const principalId = this.requirePrincipalId("stream reads");
    const requested = safePathSegment("sessionId", sessionId);
    const session = await this.transport.request(
      "GET", `/api/v1/streams/${encodeURIComponent(requested)}`, undefined,
      { parse: parseCanonicalStreamSession }, signal,
    );
    this.assertSessionScope(session, principalId);
    if (session.sessionId !== requested) {
      throw new TypeError("Canonical Media stream session identity does not match the request.");
    }
    return session;
  }

  /**
   * POST /api/v1/streams/{sessionId}/connect — attach or reconnect with the
   * one-time token. The contract declares no replay-safe idempotency; a
   * post-dispatch abort is OUTCOME_UNKNOWN, never retried.
   */
  public async connectStream(
    sessionId: string, connectionToken: string, signal?: AbortSignal,
  ): Promise<CanonicalStreamSession> {
    const principalId = this.requirePrincipalId("stream connect");
    const requested = safePathSegment("sessionId", sessionId);
    const token = this.requireStreamToken(connectionToken);
    let session: CanonicalStreamSession;
    try {
      session = await this.transport.request(
        "POST", `/api/v1/streams/${encodeURIComponent(requested)}/connect`, {},
        { parse: parseCanonicalStreamSession }, signal,
        { "X-Stream-Token": token },
      );
    } catch (failure) {
      if (failure instanceof DOMException
        && (failure.name === "AbortError" || failure.name === "TimeoutError")) {
        throw new MediaOperationAmbiguousError(`/api/v1/streams/${requested}/connect`, failure);
      }
      throw failure;
    }
    this.assertSessionScope(session, principalId);
    if (session.sessionId !== requested) {
      throw new TypeError("Canonical Media stream connect response identity does not match the request.");
    }
    return session;
  }

  /**
   * POST /api/v1/streams/{sessionId}/frames/{sequence} — ordered frame
   * submit with the contract-required idempotency scope
   * (tenantId|sessionId|sequence). A post-dispatch abort is OUTCOME_UNKNOWN.
   */
  public async submitStreamFrame(
    sessionId: string,
    connectionToken: string,
    sequence: number,
    frame: Blob,
    options: { readonly endOfStream?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<CanonicalStreamAck> {
    this.requirePrincipalId("stream frame submit");
    const requested = safePathSegment("sessionId", sessionId);
    const token = this.requireStreamToken(connectionToken);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("sequence must be a non-negative safe integer per the contract.");
    }
    if (!(frame instanceof Blob)) throw new Error("frame must be a Blob of bounded wire bytes.");
    if (frame.size > 16 * 1024 * 1024) {
      throw new Error("frame payload exceeds the bounded wire size.");
    }
    const headers = await this.transport.headers({
      "Content-Type": "application/octet-stream",
      "X-Stream-Token": token,
      ...(options.endOfStream ? { "X-End-Of-Stream": "true" } : {}),
    });
    let response: Response;
    try {
      response = await this.transport.fetchRaw(
        `${this.transport.baseUrl}/api/v1/streams/${encodeURIComponent(requested)}/frames/${sequence}`,
        { method: "POST", headers, body: frame },
        options.signal,
      );
    } catch (failure) {
      if (failure instanceof DOMException
        && (failure.name === "AbortError" || failure.name === "TimeoutError")) {
        throw new MediaOperationAmbiguousError(
          `/api/v1/streams/${requested}/frames/${sequence}`, failure);
      }
      throw failure;
    }
    if (!response.ok) throw await this.transport.errorFromResponse(response);
    return parseCanonicalStreamAck(await response.json());
  }

  /** POST /api/v1/streams/{sessionId}/close — terminal close with the token. */
  public async closeStream(
    sessionId: string, connectionToken: string, signal?: AbortSignal,
  ): Promise<CanonicalStreamSession> {
    const principalId = this.requirePrincipalId("stream close");
    const requested = safePathSegment("sessionId", sessionId);
    const token = this.requireStreamToken(connectionToken);
    let session: CanonicalStreamSession;
    try {
      session = await this.transport.request(
        "POST", `/api/v1/streams/${encodeURIComponent(requested)}/close`, {},
        { parse: parseCanonicalStreamSession }, signal,
        { "X-Stream-Token": token },
      );
    } catch (failure) {
      if (failure instanceof DOMException
        && (failure.name === "AbortError" || failure.name === "TimeoutError")) {
        throw new MediaOperationAmbiguousError(`/api/v1/streams/${requested}/close`, failure);
      }
      throw failure;
    }
    this.assertSessionScope(session, principalId);
    if (session.sessionId !== requested) {
      throw new TypeError("Canonical Media stream close response identity does not match the request.");
    }
    return session;
  }

  /**
   * No watch/event-stream route exists in the admitted contract — this is an
   * explicit NOT_ADMITTED, never an invented endpoint.
   */
  public watchStream(_sessionId: string): Promise<never> {
    return Promise.reject(new MediaOperationNotAdmittedError("media.stream.watch"));
  }

  /** No check-outcome route exists; job status reads go through getJob. */
  public checkOutcome(_operationId: string): Promise<never> {
    return Promise.reject(new MediaOperationNotAdmittedError("media.operation.check-outcome"));
  }

  /** No cursor pagination exists in the contract; use listJobs({limit}). */
  public listJobsPage(_cursor: string): Promise<never> {
    return Promise.reject(new MediaOperationNotAdmittedError("media.job.list-cursor"));
  }

  private requireStreamToken(connectionToken: string): string {
    const token = safeIdentityHeader("connectionToken", connectionToken);
    if (!token || token.length < 32) {
      throw new Error("connectionToken must be the one-time token returned by openStream.");
    }
    return token;
  }
}

export function createMediaCanonicalClient(
  config: MediaTransportConfig,
): MediaCanonicalClient {
  return new MediaCanonicalClient(config);
}
