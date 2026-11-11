import {
  MediaClientError,
  MediaHttpTransport,
  MediaOperationAmbiguousError,
  safeIdentityHeader,
  type MediaTransportConfig,
} from "./http-core.js";
import { parseCanonicalProcessingJob, type CanonicalProcessingJob } from "./canonical-operations.js";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OUTCOMES = new Set([
  "CONFIRMED", "REQUESTED_UNCONFIRMED", "OUTCOME_UNKNOWN", "UNSUPPORTED",
  "ALREADY_TERMINAL", "TERMINAL_RACE",
]);
const ACTIVE_JOB_STATUSES = new Set(["ACCEPTED", "RUNNING"]);
const TERMINAL_JOB_STATUSES = new Set(["OUTCOME_UNKNOWN", "COMPLETED", "FAILED", "CANCELLED"]);

export interface DevOnlyJobCancellationResult {
  readonly schemaVersion: "media.dev.job-cancellation-result.v1";
  readonly scope: "DEV_ONLY";
  readonly requestId: string;
  readonly outcome: "CONFIRMED" | "REQUESTED_UNCONFIRMED" | "OUTCOME_UNKNOWN"
    | "UNSUPPORTED" | "ALREADY_TERMINAL" | "TERMINAL_RACE";
  readonly replayed: boolean;
  readonly job: CanonicalProcessingJob;
}

export interface DevOnlyJobCancellationRequest {
  readonly requestId: string;
  readonly expectedVersion?: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseResult(input: unknown, requestedJobId: string, tenantId: string,
  principalId: string, requestId: string): DevOnlyJobCancellationResult {
  const value = record(input, "DEV_ONLY job cancellation result");
  const allowed = new Set(["schemaVersion", "scope", "requestId", "outcome", "replayed", "job"]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("DEV_ONLY job cancellation result fields do not match its declared schema.");
  }
  if (value.schemaVersion !== "media.dev.job-cancellation-result.v1" || value.scope !== "DEV_ONLY"
    || value.requestId !== requestId || typeof value.replayed !== "boolean"
    || typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    throw new TypeError("DEV_ONLY job cancellation result identity or outcome is invalid.");
  }
  const job = parseCanonicalProcessingJob(value.job);
  if (job.jobId !== requestedJobId || job.tenantId !== tenantId || job.principalId !== principalId) {
    throw new TypeError("DEV_ONLY job cancellation readback is outside the requested job scope.");
  }
  const outcome = value.outcome as DevOnlyJobCancellationResult["outcome"];
  const status = job.status;
  const statusMatchesOutcome = outcome === "CONFIRMED" ? status === "CANCELLED"
    : outcome === "REQUESTED_UNCONFIRMED" || outcome === "UNSUPPORTED"
      ? ACTIVE_JOB_STATUSES.has(status)
      : outcome === "OUTCOME_UNKNOWN"
        ? ACTIVE_JOB_STATUSES.has(status) || status === "OUTCOME_UNKNOWN"
        : TERMINAL_JOB_STATUSES.has(status);
  if (!statusMatchesOutcome) {
    throw new TypeError("DEV_ONLY job cancellation outcome contradicts its job status readback.");
  }
  return {
    schemaVersion: "media.dev.job-cancellation-result.v1",
    scope: "DEV_ONLY",
    requestId,
    outcome,
    replayed: value.replayed,
    job,
  };
}

/**
 * Cancellation adapter for the signed local-development route. It rejects
 * non-loopback endpoints and keeps this operation out of MediaCanonicalClient,
 * whose production admission remains unchanged.
 */
export class MediaDevOnlyJobCancellationClient {
  private readonly transport: MediaHttpTransport;
  private readonly tenantId: string;
  private readonly principalId: string;

  public constructor(config: MediaTransportConfig) {
    const endpoint = new URL(config.baseUrl);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (!loopback.has(endpoint.hostname.toLowerCase())) {
      throw new Error("DEV_ONLY job cancellation requires a loopback Media endpoint.");
    }
    this.transport = new MediaHttpTransport(config);
    this.tenantId = this.transport.tenantId;
    const principal = Object.entries(this.transport.callerDefaultHeaders())
      .find(([name]) => name.toLowerCase() === "x-principal-id")?.[1];
    this.principalId = safeIdentityHeader("principalId", principal) ?? "";
    if (!this.principalId) throw new Error("DEV_ONLY job cancellation requires the caller's X-Principal-Id scope header.");
  }

  public async cancelJob(jobId: string, request: DevOnlyJobCancellationRequest,
    signal?: AbortSignal): Promise<DevOnlyJobCancellationResult> {
    const requested = safeIdentityHeader("jobId", jobId);
    if (!requested || !REQUEST_ID.test(request.requestId)) {
      throw new Error("jobId and cancellation requestId must be bounded opaque identities.");
    }
    if (request.expectedVersion !== undefined
      && (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1)) {
      throw new Error("expectedVersion must be a positive safe integer.");
    }
    const path = `/dev/v1/jobs/${encodeURIComponent(requested)}/cancel`;
    let dispatched = false;
    try {
      return await this.transport.request(
        "POST", path,
        request.expectedVersion === undefined
          ? { requestId: request.requestId }
          : { requestId: request.requestId, expectedVersion: request.expectedVersion },
        { parse: (input) => parseResult(input, requested, this.tenantId, this.principalId, request.requestId) },
        signal,
        {},
        () => { dispatched = true; },
      );
    } catch (failure) {
      const definitive = failure instanceof MediaClientError
        && ([400, 401, 403, 404, 409, 422].includes(failure.statusCode ?? 0));
      if (dispatched && !definitive) {
        throw new MediaOperationAmbiguousError(path, failure, { requestId: request.requestId });
      }
      throw failure;
    }
  }
}

export function createMediaDevOnlyJobCancellationClient(
  config: MediaTransportConfig,
): MediaDevOnlyJobCancellationClient {
  return new MediaDevOnlyJobCancellationClient(config);
}
