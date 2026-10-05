import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createPlatformError,
  getAudioVideoPlatformMetrics,
  incrementAudioVideoPlatformMetric,
  normalizeAudioVideoRuntimeConfig,
  synthesizeWithPlatformFallback,
  transcribeWithPlatformFallback,
} from "./audioVideoPlatform";

interface MediaContractFixture {
  readonly runtimeConfig: {
    readonly languageTag: string;
    readonly requestTimeoutMs?: number;
    readonly syncToleranceMs: number;
    readonly ttsVoiceId: string;
  };
  readonly error: {
    readonly code: string;
    readonly category: "validation" | "runtime";
    readonly retryable: boolean;
    readonly message: string;
  };
  readonly errorCodes?: ReadonlyArray<{
    readonly code: string;
    readonly category: string;
    readonly retryable: boolean;
    readonly message: string;
  }>;
}

function readFixture(): MediaContractFixture {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(
    currentDir,
    "../../../../test-fixtures/media-contract-fixtures.json",
  );
  return JSON.parse(readFileSync(fixturePath, "utf8")) as MediaContractFixture;
}

describe("audioVideoPlatform", () => {
  it("normalizes runtime configuration safely", () => {
    const config = normalizeAudioVideoRuntimeConfig({
      requestTimeoutMs: 100,
      syncToleranceMs: 5,
      languageTag: "  ",
      ttsVoiceId: " narrator ",
    });

    expect(config.requestTimeoutMs).toBe(1_000);
    expect(config.syncToleranceMs).toBe(20);
    expect(config.languageTag).toBe("en-US");
    expect(config.ttsVoiceId).toBe("narrator");
  });

  it("creates shared platform errors with stable fields", () => {
    const error = createPlatformError(
      "media.processing_failed",
      "runtime",
      true,
      "fallback failed",
    );

    expect(error.code).toBe("media.processing_failed");
    expect(error.category).toBe("runtime");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("fallback failed");
  });

  it("tracks shared runtime metrics", () => {
    const before = getAudioVideoPlatformMetrics();
    incrementAudioVideoPlatformMetric("sttFallbackRequests");
    incrementAudioVideoPlatformMetric("fallbackFailures");
    const after = getAudioVideoPlatformMetrics();

    expect(after.sttFallbackRequests).toBe(before.sttFallbackRequests + 1);
    expect(after.fallbackFailures).toBe(before.fallbackFailures + 1);
  });

  it("matches the shared media contract fixture", () => {
    const fixture = readFixture();
    const fixtureError = fixture.error ?? fixture.errorCodes?.[0];
    if (
      !fixtureError ||
      !["validation", "runtime"].includes(fixtureError.category)
    ) {
      throw new Error(
        "media contract fixture must include a validation/runtime platform error",
      );
    }
    const config = normalizeAudioVideoRuntimeConfig(fixture.runtimeConfig);
    const error = createPlatformError(
      fixtureError.code,
      fixtureError.category as "validation" | "runtime",
      fixtureError.retryable,
      fixtureError.message,
    );

    expect(config.languageTag).toBe("en-GB");
    expect(config.syncToleranceMs).toBe(55);
    expect(config.ttsVoiceId).toBe("piper-en-gb");
    expect(error.code).toBe("media.temporarily_unavailable");
    expect(error.retryable).toBe(true);
  });

  it("surfaces typed fallback errors when no transcript is returned", async () => {
    await expect(
      transcribeWithPlatformFallback(
        new Blob(["abc"]),
        {
          sttEndpoint: "https://example.test/stt",
          fetchImpl: async () =>
            new Response(JSON.stringify({ confidence: 0.9 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        },
        "en-US",
      ),
    ).rejects.toMatchObject({
      code: "media.processing_failed",
      retryable: true,
    });
  });

  it("clamps invalid transcription confidence", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      new Response(
        JSON.stringify({ transcript: "Hello", confidence: 1.5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    await expect(
      transcribeWithPlatformFallback(
        new Blob(["audio"], { type: "audio/webm" }),
        { sttEndpoint: "https://media.test/stt", fetchImpl },
        "en-US",
      ),
    ).resolves.toEqual({ transcript: "Hello", confidence: 1 });
  });

  it("rejects empty synthesis results rather than pretending playback can start", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      new Response(new Blob([]), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      synthesizeWithPlatformFallback(
        "Hello",
        undefined,
        { ttsEndpoint: "https://media.test/tts", fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "media.processing_failed" });
  });

  it("preserves cancellation as a non-retryable platform error", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const controller = new AbortController();
    const promise = synthesizeWithPlatformFallback(
      "Hello",
      undefined,
      { ttsEndpoint: "https://media.test/tts", fetchImpl },
      controller.signal,
    );
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      code: "media.cancelled",
      retryable: false,
    });
  });
});
