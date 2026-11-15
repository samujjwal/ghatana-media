// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevAudioRestorationPanel } from "./DevAudioRestorationPanel";
import {
  DevAudioHostError, describeAudioFailure, describeAudioVerdict, parseAudioComparisonView, parseAudioHostStatus, parseAudioRestorationView,
  type DevAudioHostResponse, type DevAudioRestorationPort,
} from "./devAudioRestoration";

afterEach(cleanup);

const SRC_SHA = "a".repeat(64);
const OUT_SHA = "b".repeat(64);
const REF_SHA = "c".repeat(64);
const SRC_VERSION = `sha256:${SRC_SHA}`;
const OUT_VERSION = `sha256:${OUT_SHA}`;
const REF_VERSION = `sha256:${REF_SHA}`;

const statusBody = (over: Record<string, unknown> = {}): unknown => ({
  scope: "DEV_ONLY",
  engine: { configured: true, ready: true, name: "ffmpeg", version: "ffmpeg version 7.0.2-static" },
  transcriptDiff: { ready: true }, limits: { maxSourceBytes: 8388608, deadlineSeconds: 60 }, ...over,
});
const restorationBody = (over: { replayed?: boolean } = {}): unknown => ({
  schema: "media.dev.audio-restoration.v1", kind: "RESTORATION", scope: "DEV_ONLY", outputId: "out-1", replayed: over.replayed ?? false,
  artifact: { artifactId: "out-1", artifactVersionId: OUT_VERSION, contentType: "audio/wav", sizeBytes: 4, sha256: OUT_SHA },
  lineage: { kind: "LOCAL_AUDIO_RESTORED", source: { artifactId: "src-1", artifactVersionId: SRC_VERSION, sha256: SRC_SHA },
    filterGraph: "adeclip=threshold=10,afftdn=nr=12.0", engine: { version: "ffmpeg version 7.0.2-static" } },
});
const side = (over: Record<string, unknown>): unknown => ({ clippedSamples: 0, peakAbs: 1000, rmsDbfs: -27, noiseFloor: { rmsDbfs: -40, spectralFlatness: 0.7, frames: 40 }, snrDb: null, segmentalSnrDb: null, ...over });
const comparisonBody = (verdict = "IMPROVED", withReference = true): unknown => ({
  schema: "media.dev.audio-comparison.v1", kind: "COMPARISON", scope: "DEV_ONLY", outputId: "cmp-1", replayed: false,
  report: {
    reference: withReference ? { artifactId: "ref-1" } : undefined,
    metrics: {
      source: side({ clippedSamples: 346, snrDb: withReference ? 9.98 : null, segmentalSnrDb: withReference ? 2.87 : null, noiseFloor: { rmsDbfs: -38, spectralFlatness: 0.675, frames: 45 } }),
      restored: side({ clippedSamples: 0, snrDb: withReference ? 11.51 : null, segmentalSnrDb: withReference ? 4.14 : null, noiseFloor: { rmsDbfs: -42.18, spectralFlatness: 0.841, frames: 45 } }),
      ...(withReference ? { reference: side({ noiseFloor: { rmsDbfs: -83.9, spectralFlatness: 0.245, frames: 45 } }) } : {}),
      delta: { snrDb: withReference ? 1.53 : null, segmentalSnrDb: withReference ? 1.27 : null, clippedSamples: -346, noiseFloorDbfs: -4.18, noiseFloorSpectralFlatness: 0.166 },
    },
    verdict: { overall: verdict, snr: withReference ? "IMPROVED" : "NOT_MEASURED", segmentalSnr: withReference ? "IMPROVED" : "NOT_MEASURED", clipping: "REDUCED", noiseFloorLevel: "LOWER" },
    transcript: { status: "NOT_REQUESTED" },
  },
});
const ok = (status: number, body: unknown): Promise<DevAudioHostResponse> => Promise.resolve({ status, body });
type FakePort = { [K in keyof DevAudioRestorationPort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevAudioRestorationPort> = {}): FakePort {
  return {
    getStatus: vi.fn(() => ok(200, statusBody())),
    restore: vi.fn(() => ok(201, restorationBody())),
    compare: vi.fn(() => ok(201, comparisonBody())),
    readArtifactContent: undefined,
    ...over,
  } as unknown as FakePort;
}
const asPort = (port: FakePort): DevAudioRestorationPort => port as unknown as DevAudioRestorationPort;
const ids = (): (() => string) => { let n = 0; return () => `audio-req-${++n}`; };

async function mounted(port: FakePort, locked = false, digest?: (bytes: Uint8Array) => Promise<string>) {
  render(React.createElement(DevAudioRestorationPanel, { audio: asPort(port), locked, newRequestId: ids(), ...(digest ? { digest } : {}) }));
  await waitFor(() => expect(document.querySelector("[data-audio-engine-status]")!.textContent).toContain("ready"));
}
const set = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fillSource = () => { set("Source artifact id", "src-1"); set("Source exact version", SRC_VERSION); };
const submit = () => fireEvent.click(screen.getByRole("button", { name: /Restore and measure|Restoring|Measuring/u }));

describe("DevAudioRestorationPanel", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("reads the engine status from the host and disables the form when the engine is not ready", async () => {
    await mounted(fakePort());
    expect(document.querySelector("[data-audio-engine-status]")!.textContent).toContain("ffmpeg version 7.0.2-static");
    expect(document.querySelector("[data-audio-engine-status]")!.textContent).toContain("Whisper transcript diff is available");
    cleanup();
    render(React.createElement(DevAudioRestorationPanel, { audio: asPort(fakePort({ getStatus: vi.fn(() => ok(200, statusBody({ engine: { configured: false, ready: false } }))) })) }));
    await waitFor(() => expect(document.querySelector("[data-audio-engine-status]")!.textContent).toContain("not available"));
    expect(screen.getByRole("button", { name: "Restore and measure" }).hasAttribute("disabled")).toBe(true);
    cleanup();
    const broken = fakePort({ getStatus: vi.fn(() => Promise.reject(new DevAudioHostError("HTTP_ERROR", 503, "down"))) });
    render(React.createElement(DevAudioRestorationPanel, { audio: asPort(broken) }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry reading status" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Restore and measure" }).hasAttribute("disabled")).toBe(true);
  });

  it("validates the form locally and calls the host with nothing when a field is invalid", async () => {
    const port = fakePort();
    await mounted(port);
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("source artifact id");
    expect(alert.textContent).toContain("exact source version");
    fillSource();
    set("Noise reduction in dB (1 to 40)", "99");
    set("Declip threshold (1 to 100)", "10.5");
    submit();
    const errors = (await screen.findByRole("alert")).textContent!;
    expect(errors).toContain("Noise reduction must be a number from 1 to 40");
    expect(errors).toContain("Declip sensitivity threshold must be a whole number from 1 to 100");
    fireEvent.click(screen.getByLabelText("Declip"));
    fireEvent.click(screen.getByLabelText("Denoise"));
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("at least one restoration operation");
    expect(port.restore).not.toHaveBeenCalled();
    expect(port.compare).not.toHaveBeenCalled();
  });

  it("restores with the typed operations (normalization off by default), measures, and shows the host's numbers and verdict", async () => {
    const port = fakePort();
    await mounted(port);
    fillSource();
    set("Reference artifact id", "ref-1");
    set("Reference exact version", REF_VERSION);
    set("Remove mains hum", "50");
    submit();
    await waitFor(() => expect(document.querySelector("[data-audio-result]")).toBeTruthy());
    expect(port.restore).toHaveBeenCalledWith({
      requestId: "audio-req-1", artifactId: "src-1", artifactVersionId: SRC_VERSION,
      operations: { declip: { threshold: 10 }, dehum: { frequencyHz: 50 }, denoise: { reductionDb: 12, noiseFloorDb: -50, trackNoise: true } },
    });
    expect(port.restore.mock.calls[0]![0].operations.normalize).toBeUndefined();
    expect(port.compare).toHaveBeenCalledWith({
      requestId: "audio-req-2", source: { artifactId: "src-1", artifactVersionId: SRC_VERSION },
      restored: { artifactId: "out-1", artifactVersionId: OUT_VERSION }, reference: { artifactId: "ref-1", artifactVersionId: REF_VERSION },
    });
    const table = document.querySelector("[data-audio-measurement] table")!;
    expect(table.querySelector("caption")!.textContent).toContain("measured against the clean reference");
    const cell = (metric: string, name: string) => table.querySelector(`[data-metric='${metric}'] [data-cell='${name}']`)!.textContent;
    expect(cell("snr", "source")).toBe("9.98");
    expect(cell("snr", "restored")).toBe("11.51");
    expect(cell("snr", "change")).toContain("+1.53");
    expect(cell("clipped", "source")).toBe("346");
    expect(cell("clipped", "restored")).toBe("0");
    expect(cell("noise-floor", "change")).toContain("-4.18");
    expect(table.querySelectorAll("th[scope='col']").length).toBe(5);
    expect(table.querySelectorAll("th[scope='row']").length).toBe(5);
    expect(document.querySelector("[data-verdict-text]")!.textContent).toContain("closer to it than the source");
    expect(document.querySelector("[data-filter-graph]")!.textContent).toContain("adeclip=threshold=10");
    expect(document.activeElement?.id).toBe("audio-result-title");
  });

  it("never claims an improvement the host did not measure (no reference, degraded, mixed, unchanged)", async () => {
    const port = fakePort({ compare: vi.fn(() => ok(201, comparisonBody("NOT_MEASURED_AGAINST_REFERENCE", false))) });
    await mounted(port);
    fillSource();
    submit();
    await waitFor(() => expect(document.querySelector("[data-verdict-text]")).toBeTruthy());
    expect(document.querySelector("[data-verdict-text]")!.textContent).toContain("NOT measured and no improvement is claimed");
    expect(document.querySelector("[data-verdict-text]")!.textContent).not.toMatch(/closer to it/u);
    expect(document.querySelector("[data-audio-measurement] caption")!.textContent).toContain("descriptive only");
    expect(document.querySelector("[data-metric='snr'] [data-cell='source']")!.textContent).toBe("not measured");
    const verdictOf = (overall: string) => describeAudioVerdict(parseAudioComparisonView({ status: 201, body: comparisonBody(overall) }));
    expect(verdictOf("DEGRADED")).toContain("made it worse");
    expect(verdictOf("MIXED")).toContain("Mixed result");
    expect(verdictOf("NO_MEASURABLE_CHANGE")).toContain("No measurable change");
    expect(verdictOf("IMPROVED")).toContain("closer to it");
  });

  it("keeps one request identifier per input so a retry after an unknown outcome never duplicates, and a changed input gets a new one", async () => {
    const restore = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new DevAudioHostError("AUDIO_RESTORATION_OUTCOME_UNKNOWN", 503, "unknown")))
      .mockImplementation(() => ok(201, restorationBody()));
    const port = fakePort({ restore });
    await mounted(port);
    fillSource();
    submit();
    const failure = await waitFor(() => { const node = document.querySelector("[data-failure-code]"); expect(node).toBeTruthy(); return node!; });
    expect(failure.getAttribute("data-failure-tone")).toBe("unknown");
    expect(failure.textContent).toContain("outcome is unknown");
    expect(document.querySelector("[data-audio-result]")).toBeNull();
    expect(port.compare).not.toHaveBeenCalled();
    submit();
    await waitFor(() => expect(document.querySelector("[data-audio-result]")).toBeTruthy());
    expect(restore.mock.calls[0]![0].requestId).toBe("audio-req-1");
    expect(restore.mock.calls[1]![0].requestId).toBe("audio-req-1");
    set("Remove mains hum", "60");
    submit();
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(3));
    expect(restore.mock.calls[2]![0].requestId).not.toBe("audio-req-1");
  });

  it("describes each typed refusal in plain language and never implies audio was produced", async () => {
    const cases: Array<[string, number, string, RegExp]> = [
      ["RIGHTS_DECISION_REVOKED", 403, "denied", /revoked.*Nothing was processed or registered/u],
      ["RIGHTS_DECISION_DENIED", 403, "denied", /denied/u],
      ["SOURCE_VERSION_STALE", 409, "stale", /not the current version/u],
      ["AUDIO_PARAMETERS_INVALID", 422, "invalid", /Nothing was processed/u],
      ["AUDIO_ENGINE_UNAVAILABLE", 503, "unavailable", /not available/u],
    ];
    for (const [code, status, tone, text] of cases) {
      cleanup();
      const port = fakePort({ restore: vi.fn(() => Promise.reject(new DevAudioHostError(code, status, "refused by host"))) });
      await mounted(port);
      fillSource();
      submit();
      const node = await waitFor(() => { const found = document.querySelector("[data-failure-code]"); expect(found).toBeTruthy(); return found!; });
      expect(node.getAttribute("data-failure-code")).toBe(code);
      expect(node.getAttribute("data-failure-tone")).toBe(tone);
      expect(node.textContent).toMatch(text);
      expect(document.querySelector("[data-audio-result]")).toBeNull();
    }
    expect(describeAudioFailure(new DevAudioHostError("X", 0, "no response")).tone).toBe("unknown");
    expect(describeAudioFailure(new Error("boom")).tone).toBe("unknown");
  });

  it("keeps the registered restoration visible when only the measurement fails, and offers a retry", async () => {
    const port = fakePort({ compare: vi.fn(() => Promise.reject(new DevAudioHostError("COMPARISON_SHAPE_MISMATCH", 422, "shape"))) });
    await mounted(port);
    fillSource();
    submit();
    await waitFor(() => expect(document.querySelector("[data-audio-result]")).toBeTruthy());
    expect(document.querySelector("[data-restored-version]")!.textContent).toBe(OUT_VERSION);
    expect(document.querySelector("[data-audio-measurement]")).toBeNull();
    expect(document.querySelector("[data-audio-result] [data-failure-code='COMPARISON_SHAPE_MISMATCH']")!.textContent).toContain("No alignment is guessed");
  });

  it("is inert while locked", async () => {
    const port = fakePort();
    await mounted(port, true);
    expect(screen.getByRole("button", { name: "Restore and measure" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Source artifact id").matches(":disabled")).toBe(true);
  });

  describe("A/B player", () => {
    const bytesFor = (marker: number) => new Uint8Array([marker, 1, 2, 3]);
    function withContent(map: Record<string, Uint8Array>) {
      const readArtifactContent = vi.fn(async ({ artifactVersionId }: { artifactVersionId: string }) =>
        ({ status: 200, contentType: "audio/wav", bytes: map[artifactVersionId]! }));
      const digest = async (bytes: Uint8Array): Promise<string> => bytes[0] === 1 ? SRC_SHA : bytes[0] === 2 ? OUT_SHA : "d".repeat(64);
      return { readArtifactContent, digest };
    }
    beforeEach(() => {
      let n = 0;
      vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:fake-${++n}`), revokeObjectURL: vi.fn() }));
    });

    async function openResult(port: FakePort, digest?: (bytes: Uint8Array) => Promise<string>) {
      await mounted(port, false, digest);
      fillSource();
      submit();
      await waitFor(() => expect(document.querySelector("[data-audio-ab]")).toBeTruthy());
    }

    it("states that the clips cannot be played when the host exposes no content route", async () => {
      await openResult(fakePort());
      expect(document.querySelector("[data-audio-ab]")!.textContent).toContain("cannot be played here");
      expect(screen.queryByRole("button", { name: /Load both clips/u })).toBeNull();
    });

    it("plays only after both versions verify, and switches A/B at the same position and play state", async () => {
      const { readArtifactContent, digest } = withContent({ [SRC_VERSION]: bytesFor(1), [OUT_VERSION]: bytesFor(2) });
      await openResult(fakePort({ readArtifactContent }), digest);
      expect(document.querySelector("audio")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Load both clips/u }));
      await waitFor(() => expect(document.querySelector("audio")).toBeTruthy());
      expect(readArtifactContent).toHaveBeenCalledTimes(2);
      expect(document.querySelector("[data-ab-status]")!.textContent).toContain(SRC_SHA);
      expect(document.querySelector("[data-ab-status]")!.textContent).toContain(OUT_SHA);
      const audio = document.querySelector("audio") as HTMLAudioElement;
      expect(audio.getAttribute("src")).toBe("blob:fake-1");
      expect(audio.getAttribute("aria-label")).toContain("Source (A)");
      expect((screen.getByLabelText("Source (A)") as HTMLInputElement).checked).toBe(true);
      Object.defineProperty(audio, "currentTime", { value: 1.25, writable: true, configurable: true });
      Object.defineProperty(audio, "paused", { value: false, configurable: true });
      Object.defineProperty(audio, "duration", { value: 9, configurable: true });
      const play = vi.fn(() => Promise.resolve());
      (audio as unknown as { play: () => Promise<void> }).play = play;
      fireEvent.click(screen.getByRole("button", { name: /Switch to restored/u }));
      expect(audio.getAttribute("src")).toBe("blob:fake-2");
      expect(audio.getAttribute("aria-label")).toContain("Restored (B)");
      fireEvent.loadedMetadata(audio);
      expect(audio.currentTime).toBe(1.25);
      expect(play).toHaveBeenCalledTimes(1);
      expect(document.querySelector("[data-ab-announce]")!.textContent).toContain("Restored (B)");
      // the radio group switches back with the same behavior
      fireEvent.click(screen.getByLabelText("Source (A)"));
      expect(audio.getAttribute("src")).toBe("blob:fake-1");
      expect(screen.getByRole("button", { name: /Switch to restored/u })).toBeTruthy();
    });

    it("refuses to play when a version's bytes do not match its registered SHA-256", async () => {
      const { readArtifactContent } = withContent({ [SRC_VERSION]: bytesFor(1), [OUT_VERSION]: bytesFor(9) });
      const digest = async (bytes: Uint8Array): Promise<string> => bytes[0] === 1 ? SRC_SHA : "e".repeat(64);
      await openResult(fakePort({ readArtifactContent }), digest);
      fireEvent.click(screen.getByRole("button", { name: /Load both clips/u }));
      await waitFor(() => expect(document.querySelector("[data-ab-state='failed']")).toBeTruthy());
      expect(document.querySelector("[data-ab-status]")!.textContent).toContain("CONTENT_DIGEST_MISMATCH");
      expect(document.querySelector("audio")).toBeNull();
    });
  });
});

describe("audio parsers", () => {
  it("accepts the host views and rejects malformed or unlabelled ones", () => {
    expect(parseAudioHostStatus({ status: 200, body: statusBody() }).engineReady).toBe(true);
    expect(parseAudioRestorationView({ status: 201, body: restorationBody() }).artifact.artifactVersionId).toBe(OUT_VERSION);
    expect(parseAudioComparisonView({ status: 201, body: comparisonBody() }).delta.snrDb).toBeCloseTo(1.53);
    const bad = restorationBody() as { artifact: { sha256: string } };
    bad.artifact.sha256 = "f".repeat(64); // version no longer equals sha256:<sha>
    expect(() => parseAudioRestorationView({ status: 201, body: bad })).toThrow(DevAudioHostError);
    expect(() => parseAudioRestorationView({ status: 201, body: { ...(restorationBody() as object), scope: "PRODUCTION" } })).toThrow(DevAudioHostError);
    expect(() => parseAudioComparisonView({ status: 201, body: { scope: "DEV_ONLY", kind: "COMPARISON" } })).toThrow(DevAudioHostError);
    expect(() => parseAudioHostStatus({ status: 200, body: {} })).toThrow(DevAudioHostError);
  });
});
