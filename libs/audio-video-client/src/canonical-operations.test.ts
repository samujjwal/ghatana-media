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
    expect(call.init.redirect).toBe("error");
    const body = JSON.parse(String(call.init.body));
    expect(body.tenantId).toBe("tenant-1");
    expect(body.principalId).toBe("principal-1");
  });

  it("serializes caller-owned mutation data before asynchronous credential lookup", async () => {
    let releaseToken!: (value: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(job(), 202));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => token,
      fetchImpl,
    });
    const parameters = { languageTag: "en-US" };
    const pending = client.submitJob({
      requestId: "req-snapshot", correlationId: "corr-snapshot", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", parameters, idempotencyKey: "idem-snapshot",
    });
    parameters.languageTag = "hi-IN";
    releaseToken("configured-token");

    await pending;
    expect(JSON.parse(String(calls[0]?.init.body)).parameters).toEqual({ languageTag: "en-US" });
  });

  it("keeps a dispatched submit with a cross-scope acknowledgement OUTCOME_UNKNOWN", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(job({ tenantId: "tenant-2" }), 202));
    const client = clientWith(fetchImpl);
    const failure = await client.submitJob({
      requestId: "req-1", correlationId: "corr-1", artifactId: "art-1",
      jobType: "TRANSCODE", idempotencyKey: "idem-cross-scope",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toMatchObject({ path: "/api/v1/jobs", requestKey: "idem-cross-scope" });
    expect(calls).toHaveLength(1);
  });

  it("preserves the server conflict for a changed payload reused with the same idempotency key", async () => {
    const calls: { init: RequestInit }[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ init: init ?? {} });
      if (calls.length === 1) return jsonResponse(job(), 202);
      return jsonResponse({
        error: { code: "IDEMPOTENCY_CONFLICT", message: "Request payload differs", retryable: false },
        meta: { correlationId: "corr-idempotency-conflict" },
      }, 409);
    }) as typeof fetch;
    const client = clientWith(fetchImpl);

    await client.submitJob({
      requestId: "req-1", correlationId: "corr-1", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", parameters: { languageTag: "en-US" }, idempotencyKey: "stable-key",
    });
    const failure = await client.submitJob({
      requestId: "req-1", correlationId: "corr-1", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", parameters: { languageTag: "hi-IN" }, idempotencyKey: "stable-key",
    }).then(
      () => { throw new Error("changed payload must be rejected by the server idempotency contract"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MediaClientError);
    expect((failure as MediaClientError).statusCode).toBe(409);
    expect((failure as MediaClientError).detail.category).toBe("CONFLICT");
    expect((failure as MediaClientError).detail.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get("Idempotency-Key")).toBe("stable-key");
    expect(new Headers(calls[1]!.init.headers).get("Idempotency-Key")).toBe("stable-key");
    expect(calls[0]!.init.body).not.toBe(calls[1]!.init.body);
  });

  it("rejects a job response outside the caller tenant/principal scope", async () => {
    const { fetchImpl } = recordedFetch(() =>
      jsonResponse(job({ tenantId: "tenant-2" }), 200));
    const client = clientWith(fetchImpl);
    await expect(client.getJob("job-1")).rejects.toThrow(/outside the caller's tenant and principal scope/u);
  });

  it("rejects a getJob response whose identity differs from the request", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(job({ jobId: "job-2" })));
    const client = clientWith(fetchImpl);
    await expect(client.getJob("job-1")).rejects.toThrow(/identity does not match/u);
    expect(calls[0]?.init.redirect).toBe("error");
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

  it("maps a lost post-dispatch response to OUTCOME_UNKNOWN", async () => {
    const fetchImpl = (async () => { throw new TypeError("connection lost"); }) as typeof fetch;
    const client = clientWith(fetchImpl);
    const failure = await client.submitJob({
      requestId: "req-lost", correlationId: "corr-lost", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", idempotencyKey: "idem-lost",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/jobs");
  });

  it("bounds a stalled acknowledgement body and preserves OUTCOME_UNKNOWN", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 202,
      json: () => new Promise<never>(() => undefined),
    }) as unknown as Response) as typeof fetch;
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => "bearer-secret",
      requestTimeoutMs: 10,
      fetchImpl,
    });

    const failure = await client.submitJob({
      requestId: "req-body-timeout", correlationId: "corr-body-timeout", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", idempotencyKey: "idem-body-timeout",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toMatchObject({ path: "/api/v1/jobs", requestKey: "idem-body-timeout" });
  });

  it("maps a retryable 503 envelope after mutation dispatch to OUTCOME_UNKNOWN", async () => {
    const { fetchImpl } = recordedFetch(() => jsonResponse({
      error: { code: "TEMPORARY_FAILURE", message: "try later", retryable: true },
      meta: { correlationId: "corr-503" },
    }, 503));
    const client = clientWith(fetchImpl);
    const failure = await client.submitJob({
      requestId: "req-503", correlationId: "corr-503", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", idempotencyKey: "idem-503",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).cause).toBeInstanceOf(MediaClientError);
    expect((failure as MediaOperationAmbiguousError).requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect((failure as MediaOperationAmbiguousError).requestKey).toBe("idem-503");
  });

  it.each([408, 409, 422])(
    "maps non-definitive HTTP %i after job dispatch to OUTCOME_UNKNOWN",
    async (status) => {
      const { fetchImpl, calls } = recordedFetch(() => jsonResponse({
        error: { code: `HTTP_${status}_UNKNOWN`, message: "response does not prove no effect", retryable: false },
        meta: { correlationId: `corr-${status}` },
      }, status));
      const client = clientWith(fetchImpl);
      const failure = await client.submitJob({
        requestId: `req-${status}`, correlationId: `corr-${status}`, artifactId: "art-1",
        jobType: "SPEECH_TO_TEXT", idempotencyKey: `idem-${status}`,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
      expect((failure as MediaOperationAmbiguousError).requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect((failure as MediaOperationAmbiguousError).requestKey).toBe(`idem-${status}`);
      expect(calls).toHaveLength(1);
    },
  );

  it("preserves a proven pre-dispatch abort as no-effect", async () => {
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(job(), 202));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => token,
      fetchImpl,
    });
    const controller = new AbortController();
    const pending = client.submitJob({
      requestId: "req-pre-abort", correlationId: "corr-pre-abort", artifactId: "art-1",
      jobType: "SPEECH_TO_TEXT", idempotencyKey: "idem-pre-abort",
    }, controller.signal);

    controller.abort(new DOMException("cancelled before dispatch", "AbortError"));
    releaseToken("token");
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure).not.toBeInstanceOf(MediaOperationAmbiguousError);
    expect(calls).toHaveLength(0);
  });

  it("cancelJob round-trips and never retries after a dispatch abort", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse(job({ status: "CANCELLED" }), 200));
    const client = clientWith(fetchImpl);
    const cancelled = await client.cancelJob("job-1");
    expect(cancelled.status).toBe("CANCELLED");
    expect(calls[0]!.url).toBe("https://media.example.test/api/v1/jobs/job-1/cancel");
  });

  it("keeps a dispatched cancel with a mismatched job acknowledgement OUTCOME_UNKNOWN", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse(job({ jobId: "job-2", status: "CANCELLED" }), 200));
    const client = clientWith(fetchImpl);
    const failure = await client.cancelJob("job-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toMatchObject({ path: "/api/v1/jobs/job-1/cancel" });
    expect(calls).toHaveLength(1);
  });

  it("reports a post-dispatch cancel abort as OUTCOME_UNKNOWN without retry", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = recordedFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    }));
    const client = clientWith(fetchImpl);
    const pending = client.cancelJob("job-1", controller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    const failure = await pending.then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/jobs/job-1/cancel");
    expect(calls).toHaveLength(1);
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

  it("does not invent a route for the seven-dimension status read", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse({}));
    const client = clientWith(fetchImpl);
    await expect(client.readJobStatusDimensions("job-1"))
      .rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
    expect(calls).toHaveLength(0);
  });

  it("rejects principal-only scope before dispatch", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(job()));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });
    await expect(client.getJob("job-1")).rejects.toThrow(/authentication is required/u);
    expect(calls).toHaveLength(0);
  });

  it("accepts the OpenAPI API-key credential configured in default headers", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse(job()));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1", "X-API-Key": "configured-api-key" },
      fetchImpl,
    });
    await expect(client.getJob("job-1")).resolves.toMatchObject({ jobId: "job-1" });
    expect(new Headers(calls[0]!.init.headers).get("X-API-Key")).toBe("configured-api-key");
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

  it("keeps a dispatched open with a cross-scope session OUTCOME_UNKNOWN", async () => {
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse({
      session: session({ tenantId: "tenant-2" }), connectionToken,
    }, 201));
    const client = clientWith(fetchImpl);
    const failure = await client.openStream({
      correlationId: "corr-1", streamKind: "AUDIO", maximumBufferedBytes: 1_048_576,
      leaseDuration: "PT30S", idempotencyKey: "idem-open-cross-scope",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toMatchObject({ path: "/api/v1/streams", requestKey: "idem-open-cross-scope" });
    expect(calls).toHaveLength(1);
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

  it("keeps a dispatched connect with a cross-tenant session acknowledgement OUTCOME_UNKNOWN", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse(session({ tenantId: "tenant-2", state: "CONNECTED" })));
    const client = clientWith(fetchImpl);
    const failure = await client.connectStream("sess-1", connectionToken).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toMatchObject({ path: "/api/v1/streams/sess-1/connect" });
    expect(calls).toHaveLength(1);
  });

  it("keeps a dispatched close with a mismatched session acknowledgement OUTCOME_UNKNOWN", async () => {
    const { fetchImpl, calls } = recordedFetch(() =>
      jsonResponse(session({ sessionId: "sess-2", state: "CLOSED", closedAt: timestamp })));
    const client = clientWith(fetchImpl);
    const failure = await client.closeStream("sess-1", connectionToken).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toMatchObject({ path: "/api/v1/streams/sess-1/close" });
    expect(calls).toHaveLength(1);
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

  it("keeps caller abort linked while reading a dispatched frame acknowledgement", async () => {
    let responseReady!: () => void;
    const ready = new Promise<void>((resolve) => { responseReady = resolve; });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const requestSignal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener("abort", () => {
            controller.error(requestSignal.reason ?? new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      });
      responseReady();
      return new Response(body, { status: 202, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = clientWith(fetchImpl);
    const controller = new AbortController();
    const pending = client.submitStreamFrame(
      "sess-1", connectionToken, 0, new Blob(["f"]), { signal: controller.signal });
    await ready;
    controller.abort(new DOMException("caller stopped waiting", "AbortError"));

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toMatchObject({ path: "/api/v1/streams/sess-1/frames/0" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps frame credential setup under abort control and avoids dispatch after abort", async () => {
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const { fetchImpl, calls } = recordedFetch(() => jsonResponse({
      acceptedSequence: 0, bufferedBytes: 1, backpressured: false,
    }, 202));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => token, fetchImpl,
    });
    const controller = new AbortController();
    const pending = client.submitStreamFrame(
      "sess-1", connectionToken, 0, new Blob(["f"]), { signal: controller.signal });
    controller.abort(new DOMException("cancelled before dispatch", "AbortError"));
    releaseToken("token");
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure).not.toBeInstanceOf(MediaOperationAmbiguousError);
    expect(calls).toHaveLength(0);
  });

  it("times out frame credential setup before dispatch", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const client = createMediaCanonicalClient({
        baseUrl: "https://media.example.test", tenantId: "tenant-1",
        defaultHeaders: { "X-Principal-Id": "principal-1" },
        getAccessToken: () => new Promise<string>(() => undefined), fetchImpl,
        requestTimeoutMs: 5,
      });
      const pending = client.submitStreamFrame("sess-1", connectionToken, 0, new Blob(["f"]));
      const failurePromise = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(6);
      const failure = await failurePromise;
      expect(failure).toBeInstanceOf(DOMException);
      expect((failure as DOMException).name).toBe("TimeoutError");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([429, 503])("maps retryable frame HTTP %s to OUTCOME_UNKNOWN", async (status) => {
    const { fetchImpl } = recordedFetch(() => jsonResponse({
      error: { code: "TEMPORARY_FAILURE", message: "try later", retryable: true },
      meta: { correlationId: `corr-${status}` },
    }, status));
    const client = clientWith(fetchImpl);
    const failure = await client.submitStreamFrame(
      "sess-1", connectionToken, 0, new Blob(["f"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).cause).toBeInstanceOf(MediaClientError);
  });

  it("rejects frame mutation redirects without following or replaying the frame", async () => {
    const { fetchImpl, calls } = recordedFetch((_url, init) => {
      expect(init.redirect).toBe("error");
      throw new TypeError("redirect mode error");
    });
    const client = clientWith(fetchImpl);
    const failure = await client.submitStreamFrame(
      "sess-1", connectionToken, 0, new Blob(["f"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(calls).toHaveLength(1);
  });

  it.each([
    new Response("", { status: 202 }),
    jsonResponse({ acceptedSequence: "invalid", bufferedBytes: 1, backpressured: false }, 202),
  ])("maps malformed frame acknowledgement to OUTCOME_UNKNOWN", async (response) => {
    const { fetchImpl } = recordedFetch(() => response);
    const client = clientWith(fetchImpl);
    const failure = await client.submitStreamFrame(
      "sess-1", connectionToken, 0, new Blob(["f"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
  });

  it("preserves a definitive frame 403 response", async () => {
    const { fetchImpl } = recordedFetch(() => jsonResponse({
      error: { code: "STREAM_REVOKED", message: "purpose revoked", retryable: false },
      meta: { correlationId: "corr-403" },
    }, 403));
    const client = clientWith(fetchImpl);
    const failure = await client.submitStreamFrame(
      "sess-1", connectionToken, 0, new Blob(["f"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaClientError);
    expect((failure as MediaClientError).statusCode).toBe(403);
    expect((failure as MediaClientError).detail.retryable).toBe(false);
  });

  it("a generic 409 on connect is OUTCOME_UNKNOWN after dispatch", async () => {
    const { fetchImpl } = recordedFetch(() => jsonResponse({
      error: { code: "STREAM_LEASE_CONFLICT", message: "lease held", retryable: false },
      meta: { correlationId: "corr-409" },
    }, 409));
    const client = clientWith(fetchImpl);
    const failure = await client.connectStream("sess-1", connectionToken).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/streams/sess-1/connect");
    expect((failure as MediaOperationAmbiguousError).requestId).toMatch(/^[0-9a-f-]{36}$/u);
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

  it("ProcessingJob validates RFC 3339 instants without normalizing invalid dates", () => {
    const validOffset = "2024-02-29T23:59:59.123456789+05:30";
    const parsed = parseCanonicalProcessingJob(job({ createdAt: validOffset, startedAt: null }));
    expect(parsed.createdAt).toBe(validOffset);
    expect(parsed.startedAt).toBeNull();
    expect(parseCanonicalProcessingJob(job({
      createdAt: "2024-02-29t23:59:59.123456789z",
    })).createdAt).toBe("2024-02-29t23:59:59.123456789z");
    const highPrecisionFraction = "2024-02-29T23:59:59.12345678901234567890Z";
    expect(parseCanonicalProcessingJob(job({ createdAt: highPrecisionFraction })).createdAt)
      .toBe(highPrecisionFraction);
    expect(parseCanonicalProcessingJob(job({
      createdAt: "2016-12-31T23:59:60Z",
    })).createdAt).toBe("2016-12-31T23:59:60Z");
    expect(parseCanonicalProcessingJob(job({
      createdAt: "2017-01-01T00:59:60+01:00",
    })).createdAt).toBe("2017-01-01T00:59:60+01:00");
    for (const invalid of [
      "2026-02-30T12:00:00Z",
      "2026-13-01T12:00:00Z",
      "2026-01-01T25:00:00Z",
      "2026-10-30T12:00:60Z",
      "2016-12-31T22:59:60Z",
      "2026-01-01T12:00:00.Z",
      "not-a-date",
      "2026-01-01T12:00:00",
    ]) {
      expect(() => parseCanonicalProcessingJob(job({ createdAt: invalid })))
        .toThrow(/RFC 3339 date-time/u);
    }
    expect(() => parseCanonicalProcessingJob(job({ completedAt: "2026-04-31T12:00:00Z" })))
      .toThrow(/RFC 3339 date-time/u);
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
