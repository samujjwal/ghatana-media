import { describe, expect, it, vi } from "vitest";
import {
  MediaClientError,
  createMediaOperationClient,
} from "./operations";

const timestamp = "2026-08-05T12:00:00.000Z";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function queuedJob() {
  return {
    id: "job-1",
    tenantId: "tenant-1",
    kind: "TRANSCRIBE",
    state: "QUEUED",
    progress: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    correlationId: "correlation-1",
    inputArtifactIds: ["artifact-1"],
    outputArtifactIds: [],
    cancellable: true,
    retryable: true,
  } as const;
}

function completedJob() {
  return {
    ...queuedJob(),
    state: "COMPLETED",
    progress: 100,
    completedAt: timestamp,
    cancellable: false,
    retryable: false,
  } as const;
}

function cancelledJob() {
  return {
    ...queuedJob(),
    state: "CANCELLED",
    progress: 10,
    completedAt: timestamp,
    cancellable: false,
    retryable: true,
  } as const;
}

describe("MediaOperationClient", () => {
  it("submits with tenant and idempotency identity, reports progress, and returns a validated result", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/api/v1/media/transcriptions")) {
          return jsonResponse({
            operationId: "operation-1",
            job: queuedJob(),
            statusUrl: "/api/v1/media/operations/operation-1",
            cancelUrl: "/api/v1/media/operations/operation-1:cancel",
            correlationId: "correlation-1",
          }, 202);
        }
        if (url.endsWith("/api/v1/media/operations/operation-1")) {
          return jsonResponse(completedJob());
        }
        if (url.endsWith("/api/v1/media/operations/operation-1/result")) {
          return jsonResponse({
            artifactId: "artifact-1",
            transcriptArtifactId: "transcript-1",
            text: "Hello world",
            languageTag: "en-US",
            confidence: 0.98,
            words: [],
            alternatives: [],
            providerId: "provider-1",
            modelId: "model-1",
            modelVersion: "1.0.0",
            processingTimeMs: 250,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    ) as unknown as typeof fetch;

    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test/",
      tenantId: "tenant-1",
      getAccessToken: () => "token-1",
      fetchImpl,
      pollIntervalMs: 1,
      defaultHeaders: { "X-Request-ID": "caller-controlled-request" },
      requestContext: {
        correlationId: "correlation-parent",
        causationId: "cause-7",
        parentRunId: "run-9",
        principalDelegation: "delegation-token",
      },
    });
    const progress: string[] = [];
    const handle = await client.transcribe({
      artifactId: "artifact-1",
      languageTag: "en-US",
      punctuation: true,
      wordTimestamps: true,
      alternatives: 1,
      profanityPolicy: "PRESERVE",
      idempotencyKey: "idem-1",
    });
    const result = await handle.wait({
      pollIntervalMs: 1,
      onProgress: (job) => progress.push(job.state),
    });

    expect(result.text).toBe("Hello world");
    expect(progress).toEqual(["QUEUED", "COMPLETED"]);
    const submission = calls[0];
    expect(submission?.url).toBe(
      "https://media.example.test/api/v1/media/transcriptions",
    );
    const headers = new Headers(submission?.init?.headers);
    expect(headers.get("X-Tenant-ID")).toBe("tenant-1");
    expect(headers.get("Idempotency-Key")).toBe("idem-1");
    expect(headers.get("Authorization")).toBe("Bearer token-1");
    expect(headers.get("X-Request-ID")).toBeTruthy();
    expect(headers.get("X-Request-ID")).not.toBe("caller-controlled-request");
    expect(headers.get("X-Correlation-ID")).toBe("correlation-parent");
    expect(headers.get("X-Causation-ID")).toBe("cause-7");
    expect(headers.get("X-Parent-Run-ID")).toBe("run-9");
    expect(headers.get("X-Ghatana-Delegation")).toBe("delegation-token");
  });

  it("rejects malformed cross-service identity before sending", () => {
    expect(() => createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      requestContext: { correlationId: "correlation\nspoof" },
    })).toThrow(/correlationId/u);
  });

  it("cancels through the canonical operation endpoint", async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/api/v1/media/transcriptions")) {
          return jsonResponse({
            operationId: "operation-1",
            job: queuedJob(),
            statusUrl: "/api/v1/media/operations/operation-1",
            cancelUrl: "/api/v1/media/operations/operation-1:cancel",
            correlationId: "correlation-1",
          }, 202);
        }
        if (url.endsWith("/api/v1/media/operations/operation-1:cancel")) {
          return jsonResponse(cancelledJob(), 202);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    ) as unknown as typeof fetch;

    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      fetchImpl,
    });
    const handle = await client.transcribe({
      artifactId: "artifact-1",
      idempotencyKey: "idem-1",
      punctuation: true,
      wordTimestamps: true,
      alternatives: 1,
      profanityPolicy: "PRESERVE",
    });

    await expect(handle.cancel()).resolves.toMatchObject({ state: "CANCELLED" });
  });

  it.each(["OUTCOME_UNKNOWN", "RECONCILING"] as const)(
    "keeps %s nonterminal and never fetches a result while finality is unresolved",
    async (state) => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/v1/media/transcriptions")) {
          return jsonResponse({
            operationId: "operation-1",
            job: queuedJob(),
            statusUrl: "/api/v1/media/operations/operation-1",
            cancelUrl: "/api/v1/media/operations/operation-1:cancel",
            correlationId: "correlation-1",
          }, 202);
        }
        if (url.endsWith("/api/v1/media/operations/operation-1")) {
          return jsonResponse({
            ...queuedJob(),
            state,
            ...(state === "OUTCOME_UNKNOWN"
              ? { outcomeUnknownSince: timestamp }
              : { reconciliationStartedAt: timestamp }),
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as unknown as typeof fetch;

      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test",
        tenantId: "tenant-1",
        fetchImpl,
        pollIntervalMs: 1,
      });
      const handle = await client.transcribe({
        artifactId: "artifact-1",
        idempotencyKey: "idem-1",
        punctuation: true,
        wordTimestamps: true,
        alternatives: 1,
        profanityPolicy: "PRESERVE",
      });
      const progress: string[] = [];

      await expect(handle.wait({
        timeoutMs: 15,
        pollIntervalMs: 1,
        onProgress: (job) => progress.push(job.state),
      })).rejects.toMatchObject({ name: "TimeoutError" });

      expect(progress).toContain(state);
      expect(calls.some((url) => url.endsWith("/result"))).toBe(false);
    },
  );

  it("preserves canonical retry guidance and correlation identity on errors", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse(
        {
          code: "RATE_LIMITED",
          message: "Media capacity is temporarily exhausted.",
          correlationId: "correlation-429",
          retryable: true,
          category: "RATE_LIMIT",
          retryAfterMs: 2_000,
          remediation: "Retry after the stated delay.",
        },
        429,
      ),
    ) as unknown as typeof fetch;

    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      fetchImpl,
    });

    await expect(
      client.getArtifact("artifact-1"),
    ).rejects.toMatchObject({
      name: "MediaClientError",
      detail: expect.objectContaining({
        code: "RATE_LIMITED",
        correlationId: "correlation-429",
        retryable: true,
        retryAfterMs: 2_000,
      }),
    });
  });
});
