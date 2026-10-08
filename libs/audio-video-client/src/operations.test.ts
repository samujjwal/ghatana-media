import { describe, expect, it, vi } from "vitest";
import {
  MediaClientError,
  MediaOperationNotAdmittedError,
  createMediaOperationClient,
  type CanonicalMediaUploadSessionObservation,
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

function canonicalArtifact(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-1",
    principalId: "principal-1",
    artifactId: "artifact-1",
    fileName: "source.wav",
    contentType: "audio/wav",
    sizeBytes: 16,
    sha256: "a".repeat(64),
    objectReference: "opaque-object-reference",
    classification: "INTERNAL",
    createdAt: timestamp,
    expiresAt: "2026-09-05T12:00:00.000Z",
    metadata: { purpose: "transcription" },
    ...overrides,
  } as const;
}

function uploadSession(overrides: Record<string, unknown> = {}): CanonicalMediaUploadSessionObservation {
  return {
    uploadId: "upload-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    fileName: "source.wav",
    contentType: "audio/wav",
    expectedSizeBytes: 3,
    expectedSha256: "a".repeat(64),
    classification: "INTERNAL",
    createdAt: timestamp,
    expiresAt: "2026-09-05T12:00:00.000Z",
    bytesReceived: 0,
    nextChunkIndex: 0,
    status: "OPEN",
    metadata: {},
    ...overrides,
  } as unknown as CanonicalMediaUploadSessionObservation;
}

