import { describe, expect, it } from "vitest";
import { MediaDevOnlyRenderExportClient } from "./dev-render-export.js";

const digest = "a".repeat(64);

function config(fetchImpl: typeof fetch) {
  return {
    baseUrl: "http://127.0.0.1:8080",
    tenantId: "tenant-1",
    defaultHeaders: { "X-Principal-Id": "principal-1" },
    getAccessToken: () => "dev-token",
    fetchImpl,
  };
}

function exportResponse(replayed = false, confirmed = true) {
  return {
    requestId: "export-1",
    artifactId: "artifact-1",
    artifactVersionId: `sha256:${digest}`,
    artifactDigest: digest,
    destinationId: "destination-1",
    status: confirmed ? "DESTINATION_CONFIRMED" : "SENT",
    acknowledgedBytes: 12,
    destinationConfirmed: confirmed,
    destinationReceiptRef: confirmed ? "receipt-1" : null,
    replayed,
    ackState: confirmed ? "DELIVERED" : "UNKNOWN",
    failure: null,
    destinationReceivedBytes: confirmed ? 12 : null,
    observedAt: "2026-11-21T00:00:00Z",
    scope: "DEV_ONLY",
  };
}

describe("MediaDevOnlyRenderExportClient", () => {
  it("preserves DEV_ONLY scope for exact-version export create, replay and readback", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const client = new MediaDevOnlyRenderExportClient(config(async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      if (init?.method === "POST") return new Response(JSON.stringify(exportResponse(false)), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
      return new Response(JSON.stringify(exportResponse(true)), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));

    const request = {
      requestId: "export-1",
      artifactId: "artifact-1",
      artifactVersionId: `sha256:${digest}`,
      destinationId: "destination-1",
    };
    const created = await client.createExport(request);
    const observed = await client.getExport(request.requestId);
    expect(created).toMatchObject({ scope: "DEV_ONLY", httpStatus: 201, ackState: "DELIVERED" });
    expect(observed).toMatchObject({ scope: "DEV_ONLY", httpStatus: 200, replayed: true, ackState: "DELIVERED" });
    expect(calls).toEqual([
      { method: "POST", url: "http://127.0.0.1:8080/dev/v1/exports" },
      { method: "GET", url: "http://127.0.0.1:8080/dev/v1/exports/export-1" },
    ]);
  });

  it("keeps an unconfirmed export observation nonfinal", async () => {
    const client = new MediaDevOnlyRenderExportClient(config(async () => new Response(
      JSON.stringify(exportResponse(false, false)), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      },
    )));
    await expect(client.createExport({
      requestId: "export-1",
      artifactId: "artifact-1",
      artifactVersionId: `sha256:${digest}`,
      destinationId: "destination-1",
    })).resolves.toMatchObject({
      scope: "DEV_ONLY", httpStatus: 202, destinationConfirmed: false, ackState: "UNKNOWN",
    });
  });
});
