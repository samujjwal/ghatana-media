import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CaptureNotAdmittedError,
  CaptureOutcomeUnknownError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  routedCaptureAdapter,
  type CaptureAdapterEligibility,
  type CaptureRequest,
} from "./capture-adapters";
import { HttpApiCaptureAdapter } from "./http-capture-adapter";

const admitted: CaptureAdapterEligibility = { check: () => "ADMITTED" };

const request: CaptureRequest = {
  kind: "HTTP_API",
  sourceIdentity: "api:snapshot-1",
  purposeRef: "purpose/v1",
  exactRightsScope: "rights/snapshot-1/v1",
  sourceVersionRef: "snapshot-1@v2",
  secretsRef: "secrets/capture-http",
  frameClockRef: "clock/ntsc-30",
};

const servers: Server[] = [];

async function withServer(
  handler: (req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await run(`http://127.0.0.1:${address.port}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

function adapterFor(origin: string, options: {
  allowedOrigins?: readonly string[];
  maxBytes?: number;
  timeoutMillis?: number;
  maxRedirects?: number;
} = {}): HttpApiCaptureAdapter {
  return new HttpApiCaptureAdapter({
    resolveEndpoint: () => `${origin}/capture?token=endpoint-secret-marker`,
    ...options,
  });
}

describe("HttpApiCaptureAdapter", () => {
  it("captures real response bytes through the admission seam", async () => {
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252]);
    let sawPath: string | undefined;
    let sawMethod: string | undefined;
    await withServer((req, res) => {
      sawMethod = req.method;
      sawPath = req.url;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(payload));
    }, async (origin) => {
      const frame = await captureWithAdmission(admitted,
        adapterFor(origin), request);
      expect(frame.bytes).toEqual(payload);
      expect(frame.sourceIdentity).toBe(request.sourceIdentity);
      expect(frame.purposeRef).toBe(request.purposeRef);
      expect(frame.exactRightsScope).toBe(request.exactRightsScope);
      expect(frame.sourceVersionRef).toBe(request.sourceVersionRef);
      expect(frame.frameClockRef).toBe(request.frameClockRef);
      expect(Number.isSafeInteger(frame.capturedAtEpochMillis)).toBe(true);
    });
    expect(sawMethod).toBe("GET");
    expect(sawPath).toBe("/capture?token=endpoint-secret-marker");
  });

  it("returns real bytes on a direct adapter call without the wrapper", async () => {
    await withServer((_req, res) => {
      res.writeHead(200).end("direct-bytes");
    }, async (origin) => {
      const frame = await adapterFor(origin).capture(request);
      expect(new TextDecoder().decode(frame.bytes)).toBe("direct-bytes");
    });
  });

  it("follows a same-origin redirect and re-validates the hop", async () => {
    await withServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" }).end();
        return;
      }
      res.writeHead(200).end("redirected-bytes");
    }, async (origin) => {
      const adapter = new HttpApiCaptureAdapter({
        resolveEndpoint: () => `${origin}/start`,
        allowedOrigins: [origin],
      });
      const frame = await captureWithAdmission(admitted, adapter, request);
      expect(new TextDecoder().decode(frame.bytes)).toBe("redirected-bytes");
    });
  });

  it("rejects a redirect to an origin outside allowedOrigins", async () => {
    let secondOriginRequests = 0;
    await withServer((_req, res) => {
      secondOriginRequests += 1;
      res.writeHead(200).end("must-not-arrive");
    }, async (secondOrigin) => {
      await withServer((_req, res) => {
        res.writeHead(302, { location: `${secondOrigin}/stolen` }).end();
      }, async (firstOrigin) => {
        const adapter = new HttpApiCaptureAdapter({
          resolveEndpoint: () => `${firstOrigin}/start`,
          allowedOrigins: [firstOrigin],
        });
        await expect(captureWithAdmission(admitted, adapter, request))
          .rejects.toBeInstanceOf(CaptureOutcomeUnknownError);
      });
    });
    expect(secondOriginRequests).toBe(0);
  });

  it("bounds redirect hops and reports UNKNOWN beyond the limit", async () => {
    await withServer((_req, res) => {
      res.writeHead(302, { location: "/loop" }).end();
    }, async (origin) => {
      const adapter = new HttpApiCaptureAdapter({
        resolveEndpoint: () => `${origin}/loop`,
        maxRedirects: 2,
      });
      await expect(captureWithAdmission(admitted, adapter, request))
        .rejects.toMatchObject({ reason: "ADAPTER_REJECTED" });
    });
  });

  it("rejects non-success responses as UNKNOWN without provider detail", async () => {
    await withServer((_req, res) => {
      res.writeHead(500).end("provider-secret-detail");
    }, async (origin) => {
      let outcome: unknown;
      try {
        await captureWithAdmission(admitted, adapterFor(origin), request);
      } catch (error) {
        outcome = error;
      }
      expect(outcome).toBeInstanceOf(CaptureOutcomeUnknownError);
      expect(String(outcome)).not.toContain("provider-secret-detail");
      expect(String(outcome)).not.toContain("endpoint-secret-marker");
    });
  });

  it("rejects response bodies above the byte bound", async () => {
    await withServer((_req, res) => {
      res.writeHead(200).end(Buffer.alloc(64, 7));
    }, async (origin) => {
      const adapter = adapterFor(origin, { maxBytes: 16 });
      await expect(captureWithAdmission(admitted, adapter, request))
        .rejects.toMatchObject({ reason: "ADAPTER_REJECTED" });
    });
  });

  it("times out an unresponsive endpoint within the configured deadline", async () => {
    await withServer(() => {
      // Never respond; the adapter's AbortSignal must cut the capture.
    }, async (origin) => {
      const adapter = adapterFor(origin, { timeoutMillis: 100 });
      const started = Date.now();
      await expect(captureWithAdmission(admitted, adapter, request))
        .rejects.toMatchObject({ reason: "ADAPTER_REJECTED" });
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  }, 15_000);

  it("rejects plain-HTTP non-loopback endpoints before any request", async () => {
    let fetchCalls = 0;
    const adapter = new HttpApiCaptureAdapter({
      resolveEndpoint: () => "http://capture.invalid/snapshot?token=endpoint-secret-marker",
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      }) as typeof fetch,
    });
    await expect(captureWithAdmission(admitted, adapter, request))
      .rejects.toMatchObject({ reason: "ADAPTER_REJECTED" });
    expect(fetchCalls).toBe(0);
  });

  it("rejects endpoints carrying userinfo credentials", async () => {
    let fetchCalls = 0;
    const adapter = new HttpApiCaptureAdapter({
      resolveEndpoint: () => "https://user:pass@api.example.com/snapshot",
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      }) as typeof fetch,
    });
    await expect(captureWithAdmission(admitted, adapter, request))
      .rejects.toMatchObject({ reason: "ADAPTER_REJECTED" });
    expect(fetchCalls).toBe(0);
  });

  it("permits an explicitly allowed plain-HTTP origin", async () => {
    await withServer((_req, res) => {
      res.writeHead(200).end("allowed-http");
    }, async (origin) => {
      const adapter = new HttpApiCaptureAdapter({
        resolveEndpoint: () => `${origin}/capture`,
        allowedOrigins: [origin],
      });
      const frame = await captureWithAdmission(admitted, adapter, request);
      expect(new TextDecoder().decode(frame.bytes)).toBe("allowed-http");
    });
  });

  it("does not resolve or fetch when eligibility denies the request", async () => {
    let resolveCalls = 0;
    let fetchCalls = 0;
    const adapter = new HttpApiCaptureAdapter({
      resolveEndpoint: () => {
        resolveCalls += 1;
        return "https://api.example.com/snapshot";
      },
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      }) as typeof fetch,
    });
    await expect(captureWithAdmission(noAdmittedCaptureAdapter, adapter, request))
      .rejects.toBeInstanceOf(CaptureNotAdmittedError);
    expect(resolveCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("rejects a request kind outside HTTP_API before resolving", async () => {
    let resolveCalls = 0;
    const adapter = new HttpApiCaptureAdapter({
      resolveEndpoint: () => {
        resolveCalls += 1;
        return "https://api.example.com/snapshot";
      },
    });
    await expect(adapter.capture({ ...request, kind: "MEDIA_FILE" }))
      .rejects.toThrow(/kind does not match/u);
    expect(resolveCalls).toBe(0);
  });

  it("routes HTTP_API requests through routedCaptureAdapter", async () => {
    await withServer((_req, res) => {
      res.writeHead(200).end("routed-bytes");
    }, async (origin) => {
      const routed = routedCaptureAdapter({ HTTP_API: adapterFor(origin) });
      const frame = await captureWithAdmission(admitted, routed, request);
      expect(new TextDecoder().decode(frame.bytes)).toBe("routed-bytes");
    });
  });
});