describe("MediaOperationClient", () => {
  it("creates upload sessions with exact runtime fields and caller scope", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured = { url: String(input), init };
      return jsonResponse(uploadSession({ metadata: { purpose: "test", outer: { first: 1, second: 2 } } }));
    }) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });
    await expect(client.createUploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "A".repeat(64), classification: "INTERNAL", retention: "PT24H",
      metadata: { outer: { second: 2, first: 1 }, purpose: "test" }, idempotencyKey: "upload-request-1",
    })).resolves.toMatchObject({ uploadId: "upload-1", nextChunkIndex: 0 });
    expect(captured?.url).toBe("https://media.example.test/api/v1/artifacts/uploads");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("X-Tenant-ID")).toBe("tenant-1");
    expect(headers.get("X-Principal-Id")).toBe("principal-1");
    expect(headers.get("Idempotency-Key")).toBe("upload-request-1");
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      tenantId: "tenant-1", principalId: "principal-1", fileName: "source.wav", contentType: "audio/wav",
      expectedSizeBytes: 3, expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H",
      metadata: { purpose: "test", outer: { first: 1, second: 2 } },
    });
  });

  it("rejects legacy upload aliases, missing principal, and invalid canonical request before network", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
    const noPrincipal = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl });
    const request = { fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL" as const, retention: "PT24H", idempotencyKey: "key" };
    await expect(noPrincipal.createUploadSession(request)).rejects.toThrow(/X-Principal-Id/u);
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.createUploadSession({ ...request, mimeType: "audio/wav" } as never)).rejects.toThrow(/outside the canonical/u);
    await expect(client.createUploadSession({ ...request, expectedSizeBytes: 0 })).rejects.toThrow(/expectedSizeBytes/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects filenames that runtime stores would trim, path-normalize, or rewrite before upload dispatch", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const request = { fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL" as const, retention: "PT24H", idempotencyKey: "key" };
    for (const fileName of [" source.wav", "source.wav ", "folder/source.wav", "folder\\source.wav", ".", "..", "source\n.wav", "source\u0000.wav"]) {
      await expect(client.createUploadSession({ ...request, fileName })).rejects.toThrow(/fileName.*canonical/u);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects content-type whitespace normalization and unsupported classifications before upload dispatch", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const request = { fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL" as const, retention: "PT24H", idempotencyKey: "key" };
    for (const contentType of [" audio/wav", "audio/wav ", "audio/\twav"]) {
      await expect(client.createUploadSession({ ...request, contentType })).rejects.toThrow(/contentType.*canonical/u);
    }
    for (const classification of [" INTERNAL", "INTERNAL ", "internal", "RESTRICTED\n", "SECRET"]) {
      await expect(client.createUploadSession({ ...request, classification: classification as never })).rejects.toThrow(/classification must be one of/u);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const)(
    "accepts the exact runtime classification %s without rewriting it",
    async (classification) => {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        jsonResponse(uploadSession({ classification }))) as unknown as typeof fetch;
      const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        defaultHeaders: { "X-Principal-Id": "principal-1" } });
      await expect(client.createUploadSession({
        fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
        expectedSha256: "a".repeat(64), classification, retention: "PT24H", idempotencyKey: "key",
      })).resolves.toMatchObject({ classification });
      expect(JSON.parse(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)).classification)
        .toBe(classification);
    },
  );

  it("rejects a create receipt bound to a different submitted payload", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({ expectedSha256: "b".repeat(64) }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.createUploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H", idempotencyKey: "key",
    })).rejects.toThrow(/does not bind the submitted immutable/u);
  });

  it("rejects a create response with a classification outside the canonical enum", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({ classification: "SECRET" }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.createUploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H", idempotencyKey: "key",
    })).rejects.toThrow(/classification is outside the runtime enum/u);
  });

  it("snapshots upload metadata before asynchronous token acquisition", async () => {
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    let sentBody = "";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      sentBody = String(init?.body);
      return jsonResponse(uploadSession({ metadata: { nested: { value: "before" } } }));
    }) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      getAccessToken: () => token, defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const metadata = { nested: { value: "before" } };
    const pending = client.createUploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H", metadata, idempotencyKey: "key",
    });
    metadata.nested.value = "after";
    releaseToken("token-1");
    await expect(pending).resolves.toMatchObject({ metadata: { nested: { value: "before" } } });
    expect(JSON.parse(sentBody).metadata).toEqual({ nested: { value: "before" } });
  });

  it("appends only the next zero-based chunk and returns the canonical session", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured = { url: String(input), init };
      return jsonResponse(uploadSession({ bytesReceived: 3, nextChunkIndex: 1 }));
    }) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const next = await client.uploadPart(uploadSession(), 0, new Blob(["abc"]));
    expect(next.nextChunkIndex).toBe(1);
    expect(captured?.url).toBe("https://media.example.test/api/v1/artifacts/uploads/upload-1/chunks/0");
    expect(captured?.init?.method).toBe("PUT");
    expect(captured?.init?.body).toBeInstanceOf(Blob);
    await expect(client.uploadPart(uploadSession(), 1, new Blob(["x"]))).rejects.toThrow(/next zero-based/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an append response with a classification outside the canonical enum", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({
      classification: "SECRET", bytesReceived: 1, nextChunkIndex: 1,
    }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.uploadPart(uploadSession(), 0, new Blob(["x"])))
      .rejects.toThrow(/classification is outside the runtime enum/u);
  });

  it("reads the exact upload-session DTO from the tenant- and principal-scoped canonical route", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });

    await expect(client.getUploadSession("upload-1")).resolves.toEqual(uploadSession());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://media.example.test/api/v1/artifacts/uploads/upload-1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("X-Tenant-ID")).toBe("tenant-1");
    expect(headers.get("X-Principal-Id")).toBe("principal-1");
    expect(headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("keeps upload-read principal scope immutable across caller header mutation", async () => {
    const originalHeaders = { "X-Principal-Id": "principal-1" };
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", defaultHeaders: originalHeaders, fetchImpl,
    });
    originalHeaders["X-Principal-Id"] = "principal-2";

    await expect(client.getUploadSession("upload-1")).resolves.toEqual(uploadSession());
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("X-Principal-Id")).toBe("principal-1");
  });

  it("preserves the scoped upload 404 code, status, and correlation without inferring global absence", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      error: { code: "UPLOAD_NOT_FOUND", message: "Upload session not found", retryable: false, evidenceRefs: [], actionRefs: [] },
      meta: { requestId: "request-upload-404", correlationId: "correlation-upload-404", timestamp, apiVersion: "1.0.0" },
    }, 404)) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });

    await expect(client.getUploadSession("upload-1")).rejects.toMatchObject({
      name: "MediaClientError",
      statusCode: 404,
      detail: expect.objectContaining({ code: "UPLOAD_NOT_FOUND", correlationId: "correlation-upload-404", retryable: false }),
    });
  });

  it("rejects upload reads without a valid principal before transport", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
    const noPrincipal = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl });
    await expect(noPrincipal.getUploadSession("upload-1")).rejects.toThrow("X-Principal-Id");
    const invalidPrincipal = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal with spaces" },
    });
    await expect(invalidPrincipal.getUploadSession("upload-1")).rejects.toThrow("Invalid media client request identity field: principalId");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "upload with spaces", "upload\n1", "é", "a".repeat(256), ".", "..", "a/b", "a\\b"])(
    "rejects unsafe upload ID %j before transport",
    async (uploadId) => {
      const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        defaultHeaders: { "X-Principal-Id": "principal-1" },
      });
      await expect(client.getUploadSession(uploadId)).rejects.toThrow(/upload(?:Id| ID)/u);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a different tenant", { tenantId: "tenant-2" }],
    ["a different principal", { principalId: "principal-2" }],
  ])("rejects upload observations outside %s scope", async (_caseName, scopeOverride) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({ ...uploadSession(), ...scopeOverride })) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });
    await expect(client.getUploadSession("upload-1")).rejects.toThrow("outside the caller's tenant and principal scope");
  });

  it("rejects an upload observation whose identity differs from the requested path", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({ uploadId: "different-upload" }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });
    await expect(client.getUploadSession("upload-1")).rejects.toThrow("identity does not match the requested upload");
  });

  it.each([
    ["an unsupported status", { status: "RETRYABLE" }],
    ["an unsupported classification", { classification: "SECRET" }],
    ["an invented response alias", { id: "upload-1" }],
    ["an invalid expiry timestamp", { expiresAt: "not-a-date" }],
    ["a nonexistent February day", { expiresAt: "2026-02-30T12:00:00Z" }],
    ["a nonexistent April day", { expiresAt: "2026-04-31T12:00:00Z" }],
    ["an hour rollover", { expiresAt: "2026-08-06T24:00:00Z" }],
    ["a minute rollover", { expiresAt: "2026-08-06T12:60:00Z" }],
    ["a fraction longer than Java Instant precision", { expiresAt: "2026-08-06T12:00:00.1234567890Z" }],
    ["an unsafe size", { expectedSizeBytes: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects upload observations with %s", async (_caseName, override) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({ ...uploadSession(), ...override })) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });
    await expect(client.getUploadSession("upload-1")).rejects.toThrow(TypeError);
  });

  it("preserves valid leap-day UTC instants at nanosecond precision", async () => {
    const createdAt = "2024-02-29T12:00:00.123456789Z";
    const expiresAt = "2024-02-29T12:00:00.123456790Z";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      String(input).endsWith("/api/v1/artifacts/uploads/upload-1")
        ? jsonResponse(uploadSession({ createdAt, expiresAt }))
        : jsonResponse(canonicalArtifact({ createdAt, expiresAt }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });

    await expect(client.getUploadSession("upload-1")).resolves.toMatchObject({ createdAt, expiresAt });
    await expect(client.getArtifact("artifact-1")).resolves.toMatchObject({ createdAt, expiresAt });
  });

  it("returns observed terminal status without inferring finality or mutation permission", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({
      bytesReceived: 3, nextChunkIndex: 1, status: "COMPLETED",
    }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });
    await expect(client.getUploadSession("upload-1")).resolves.toMatchObject({ status: "COMPLETED", bytesReceived: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects chunk receipts that mutate immutable upload fields or leave OPEN", async () => {
    for (const mutated of [
      uploadSession({ bytesReceived: 3, nextChunkIndex: 1, expectedSha256: "b".repeat(64) }),
      uploadSession({ bytesReceived: 3, nextChunkIndex: 1, status: "COMPLETED" }),
    ]) {
      const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(mutated)) as unknown as typeof fetch;
      const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        defaultHeaders: { "X-Principal-Id": "principal-1" } });
      await expect(client.uploadPart(uploadSession(), 0, new Blob(["abc"]))).rejects.toThrow(/unchanged session/u);
    }
  });

  it("does not replay a chunk after an ambiguous lost acknowledgement", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => { throw new TypeError("connection lost after send"); }) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.uploadPart(uploadSession(), 0, new Blob(["abc"]))).rejects.toThrow("connection lost after send");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("completes uploads on the canonical route without a body and returns the runtime artifact DTO", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured = { url: String(input), init };
      return jsonResponse(canonicalArtifact({ sizeBytes: 16 }), 201);
    }) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const session = uploadSession({ expectedSizeBytes: 16, bytesReceived: 16, metadata: { purpose: "transcription" } });
    await expect(client.completeUploadSession(session)).resolves.toMatchObject({ artifactId: "artifact-1" });
    expect(captured?.url).toBe("https://media.example.test/api/v1/artifacts/uploads/upload-1/complete");
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.body).toBeUndefined();
  });

  it("rejects a completion artifact whose hash or size differs from the supplied session", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact({ sizeBytes: 3, sha256: "b".repeat(64) }), 201)) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const session = uploadSession({ expectedSizeBytes: 3, bytesReceived: 3, metadata: { purpose: "transcription" } });
    await expect(client.completeUploadSession(session)).rejects.toThrow(/does not bind to the completed upload session/u);
  });

  it("retains ID-only completion compatibility without claiming upload-payload binding", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact(), 201)) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.completeUploadSession("upload-1")).resolves.toMatchObject({ artifactId: "artifact-1" });
  });

  it("fails closed for legacy retry when no server retry contract is admitted", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({}, 200)) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      fetchImpl,
    });

    await expect(client.retryOperation("operation-1", { parse: (value) => value })).rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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

  it("keeps configured principal scope stable when callers mutate the original headers", async () => {
    const originalHeaders = { "X-Principal-Id": "principal-1" };
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact())) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", defaultHeaders: originalHeaders, fetchImpl,
    });
    originalHeaders["X-Principal-Id"] = "principal-2";
    await expect(client.getArtifact("artifact-1")).resolves.toEqual(canonicalArtifact());
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("X-Principal-Id")).toBe("principal-1");
    delete (originalHeaders as Partial<typeof originalHeaders>)["X-Principal-Id"];
    await expect(client.getArtifact("artifact-1")).resolves.toEqual(canonicalArtifact());
  });

  it("reads the canonical artifact DTO through the tenant- and principal-scoped route", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact())) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });

    await expect(client.getArtifact("artifact-1")).resolves.toEqual(canonicalArtifact());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://media.example.test/api/v1/artifacts/artifact-1");
    expect(new Headers(init.headers).get("X-Tenant-ID")).toBe("tenant-1");
    expect(new Headers(init.headers).get("X-Principal-Id")).toBe("principal-1");
  });

  it("preserves the caller-scoped 404 code, status and correlation without inferring global absence", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      error: { code: "ARTIFACT_NOT_FOUND", message: "Media artifact not found", retryable: false, evidenceRefs: [], actionRefs: [] },
      meta: { requestId: "request-404", correlationId: "correlation-404", timestamp, apiVersion: "1.0.0" },
    }, 404)) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });

    await expect(client.getArtifact("artifact-1")).rejects.toMatchObject({
      name: "MediaClientError",
      statusCode: 404,
      detail: expect.objectContaining({ code: "ARTIFACT_NOT_FOUND", correlationId: "correlation-404", retryable: false }),
    });
  });

  it("rejects artifact reads without a caller principal before transport", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact())) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl });

    await expect(client.getArtifact("artifact-1")).rejects.toThrow("X-Principal-Id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid caller principal before transport", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact())) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal with spaces" },
      fetchImpl,
    });

    await expect(client.getArtifact("artifact-1")).rejects.toThrow("Invalid media client request identity field: principalId");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "artifact with spaces", "artifact\n1", "é", "a".repeat(256), ".", "..", "a/b", "a\\b"])(
    "rejects unsafe artifact ID %j before transport",
    async (artifactId) => {
      const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact())) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test",
        tenantId: "tenant-1",
        defaultHeaders: { "X-Principal-Id": "principal-1" },
        fetchImpl,
      });

      await expect(client.getArtifact(artifactId)).rejects.toThrow(/artifact(?:Id| ID)/u);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an unsupported classification", { classification: "BIOMETRIC" }],
    ["an unsafe numeric size", { sizeBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ["an invented field alias", { id: "artifact-1" }],
  ])("rejects artifact responses with %s", async (_caseName, override) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({ ...canonicalArtifact(), ...override })) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });

    await expect(client.getArtifact("artifact-1")).rejects.toThrow(TypeError);
  });

  it.each([
    ["a nonexistent February day", { createdAt: "2026-02-30T12:00:00Z" }],
    ["a nonexistent April day", { expiresAt: "2026-04-31T12:00:00Z" }],
    ["an hour rollover", { createdAt: "2026-08-05T24:00:00Z" }],
    ["a minute rollover", { expiresAt: "2026-08-06T12:60:00Z" }],
    ["a fraction longer than Java Instant precision", { createdAt: "2026-08-05T12:00:00.1234567890Z" }],
  ])("rejects artifact responses with %s", async (_caseName, override) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({ ...canonicalArtifact(), ...override })) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });

    await expect(client.getArtifact("artifact-1")).rejects.toThrow(TypeError);
  });

  it.each([
    ["a different tenant", { tenantId: "tenant-2" }],
    ["a different principal", { principalId: "principal-2" }],
  ])("rejects artifact responses outside %s scope", async (_caseName, scopeOverride) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({ ...canonicalArtifact(), ...scopeOverride })) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });

    await expect(client.getArtifact("artifact-1")).rejects.toThrow("scope does not match the caller");
  });

  it("rejects an artifact response whose identity differs from the requested path identity", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      ...canonicalArtifact(),
      artifactId: "different-artifact",
    })) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });

    await expect(client.getArtifact("artifact-1")).rejects.toThrow("identity does not match the requested artifact");
  });
});
