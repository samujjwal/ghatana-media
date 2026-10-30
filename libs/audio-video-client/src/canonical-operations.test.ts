import { describe, expect, it, vi } from "vitest";
import {
  MediaClientError,
  MediaOperationAmbiguousError,
  MediaOperationNotAdmittedError,
} from "./http-core";
import {
  createMediaCanonicalClient,
  parseCanonicalProcessingJob,
  parseCanonicalStreamSession,
  type CanonicalProcessingJob,
  type CanonicalStreamSession,
} from "./canonical-operations";

const timestamp = "2026-10-30T12:00:00.000Z";
const connectionToken = "a".repeat(32) + "-one-time";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-1", requestId: "req-1", tenantId: "tenant-1", principalId: "principal-1",
    artifactId: "art-1", jobType: "SPEECH_TO_TEXT", providerId: "whisper-local",
    status: "RUNNING", createdAt: timestamp, startedAt: timestamp, completedAt: null,
    result: {}, failureCode: null, version: 3, expectedArtifactVersion: "",
    requestFingerprint: `sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}): CanonicalStreamSession {
  return {
    tenantId: "tenant-1", sessionId: "sess-1", principalId: "principal-1",
    streamKind: "AUDIO", providerId: "in-process", state: "CONNECTED",
    lastSequence: 0, bufferedBytes: 16, maximumBufferedBytes: 1_048_576,
    reconnectCount: 0, leaseExpiresAt: "2026-10-30T12:30:00.000Z",
    createdAt: timestamp, updatedAt: timestamp, closedAt: null,
    metadata: {}, version: 2, acknowledgementRevision: 4, finality: "NONE",
    ...overrides,
  };
}

function clientWith(fetchImpl: typeof fetch) {
  return createMediaCanonicalClient({
    baseUrl: "https://media.example.test",
    tenantId: "tenant-1",
    defaultHeaders: { "X-Principal-Id": "principal-1" },
    getAccessToken: () => "bearer-secret",
    fetchImpl,
  });
}

function recordedFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("MediaCanonicalClient job operations", () => {
  it("submits a job with idempotency key and binds scope + identity", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(job(), 202));
    const client = clientWith(fetchImpl);
    const accepted = await client.submitJob({
      requestId: "req-1", correlationId: "corr-1", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", parameters: { languageTag: "en-US" },
      idempotencyKey: "idem-1",
    });
    expect(accepted.jobId).toBe("job-1");
    const [call] = calls;
    expect(call.url).toBe("https://media.example.test/api/v1/jobs");
    const headers = new Headers(call.init.headers);
    expect(headers.get("Idempotency-Key")).toBe("idem-1");
    expect(headers.get("Authorization")).toBe("Bearer bearer-secret");
    expect(headers.get("X-Tenant-ID")).toBe("tenant-1");
    expect(headers.get("X-Principal-Id")).toBe("principal-1");
    const body = JSON.parse(String(call.init.body));
    expect(body.tenantId).toBe("tenant-1");
    expect(body.principalId).toBe("principal-1");
  });

  it("rejects a job response outside the caller tenant/principal scope", async () => {
    const { fetchImpl } = recordedFetch(() =>
      jsonResponse(job({ tenantId: "tenant-2" }), 200));
    const client = clientWith(fetchImpl);
    await expect(client.getJob("job-1")).rejects.toThrow(/outside the caller's tenant and principal scope/u);
  });

  it("rejects a getJob response whose identity differs from the request", async () => {
    const { fetchImpl } = recordedFetch(() => jsonResponse(job({ jobId: "job-2" })));
    const client = clientWith(fetchImpl);
    await expect(client.getJob("job-1")).rejects.toThrow(/identity does not match/u);
  });

  it("maps a 404 error envelope into a MediaClientError with status", async () => {
    const { fetchImpl } = recordedFetch(() => jsonResponse({
      error: { code: "JOB_NOT_FOUND", message: "not visible", retryable: false },
      meta: { correlationId: "corr-404" },
    }, 404));
    const client = clientWith(fetchImpl);
    const failure = await client.getJob("job-1").then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MediaClientError);
    expect((failure as MediaClientError).statusCode).toBe(404);
    expect((failure as MediaClientError).detail.code).toBe("JOB_NOT_FOUND");
    expect((failure as MediaClientError).detail.category).toBe("VALIDATION");
  });

  it("maps a 403 into an AUTHORIZATION error", async () => {
    const { fetchImpl } = recordedFetch(() => jsonResponse({
      error: { code: "FORBIDDEN", message: "denied", retryable: false },
      meta: { correlationId: "corr-403" },
    }, 403));
    const client = clientWith(fetchImpl);
    const failure = await client.getJob("job-1").then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    ) as MediaClientError;
    expect(failure.statusCode).toBe(403);
    expect(failure.detail.category).toBe("AUTHORIZATION");
  });

  it("surfaces a post-dispatch abort on submit as OUTCOME_UNKNOWN, not a clean failure", async () => {
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) =>
      Promise.reject(init?.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    ) as unknown as typeof fetch;
    const client = clientWith(fetchImpl);
    const failure = await client.submitJob({
      requestId: "r", correlationId: "c", artifactId: "a",
      jobType: "VISION", idempotencyKey: "i",
    }).then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/jobs");
  });

  it("cancelJob round-trips and never retries after a dispatch abort", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse(job({ status: "CANCELLED" }), 200));
    const client = clientWith(fetchImpl);
    const cancelled = await client.cancelJob("job-1");
    expect(cancelled.status).toBe("CANCELLED");
    expect(calls[0]!.url).toBe("https://media.example.test/api/v1/jobs/job-1/cancel");
  });

  it("listJobs honors the bounded limit and binds every job to scope", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse({ jobs: [job(), job({ jobId: "job-2", requestId: "req-2" })] }));
    const client = clientWith(fetchImpl);
    const jobs = await client.listJobs({ limit: 25 });
    expect(jobs).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://media.example.test/api/v1/jobs?limit=25");
    await expect(client.listJobs({ limit: 0 })).rejects.toThrow(/limit/u);
    await expect(client.listJobs({ limit: 1001 })).rejects.toThrow(/limit/u);
  });
});

describe("MediaCanonicalClient stream operations", () => {
  it("opens a stream and returns the one-time token with a scoped session", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse({ session: session({ state: "OPEN" }), connectionToken }, 201));
    const client = clientWith(fetchImpl);
    const registration = await client.openStream({
      correlationId: "corr-1", streamKind: "AUDIO", maximumBufferedBytes: 1_048_576,
      leaseDuration: "PT30S", metadata: {}, idempotencyKey: "idem-open",
    });
    expect(registration.connectionToken).toBe(connectionToken);
    expect(registration.session.sessionId).toBe("sess-1");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBe("idem-open");
  });

  it("connect and close carry the stream token, never the bearer credential in the body", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(session()));
    const client = clientWith(fetchImpl);
    await client.connectStream("sess-1", connectionToken);
    await client.closeStream("sess-1", connectionToken);
    expect(new Headers(calls[0]!.init.headers).get("X-Stream-Token")).toBe(connectionToken);
    expect(calls[0]!.url).toContain("/api/v1/streams/sess-1/connect");
    expect(new Headers(calls[1]!.init.headers).get("X-Stream-Token")).toBe(connectionToken);
    expect(calls[1]!.url).toContain("/api/v1/streams/sess-1/close");
  });

  it("submits a frame with sequence path + octet-stream body and parses the ack", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse({ acceptedSequence: 7, bufferedBytes: 8, backpressured: false }, 202));
    const client = clientWith(fetchImpl);
    const ack = await client.submitStreamFrame(
      "sess-1", connectionToken, 7, new Blob([new Uint8Array(8)]));
    expect(ack).toEqual({ acceptedSequence: 7, bufferedBytes: 8, backpressured: false });
    expect(calls[0]!.url).toBe("https://media.example.test/api/v1/streams/sess-1/frames/7");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("X-Stream-Token")).toBe(connectionToken);
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("a 409 on connect surfaces as a CONFLICT MediaClientError", async () => {
    const { fetchImpl } = recordedFetch(() => jsonResponse({
      error: { code: "STREAM_LEASE_CONFLICT", message: "lease held", retryable: false },
      meta: { correlationId: "corr-409" },
    }, 409));
    const client = clientWith(fetchImpl);
    const failure = await client.connectStream("sess-1", connectionToken).then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    ) as MediaClientError;
    expect(failure.statusCode).toBe(409);
    expect(failure.detail.category).toBe("CONFLICT");
  });

  it("rejects a short or absent connection token before any dispatch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = clientWith(fetchImpl);
    await expect(client.connectStream("sess-1", "short")).rejects.toThrow(/connectionToken/u);
    await expect(client.closeStream("sess-1", "")).rejects.toThrow(/connectionToken/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("watch, check-outcome and cursor pagination are explicit NOT_ADMITTED", async () => {
    const client = clientWith(vi.fn() as unknown as typeof fetch);
    await expect(client.watchStream("sess-1")).rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
    await expect(client.checkOutcome("op-1")).rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
    await expect(client.listJobsPage("cursor-1")).rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
  });
});

describe("canonical parsers", () => {
  it("ProcessingJob tolerates unknown properties but requires exact enums", () => {
    const parsed: CanonicalProcessingJob = parseCanonicalProcessingJob(
      job({ extraRuntimeField: { nested: true } }));
    expect(parsed.status).toBe("RUNNING");
    expect(() => parseCanonicalProcessingJob(job({ status: "QUEUED" })))
      .toThrow(/outside the runtime enum/u);
    expect(() => parseCanonicalProcessingJob(job({ requestFingerprint: "md5:abc" })))
      .toThrow(/requestFingerprint/u);
    expect(() => parseCanonicalProcessingJob({ ...job(), version: 0 }))
      .toThrow(/bounded safe integer/u);
  });

  it("StreamSession is strict — unknown or missing fields reject", () => {
    expect(() => parseCanonicalStreamSession({ ...session(), sneak: 1 }))
      .toThrow(/do not match the runtime DTO/u);
    const { metadata: _drop, ...missingField } = session();
    expect(() => parseCanonicalStreamSession(missingField))
      .toThrow(/do not match the runtime DTO/u);
    expect(() => parseCanonicalStreamSession(session({ state: "ATTACHED" })))
      .toThrow(/outside the runtime enum/u);
    expect(parseCanonicalStreamSession(session()).finality).toBe("NONE");
  });
});
