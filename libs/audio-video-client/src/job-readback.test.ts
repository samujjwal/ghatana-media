import { describe, expect, it, vi } from "vitest";
import { createMediaCanonicalClient } from "./canonical-operations";

const timestamp = "2026-10-30T12:00:00.000Z";

function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-1", requestId: "req-1", tenantId: "tenant-1", principalId: "principal-1",
    artifactId: "art-1", jobType: "SPEECH_TO_TEXT", providerId: "whisper-local",
    status: "RUNNING", createdAt: timestamp, startedAt: timestamp, completedAt: null,
    result: {}, failureCode: null, version: 3, expectedArtifactVersion: "",
    requestFingerprint: `sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MediaCanonicalClient request-bound job readback", () => {
  it("uses the existing requestId query and returns the matching scoped job", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(job({ requestId: "req/1" })));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => "bearer-secret",
      fetchImpl,
    });

    await expect(client.getJobByRequest("job-1", "req/1")).resolves.toMatchObject({
      jobId: "job-1", requestId: "req/1",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://media.example.test/api/v1/jobs/job-1?requestId=req%2F1",
    );
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer bearer-secret");
    expect(headers.get("X-Tenant-ID")).toBe("tenant-1");
    expect(headers.get("X-Principal-Id")).toBe("principal-1");
  });

  it("rejects a readback whose job request identity differs", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(job({ requestId: "other-request" })));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => "bearer-secret",
      fetchImpl,
    });

    await expect(client.getJobByRequest("job-1", "req-1")).rejects.toThrow(/requestId does not match/u);
  });

  it("rejects malformed request identity before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(job()));
    const client = createMediaCanonicalClient({
      baseUrl: "https://media.example.test",
      tenantId: "tenant-1",
      defaultHeaders: { "X-Principal-Id": "principal-1" },
      getAccessToken: () => "bearer-secret",
      fetchImpl,
    });

    await expect(client.getJobByRequest("job-1", " \n ")).rejects.toThrow(/requestId/u);
    await expect(client.getJobByRequest("job-1", "r".repeat(256))).rejects.toThrow(/requestId/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
