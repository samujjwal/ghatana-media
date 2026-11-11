import { describe, expect, it } from "vitest";
import { MediaDevOnlyJobCancellationClient } from "./dev-job-cancellation.js";

const timestamp = "2026-11-10T12:00:00.000Z";

function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-1", requestId: "submit-1", tenantId: "tenant-1", principalId: "principal-1",
    artifactId: "artifact-1", jobType: "TRANSCODE", providerId: "local-diagnostic", status: "RUNNING",
    createdAt: timestamp, startedAt: timestamp, completedAt: null, result: {}, failureCode: null,
    version: 4, expectedArtifactVersion: "", requestFingerprint: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function cancellation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "media.dev.job-cancellation-result.v1", scope: "DEV_ONLY",
    requestId: "cancel-1", outcome: "REQUESTED_UNCONFIRMED", replayed: false, job: job(),
    ...overrides,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch, baseUrl = "http://127.0.0.1:8093") {
  return new MediaDevOnlyJobCancellationClient({
    baseUrl, tenantId: "tenant-1", defaultHeaders: { "X-Principal-Id": "principal-1" },
    getAccessToken: () => "dev-token-fixture", fetchImpl,
  });
}

describe("MediaDevOnlyJobCancellationClient", () => {
  it("sends stable request identity to the loopback DEV_ONLY route and validates the scoped outcome", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response(cancellation());
    }) as typeof fetch;

    const result = await client(fetchImpl).cancelJob("job-1", { requestId: "cancel-1", expectedVersion: 4 });

    expect(result.outcome).toBe("REQUESTED_UNCONFIRMED");
    expect(result.job.status).toBe("RUNNING");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8093/dev/v1/jobs/job-1/cancel");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ requestId: "cancel-1", expectedVersion: 4 });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("X-Tenant-ID")).toBe("tenant-1");
    expect(headers.get("X-Principal-Id")).toBe("principal-1");
    expect(headers.get("Authorization")).toBe("Bearer dev-token-fixture");
  });

  it("rejects non-loopback endpoints before dispatch", () => {
    expect(() => client(fetch, "https://media.example.test"))
      .toThrow("DEV_ONLY job cancellation requires a loopback Media endpoint.");
  });

  it("rejects a cancellation readback outside the requested tenant or principal", async () => {
    const fetchImpl = (async () => response(cancellation({
      job: job({ principalId: "principal-other" }),
    }))) as typeof fetch;
    await expect(client(fetchImpl).cancelJob("job-1", { requestId: "cancel-1" }))
      .rejects.toMatchObject({ name: "MediaOperationAmbiguousError", requestId: "cancel-1" });
  });

  it.each([
    ["CONFIRMED", "CANCELLED"],
    ["REQUESTED_UNCONFIRMED", "ACCEPTED"],
    ["REQUESTED_UNCONFIRMED", "RUNNING"],
    ["UNSUPPORTED", "ACCEPTED"],
    ["UNSUPPORTED", "RUNNING"],
    ["OUTCOME_UNKNOWN", "ACCEPTED"],
    ["OUTCOME_UNKNOWN", "RUNNING"],
    ["OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"],
    ["ALREADY_TERMINAL", "OUTCOME_UNKNOWN"],
    ["ALREADY_TERMINAL", "COMPLETED"],
    ["ALREADY_TERMINAL", "FAILED"],
    ["ALREADY_TERMINAL", "CANCELLED"],
    ["TERMINAL_RACE", "OUTCOME_UNKNOWN"],
    ["TERMINAL_RACE", "COMPLETED"],
    ["TERMINAL_RACE", "FAILED"],
    ["TERMINAL_RACE", "CANCELLED"],
  ])("accepts outcome %s with job status %s", async (outcome, status) => {
    const fetchImpl = (async () => response(cancellation({ outcome, job: job({ status }) }))) as typeof fetch;
    const result = await client(fetchImpl).cancelJob("job-1", { requestId: "cancel-1" });
    expect(result.outcome).toBe(outcome);
    expect(result.job.status).toBe(status);
  });

  it.each([
    ["CONFIRMED", "RUNNING"],
    ["REQUESTED_UNCONFIRMED", "CANCELLED"],
    ["UNSUPPORTED", "OUTCOME_UNKNOWN"],
    ["OUTCOME_UNKNOWN", "COMPLETED"],
    ["ALREADY_TERMINAL", "RUNNING"],
    ["TERMINAL_RACE", "ACCEPTED"],
  ])("keeps contradictory dispatched outcome %s / status %s ambiguous", async (outcome, status) => {
    const fetchImpl = (async () => response(cancellation({ outcome, job: job({ status }) }))) as typeof fetch;
    await expect(client(fetchImpl).cancelJob("job-1", { requestId: "cancel-1" }))
      .rejects.toMatchObject({ name: "MediaOperationAmbiguousError", requestId: "cancel-1" });
  });

  it("retains the same request ID on a post-dispatch ambiguous result", async () => {
    const fetchImpl = (async () => { throw new Error("socket closed after request dispatch"); }) as typeof fetch;
    await expect(client(fetchImpl).cancelJob("job-1", { requestId: "cancel-1" }))
      .rejects.toMatchObject({
        name: "MediaOperationAmbiguousError", requestId: "cancel-1",
        path: "/dev/v1/jobs/job-1/cancel",
      });
  });
});
