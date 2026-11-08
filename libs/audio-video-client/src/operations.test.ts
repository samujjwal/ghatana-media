import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import {
  MediaClientError,
  MediaOperationAmbiguousError,
  MediaUploadProgressCallbackError,
  MediaOperationNotAdmittedError,
  createMediaOperationClient as createConfiguredMediaOperationClient,
  type CanonicalMediaUploadSessionObservation,
} from "./operations";
import { boundedPositive, MediaHttpTransport, wait } from "./http-core";

const timestamp = "2026-08-05T12:00:00.000Z";

function createMediaOperationClient(
  config: Parameters<typeof createConfiguredMediaOperationClient>[0],
) {
  return createConfiguredMediaOperationClient({
    ...config,
    getAccessToken: config.getAccessToken ?? (() => "test-access-token"),
  });
}

describe("MediaHttpTransport configured identity boundary", () => {
  it("keeps positive sub-millisecond request bounds above zero", () => {
    expect(boundedPositive(0.1, 30_000)).toBe(1);
    expect(boundedPositive(0, 30_000)).toBe(30_000);
  });

  it("removes the abort listener after a polling wait completes", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const pending = wait(25, controller.signal);

      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeUndefined();

      expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1]);
      controller.abort();
      expect(removeListener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let per-request additions replace tenant/principal scope or inject credentials", async () => {
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
      getAccessToken: () => "configured-token",
      defaultHeaders: { "X-Principal-Id": "principal-configured" },
      requestContext: { correlationId: "correlation-configured" },
    });
    const headers = await transport.headers({
      "X-Tenant-ID": "tenant-attacker",
      "X-Principal-Id": "principal-attacker",
      "X-Correlation-ID": "correlation-attacker",
      Authorization: "Bearer caller-injected",
      "X-API-Key": "caller-injected-key",
    });

    expect(headers.get("X-Tenant-ID")).toBe("tenant-configured");
    expect(headers.get("X-Principal-Id")).toBe("principal-configured");
    expect(headers.get("X-Correlation-ID")).toBe("correlation-configured");
    expect(headers.get("Authorization")).toBe("Bearer configured-token");
    expect(headers.has("X-API-Key")).toBe(false);
  });

  it("uses only the configured credential provider even when additions carry Authorization", async () => {
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
      getAccessToken: () => "configured-token",
    });
    const headers = await transport.headers({ Authorization: "Bearer injected-token" });
    expect(headers.get("Authorization")).toBe("Bearer configured-token");
  });

  it("does not accept an API key added per request as configured authentication", async () => {
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
    });
    await expect(transport.headers({ "X-API-Key": "request-injected-key" }))
      .rejects.toThrow(/authentication is required/u);
  });

  it("authenticates raw fetch only with configured credentials and scoped identity", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer raw-configured-token");
      expect(headers.get("X-API-Key")).toBeNull();
      expect(headers.get("X-Principal-Id")).toBe("principal-configured");
      expect(headers.get("Content-Type")).toBe("application/octet-stream");
      expect(headers.get("Accept")).toBe("audio/*");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
      defaultHeaders: { "X-Principal-Id": "principal-configured" },
      getAccessToken: () => "raw-configured-token",
      fetchImpl,
    });
    await transport.fetchRaw("https://media.example.test/raw", {
      method: "PUT",
      headers: {
        Authorization: "Bearer request-injected",
        "X-API-Key": "request-injected-key",
        "X-Principal-Id": "principal-attacker",
        Accept: "audio/*",
        "Content-Type": "application/octet-stream",
      },
      body: new Blob(["payload"]),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch raw fetch with only configured principal scope", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
      defaultHeaders: { "X-Principal-Id": "principal-configured" },
      fetchImpl,
    });
    await expect(transport.fetchRaw("https://media.example.test/raw", { method: "GET" }))
      .rejects.toThrow(/authentication is required/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("authenticates raw fetch with a configured API key", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("raw-configured-api-key");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
      defaultHeaders: { "X-API-Key": "raw-configured-api-key" },
      fetchImpl,
    });
    await transport.fetchRaw("https://media.example.test/raw", { method: "GET" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin raw targets before credential lookup or dispatch", async () => {
    const getAccessToken = vi.fn(() => "configured-token");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
      defaultHeaders: { "X-API-Key": "configured-api-key" },
      getAccessToken,
      fetchImpl,
    });

    await expect(transport.fetchRaw("https://attacker.example.test/collect", { method: "GET" }))
      .rejects.toThrow(/configured origin/u);
    await expect(transport.fetchRawMutation(
      "https://attacker.example.test/collect", { method: "PUT" }, {}, async (response) => response.status,
    )).rejects.toThrow(/configured origin/u);

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects raw targets with URL userinfo even when the origin matches", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const transport = new MediaHttpTransport({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-configured",
      getAccessToken: () => "configured-token",
      fetchImpl,
    });
    await expect(transport.fetchRaw("https://user:password@media.example.test/raw", { method: "GET" }))
      .rejects.toThrow(/without URL userinfo/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("PDP-1 exact artifact-version inspection", () => {
  it("returns NOT_ADMITTED without dispatch because no route binds an immutable version", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => "configured-token",
      fetchImpl,
    });
    await expect(client.inspectArtifactVersion("artifact-1", "version-1"))
      .rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("MediaOperationClient authentication preflight", () => {
  it("does not dispatch artifact reads with only principal scope configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const client = createConfiguredMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });
    await expect(client.getArtifact("artifact-1")).rejects.toThrow(/authentication is required/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

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

  it("binds upload requests and readbacks to the 2 GiB PDP-1 operation limit", async () => {
    const maxBytes = 2_147_483_648;
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse(uploadSession({ expectedSizeBytes: maxBytes }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const request = { fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: maxBytes,
      expectedSha256: "a".repeat(64), classification: "INTERNAL" as const, retention: "PT24H", idempotencyKey: "key" };

    await expect(client.createUploadSession(request)).resolves.toMatchObject({ expectedSizeBytes: maxBytes });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(client.createUploadSession({ ...request, expectedSizeBytes: maxBytes + 1 }))
      .rejects.toThrow(/2 GiB PDP-1 begin-upload limit/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("keeps a create receipt bound to a different submitted payload ambiguous", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({ expectedSha256: "b".repeat(64) }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.createUploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H", idempotencyKey: "key",
    })).rejects.toMatchObject({
      name: "MediaOperationAmbiguousError",
      path: "/api/v1/artifacts/uploads",
    });
  });

  it("keeps a create response with an invalid classification ambiguous", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({ classification: "SECRET" }))) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.createUploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H", idempotencyKey: "key",
    })).rejects.toMatchObject({
      name: "MediaOperationAmbiguousError",
      path: "/api/v1/artifacts/uploads",
    });
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
    const failure = await client.uploadPart(uploadSession(), 0, new Blob(["x"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect(failure).toHaveProperty("cause", expect.objectContaining({ message: expect.stringMatching(/classification is outside the runtime enum/u) }));
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
    ["a size above the PDP-1 operation limit", { expectedSizeBytes: 2_147_483_649 }],
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
      const failure = await client.uploadPart(uploadSession(), 0, new Blob(["abc"])).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
      expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/artifacts/uploads/upload-1/chunks/0");
    }
  });

  it("treats server errors and unbound success acknowledgements as ambiguous, preserving explicit client errors", async () => {
    const errorEnvelope = {
      error: { code: "UPLOAD_REJECTED", message: "Upload rejected", retryable: false, evidenceRefs: [], actionRefs: [] },
      meta: { requestId: "request-1", correlationId: "correlation-1", timestamp, apiVersion: "1.0.0" },
    };
    for (const response of [
      jsonResponse(errorEnvelope, 408),
      jsonResponse(errorEnvelope, 429),
      jsonResponse(errorEnvelope, 503),
      new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
      jsonResponse(uploadSession({ bytesReceived: 2, nextChunkIndex: 1 })),
    ]) {
      const fetchImpl = vi.fn(async (): Promise<Response> => response) as unknown as typeof fetch;
      const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        defaultHeaders: { "X-Principal-Id": "principal-1" } });
      const failure = await client.uploadPart(uploadSession(), 0, new Blob(["abc"])).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
      expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/artifacts/uploads/upload-1/chunks/0");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }

    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(errorEnvelope, 403)) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(client.uploadPart(uploadSession(), 0, new Blob(["abc"]))).rejects.toMatchObject({
      name: "MediaClientError", statusCode: 403, detail: expect.objectContaining({ code: "UPLOAD_REJECTED" }),
    });
  });

  it.each([
    ["upload creation", "/api/v1/artifacts/uploads", (client: ReturnType<typeof createMediaOperationClient>) => client.createUploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H",
      idempotencyKey: "upload-ambiguous-1",
    })],
    ["upload completion", "/api/v1/artifacts/uploads/upload-1/complete", (client: ReturnType<typeof createMediaOperationClient>) => client.completeUploadSession(
      uploadSession({ expectedSizeBytes: 3, bytesReceived: 3 }),
    )],
  ] as const)("preserves ambiguous post-dispatch failures for %s", async (_label, expectedPath, invoke) => {
    for (const response of [
      jsonResponse({ error: { code: "UNAVAILABLE", message: "Unavailable", retryable: true },
        meta: { correlationId: "correlation-503" } }, 503),
      new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }),
    ]) {
      const fetchImpl = vi.fn(async (): Promise<Response> => response) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        defaultHeaders: { "X-Principal-Id": "principal-1" },
      });
      const failure = await invoke(client).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
      expect((failure as MediaOperationAmbiguousError).path).toBe(expectedPath);
      expect((failure as MediaOperationAmbiguousError).requestId).toMatch(/^[0-9a-f-]{36}$/u);
      if (_label === "upload creation") {
        expect((failure as MediaOperationAmbiguousError).requestKey).toBe("upload-ambiguous-1");
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps definitive upload validation/authorization responses canonical", async () => {
    const errorResponse = (status: number): Response => jsonResponse({
      error: { code: status === 403 ? "FORBIDDEN" : "INVALID_REQUEST", message: "Rejected", retryable: false },
      meta: { correlationId: `correlation-${status}` },
    }, status);
    const attempts = [
      (client: ReturnType<typeof createMediaOperationClient>) => client.createUploadSession({
        fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
        expectedSha256: "a".repeat(64), classification: "INTERNAL", retention: "PT24H",
        idempotencyKey: "upload-denied-1",
      }),
      (client: ReturnType<typeof createMediaOperationClient>) => client.completeUploadSession(
        uploadSession({ expectedSizeBytes: 3, bytesReceived: 3 }),
      ),
    ];
    for (const status of [400, 403]) {
      for (const attempt of attempts) {
        const fetchImpl = vi.fn(async (): Promise<Response> => errorResponse(status)) as unknown as typeof fetch;
        const client = createMediaOperationClient({
          baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
          defaultHeaders: { "X-Principal-Id": "principal-1" },
        });
        await expect(attempt(client)).rejects.toMatchObject({ name: "MediaClientError", statusCode: status });
      }
    }
  });

  it("keeps legacy cancellation NOT_ADMITTED regardless of a 409 response fixture", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      error: { code: "CONFLICT", message: "Operation state changed", retryable: false },
      meta: { correlationId: "correlation-409" },
    }, 409)) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });

    await expect(client.cancelOperation("operation-1")).rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps header-provider and progress-callback failures distinguishable from dispatch ambiguity", async () => {
    const beforeDispatchFetch = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession({ bytesReceived: 3, nextChunkIndex: 1 }))) as unknown as typeof fetch;
    const headerFailure = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1",
      fetchImpl: beforeDispatchFetch, getAccessToken: () => { throw new Error("credential provider unavailable"); },
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(headerFailure.uploadPart(uploadSession(), 0, new Blob(["abc"])))
      .rejects.toThrow("credential provider unavailable");
    expect(beforeDispatchFetch).not.toHaveBeenCalled();

    const acknowledged = uploadSession({ bytesReceived: 3, nextChunkIndex: 1, metadata: { privateNote: "user-private" } });
    const requestSession = uploadSession({ metadata: { privateNote: "user-private" } });
    const afterDispatchFetch = vi.fn(async (): Promise<Response> => jsonResponse(acknowledged)) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl: afterDispatchFetch,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const controller = new AbortController();
    const callbackFailure = await client.uploadPart(requestSession, 0, new Blob(["abc"]), {
      signal: controller.signal,
      onProgress: ({ percentage }) => {
        if (percentage === 100) {
          controller.abort();
          throw new Error("progress listener failed: bearer-secret");
        }
      },
    }).catch((error: unknown) => error);
    expect(callbackFailure).toBeInstanceOf(MediaUploadProgressCallbackError);
    expect((callbackFailure as MediaUploadProgressCallbackError).confirmedSession)
      .toEqual(acknowledged);
    const standardLogRepresentations = [String(callbackFailure), JSON.stringify(callbackFailure), inspect(callbackFailure)].join("\n");
    expect(standardLogRepresentations).not.toContain("source.wav");
    expect(standardLogRepresentations).not.toContain("user-private");
    expect(standardLogRepresentations).not.toContain("bearer-secret");
    expect((callbackFailure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(Object.keys(callbackFailure as object)).not.toContain("confirmedSession");
    expect(afterDispatchFetch).toHaveBeenCalledTimes(1);
  });

  it("cleans up timeout and abort linkage when the initial progress callback throws", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
      const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        requestTimeoutMs: 10_000, defaultHeaders: { "X-Principal-Id": "principal-1" } });
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      await expect(client.uploadPart(uploadSession(), 0, new Blob(["abc"]), {
        signal: controller.signal,
        onProgress: () => { throw new Error("initial progress listener failed"); },
      })).rejects.toThrow("initial progress listener failed");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(addListener).not.toHaveBeenCalled();
      expect(removeListener).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay a chunk after an ambiguous lost acknowledgement", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => { throw new TypeError("connection lost after send"); }) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const failure = await client.uploadPart(uploadSession(), 0, new Blob(["abc"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/artifacts/uploads/upload-1/chunks/0");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an aborted chunk dispatch as ambiguous so callers reconcile before retrying", async () => {
    let markFetchEntered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => { markFetchEntered = resolve; });
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_, reject) => {
      markFetchEntered();
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const controller = new AbortController();
    const pending = client.uploadPart(uploadSession(), 0, new Blob(["abc"]), { signal: controller.signal });
    await fetchEntered;
    controller.abort(new DOMException("caller cancelled", "AbortError"));
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    expect((failure as MediaOperationAmbiguousError).path).toBe("/api/v1/artifacts/uploads/upload-1/chunks/0");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the chunk timeout active while reading the post-dispatch acknowledgement", async () => {
    vi.useFakeTimers();
    try {
      let bodyReadStarted!: () => void;
      const bodyStarted = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => {
          bodyReadStarted();
        }),
      } as Response)) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        requestTimeoutMs: 10, defaultHeaders: { "X-Principal-Id": "principal-1" },
      });

      const pending = client.uploadPart(uploadSession(), 0, new Blob(["abc"]));
      const failurePromise = pending.catch((error: unknown) => error);
      await bodyStarted;
      await vi.advanceTimersByTimeAsync(10);
      const failure = await failurePromise;

      expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
      expect((failure as MediaOperationAmbiguousError).requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch a chunk aborted while asynchronous credentials are being acquired", async () => {
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      getAccessToken: () => token,
      defaultHeaders: { "X-Principal-Id": "principal-1" },
    });
    const controller = new AbortController();
    const pending = client.uploadPart(uploadSession(), 0, new Blob(["abc"]), { signal: controller.signal });

    controller.abort(new DOMException("caller cancelled before chunk dispatch", "AbortError"));
    releaseToken("token-1");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("keeps a completion artifact whose hash or size differs from the supplied session ambiguous", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact({ sizeBytes: 3, sha256: "b".repeat(64) }), 201)) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
      defaultHeaders: { "X-Principal-Id": "principal-1" } });
    const session = uploadSession({ expectedSizeBytes: 3, bytesReceived: 3, metadata: { purpose: "transcription" } });
    await expect(client.completeUploadSession(session)).rejects.toMatchObject({
      name: "MediaOperationAmbiguousError",
      path: "/api/v1/artifacts/uploads/upload-1/complete",
    });
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

  it("preserves the multimodal SDK signature but fails closed without an admitted route", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({}, 200)) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      fetchImpl,
    });

    await expect(client.analyzeMultimodal({
      sources: [{ kind: "ARTIFACT", artifactId: "artifact-1" }],
      intent: "Summarize the media",
      outputFormat: "TEXT",
      idempotencyKey: "multimodal-1",
    })).rejects.toMatchObject({
      name: "MediaOperationNotAdmittedError",
      operation: "media.sdk.analyzeMultimodal",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["provider capabilities", (client: ReturnType<typeof createMediaOperationClient>) => client.listProviderCapabilities()],
    ["transcription", (client: ReturnType<typeof createMediaOperationClient>) => client.transcribe({
      artifactId: "artifact-1", punctuation: true, wordTimestamps: false, alternatives: 1,
      profanityPolicy: "PRESERVE", idempotencyKey: "transcription-1",
    })],
    ["synthesis", (client: ReturnType<typeof createMediaOperationClient>) => client.synthesize({
      text: "hello", voiceId: "voice-1", languageTag: "en", outputMimeType: "audio/wav",
      rate: 1, pitch: 1, volume: 1,
      idempotencyKey: "synthesis-1",
    })],
    ["voice training", (client: ReturnType<typeof createMediaOperationClient>) => client.trainVoiceModel({
      name: "voice", sampleArtifactIds: ["artifact-1"], consentReference: "consent-1",
      rightsAttestation: true, languageTags: ["en"], qualityThreshold: 0.8, idempotencyKey: "training-1",
    })],
    ["voice conversion", (client: ReturnType<typeof createMediaOperationClient>) => client.convertVoice({
      sourceArtifactId: "source-1", voiceModelArtifactId: "model-1", consentReference: "consent-1",
      pitchShiftSemitones: 0, preserveTiming: true,
      idempotencyKey: "conversion-1",
    })],
    ["legacy job read", (client: ReturnType<typeof createMediaOperationClient>) => client.getOperation("job-1")],
    ["legacy job cancellation", (client: ReturnType<typeof createMediaOperationClient>) => client.cancelOperation("job-1")],
    ["legacy result read", (client: ReturnType<typeof createMediaOperationClient>) => client.getOperationResult("job-1", { parse: (value) => value })],
  ] as const)("returns typed NOT_ADMITTED for %s before fetch", async (_label, invoke) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({})) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1",
      fetchImpl, defaultHeaders: { "X-Principal-Id": "principal-1" } });
    await expect(invoke(client)).rejects.toBeInstanceOf(MediaOperationNotAdmittedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("canonical upload mutation credential boundary", () => {
    const request = {
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "a".repeat(64), classification: "INTERNAL" as const,
      retention: "PT24H", idempotencyKey: "upload-credential-boundary",
    };

    it("does not dispatch when the caller aborts during asynchronous credential acquisition", async () => {
      let releaseToken!: (token: string) => void;
      const token = new Promise<string>((resolve) => { releaseToken = resolve; });
      const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        getAccessToken: () => token,
        defaultHeaders: { "X-Principal-Id": "principal-1" },
      });
      const controller = new AbortController();
      const pending = client.createUploadSession(request, controller.signal);

      controller.abort(new DOMException("caller cancelled before dispatch", "AbortError"));
      releaseToken("token-1");

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("observes credential rejection even when the request is already aborted", async () => {
      const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        getAccessToken: () => Promise.reject(new Error("credential provider unavailable")),
        defaultHeaders: { "X-Principal-Id": "principal-1" },
      });
      const controller = new AbortController();
      controller.abort(new DOMException("cancelled before request setup", "AbortError"));

      await expect(client.createUploadSession(request, controller.signal))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("enforces the request timeout while asynchronous credentials are pending", async () => {
      vi.useFakeTimers();
      try {
        const token = new Promise<string>(() => undefined);
        const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(uploadSession())) as unknown as typeof fetch;
        const client = createMediaOperationClient({
          baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
          getAccessToken: () => token, requestTimeoutMs: 10,
          defaultHeaders: { "X-Principal-Id": "principal-1" },
        });
        const pending = client.createUploadSession(request);
        const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

        await vi.advanceTimersByTimeAsync(10);
        await rejection;
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe.skip("legacy operation routes (UNBOUND; canonical SDK is tested elsewhere)", () => {
  it("maps a submit abort/timeout after dispatch to OUTCOME_UNKNOWN, never a clean failure", async () => {
    for (const name of ["AbortError", "TimeoutError"] as const) {
      const fetchImpl = vi.fn(async (): Promise<Response> => {
        throw new DOMException(
          name === "AbortError" ? "The operation was aborted." : "Request timed out",
          name,
        );
      }) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
        defaultHeaders: { "X-Principal-Id": "principal-1" },
      });
      const failure = await client.transcribe(
        {
          artifactId: "art-1",
          punctuation: true,
          wordTimestamps: false,
          alternatives: 1,
          profanityPolicy: "PRESERVE",
          idempotencyKey: "submit-ambig-1",
        },
      ).then(
        () => { throw new Error("expected the submit to fail"); },
        (error) => error,
      );
      // An abort surfacing at submit is ambiguous — the job may already exist
      // server-side. It must surface as OUTCOME_UNKNOWN, not a clean failure.
      expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
      expect(failure.path).toBe("/api/v1/media/transcriptions");
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no blind retry attempted
    }
  });

  it.each([
    ["network rejection", async () => { throw new TypeError("fetch failed"); }],
    ["server error response", async () => jsonResponse({
      error: { code: "SERVICE_UNAVAILABLE", message: "Unavailable", retryable: true },
      meta: { correlationId: "correlation-503" },
    }, 503)],
    ["corrupted success JSON", async () => new Response("{", {
      status: 202,
      headers: { "Content-Type": "application/json" },
    })],
  ] as const)("preserves OUTCOME_UNKNOWN for %s after submit dispatch", async (_label, response) => {
    const fetchImpl = vi.fn(response) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
    });

    await expect(client.transcribe({
      artifactId: "art-1",
      punctuation: true,
      wordTimestamps: false,
      alternatives: 1,
      profanityPolicy: "PRESERVE",
      idempotencyKey: "submit-ambig-2",
    })).rejects.toMatchObject({
      name: "MediaOperationAmbiguousError",
      path: "/api/v1/media/transcriptions",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("preserves definitive HTTP %i submit rejection", async (status) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      error: { code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", message: "Denied", retryable: false },
      meta: { correlationId: `correlation-${status}` },
    }, status)) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl,
    });

    await expect(client.transcribe({
      artifactId: "art-1",
      punctuation: true,
      wordTimestamps: false,
      alternatives: 1,
      profanityPolicy: "PRESERVE",
      idempotencyKey: "submit-denied-1",
    })).rejects.toMatchObject({ name: "MediaClientError", statusCode: status });
  });

  it("surfaces a same-key changed-payload conflict as a definitive no-effect rejection", async () => {
    const submitted: Array<{ headers: Headers; body: unknown }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      submitted.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as unknown });
      if (submitted.length === 1) {
        return jsonResponse({
          operationId: "operation-1",
          job: queuedJob(),
          statusUrl: "/api/v1/media/operations/operation-1",
          cancelUrl: "/api/v1/media/operations/operation-1:cancel",
          correlationId: "correlation-1",
        }, 202);
      }
      return jsonResponse({
        error: { code: "IDEMPOTENCY_CONFLICT", message: "Request key was used with a different payload", retryable: false },
        meta: { correlationId: "correlation-conflict" },
      }, 409);
    }) as unknown as typeof fetch;
    const client = createMediaOperationClient({ baseUrl: "https://media.example.test", tenantId: "tenant-1", fetchImpl });
    const request = {
      artifactId: "art-1",
      punctuation: true,
      wordTimestamps: false,
      alternatives: 1,
      profanityPolicy: "PRESERVE" as const,
      idempotencyKey: "same-submit-key",
    };

    await expect(client.transcribe(request)).resolves.toMatchObject({ operationId: "operation-1" });
    await expect(client.transcribe({ ...request, punctuation: false })).rejects.toMatchObject({
      name: "MediaClientError",
      statusCode: 409,
      detail: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT", correlationId: "correlation-conflict" }),
    });

    expect(submitted).toHaveLength(2);
    expect(submitted.map(({ headers }) => headers.get("Idempotency-Key"))).toEqual([
      "same-submit-key", "same-submit-key",
    ]);
    expect(submitted[0]?.body).not.toEqual(submitted[1]?.body);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  });

  it("rejects malformed cross-service identity before sending", () => {
    expect(() => createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      requestContext: { correlationId: "correlation\nspoof" },
    })).toThrow(/correlationId/u);
  });

  describe.skip("legacy operation observation routes (UNBOUND; canonical SDK is tested elsewhere)", () => {
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

  it("treats aborting local wait as stopping observation, without requesting remote cancellation", async () => {
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
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      fetchImpl,
    });
    const handle = await client.transcribe({
      artifactId: "artifact-1",
      idempotencyKey: "idem-wait-observation-1",
      punctuation: true,
      wordTimestamps: true,
      alternatives: 1,
      profanityPolicy: "PRESERVE",
    });
    const controller = new AbortController();
    const pending = handle.wait({ signal: controller.signal, pollIntervalMs: 60_000 });
    controller.abort(new DOMException("caller stopped observing", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["https://media.example.test/api/v1/media/transcriptions"]);
    expect(calls.some((url) => url.endsWith(":cancel"))).toBe(false);
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

  });

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

  it.each(["+artifact", "_artifact", "artifact+1", "a".repeat(129)])(
    "rejects artifact ID %j outside the PDP-1 opaque-id scalar before transport",
    async (artifactId) => {
      const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse(canonicalArtifact())) as unknown as typeof fetch;
      const client = createMediaOperationClient({
        baseUrl: "https://media.example.test",
        tenantId: "tenant-1",
        defaultHeaders: { "X-Principal-Id": "principal-1" },
        fetchImpl,
      });

      await expect(client.getArtifact(artifactId)).rejects.toThrow("PDP-1 opaque ID");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("retains PDP-1 opaque artifact IDs with dot, underscore, colon, and hyphen", async () => {
    const artifactId = "Artifact_01:revision-2.test";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      expect(String(input)).toBe(`https://media.example.test/api/v1/artifacts/${encodeURIComponent(artifactId)}`);
      return jsonResponse(canonicalArtifact({ artifactId }));
    }) as unknown as typeof fetch;
    const client = createMediaOperationClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      fetchImpl,
    });

    await expect(client.getArtifact(artifactId)).resolves.toMatchObject({ artifactId });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

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
